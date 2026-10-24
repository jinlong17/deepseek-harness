import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeSync } from 'node:fs'

import { body, listen } from './b5-hook-common.mjs'

const REQUEST_OBSERVER_LIMIT = 128
const REQUEST_OBSERVER_BYTES = 64 * 1024
const OBSERVED_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer'])
const sha = value => createHash('sha256').update(value).digest('hex')
function diagnosticFd() {
  let selected
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--diagnostic-fd') selected = process.argv[index + 1]
  }
  if (selected === undefined) return 2
  if (selected !== '22') throw new Error('adversarial diagnostic FD is invalid')
  return 22
}
function canonical(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 20_000 || depth > 48) throw new Error('request observer traversal bound')
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (typeof value !== 'object') throw new Error('request observer non-JSON value')
  const proto = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (proto !== Array.prototype || value.length > 20_000) throw new Error('request observer array bound')
    return Array.from({ length: value.length }, (_, index) => {
      const entry = Object.getOwnPropertyDescriptor(value, String(index))
      if (!entry || !Object.hasOwn(entry, 'value')) throw new Error('request observer array accessor')
      return canonical(entry.value, depth + 1, budget)
    })
  }
  if (proto !== Object.prototype && proto !== null) throw new Error('request observer non-JSON object')
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) throw new Error('request observer symbol key')
  const result = Object.create(null)
  for (const key of keys.sort()) {
    const entry = Object.getOwnPropertyDescriptor(value, key)
    if (!entry || !Object.hasOwn(entry, 'value')) throw new Error('request observer object accessor')
    result[key] = canonical(entry.value, depth + 1, budget)
  }
  return result
}
function requestObservation(payload, ordinal) {
  const normalized = JSON.stringify(canonical(payload))
  if (Buffer.byteLength(normalized) > 4 * 1024 * 1024) throw new Error('request observer payload bound')
  const safe = JSON.parse(normalized)
  const messages = Array.isArray(safe.messages) ? safe.messages : []
  const serialized = JSON.stringify(messages)
  if (serialized.includes('B5 STREAM') || serialized.includes('B5 CANCEL')) return undefined
  const markers = ['B5 TOOL', 'B5 REJECT', 'B5 LATE'].filter(marker => serialized.includes(marker))
  if (markers.length === 0) return undefined
  const roles = messages.slice(0, 32).map(message => OBSERVED_ROLES.has(message?.role) ? message.role : 'unknown')
  const last = messages.at(-1)
  const finalUser = last?.role === 'user' ? last : null
  const content = finalUser?.content
  const finalContentShape = finalUser === null ? 'not-user' : typeof content === 'string' ? 'string'
    : Array.isArray(content) ? 'array' : content === null ? 'null' : content === undefined ? 'absent' : 'other'
  let currentText = typeof content === 'string' ? content : null
  let currentTextState = currentText === null ? 'unknown' : 'string'
  if (Array.isArray(content)) {
    const textParts = content.every(part => part !== null && typeof part === 'object'
      && part.type === 'text' && typeof part.text === 'string')
    currentTextState = textParts ? 'text-parts' : 'mixed-or-malformed-parts'
    if (textParts) currentText = content.map(part => part.text).join('')
  }
  const currentMarkers = currentText === null ? null : ['B5 TOOL', 'B5 REJECT', 'B5 LATE'].filter(marker => currentText.includes(marker))
  const history = JSON.stringify(messages.slice(0, -1))
  const historyMarkers = ['B5 TOOL', 'B5 REJECT', 'B5 LATE'].filter(marker => history.includes(marker))
  const streamState = !Object.hasOwn(safe, 'stream') ? 'absent' : safe.stream === true ? 'true' : safe.stream === false ? 'false' : 'other'
  // This source-decoded static literal is a diagnostic equality only, never an admission rule.
  const suggestionPromptSha = '53e6d97a6587792612a74b051b81e7b5a2236496e8da25aafe6c7cf75086d8e2'
  const sourcePatterns = currentText === null ? null : sha(currentText) === suggestionPromptSha ? ['prompt-suggestion-pattern'] : []
  const tools = safe.tools
  const toolsState = !Object.hasOwn(safe, 'tools') ? 'absent' : tools === null ? 'null' : Array.isArray(tools) ? 'array' : 'other'
  const signatures = []
  if (serialized.includes('First, reason in your <analysis> block. Then, produce the <state_snapshot> XML.')) signatures.push('chat-compression')
  if (serialized.includes('Analyze *only* the content and structure of your immediately preceding response')) signatures.push('next-speaker')
  if (serialized.includes('Generate a concise, sentence-case title (3-7 words)') && serialized.includes('Conversation so far:')) signatures.push('session-title')
  return { schema: 'g9-b5-request-observation/v1', ordinal, markers, canonical_parsed_payload_sha256: sha(normalized),
    message_count: messages.length, roles, roles_truncated: messages.length > roles.length, signatures: signatures.length ? signatures : ['unknown'],
    final_role: last === undefined ? 'absent' : OBSERVED_ROLES.has(last?.role) ? last.role : 'unknown',
    final_user_content_shape: finalContentShape, current_text_state: currentTextState,
    current_final_user_markers: currentMarkers, history_markers: historyMarkers,
    source_pattern_matches: sourcePatterns, stream_state: streamState,
    tools_state: toolsState, tools_count: Array.isArray(tools) ? tools.length : null,
    shell_present: Array.isArray(tools) && tools.some(item => item?.function?.name === 'run_shell_command') }
}
export function createB5RequestObserver(writer = (fd, line) => writeSync(fd, line)) {
  let records = 0; let bytes = 0
  return (payload, ordinal) => {
    const row = requestObservation(payload, ordinal)
    if (row === undefined) return
    if (records >= REQUEST_OBSERVER_LIMIT) throw new Error('request observer record bound')
    const line = `B5_REQUEST_OBSERVATION ${JSON.stringify(row)}\n`
    const size = Buffer.byteLength(line)
    if (size > 2048 || bytes + size > REQUEST_OBSERVER_BYTES) throw new Error('request observer output bound')
    writer(diagnosticFd(), line)
    records += 1; bytes += size
  }
}

function finish(response, payload, text) {
  const base = { id: 'g9-b5', object: 'chat.completion.chunk', created: 0, model: payload.model }
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  response.end('data: [DONE]\n\n')
}
function tool(response, payload, id, command) {
  const selected = payload.tools?.find(value => value.function?.name === 'run_shell_command')
  if (selected === undefined) throw new Error('Qwen omitted run_shell_command')
  const base = { id, object: 'chat.completion.chunk', created: 0, model: payload.model }
  const args = JSON.stringify({ command, description: 'synthetic Gate1 qualification effect' })
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: selected.function.name, arguments: args } }] }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  response.end('data: [DONE]\n\n')
}
export async function desktopStub() {
  const requests = []
  const server = await listen(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(request.method === 'POST' ? 404 : 405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'fixed desktop provider route requires POST /v1/chat/completions' }))
      return
    }
    const payload = await body(request); requests.push({ method: request.method, path: request.url, payload })
    const prompt = JSON.stringify(payload.messages); const text = `LUMX synthetic response: ${prompt.slice(-256)}`
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ text }))
  })
  return Object.freeze({ endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`, requests, close: server.close })
}
export async function h1Stubs(nativeCanaryPath, listenFn = listen) {
  const wire = { broker: [], model: [] }; let brokerOrdinal = 0; let nativeOrdinal = 0; let retryOrdinal = 0; let model
  try {
    model = await listenFn(async (request, response) => {
      const payload = await body(request); const messages = JSON.stringify(payload.messages)
      const scenario = messages.includes('gateway-refusal') ? 'gateway-refusal' : messages.includes('native-tool-negative') ? 'native-tool-negative'
        : messages.includes('retry-positive') ? 'retry-positive' : 'broker-refusal'
      if (scenario === 'retry-positive') retryOrdinal += 1
      const status = scenario === 'gateway-refusal' ? 403 : scenario === 'retry-positive' && retryOrdinal === 1 ? 503 : 200
      wire.model.push({ method: request.method, path: request.url, payload, responseStatus: status, scenario })
      response.writeHead(status, { 'content-type': 'application/json' })
      if (status !== 200) return response.end(JSON.stringify({ error: `controlled ${scenario}` }))
      if (scenario === 'retry-positive') return response.end(JSON.stringify({ type: 'text', text: 'Retry recovered.' }))
      if (scenario === 'native-tool-negative') {
        nativeOrdinal += 1; return response.end(JSON.stringify(nativeOrdinal === 1 ? { type: 'tool-call', id: 'b5-native', name: 'bash', arguments: { command: `printf changed > ${JSON.stringify(nativeCanaryPath)}`, description: 'synthetic canary' } } : { type: 'text', text: 'Native refusal observed.' }))
      }
      brokerOrdinal += 1; response.end(JSON.stringify(brokerOrdinal === 1 ? { type: 'tool-call', id: 'b5-broker', name: 'lumx_broker', arguments: { action: 'physical-network' } } : { type: 'text', text: 'Broker refusal observed.' }))
    })
    const broker = await listenFn(async (request, response) => {
      const payload = await body(request); wire.broker.push({ method: request.method, path: request.url, payload, responseStatus: 403 })
      response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'controlled Broker refusal' }))
    })
    return Object.freeze({ brokerEndpoint: `http://127.0.0.1:${broker.port}/broker`, modelEndpoint: `http://127.0.0.1:${model.port}/model`, wire,
      close: async () => { const settled = await Promise.allSettled([model.close(), broker.close()]); const failures = settled.filter(x => x.status === 'rejected').map(x => x.reason); if (failures.length) throw new AggregateError(failures) } })
  } catch (primary) {
    if (model === undefined) throw primary
    try { await model.close() } catch (cleanup) { throw new AggregateError([primary, cleanup], 'H1 stub acquisition plus cleanup failed') }
    throw primary
  }
}

export async function qwenStub(config, barriers, listenFn = listen) {
  const requests = []; let ordinal = 0; let cancelCloses = 0
  const observe = createB5RequestObserver()
  const server = await listenFn(async (request, response) => {
    const payload = await body(request); requests.push({ method: request.method, path: request.url, payload }); ordinal += 1
    observe(payload, ordinal)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const messages = JSON.stringify(payload.messages)
    if (messages.includes('B5 STREAM')) {
      barriers.streamActive = true
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        barriers.streamFinished?.resolve()
      }
      let terminalSettled = false
      let resolveTerminal
      const done = () => {
        if (terminalSettled) return
        terminalSettled = true
        response.off('finish', done)
        response.off('close', done)
        response.off('error', done)
        settle()
        resolveTerminal()
      }
      const terminal = new Promise(resolve => { resolveTerminal = resolve })
      response.once('finish', done)
      response.once('close', done)
      response.once('error', done)
      if (response.destroyed || response.writableFinished || response.writableEnded) done()
      try {
        if (!response.destroyed && !response.writableEnded) {
          const base = { id: 'g9-b5-stream', object: 'chat.completion.chunk', created: 0, model: payload.model }
          response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'FIRST' }, finish_reason: null }] })}\n\n`)
        }
        barriers.streamFirst.resolve()
        await barriers.streamRelease.promise
        if (!response.destroyed && !response.writableEnded) finish(response, payload, '_FINAL')
        await terminal
      } finally {
        done()
      }
      return
    }
    if (messages.includes('B5 CANCEL')) { barriers.cancelStarted.resolve(); response.once('close', () => { cancelCloses += 1; barriers.cancelObserved.resolve() }); return }
    const last = payload.messages?.at(-1)
    if (last?.role !== 'tool' && messages.includes('B5 TOOL')) return tool(response, payload, 'b5-world', config.toolCommand)
    if (last?.role !== 'tool' && messages.includes('B5 REJECT')) return tool(response, payload, 'b5-reject', config.rejectCommand)
    if (last?.role !== 'tool' && messages.includes('B5 LATE')) return tool(response, payload, 'b5-late', config.lateCommand)
    finish(response, payload, `B5_OK_${ordinal}`)
  })
  return Object.freeze({ endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions`, requests, close: server.close, cancelCloses: () => cancelCloses,
    effects: () => ({ world: existsSync(config.worldEffect) ? readFileSync(config.worldEffect, 'utf8') : null,
      reject: existsSync(config.rejectEffect), late: existsSync(config.lateEffect) }) })
}
