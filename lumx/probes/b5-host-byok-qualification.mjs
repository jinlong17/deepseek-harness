import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Invoke a fixed alternate adapter once; admission remains owned by product LLM hooks. */
export async function qualifyAlternateByok(runtime, input) {
  if (runtime.consumer !== 'desktop-byok') throw new Error('alternate BYOK qualification requires desktop-byok Host')
  const llm = await import(pathToFileURL(join(input.sourceRoot, 'packages/llm/llm/lib/index.js')).href)
  let adapterCalls = 0
  class QualificationAdapter extends llm.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Gate1 qualification alternate adapter' } }
    listModels(provider) { return Promise.resolve([{ provider, id: 'alternate', name: 'Alternate' }]) }
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: 'Alternate' }) }
    async * stream() { adapterCalls += 1; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  const release = runtime.ctx.llm.registerAdapter(['lumx-gate1-alternate'], new QualificationAdapter())
  const chunks = []; let failure
  try {
    try { for await (const chunk of runtime.ctx.llm.stream({ provider: 'lumx-gate1-alternate', model: 'alternate', messages: [] })) chunks.push(chunk) }
    catch (error) { failure = { code: error?.code, message: error instanceof Error ? error.message : String(error), name: error?.name ?? 'Error' } }
    return Object.freeze({ adapterCalls, chunks, failure })
  } finally { release() }
}
