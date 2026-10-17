import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { installGovernedH1SessionPolicy } from './governed-session-policy.mjs'

const RUNTIMES = new Map()

function loopbackEndpoint(value, label) {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username !== '' || endpoint.password !== '' || endpoint.port === '') {
    throw new Error(`${label} must use literal IPv4 loopback HTTP with an explicit port and no userinfo`)
  }
  return endpoint
}

function snapshotSchemas(tools) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  }))
}

async function postJson(endpoint, body, signal) {
  const encoded = JSON.stringify(body)
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error('governed H1 request exceeds local loopback bound')
  const response = await fetch(endpoint, {
    body: encoded,
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal,
  })
  return response
}

/** Install credential-free loopback ports for one product governed-H1 composition. */
export function installGovernedH1Runtime(input) {
  if (RUNTIMES.has(input.runtimeId)) throw new Error(`governed H1 runtime already installed: ${input.runtimeId}`)
  const state = {
    brokerEndpoint: loopbackEndpoint(input.brokerEndpoint, 'H1 Broker endpoint'),
    brokerInvocations: [],
    modelEndpoint: loopbackEndpoint(input.modelEndpoint, 'H1 model endpoint'),
    modelRequests: [],
  }
  RUNTIMES.set(input.runtimeId, state)
  return Object.freeze({
    assertAgent(agent) { state.sessionPolicy?.assertAgent(agent) },
    release() { state.sessionPolicy?.dispose(); RUNTIMES.delete(input.runtimeId) },
    snapshot() {
      return structuredClone({ brokerInvocations: state.brokerInvocations, modelRequests: state.modelRequests })
    },
  })
}

export const name = 'lumx-governed-h1-adapter'
export const inject = ['llm', 'tools']

/** Register the only product H1 model route and the only model-visible capability tool. */
export async function apply(ctx, config) {
  const state = RUNTIMES.get(config.runtimeId)
  if (state === undefined) throw new Error('governed H1 runtime state is unavailable')
  const llm = await import(pathToFileURL(join(config.sourceRoot, 'packages/llm/llm/lib/index.js')).href)

  class GovernedH1Adapter extends llm.LlmAdapter {
    retryPolicy = llm.resolveRetryPolicy({
      mode: 'normal', maxRetries: 1, retryableCodes: ['SERVER'],
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'LUMX governed H1 retry policy')
    providerInfo(provider) { return { id: provider, name: 'LUMX governed H1 model' } }
    providerRetryPolicy() { return this.retryPolicy }
    listModels(provider) {
      return Promise.resolve([{ provider, id: 'h1-controlled', name: 'H1 controlled', inputModalities: ['text'] }])
    }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: 'H1 controlled', inputModalities: ['text'] })
    }
    async * stream(options) {
      const request = {
        model: options.model, ordinal: state.modelRequests.length + 1, provider: options.provider,
        tools: snapshotSchemas(options.tools ?? []),
      }
      state.modelRequests.push(request)
      const response = await postJson(state.modelEndpoint, {
        messages: options.messages, model: options.model, provider: options.provider, tools: request.tools,
      }, options.signal)
      if (!response.ok) {
        throw new llm.LlmError(`LUMX governed H1 model rejected the request (${String(response.status)})`,
          response.status >= 500 ? 'SERVER' : 'UNKNOWN')
      }
      const reply = await response.json()
      if (reply?.type === 'tool-call' && typeof reply.id === 'string'
        && typeof reply.name === 'string' && reply.arguments !== null && typeof reply.arguments === 'object') {
        const callId = llm.ToolCallId(reply.id); const argumentsJson = JSON.stringify(reply.arguments)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: reply.name, argumentsDelta: argumentsJson }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: reply.name, arguments: argumentsJson } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (reply?.type !== 'text' || typeof reply.text !== 'string' || reply.text.length === 0) {
        throw new Error('LUMX governed H1 model returned an invalid response')
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  ctx.llm.registerAdapter(['lumx-h1'], new GovernedH1Adapter())
  ctx.tools.register({
    name: 'lumx_broker',
    description: 'Submit one governed capability request to the LUMX Broker.',
    parameters: { action: { type: 'string', required: true, enum: ['physical-network'], description: 'Governed capability request.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) {
      const invocation = { action: args.action, ordinal: state.brokerInvocations.length + 1 }
      state.brokerInvocations.push(invocation)
      const response = await postJson(state.brokerEndpoint, { action: args.action }, execution.signal)
      const responseBody = await response.text()
      if (Buffer.byteLength(responseBody) > 64 * 1024) throw new Error('governed Broker response exceeds local loopback bound')
      invocation.responseStatus = response.status
      if (!response.ok) throw new Error(`LUMX Broker refused governed capability (${String(response.status)}): ${responseBody}`)
      return responseBody
    },
  })
  // Adapter registration is a profile entry, so this runs before boot releases
  // any configured root/child/resume path to its first request.
  state.sessionPolicy = installGovernedH1SessionPolicy(ctx)
}
