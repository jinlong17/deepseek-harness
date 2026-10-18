import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { spawn } from 'node:child_process'

import { closeB5HostOwners, withB5FactoryCleanup } from './b5-factory-cleanup.mjs'
import { h1Stubs } from './b5-fixed-stubs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const node = process.execPath
const nodeSha256 = createHash('sha256').update(await readFile(node)).digest('hex')
const temp = await mkdtemp(join(tmpdir(), 'g9-b5-factory-cleanup-'))
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const modulePath = name => join(here, name)

after(async () => { await (await import('node:fs/promises')).rm(temp, { force: true, recursive: true }) })

function runNode(script, args = [], options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(node, [script, ...args], { cwd: root, stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] })
    const stdout = []; const stderr = []
    child.stdout?.on('data', chunk => stdout.push(chunk))
    child.stderr?.on('data', chunk => stderr.push(chunk))
    child.once('error', rejectRun)
    child.once('close', (code, signal) => resolveRun({ child, code, signal, stderr: Buffer.concat(stderr).toString('utf8'), stdout: Buffer.concat(stdout).toString('utf8') }))
  })
}

function frame(stream, value) {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  stream.write(Buffer.concat([header, body]))
}

function frameReader(stream) {
  let buffered = Buffer.alloc(0); const values = []; const waiters = []
  const deliver = () => {
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.length < length + 4) return
      const value = JSON.parse(buffered.subarray(4, length + 4).toString('utf8'))
      buffered = buffered.subarray(length + 4)
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(value); else values.push(value)
    }
  }
  stream.on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); deliver() })
  return () => values.shift() ?? new Promise(resolveValue => waiters.push(resolveValue))
}

function closed(port) {
  return new Promise((resolveClosed, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`loopback port ${port} remained open`)) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolveClosed() : reject(error))
  })
}

async function fixture(name, scenario) {
  const directory = join(temp, name); await mkdir(directory, { recursive: true })
  for (const value of ['home', 'runtime', 'workspace', 'qwen']) await mkdir(join(directory, value), { recursive: true })
  const files = {}
  for (const value of ['canary', 'qwen-cli', 'world', 'reject', 'late', 'continuity']) {
    files[value] = join(directory, value); await writeFile(files[value], value)
  }
  const config = {
    schema: 'g9-b5-runtime-scenario/v1', resultPath: join(directory, 'result.json'), forkRoot: root,
    nodePath: node, nodeSha256, osHome: join(directory, 'home'), runtimeParent: join(directory, 'runtime'),
    sourceRoot: root, workspaceDirectory: join(directory, 'workspace'), mode: 'consumer', fdQualification: {},
    scenario, nativeCanaryPath: files.canary, nativeCanaryExpected: 'canary', qwenCliPath: files['qwen-cli'],
    qwenCliSha256: await sha256(files['qwen-cli']), qwenRoot: join(directory, 'qwen'), qwenTreeSha256: 'a'.repeat(64),
    worldEffect: files.world, rejectEffect: files.reject, lateEffect: files.late, continuityPath: files.continuity,
    continuitySha256: await sha256(files.continuity), continuityOutput: join(directory, 'continuity-output.json'),
  }
  const configPath = join(directory, 'scenario.json'); await writeFile(configPath, JSON.stringify(config))
  return { config, configPath, configSha256: await sha256(configPath), directory }
}

async function factoryCleanup(name, moduleName, scenario, consumer, stream = false) {
  const state = await fixture(name, scenario); const script = join(state.directory, 'factory-child.mjs')
  const source = `import { makeB5HostLaunchInput, closeB5HostFactory } from ${JSON.stringify(pathToFileURL(modulePath(moduleName)).href)};
const supplied = await makeB5HostLaunchInput({ consumer: ${JSON.stringify(consumer)}, sourceAnchorSha256: 'f'.repeat(64) });
const launch = supplied.launchInput;
let stream = null;
if (${JSON.stringify(stream)}) {
  stream = await fetch(launch.auth.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'B5 STREAM' }] }) });
}
const firstClose = closeB5HostFactory(); const secondClose = closeB5HostFactory();
await Promise.allSettled([firstClose, secondClose]);
const endpoints = launch.h1 ? [launch.h1.modelEndpoint, launch.h1.brokerEndpoint] : [launch.auth.endpoint];
process.stdout.write(JSON.stringify({ endpoints, sameClose: firstClose === secondClose, stream: stream === null ? null : await stream.text() }));`
  await writeFile(script, source)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.sameClose, true)
  for (const endpoint of value.endpoints) await closed(Number(new URL(endpoint).port))
  if (stream) assert.match(value.stream, /_FINAL/u)
}

test('each B5 factory closes prepared loopback resources idempotently before Host launch', async () => {
  await factoryCleanup('desktop', 'b5-desktop-host-factory.mjs', 'desktop-main', 'desktop-byok')
  await factoryCleanup('h1', 'b5-h1-host-factory.mjs', 'h1-valid', 'governed-h1')
  await factoryCleanup('external-stream', 'b5-external-qwen-factory.mjs', 'external-create', 'external-qwen', true)
  await factoryCleanup('external-idle', 'b5-external-qwen-factory.mjs', 'external-create', 'external-qwen')
})

test('H1 partial listener acquisition closes the first listener and preserves both failures', async () => {
  const primary = new Error('second listener failed'); const cleanup = new Error('first listener cleanup failed')
  let closes = 0; let calls = 0
  await assert.rejects(
    h1Stubs('/tmp/canary', async () => {
      calls += 1
      if (calls === 1) return { close: async () => { closes += 1; throw cleanup }, port: 1 }
      throw primary
    }),
    error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
  )
  assert.equal(closes, 1)
})

test('scenario cleanup preserves its primary error and memoizes the close outcome', async () => {
  const primary = new Error('scenario'); const cleanup = new Error('cleanup'); let calls = 0
  const close = () => {
    calls += 1
    return Promise.reject(cleanup)
  }
  await assert.rejects(
    withB5FactoryCleanup(close, async () => { throw primary }),
    error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
  )
  assert.equal(calls, 1)
})

test('controller owner cleanup is ordered, attempts all owners, and retains primary plus cleanup errors', async () => {
  const calls = []; const primary = new Error('primary'); const host = new Error('host'); const retained = new Error('retained'); const factory = new Error('factory')
  await assert.rejects(
    closeB5HostOwners({
      host: { shutdown: async () => { calls.push('host'); throw host } },
      retained: { cleanup: async () => { calls.push('retained'); throw retained } },
      factory: { closeB5HostFactory: async () => { calls.push('factory'); throw factory } }, primary,
    }),
    error => error instanceof AggregateError && error.errors[0] === primary && error.errors.slice(1).every((value, index) => value === [host, retained, factory][index]),
  )
  assert.deepEqual(calls, ['host', 'retained', 'factory'])
})

test('actual controller pre-scenario owner rejection closes governed H1 listeners without a signal', async () => {
  const state = await fixture('controller', 'h1-valid'); const materialDir = join(state.directory, 'materials'); await mkdir(materialDir)
  const records = join(state.directory, 'endpoints.json')
  const files = {}
  for (const value of ['profile', 'config', 'bootstrap', 'entry']) { files[value] = join(materialDir, value); await writeFile(files[value], value) }
  const anchors = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, value]) => [key, await sha256(value)])))
  const materials = join(state.directory, 'materials.mjs')
  await writeFile(materials, `import { writeFileSync } from 'node:fs';
export async function prepareLumxHostLaunch(input) {
  writeFileSync(${JSON.stringify(records)}, JSON.stringify(input.h1));
  return { paths: { profilePath: ${JSON.stringify(files.profile)}, configPath: ${JSON.stringify(files.config)}, bootstrap: ${JSON.stringify(files.bootstrap)}, hostEntry: ${JSON.stringify(files.entry)} }, anchors: { profileSha256: ${JSON.stringify(anchors.profile)}, configFileSha256: ${JSON.stringify(anchors.config)}, bootstrapSha256: ${JSON.stringify(anchors.bootstrap)}, hostEntrySha256: ${JSON.stringify(anchors.entry)} }, payload: { generation: 'fixture-generation' }, nodePath: process.execPath, cleanup: async () => {} };
}`)
  const supervisor = join(state.directory, 'supervisor.mjs')
  await writeFile(supervisor, `export async function launchLumxHost(_retained, { beforeBootstrap }) { await beforeBootstrap({ pid: 7311, pgid: 7311 }); throw new Error('ownership rejection must stop launch'); }`)
  const controller = modulePath('gate1-prepared-host-controller.mjs')
  const child = spawn(node, [controller, '--source-anchor-sha256', 'a'.repeat(64), '--preparation-anchor-sha256', 'b'.repeat(64), '--consumer', 'governed-h1', '--runtime-role', 'h1-grant', '--materials-module', materials, '--supervisor-module', supervisor, '--factory-module', modulePath('b5-h1-host-factory.mjs'), '--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256, '--ready-fd', '3', '--ack-fd', '4', '--ack-timeout-ms', '1000'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  const stderr = []; child.stderr.on('data', chunk => stderr.push(chunk)); const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))); const next = frameReader(child.stdio[3])
  const within = promise => new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => rejectFrame(new Error('controller frame timeout')), 3_000)
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolveFrame(value) }, error => { clearTimeout(timer); rejectFrame(error) })
  })
  try {
    const ready = await within(next())
    frame(child.stdio[4], { schema: 'g9-b5-host-ack/v1', nonce: ready.nonce, source_anchor_sha256: ready.source_anchor_sha256, preparation_anchor_sha256: ready.preparation_anchor_sha256, runtime_anchor_sha256: 'c'.repeat(64), material_sha256: Object.fromEntries(ready.materials.map(row => [row.material_id, row.sha256])) })
    const owner = await within(next())
    frame(child.stdio[4], { schema: 'g9-b5-host-owner-ack/v1', nonce: owner.nonce, runtime_anchor_sha256: owner.runtime_anchor_sha256, generation: 'wrong-generation', pid: owner.pid, pgid: owner.pgid })
    child.stdio[4].end()
    const exit = await within(exited)
    assert.deepEqual(exit, { code: 1, signal: null }, Buffer.concat(stderr).toString('utf8'))
    const endpoints = JSON.parse(await readFile(records, 'utf8'))
    await closed(Number(new URL(endpoints.modelEndpoint).port)); await closed(Number(new URL(endpoints.brokerEndpoint).port))
  } catch (error) {
    throw new Error(`${error.message}: ${Buffer.concat(stderr).toString('utf8')}`)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
})
