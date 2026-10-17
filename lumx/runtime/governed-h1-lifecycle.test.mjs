import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createH1GovernedAgent, launchH1DriverRuntime } from './h1-driver-runtime.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const llm = await import(pathToFileURL(join(ROOT, 'packages/llm/llm/lib/index.js')).href)

async function waitFor(path, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (existsSync(path)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `lumx-h1-${label}-`))
  const workspaceDirectory = join(root, 'workspace')
  let runtime
  const handles = []
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  runtime = await launchH1DriverRuntime({
    brokerEndpoint: 'http://127.0.0.1:1/broker',
    dataHomeDirectory: join(root, 'home', '.lumx'),
    environment: { DSH_TELEMETRY_DISABLED: '1' },
    modelEndpoint: 'http://127.0.0.1:2/model',
    sourceRoot: ROOT,
    workspaceDirectory,
  })
  let executions = 0
  const removeCanary = runtime.ctx.tools.register({
    name: 'lifecycle_native_canary', description: 'Synthetic lifecycle canary.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { executions += 1; return Promise.resolve('executed') },
  })
  t.after(removeCanary)
  const create = async (sessionId, parentAgent) => {
    const handle = await createH1GovernedAgent(runtime.ctx, { parentAgent, sessionId, workspaceDirectory })
    handles.push(handle)
    return handle
  }
  const attempt = agent => runtime.ctx.tools.execute({
    agent, arguments: {}, callId: llm.ToolCallId(`canary-${String(Math.random())}`),
    name: 'lifecycle_native_canary', signal: new AbortController().signal,
  })
  return { create, get executions() { return executions }, handles, root, runtime, attempt, workspaceDirectory }
}

function assertDenied(result) {
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /denied native tool execution/)
}

test('root policy denies root, child, and resumed first work and survives adapter removal', async t => {
  const f = await fixture(t, 'remove')
  const root = await f.create('lifecycle-root')
  const child = await f.runtime.ctx.agents.create({
    sessionId: 'lifecycle-child', parentAgent: root.agent,
    agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' }, meta: { cwd: f.workspaceDirectory },
  })
  f.handles.push(child)
  const seed = await f.create('lifecycle-resume')
  await seed.dispose(); f.handles.splice(f.handles.indexOf(seed), 1)
  const resumed = await f.runtime.ctx.agents.resume({
    resumeSessionId: 'lifecycle-resume', agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' },
  })
  f.handles.push(resumed)
  for (const agent of [root.agent, child.agent, resumed.agent]) assertDenied(await f.attempt(agent))
  assert.equal(f.executions, 0)

  const entry = [...f.runtime.ctx.loader.entries()].find(row => row.options.id === 'lumx-governed-h1-adapter')
  const fiber = entry.fiber
  entry.parent.remove(entry.options.id)
  await fiber.await()
  assertDenied(await f.attempt(root.agent))
  await assert.rejects(f.create('lifecycle-after-remove'), /Broker capability is unavailable/)
  assert.equal(f.executions, 0)
})

test('root policy closes the asynchronous adapter reconfiguration gap and recovers', async t => {
  const f = await fixture(t, 'update')
  const guarded = await f.create('update-existing')
  const entry = [...f.runtime.ctx.loader.entries()].find(row => row.options.id === 'lumx-governed-h1-adapter')
  const fiber = entry.fiber
  const fakeRoot = join(f.root, 'barrier-source')
  const entered = join(f.root, 'entered')
  const release = join(f.root, 'release')
  await mkdir(join(fakeRoot, 'packages/llm/llm/lib'), { recursive: true })
  await writeFile(join(fakeRoot, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(fakeRoot, 'packages/llm/llm/lib/index.js'), [
    `import { existsSync, writeFileSync } from 'node:fs'`,
    `import * as actual from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/llm/llm/lib/index.js')).href)}`,
    `writeFileSync(${JSON.stringify(entered)}, 'entered')`,
    `while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10))`,
    'export const LlmAdapter = actual.LlmAdapter',
    'export const resolveRetryPolicy = actual.resolveRetryPolicy',
    'export const LlmError = actual.LlmError',
    'export const ToolCallId = actual.ToolCallId',
  ].join('\n'))
  await entry.update({ config: { ...entry.options.config, sourceRoot: fakeRoot } })
  await waitFor(entered)
  assertDenied(await f.attempt(guarded.agent))
  await assert.rejects(f.create('update-gap'), /Broker capability is unavailable/)
  assert.equal(f.executions, 0)

  await writeFile(release, 'release')
  await fiber.await()
  const recovered = await f.create('update-recovered')
  assert.deepEqual(f.runtime.ctx.tools.schemas(recovered.agent).map(row => row.name), ['lumx_broker'])
  f.runtime.assertAgent(recovered.agent)
  assertDenied(await f.attempt(recovered.agent))
  assert.equal(f.executions, 0)
})
