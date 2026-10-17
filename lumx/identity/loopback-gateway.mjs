/**
 * Creates the only HTTP gateway used by this boundary's tests and local harness.
 * It intentionally accepts loopback endpoints only; no real identity provider is wired.
 *
 * @param {{ endpoint: string, fetchImpl?: typeof fetch }} input
 * @returns {{ validate(input: { audience: string, credential: string, subject: string }): Promise<{ active: boolean, expiresAt: string, subject: string }> }}
 */
export function createLoopbackIdentityGateway(input) {
  const endpoint = new URL(input.endpoint)
  if (!['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('LUMX local identity gateway must use a loopback host')
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('LUMX local identity gateway requires fetch')

  return {
    async validate(identity) {
      const response = await fetchImpl(endpoint, {
        body: JSON.stringify(identity),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) throw new Error('LUMX local identity gateway rejected the request')
      return response.json()
    },
  }
}
