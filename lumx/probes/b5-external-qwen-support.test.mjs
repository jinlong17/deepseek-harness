import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { createB5RequestObserver, qwenStub } from './b5-fixed-stubs.mjs'
import { closeBrowserContext, initialize, waitForB5UiRoot } from './b5-external-qwen-support.mjs'

const host = () => ({
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: { sessionCapabilities: { resume: {}, list: {}, close: {} } },
})
const client = response => ({ connection: { initialize: async () => response } })

test('official Host ACP accepts the three session capabilities without engine loadSession', async () => {
  assert.deepEqual(await initialize(client(host())), host())
})

test('official Host ACP rejects an incorrect protocol version', async () => {
  await assert.rejects(initialize(client({ ...host(), protocolVersion: -1 })), /Host ACP session capabilities mismatch/)
})

for (const name of ['resume', 'list', 'close']) {
  test(`official Host ACP rejects missing or malformed ${name}`, async () => {
    for (const value of [undefined, null, true, false, [], 'enabled']) {
      const response = host()
      if (value === undefined) delete response.agentCapabilities.sessionCapabilities[name]
      else response.agentCapabilities.sessionCapabilities[name] = value
      await assert.rejects(initialize(client(response)), /Host ACP session capabilities mismatch/)
    }
  })
}

test('engine loadSession cannot replace Host resume', async () => {
  const response = host()
  delete response.agentCapabilities.sessionCapabilities.resume
  response.agentCapabilities.loadSession = true
  await assert.rejects(initialize(client(response)), /Host ACP session capabilities mismatch/)
})

const digest = value => createHash('sha256').update(value).digest('hex')
const parseObservation = line => JSON.parse(line.slice('B5_REQUEST_OBSERVATION '.length))
test('request observer records bounded source signatures without changing tool admission', () => {
  const lines = []; const observe = createB5RequestObserver((_fd, line) => lines.push(line))
  const tool = { model: 'qwen3.7-max', messages: [{ role: 'user', content: 'B5 TOOL' }], tools: [{ type: 'function', function: { name: 'run_shell_command' } }] }
  observe(tool, 4)
  const row = parseObservation(lines[0])
  assert.equal(row.shell_present, true)
  assert.equal(row.tools_count, 1)
  assert.deepEqual(row.signatures, ['unknown'])
  assert.equal(row.canonical_parsed_payload_sha256, digest(JSON.stringify({ messages: [{ content: 'B5 TOOL', role: 'user' }], model: 'qwen3.7-max', tools: [{ function: { name: 'run_shell_command' }, type: 'function' }] })))
  for (const [signature, content] of [
    ['chat-compression', 'B5 TOOL First, reason in your <analysis> block. Then, produce the <state_snapshot> XML.'],
    ['next-speaker', 'B5 TOOL Analyze *only* the content and structure of your immediately preceding response'],
    ['session-title', 'B5 TOOL Generate a concise, sentence-case title (3-7 words) Conversation so far:'],
  ]) {
    observe({ messages: [{ role: 'user', content }] }, 5)
    assert.deepEqual(parseObservation(lines.at(-1)).signatures, [signature])
  }
  observe({ messages: [{ role: 'user', content: 'B5 TOOL First, reason in your <analysis> block. Then, produce the <state_snapshot> XML. Analyze *only* the content and structure of your immediately preceding response' }] }, 6)
  assert.deepEqual(parseObservation(lines.at(-1)).signatures, ['chat-compression', 'next-speaker'])
  observe({ messages: [{ role: 'user', content: 'B5 TOOL Generate a concise title. Conversation so far:' }] }, 6)
  assert.deepEqual(parseObservation(lines.at(-1)).signatures, ['unknown'])
  observe({ messages: [{ role: 'user', content: 'markerless' }] }, 7)
  assert.equal(lines.length, 6)
  const newSession = []; createB5RequestObserver((_fd, line) => newSession.push(line))({ messages: [{ role: 'user', content: 'B5 TOOL' }], tools: [] }, 1)
  assert.equal(parseObservation(newSession[0]).ordinal, 1)
})

test('request observer fails closed on getters, sink errors and record flood', () => {
  const lines = []; const observe = createB5RequestObserver((_fd, line) => lines.push(line))
  let reads = 0
  const poison = { messages: [{ role: 'user', content: 'B5 TOOL' }] }
  Object.defineProperty(poison, 'secret', { enumerable: true, get() { reads += 1; throw new Error('TOKEN-POISON') } })
  assert.throws(() => observe(poison, 1), /observer object accessor/)
  assert.equal(reads, 0)
  assert.equal(lines.length, 0)
  assert.throws(() => createB5RequestObserver(() => { throw new Error('sink unavailable') })({ messages: [{ role: 'user', content: 'B5 TOOL' }] }, 1), /sink unavailable/)
  for (let index = 0; index < 128; index += 1) observe({ messages: [{ role: 'user', content: 'B5 TOOL' }] }, index)
  assert.equal(lines.length, 128)
  assert.throws(() => observe({ messages: [{ role: 'user', content: 'B5 TOOL' }] }, 129), /record bound/)
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 2048))
})

async function syntheticQwenHandler() {
  let handler
  const stub = await qwenStub({ toolCommand: 'printf synthetic', rejectCommand: 'printf reject', lateCommand: 'printf late', worldEffect: '/nonexistent', rejectEffect: '/nonexistent', lateEffect: '/nonexistent' }, {}, async value => {
    handler = value; return { port: 1, close: async () => {} }
  })
  return { handler, stub }
}
async function invoke(handler, payload) {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))]); request.method = 'POST'; request.url = '/v1/chat/completions'
  const response = { status: null, headers: null, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(chunk) }, end(chunk = '') { this.chunks.push(chunk) } }
  await handler(request, response)
  return response
}
test('real fixture handler still requires shell on first TOOL and keeps normal SSE tool/result paths', async () => {
  const { handler, stub } = await syntheticQwenHandler()
  const prompt = [{ role: 'user', content: 'B5 TOOL' }]
  await assert.rejects(invoke(handler, { model: 'qwen3.7-max', messages: prompt }), /Qwen omitted run_shell_command/)
  await assert.rejects(invoke(handler, { model: 'qwen3.7-max', messages: prompt, tools: [{ function: { name: 'other_tool' } }] }), /Qwen omitted run_shell_command/)
  const normal = await invoke(handler, { model: 'qwen3.7-max', messages: prompt, tools: [{ function: { name: 'run_shell_command' } }] })
  assert.equal(normal.headers['content-type'], 'text/event-stream')
  assert.match(normal.chunks.join(''), /run_shell_command/)
  const followup = await invoke(handler, { model: 'qwen3.7-max', messages: [...prompt, { role: 'tool', content: 'done' }], tools: [{ function: { name: 'run_shell_command' } }] })
  assert.match(followup.chunks.join(''), /B5_OK_/)
  await assert.rejects(invoke(handler, { model: 'qwen3.7-max', messages: [{ role: 'user', content: 'B5 TOOL Conversation so far:' }] }), /Qwen omitted run_shell_command/)
  await assert.rejects(invoke(handler, { model: 'qwen3.7-max', messages: [{ role: 'user', content: 'B5 REJECT' }] }), /Qwen omitted run_shell_command/)
  await assert.rejects(invoke(handler, { model: 'qwen3.7-max', messages: [{ role: 'user', content: 'B5 LATE' }] }), /Qwen omitted run_shell_command/)
  assert.equal(stub.effects().world, null)
  await stub.close()
})

test('request observer honors selected fd22 while fd2 is poisoned', () => {
  const directory = mkdtempSync(join(tmpdir(), 'b5-fd22-'))
  try {
    const script = join(directory, 'observe.mjs')
    writeFileSync(script, `import { createB5RequestObserver } from ${JSON.stringify(new URL('./b5-fixed-stubs.mjs', import.meta.url).href)};\nprocess.stderr.write('FD2_POISON'); createB5RequestObserver()({messages:[{role:'user',content:'B5 TOOL'}]},1);\n`, { mode: 0o600 })
    const stdio = Array.from({ length: 23 }, (_, index) => index === 1 || index === 2 || index === 22 ? 'pipe' : 'ignore')
    const result = spawnSync(process.execPath, [script, '--diagnostic-fd', '22'], { stdio, timeout: 5_000 })
    assert.equal(result.status, 0, String(result.error))
    assert.equal(result.output[2].toString(), 'FD2_POISON')
    assert.match(result.output[22].toString(), /^B5_REQUEST_OBSERVATION /)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

function fakePage({ failure, roots = 0, visible = false, evaluateError, navigation = { status: () => 200 } } = {}) {
  const page = new EventEmitter(); page.calls = []
  page.goto = async (url, options) => { page.calls.push(['goto', url, options]); if (failure === 'goto') throw page.primary; return navigation }
  page.locator = selector => { page.calls.push(['locator', selector]); return {
    waitFor: async options => { page.calls.push(['waitFor', options]); if (failure === 'wait') throw page.primary },
    nth: index => ({ isVisible: async () => { page.calls.push(['isVisible', index]); return visible } }),
  } }
  page.evaluate = async (_fn, selectors) => { page.calls.push(['evaluate', selectors]); if (evaluateError) throw evaluateError
    return { readyState: 'complete', pathname: 'http://user:secret@127.0.0.1:1234/?token=secret', roots, rootError: false } }
  page.primary = new Error('ORIGINAL_TIMEOUT_PRIVATE')
  return page
}
const uiRecord = line => JSON.parse(line.slice('B5_UI_FAILURE '.length))
test('UI success preserves original goto/load and root-visible wait without diagnostic', async () => {
  const page = fakePage(); const lines = []
  await waitForB5UiRoot(page, 'http://127.0.0.1:1234/', 'create', (_fd, line) => lines.push(line))
  assert.deepEqual(page.calls, [['goto', 'http://127.0.0.1:1234/', { waitUntil: 'load', timeout: 30_000 }],
    ['locator', '[data-slot="root"]'], ['waitFor', { timeout: 20_000 }]])
  assert.equal(lines.length, 0)
  assert.equal(page.listenerCount('response') + page.listenerCount('pageerror') + page.listenerCount('requestfailed'), 0)
})
test('UI failure captures bounded passive metadata, root state, and rethrows identical primary', async () => {
  const page = fakePage({ failure: 'wait', roots: 17, visible: false }); const lines = []
  page.goto = async (url, options) => {
    page.calls.push(['goto', url, options])
    page.emit('response', { request: () => ({ resourceType: () => 'document' }), url: () => 'http://127.0.0.1:1234/?credential=POISON', status: () => 200 })
    page.emit('response', { request: () => ({ resourceType: () => 'script' }), url: () => 'http://127.0.0.1:1234/assets/app.js?token=POISON', status: () => 404 })
    page.emit('pageerror', Object.assign(new Error('TOKEN POISON'), { name: 'TypeError' }))
    page.emit('requestfailed', { resourceType: () => 'script', url: () => 'http://127.0.0.1:1234/assets/app.js?token=POISON', failure: () => ({ errorText: 'ERR_CONNECTION_REFUSED POISON' }) })
    return { status: () => 200 }
  }
  await assert.rejects(waitForB5UiRoot(page, 'http://127.0.0.1:1234/', 'create', (fd, line) => { assert.equal(fd, 2); lines.push(line) }), error => error === page.primary)
  assert.equal(lines.length, 1); assert.ok(Buffer.byteLength(lines[0]) <= 8192)
  const record = uiRecord(lines[0]); assert.equal(record.navigation_status, 200)
  assert.equal(record.navigation.length, 1); assert.equal(record.assets[0].status, 404)
  assert.equal(record.page_errors[0].classification, 'type')
  assert.equal(record.request_failures[0].failure, 'connection')
  assert.equal(record.snapshot.root_attached_count, 16); assert.equal(record.snapshot.roots_truncated, true)
  assert.equal(record.snapshot.root_visible, false)
  assert.doesNotMatch(lines[0], /POISON|credential|token=|ORIGINAL_TIMEOUT_PRIVATE/)
  assert.equal(page.listenerCount('response') + page.listenerCount('pageerror') + page.listenerCount('requestfailed'), 0)
  assert.equal(page.calls.filter(call => call[0] === 'goto').length, 1)
})
test('UI missing root and closed page keep unavailable fields and the original error', async () => {
  for (const spec of [{ roots: 0 }, { roots: 0, evaluateError: new Error('SECRET') }]) {
    const page = fakePage({ ...spec, failure: 'goto' }); const lines = []
    await assert.rejects(waitForB5UiRoot(page, 'http://127.0.0.1:1234/', 'resume', (_fd, line) => lines.push(line)), error => error === page.primary)
    assert.equal(lines.length, 1)
    const record = uiRecord(lines[0]); assert.equal(record.navigation_status, null)
    if (spec.evaluateError) assert.equal(record.snapshot.unavailable, true)
    else { assert.equal(record.snapshot.root_attached_count, 0); assert.equal(record.snapshot.root_visible, false) }
  }
})
test('UI diagnostic sink failure and cleanup failure cannot replace the original cause', async () => {
  const page = fakePage({ failure: 'wait' })
  await assert.rejects(waitForB5UiRoot(page, 'http://127.0.0.1:1234/', 'create', () => { throw new Error('SINK_SECRET') }), error => error === page.primary)
  assert.equal(page.listenerCount('response'), 0)
  const cleanup = new Error('CLEANUP')
  await assert.rejects(closeBrowserContext({ close: async () => { throw cleanup } }, true, page.primary), error => error instanceof AggregateError && error.errors[0] === page.primary && error.errors[1] === cleanup)
  await assert.rejects(closeBrowserContext({ close: async () => { throw cleanup } }, false), error => error === cleanup)
})
test('UI snapshot timeout, event flood and malformed events remain bounded', async () => {
  const page = fakePage({ failure: 'wait' }); const lines = []
  page.evaluate = async () => await new Promise(() => {})
  page.goto = async () => {
    for (let index = 0; index < 60; index += 1) {
      page.emit('response', { request: () => ({ resourceType: () => 'script' }), url: () => `http://127.0.0.1:1234/assets/${index}.js?secret=POISON`, status: () => 200 })
      page.emit('pageerror', Object.assign(new Error('TOKEN POISON'), { name: 'SyntaxError' }))
      page.emit('requestfailed', { resourceType: () => 'script', url: () => 'http://127.0.0.1:1234/assets/app.js?secret=POISON', failure: () => ({ errorText: 'ERR_ABORTED POISON' }) })
      page.emit('response', { request: () => { throw new Error('POISON') } })
    }
    return { status: () => 200 }
  }
  await assert.rejects(waitForB5UiRoot(page, 'http://127.0.0.1:1234/', 'resume', (_fd, line) => lines.push(line)), error => error === page.primary)
  assert.equal(lines.length, 1); assert.ok(Buffer.byteLength(lines[0]) <= 8192)
  const record = uiRecord(lines[0]); assert.equal(record.snapshot.observation_timeout, true)
  assert.equal(record.retained_counts.assets, 16); assert.equal(record.retained_counts.page_errors, 8); assert.equal(record.retained_counts.request_failures, 16)
  assert.equal(record.dropped.assets, 44); assert.equal(record.dropped.page_errors, 52); assert.equal(record.dropped.request_failures, 44)
  assert.equal(record.observation_failed, true)
  assert.doesNotMatch(lines[0], /POISON|secret=/)
  assert.equal(page.listenerCount('response') + page.listenerCount('pageerror') + page.listenerCount('requestfailed'), 0)
})
