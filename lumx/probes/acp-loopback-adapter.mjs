import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const endpoint = new URL(process.env.LUMX_ACP_MODEL_ENDPOINT ?? '')
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
  || endpoint.username !== '' || endpoint.password !== '') {
  throw new Error('ACP qualification endpoint must be literal IPv4 loopback HTTP')
}

const sourceRoot = process.env.LUMX_PINNED_SOURCE_ROOT
if (sourceRoot === undefined) throw new Error('missing pinned source root')
const llm = await import(pathToFileURL(join(sourceRoot, 'packages/llm/llm/lib/index.js')).href)

class AcpLoopbackAdapter extends llm.LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'LUMX ACP qualification loopback' } }
  listModels(provider) {
    return Promise.resolve([{ provider, id: 'lumx-loopback', name: 'LUMX Loopback', inputModalities: ['text'] }])
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: 'LUMX Loopback', inputModalities: ['text'] })
  }
  async * stream(options) {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ messages: options.messages, model: options.model }),
      headers: { 'content-type': 'application/json' }, method: 'POST', redirect: 'error', signal: options.signal,
    })
    if (!response.ok) throw new Error(`ACP loopback model rejected request (${String(response.status)})`)
    const value = await response.json()
    if (typeof value?.text !== 'string' || value.text.length === 0) throw new Error('ACP loopback model returned no text')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'lumx-acp-loopback'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['lumx-acp-probe'], new AcpLoopbackAdapter())
}
