import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { admitLumxByok, LumxByokAdmissionError } from '../../identity/byok-admission.mjs'

const MAX_BODY_BYTES = 1024 * 1024
const FORWARD_TIMEOUT_MS = 30_000

function loopbackEndpoint(value, name) {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
    throw new Error(`${name} must use literal IPv4 loopback HTTP without userinfo or fragment`)
  }
  return endpoint
}

function equalSecret(actual, expected) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('relay request body exceeds the fixed limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

/**
 * Product-owned, launch-scoped OpenAI-compatible model relay. Identity is
 * revalidated for every operation and every HTTP forwarding attempt.
 * @param {{ engineId: string, gateway: object, getIdentity(): object | undefined, launchId: string, model: string, providerEndpoint: string, providerKey: string, sessionId: string }} options
 */
export async function createAcpModelRelay(options) {
  const providerEndpoint = loopbackEndpoint(options.providerEndpoint, 'provider endpoint')
  if (providerEndpoint.pathname !== '/v1/chat/completions' || providerEndpoint.search !== '') throw new Error('provider endpoint must be the fixed /v1/chat/completions route')
  for (const name of ['engineId', 'launchId', 'model', 'providerKey', 'sessionId']) {
    if (typeof options[name] !== 'string' || options[name].length === 0) throw new Error(`${name} must be a non-empty string`)
  }
  if (typeof options.getIdentity !== 'function') throw new Error('getIdentity must be a function')

  const capability = `lumx-relay-${randomBytes(32).toString('base64url')}`
  const lifecycle = { accepting: true }
  const active = new Set()
  const stats = { admittedOperations: 0, deniedOperations: 0, forwarded: 0, providerResponses: 0 }

  const admit = async (operation) => {
    if (!lifecycle.accepting) throw new Error('LUMX ACP relay is disposed')
    if (!['create', 'resume', 'prompt', 'forward'].includes(operation)) throw new Error('unsupported ACP relay operation')
    const identity = options.getIdentity()
    let result
    try {
      result = await admitLumxByok({ byokKey: options.providerKey, gateway: options.gateway, identity })
    } catch (error) {
      stats.deniedOperations += 1
      if (error instanceof LumxByokAdmissionError) throw error
      throw new LumxByokAdmissionError('identity_rejected')
    }
    if (!lifecycle.accepting) throw new Error('LUMX ACP relay is disposed')
    const current = options.getIdentity()
    if (current === undefined || identity === undefined
      || current.type !== identity.type || current.subject !== identity.subject
      || current.credential !== identity.credential || current.expiresAt !== identity.expiresAt
      || Date.parse(current.expiresAt) <= Date.now()) {
      stats.deniedOperations += 1
      throw new LumxByokAdmissionError('identity_rejected')
    }
    stats.admittedOperations += 1
    return { operation, subject: result.subject }
  }

  const server = createServer(async (request, response) => {
    try {
      if (!lifecycle.accepting) return json(response, 503, { error: { code: 'relay_disposed' } })
      const authorization = request.headers.authorization ?? ''
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!equalSecret(presented, capability)) return json(response, 401, { error: { code: 'relay_capability_rejected' } })
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: { code: 'relay_route_rejected' } })
      const body = await readBody(request)
      const payload = JSON.parse(body.toString('utf8'))
      if (payload === null || typeof payload !== 'object' || payload.model !== options.model) return json(response, 400, { error: { code: 'relay_model_rejected' } })
      await admit('forward')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('provider forward timed out')), FORWARD_TIMEOUT_MS)
      const abortForward = () => controller.abort(new Error('relay client disconnected'))
      request.once('aborted', abortForward)
      response.once('close', () => { if (!response.writableEnded) abortForward() })
      active.add(controller)
      stats.forwarded += 1
      try {
        const upstream = await fetch(providerEndpoint, {
          body,
          headers: { authorization: `Bearer ${options.providerKey}`, 'content-type': 'application/json' },
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
        })
        stats.providerResponses += 1
        const responseBody = Buffer.from(await upstream.arrayBuffer())
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
        response.end(responseBody)
      } finally {
        clearTimeout(timer)
        request.off('aborted', abortForward)
        active.delete(controller)
      }
    } catch (error) {
      const code = error instanceof LumxByokAdmissionError ? error.code : 'relay_failure'
      if (!response.headersSent) json(response, error instanceof LumxByokAdmissionError ? 403 : 502, { error: { code } })
      else response.destroy()
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('relay did not bind a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}/v1`

  let disposal
  const dispose = () => (disposal ??= (async () => {
    lifecycle.accepting = false
    for (const controller of active) controller.abort(new Error('relay disposed'))
    server.closeAllConnections?.()
    await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  })())

  return Object.freeze({
    admit,
    capability,
    dispose,
    endpoint,
    identity: Object.freeze({ engineId: options.engineId, launchId: options.launchId, sessionId: options.sessionId }),
    stats,
  })
}
