import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { admitLumxByok } from '../identity/byok-admission.mjs'

const RUNTIMES = new Map()

function loopbackEndpoint(value) {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('LUMX model endpoint must use literal IPv4 loopback HTTP without userinfo')
  }
  return endpoint
}

/**
 * Install memory-only identity and BYOK state for one runProfile composition.
 *
 * @param {{ runtimeId: string, byokKey: string, endpoint: string, gateway: object, getIdentity(): object | undefined, now?(): Date }} input
 */
export function installLumxByokRuntime(input) {
  if (RUNTIMES.has(input.runtimeId)) throw new Error(`LUMX runtime already installed: ${input.runtimeId}`)
  const state = Object.freeze({ ...input, endpoint: loopbackEndpoint(input.endpoint) })
  RUNTIMES.set(input.runtimeId, state)
  return () => { RUNTIMES.delete(input.runtimeId) }
}

async function modelReply(state, options) {
  await admitLumxByok({
    byokKey: state.byokKey,
    gateway: state.gateway,
    identity: state.getIdentity(),
    now: state.now?.(),
  })
  const response = await fetch(state.endpoint, {
    body: JSON.stringify({ messages: options.messages, model: options.model }),
    headers: { authorization: `Bearer ${state.byokKey}`, 'content-type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal: options.signal,
  })
  if (!response.ok) throw new Error(`LUMX loopback model rejected the request (${String(response.status)})`)
  const value = await response.json()
  if (value === null || typeof value !== 'object' || typeof value.text !== 'string' || value.text.length === 0) {
    throw new Error('LUMX loopback model returned no text')
  }
  return value.text
}

export const name = 'lumx-byok'
export const inject = ['llm']

/** Register a BYOK-gated loopback adapter on the real LLM runtime. */
export async function apply(ctx, config) {
  const state = RUNTIMES.get(config.runtimeId)
  if (state === undefined) throw new Error('LUMX BYOK runtime state is unavailable')
  const llmModule = await import(pathToFileURL(join(config.sourceRoot, 'packages/llm/llm/lib/index.js')).href)
  class LumxLoopbackAdapter extends llmModule.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'LUMX BYOK' } }
    listModels(provider) {
      return Promise.resolve([{ provider, id: 'lumx-loopback', name: 'LUMX Loopback', inputModalities: ['text'] }])
    }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: 'LUMX Loopback', inputModalities: ['text'] })
    }
    async * stream(options) {
      const text = await modelReply(state, options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['lumx-byok'], new LumxLoopbackAdapter())
}
