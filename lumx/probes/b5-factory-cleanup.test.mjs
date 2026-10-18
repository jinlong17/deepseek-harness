import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { spawn } from 'node:child_process'

import { closeB5HostOwners, withB5FactoryCleanup } from './b5-factory-cleanup.mjs'
import { desktopStub, h1Stubs, qwenStub } from './b5-fixed-stubs.mjs'
import { listen, qualificationFacts } from './b5-hook-common.mjs'

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
    const timer = setTimeout(() => { child.kill('SIGTERM'); rejectRun(new Error(`child timed out: ${script}`)) }, 5_000)
    child.stdout?.on('data', chunk => stdout.push(chunk))
    child.stderr?.on('data', chunk => stderr.push(chunk))
    child.once('error', error => { clearTimeout(timer); rejectRun(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ child, code, signal, stderr: Buffer.concat(stderr).toString('utf8'), stdout: Buffer.concat(stdout).toString('utf8') }) })
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

async function factoryCleanup(name, moduleName, scenario, consumer, stream = 'none') {
  const state = await fixture(name, scenario); const script = join(state.directory, 'factory-child.mjs')
  const source = `import { makeB5HostLaunchInput, closeB5HostFactory } from ${JSON.stringify(pathToFileURL(modulePath(moduleName)).href)};
const supplied = await makeB5HostLaunchInput({ consumer: ${JSON.stringify(consumer)}, sourceAnchorSha256: 'f'.repeat(64) });
const launch = supplied.launchInput;
let stream = null;
if (${JSON.stringify(stream)} !== 'none') {
  stream = await fetch(launch.auth.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'B5 STREAM' }] }) });
}
if (${JSON.stringify(stream)} === 'abort') await stream.body.cancel();
const firstClose = closeB5HostFactory(); const secondClose = closeB5HostFactory();
await Promise.allSettled([firstClose, secondClose]);
const endpoints = launch.h1 ? [launch.h1.modelEndpoint, launch.h1.brokerEndpoint] : [launch.auth.endpoint];
process.stdout.write(JSON.stringify({ endpoints, sameClose: firstClose === secondClose, stream: ${JSON.stringify(stream)} === 'finish' ? await stream.text() : null }));`
  await writeFile(script, source)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.sameClose, true)
  for (const endpoint of value.endpoints) await closed(Number(new URL(endpoint).port))
  if (stream === 'finish') assert.match(value.stream, /_FINAL/u)
  return value
}

test('desktop stub accepts only the fixed POST provider route', async () => {
  const stub = await desktopStub(); const endpoint = new URL(stub.endpoint)
  try {
    assert.equal(endpoint.hostname, '127.0.0.1')
    assert.equal(endpoint.pathname, '/v1/chat/completions')
    assert.equal(endpoint.search, '')
    const accepted = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'fixture' }] }) })
    assert.equal(accepted.status, 200)
    assert.match((await accepted.json()).text, /^LUMX synthetic response:/u)
    assert.equal(stub.requests.length, 1)
    assert.deepEqual(stub.requests[0], { method: 'POST', path: '/v1/chat/completions', payload: { messages: [{ role: 'user', content: 'fixture' }] } })
    for (const value of [
      { url: new URL('/model', endpoint), method: 'POST' },
      { url: new URL(`${endpoint.pathname}?probe=1`, endpoint), method: 'POST' },
      { url: endpoint, method: 'GET' },
    ]) {
      const rejected = await fetch(value.url, { method: value.method })
      assert.equal(rejected.ok, false)
      assert.equal(stub.requests.length, 1)
    }
  } finally {
    await stub.close(); await closed(Number(endpoint.port))
  }
})

test('each B5 factory closes prepared loopback resources idempotently before Host launch', async () => {
  for (const scenario of ['desktop-main', 'desktop-alternate-anonymous', 'desktop-alternate-valid']) {
    const value = await factoryCleanup(`desktop-${scenario}`, 'b5-desktop-host-factory.mjs', scenario, 'desktop-byok')
    const endpoint = new URL(value.endpoints[0])
    assert.equal(endpoint.hostname, '127.0.0.1')
    assert.equal(endpoint.pathname, '/v1/chat/completions')
    assert.equal(endpoint.search, '')
  }
  await factoryCleanup('h1', 'b5-h1-host-factory.mjs', 'h1-valid', 'governed-h1')
  await factoryCleanup('external-stream', 'b5-external-qwen-factory.mjs', 'external-create', 'external-qwen', 'finish')
  await factoryCleanup('external-abort', 'b5-external-qwen-factory.mjs', 'external-create', 'external-qwen', 'abort')
  await factoryCleanup('external-idle', 'b5-external-qwen-factory.mjs', 'external-create', 'external-qwen')
})

async function alternateQualification(scenario, facts) {
  const state = await fixture(`alternate-${scenario}`, scenario)
  const script = join(state.directory, 'alternate-child.mjs')
  const qualification = { consumer: 'desktop-byok', materialProjection: [{ materialId: 'host-profile', role: 'host', sha256: 'd'.repeat(64) }] }
  await writeFile(script, `import { readFileSync } from 'node:fs';
import { makeB5HostLaunchInput, runB5HostScenario } from ${JSON.stringify(pathToFileURL(modulePath('b5-desktop-host-factory.mjs')).href)};
const qualification = ${JSON.stringify(qualification)};
await makeB5HostLaunchInput({ consumer: 'desktop-byok', sourceAnchorSha256: 'e'.repeat(64) });
await runB5HostScenario({ host: { control: { qualify: async () => ({ type: 'qualify', operation: 'byok-alternate', status: 'pass', facts: (${JSON.stringify(facts)}) }) } }, runtimeAnchorSha256: 'f'.repeat(64), qualification });
process.stdout.write(readFileSync(${JSON.stringify(state.config.resultPath)}, 'utf8'));`)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.deepEqual(value.qualification, qualification)
  assert.equal(value.counted_results[0].status, 'pass')
  assert.ok(value.counted_results[0].subchecks.every(check => check.result === 'pass'))
}

test('desktop alternate results retain the received qualification for anonymous and valid fixtures', async () => {
  await alternateQualification('desktop-alternate-anonymous', { adapterCalls: 0, failure: { code: 'identity_required' } })
  await alternateQualification('desktop-alternate-valid', { adapterCalls: 1, chunks: [{ type: 'finish' }] })
})

test('desktop governance capability requires exact policy rows, desktop consumer, and a real BYOK result', async () => {
  const state = await fixture('desktop-governance-capability', 'desktop-main')
  const script = join(state.directory, 'desktop-governance-capability-child.mjs')
  const packages = {
    'session-log-deepseek': '@deepseek-ai/dsh-session-log-deepseek',
    'plugin-package-inventory-deepseek': '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
    'session-telemetry-otel': '@deepseek-ai/dsh-session-telemetry-otel',
    'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
    'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
    'desktop-product-telemetry': '@deepseek-ai/dsh-host-product-telemetry-otel',
    'product-analytics': '@deepseek-ai/dsh-client-product-analytics',
  }
  await writeFile(script, `import { closeB5HostFactory, desktopGovernanceByokReady, makeB5HostLaunchInput } from ${JSON.stringify(pathToFileURL(modulePath('b5-desktop-host-factory.mjs')).href)};
await makeB5HostLaunchInput({ consumer: 'desktop-byok', sourceAnchorSha256: 'e'.repeat(64) });
const packages = ${JSON.stringify(packages)};
const rows = Object.entries(packages).map(([id, specifier], index) => ({ id, specifier, identity: { format: 'module', generation: index + 1, url: 'file:///fixed/' + id + '.mjs' } }));
const facts = () => ({ governance: { ready: true, rows: structuredClone(rows) }, protectedActions: rows.map(row => ({ id: row.id, package: row.specifier, packageIdentity: structuredClone(row.identity) })), candidates: rows.map(row => ({ id: row.id, protectedId: row.id, name: row.specifier, identity: structuredClone(row.identity), disabled: true, fiberPresent: false })) });
const positive = { modelRequests: 1, response: { status: 'pass' } };
const evaluate = (consumer, mutate, byok = positive) => { const privacyFacts = facts(); mutate?.(privacyFacts); return desktopGovernanceByokReady({ consumer, privacyFacts, positive: byok }); };
const results = {
  exact: evaluate('desktop-byok'),
  missing: evaluate('desktop-byok', value => value.governance.rows.pop()),
  extra: evaluate('desktop-byok', value => value.governance.rows.push(structuredClone(value.governance.rows[0]))),
  duplicate: evaluate('desktop-byok', value => { value.governance.rows[1].id = value.governance.rows[0].id; }),
  duplicateAction: evaluate('desktop-byok', value => { value.protectedActions[1].id = value.protectedActions[0].id; }),
  malformed: evaluate('desktop-byok', value => { value.governance.rows[0].identity.url = ''; }),
  failedGuard: evaluate('desktop-byok', value => { value.governance.ready = false; }),
  wrongConsumer: evaluate('governed-h1'),
  absentByok: evaluate('desktop-byok', undefined, { modelRequests: 0, response: { status: 'pass' } }),
};
await closeB5HostFactory();
process.stdout.write(JSON.stringify(results));`)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    exact: true, missing: false, extra: false, duplicate: false, duplicateAction: false, malformed: false, failedGuard: false, wrongConsumer: false, absentByok: false,
  })
})

test('Host qualification envelopes preserve failure facts and reject malformed responses before factory dereference', async () => {
  const facts = { denied: true }
  assert.equal(qualificationFacts({ type: 'qualify', operation: 'isolation-network', status: 'pass', facts }, 'isolation-network'), facts)
  const rejected = { type: 'qualify', status: 'fail', error: 'synthetic qualification failure' }
  assert.throws(
    () => qualificationFacts(rejected, 'privacy-lifecycle'),
    error => error.message.includes(JSON.stringify(rejected)),
  )
  for (const value of [
    { type: 'qualify', operation: 'privacy-lifecycle', status: 'pass' },
    { type: 'qualify', operation: 'wrong-operation', status: 'pass', facts: {} },
    { type: 'other', operation: 'privacy-lifecycle', status: 'pass', facts: {} },
    { type: 'qualify', operation: 'privacy-lifecycle', status: 'fail', facts: {} },
    null,
  ]) assert.throws(() => qualificationFacts(value, 'privacy-lifecycle'), /Host qualification privacy-lifecycle response rejected/)
})

test('H1 factory preserves the actual fail envelope rather than dereferencing missing facts', async () => {
  const state = await fixture('h1-qualification-failure', 'h1-valid')
  const script = join(state.directory, 'h1-failure-child.mjs')
  await writeFile(script, `import { makeB5HostLaunchInput, runB5HostScenario } from ${JSON.stringify(pathToFileURL(modulePath('b5-h1-host-factory.mjs')).href)};
await makeB5HostLaunchInput({ consumer: 'governed-h1', sourceAnchorSha256: 'e'.repeat(64) });
const calls = [];
try {
  await runB5HostScenario({ host: { control: { qualify: async ({ operation }) => { calls.push(operation); return operation === 'isolation-network'
    ? { type: 'qualify', operation, status: 'pass', facts: { denied: true } }
    : { type: 'qualify', status: 'fail', error: 'synthetic privacy failure' }; } }, consumer: 'governed-h1' }, runtimeAnchorSha256: 'f'.repeat(64), qualification: {} });
} catch (error) { process.stdout.write(JSON.stringify({ calls, message: error.message })); }`)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { calls: ['isolation-network', 'privacy-lifecycle'], message: 'Host qualification privacy-lifecycle response rejected: {"type":"qualify","status":"fail","error":"synthetic privacy failure"}' })
})

test('desktop factory preserves a failed alternate qualification envelope', async () => {
  const state = await fixture('desktop-qualification-failure', 'desktop-alternate-valid')
  const script = join(state.directory, 'desktop-failure-child.mjs')
  await writeFile(script, `import { makeB5HostLaunchInput, runB5HostScenario } from ${JSON.stringify(pathToFileURL(modulePath('b5-desktop-host-factory.mjs')).href)};
await makeB5HostLaunchInput({ consumer: 'desktop-byok', sourceAnchorSha256: 'e'.repeat(64) });
try {
  await runB5HostScenario({ host: { control: { qualify: async () => ({ type: 'qualify', status: 'fail', error: 'synthetic alternate failure' }) } }, runtimeAnchorSha256: 'f'.repeat(64), qualification: {} });
} catch (error) { process.stdout.write(JSON.stringify({ message: error.message })); }`)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).message, 'Host qualification byok-alternate response rejected: {"type":"qualify","status":"fail","error":"synthetic alternate failure"}')
})

test('desktop main stops qualification after an isolation failure', async () => {
  const state = await fixture('desktop-isolation-failure', 'desktop-main')
  const script = join(state.directory, 'desktop-isolation-failure-child.mjs')
  await writeFile(script, `import { createServer } from 'node:http';
import { makeB5HostLaunchInput, runB5HostScenario } from ${JSON.stringify(pathToFileURL(modulePath('b5-desktop-host-factory.mjs')).href)};
const server = createServer((request, response) => {
  if (request.url === '/') { response.writeHead(303, { location: '/page', 'set-cookie': 'b5=fixture' }); response.end(); return; }
  response.writeHead(200); response.end('fixture');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; const calls = [];
await makeB5HostLaunchInput({ consumer: 'desktop-byok', sourceAnchorSha256: 'e'.repeat(64) });
try {
  await runB5HostScenario({ host: { consumer: 'desktop-byok', readyUrl: 'http://127.0.0.1:' + port + '/', control: { qualify: async ({ operation }) => { calls.push(operation); return { type: 'qualify', status: 'fail', error: 'synthetic isolation failure' }; } } }, runtimeAnchorSha256: 'f'.repeat(64), qualification: {} });
} catch (error) { process.stdout.write(JSON.stringify({ calls, message: error.message })); }
finally { await new Promise(resolve => server.close(resolve)); }`)
  const result = await runNode(script, ['--scenario-config', state.configPath, '--scenario-config-sha256', state.configSha256])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { calls: ['isolation-network'], message: 'Host qualification isolation-network response rejected: {"type":"qualify","status":"fail","error":"synthetic isolation failure"}' })
})

test('an already-destroyed Qwen stream settles before provider close', async () => {
  const barriers = { streamActive: false, streamFirst: Promise.withResolvers(), streamRelease: Promise.withResolvers(), streamFinished: Promise.withResolvers(), cancelStarted: Promise.withResolvers(), cancelObserved: Promise.withResolvers() }
  let handler; let closes = 0
  const stub = await qwenStub({ lateEffect: '/tmp/late', rejectEffect: '/tmp/reject', toolCommand: 'true', rejectCommand: 'true', worldEffect: '/tmp/world' }, barriers, async candidate => {
    handler = candidate
    return { close: async () => { closes += 1 }, port: 0 }
  })
  const response = new EventEmitter()
  Object.assign(response, { destroyed: true, writableEnded: false, writableFinished: false, writeHead() {}, write() {}, end() {} })
  const request = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'B5 STREAM' }] })) } }
  const running = handler(request, response)
  await barriers.streamFirst.promise
  barriers.streamRelease.resolve()
  await running
  await stub.close()
  assert.equal(closes, 1)
})

test('H1 partial listener acquisition closes a real first listener before rejecting', async () => {
  let firstPort
  let calls = 0
  await assert.rejects(
    h1Stubs('/tmp/canary', async handler => {
      calls += 1
      if (calls === 1) {
        const first = await listen(handler)
        firstPort = first.port
        return first
      }
      throw new Error('second listener failed')
    }),
    /second listener failed/,
  )
  await closed(firstPort)
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
