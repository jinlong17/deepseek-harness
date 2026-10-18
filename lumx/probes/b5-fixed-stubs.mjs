import { existsSync, readFileSync } from 'node:fs'

import { body, listen } from './b5-hook-common.mjs'

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
    const payload = await body(request); requests.push({ method: request.method, path: request.url, payload })
    const prompt = JSON.stringify(payload.messages); const text = `LUMX synthetic response: ${prompt.slice(-256)}`
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ text }))
  })
  return Object.freeze({ endpoint: `http://127.0.0.1:${server.port}/model`, requests, close: server.close })
}
export async function h1Stubs(nativeCanaryPath) {
  const wire = { broker: [], model: [] }; let brokerOrdinal = 0; let nativeOrdinal = 0; let retryOrdinal = 0
  const model = await listen(async (request, response) => {
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
  const broker = await listen(async (request, response) => {
    const payload = await body(request); wire.broker.push({ method: request.method, path: request.url, payload, responseStatus: 403 })
    response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'controlled Broker refusal' }))
  })
  return Object.freeze({ brokerEndpoint: `http://127.0.0.1:${broker.port}/broker`, modelEndpoint: `http://127.0.0.1:${model.port}/model`, wire,
    close: async () => { const settled = await Promise.allSettled([model.close(), broker.close()]); const failures = settled.filter(x => x.status === 'rejected').map(x => x.reason); if (failures.length) throw new AggregateError(failures) } })
}
export async function qwenStub(config, barriers) {
  const requests = []; let ordinal = 0; let cancelCloses = 0
  const server = await listen(async (request, response) => {
    const payload = await body(request); requests.push({ method: request.method, path: request.url, payload }); ordinal += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const messages = JSON.stringify(payload.messages)
    if (messages.includes('B5 STREAM')) {
      const base = { id: 'g9-b5-stream', object: 'chat.completion.chunk', created: 0, model: payload.model }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'FIRST' }, finish_reason: null }] })}\n\n`)
      barriers.streamFirst.resolve(); await barriers.streamRelease.promise; return finish(response, payload, '_FINAL')
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
