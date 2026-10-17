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

function loopbackEndpoint(value, label) {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username !== '' || endpoint.password !== '' || endpoint.port === '') {
    throw new Error(`${label} must use literal IPv4 loopback HTTP with an explicit port and no userinfo`)
  }
  return endpoint
}

async function postJson(endpoint, body, signal) {
  return fetch(endpoint, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal,
  })
}

/** Install the controlled model and Broker observations for one H1 run. */
export function installH1DriverRuntime(input) {
  if (RUNTIMES.has(input.runtimeId)) throw new Error(`H1 driver runtime already installed: ${input.runtimeId}`)
  const state = {
    brokerInvocations: [],
    brokerEndpoint: loopbackEndpoint(input.brokerEndpoint, 'H1 Broker endpoint'),
    modelEndpoint: loopbackEndpoint(input.modelEndpoint, 'H1 model endpoint'),
    modelRequests: [],
  }
  RUNTIMES.set(input.runtimeId, state)
  return Object.freeze({
    release() { RUNTIMES.delete(input.runtimeId) },
    snapshot() {
      return structuredClone({
        brokerInvocations: state.brokerInvocations,
        modelRequests: state.modelRequests,
      })
    },
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
    retryPolicy = llm.resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: ['SERVER'],
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'LUMX H1 controlled retry policy')
    providerInfo(provider) { return { id: provider, name: 'LUMX H1 controlled model' } }
    providerRetryPolicy() { return this.retryPolicy }
    listModels(provider) {
      return Promise.resolve([{ provider, id: 'h1-controlled', name: 'H1 controlled', inputModalities: ['text'] }])
    }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: 'H1 controlled', inputModalities: ['text'] })
    }
    async * stream(options) {
      const ordinal = state.modelRequests.length + 1
      const request = {
        ordinal,
        provider: options.provider,
        model: options.model,
        tools: snapshotSchemas(options.tools ?? []),
      }
      state.modelRequests.push(request)
      const response = await postJson(state.modelEndpoint, {
        messages: options.messages,
        model: options.model,
        provider: options.provider,
        tools: request.tools,
      }, options.signal)
      if (!response.ok) {
        throw new llm.LlmError(
          `LUMX H1 loopback model gateway rejected the request (${String(response.status)})`,
          response.status >= 500 ? 'SERVER' : 'UNKNOWN',
        )
      }
      const reply = await response.json()
      if (reply?.type === 'tool-call' && typeof reply.id === 'string'
        && typeof reply.name === 'string' && reply.arguments !== null
        && typeof reply.arguments === 'object') {
        const callId = llm.ToolCallId(reply.id)
        const argumentsJson = JSON.stringify(reply.arguments)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: reply.name, argumentsDelta: argumentsJson }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: callId, name: reply.name, arguments: argumentsJson },
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (reply?.type !== 'text' || typeof reply.text !== 'string' || reply.text.length === 0) {
        throw new Error('LUMX H1 loopback model gateway returned an invalid response')
      }
      const text = reply.text
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
      const invocation = { action: args.action, ordinal: state.brokerInvocations.length + 1 }
      state.brokerInvocations.push(invocation)
      const response = await postJson(state.brokerEndpoint, { action: args.action })
      const responseBody = await response.text()
      invocation.responseStatus = response.status
      if (!response.ok) {
        throw new Error(`LUMX Broker refused governed capability (${String(response.status)}): ${responseBody}`)
      }
      return responseBody
    },
  })
}
