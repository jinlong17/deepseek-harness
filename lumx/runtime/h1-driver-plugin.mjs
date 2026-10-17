import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIMES = new Map()

/** Lab-only qualification fixture. It is installed solely by h1-driver-runtime.mjs. */

function snapshotSchemas(tools) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  }))
}

/** Install the controlled model and Broker observations for one H1 run. */
export function installH1DriverRuntime(runtimeId) {
  if (RUNTIMES.has(runtimeId)) throw new Error(`H1 driver runtime already installed: ${runtimeId}`)
  const state = {
    brokerInvocations: [],
    modelRequests: [],
  }
  RUNTIMES.set(runtimeId, state)
  return Object.freeze({
    release() { RUNTIMES.delete(runtimeId) },
    snapshot() { return structuredClone(state) },
  })
}

export const name = 'lumx-h1-driver'
export const inject = ['llm', 'tools']

/** Register the only H1 model route and the only model-visible Broker tool. */
export async function apply(ctx, config) {
  const state = RUNTIMES.get(config.runtimeId)
  if (state === undefined) throw new Error('H1 driver runtime state is unavailable')
  const llm = await import(pathToFileURL(join(config.sourceRoot, 'packages/llm/llm/lib/index.js')).href)

  class H1ControlledAdapter extends llm.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'LUMX H1 controlled model' } }
    listModels(provider) {
      return Promise.resolve([{ provider, id: 'h1-controlled', name: 'H1 controlled', inputModalities: ['text'] }])
    }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: 'H1 controlled', inputModalities: ['text'] })
    }
    async * stream(options) {
      const ordinal = state.modelRequests.length + 1
      state.modelRequests.push({
        ordinal,
        provider: options.provider,
        model: options.model,
        tools: snapshotSchemas(options.tools ?? []),
      })
      if (ordinal === 1) {
        const callId = llm.ToolCallId('h1-broker-call-1')
        const argumentsJson = JSON.stringify({ action: 'physical-network' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: 'lumx_broker', argumentsDelta: argumentsJson }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: callId, name: 'lumx_broker', arguments: argumentsJson },
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = 'Broker refusal observed; stop.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  ctx.llm.registerAdapter(['lumx-h1'], new H1ControlledAdapter())
  ctx.tools.register({
    name: 'lumx_broker',
    description: 'Submit one governed capability request to the LUMX Broker.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['physical-network'],
        description: 'Governed capability requested by the controlled model.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      state.brokerInvocations.push({ action: args.action, ordinal: state.brokerInvocations.length + 1 })
      throw new Error(`LUMX Broker refused governed capability: ${args.action}`)
    },
  })
}
