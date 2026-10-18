import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createExternalEngineRouter, createExternalQwenFactory } from '../agent/external-agent-factory.mjs'
import { createExternalSessionEligibilityStore } from '../agent/external-session-eligibility.mjs'

const PROVIDER = 'external-qwen'

/** Install the product-owned external-Qwen factory and official ACP consumer. */
export async function installExternalQwenComposition(ctx, input) {
  const moduleUrl = path => pathToFileURL(join(input.sourceRoot, path)).href
  const llm = await import(moduleUrl('packages/llm/llm/lib/index.js'))
  const acp = await import(moduleUrl('packages/acp/acp/lib/index.js'))
  const agentLoop = await import(moduleUrl('packages/core/agent-loop/lib/index.js'))
  const sdk = await import(moduleUrl('apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'))
  const router = createExternalEngineRouter()
  if (resolve(ctx.sessionPersistence.config?.root ?? '') !== resolve(input.persistenceRoot)) throw new Error('external Qwen persistence root differs from frozen product configuration')
  const eligibility = createExternalSessionEligibilityStore({ eligibilityRoot: input.eligibilityRoot, mode: input.mode,
    persistenceRoot: input.persistenceRoot, persistenceScope: input.persistenceRoot })
  ctx.sessionProjections.register(agentLoop.turnBoundaryProjectionDefinition)
  ctx.sessionProjections.register(agentLoop.inboxProjectionDefinition)
  class CatalogOnlyAdapter extends llm.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'External Qwen' } }
    listModels(provider) { return Promise.resolve([{ provider, id: input.model, name: 'External Qwen', inputModalities: ['text'] }]) }
    resolveModel(provider, model) {
      if (provider !== PROVIDER || model !== input.model) return Promise.reject(new Error('external Qwen model route is fixed'))
      return Promise.resolve({ provider, id: model, name: 'External Qwen', inputModalities: ['text'] })
    }
    async * stream() { throw new Error('external Qwen model stream is available only through the external Agent factory') }
  }
  const releaseCatalog = ctx.llm.registerAdapter([PROVIDER], new CatalogOnlyAdapter())
  const factory = createExternalQwenFactory(ctx, { artifactIdentity: input.artifactIdentity, eligibility, engine: input.engine,
    engineId: input.engineId, model: input.model, provider: PROVIDER, router })
  acp.apply(ctx, { provider: PROVIDER, model: input.model, stream: sdk.ndJsonStream(input.acp.writable, input.acp.readable) })
  let closed
  const close = () => (closed ??= (async () => { await factory.close(); releaseCatalog() })())
  return Object.freeze({ close, eligibility: eligibility.roots, factory, router })
}
