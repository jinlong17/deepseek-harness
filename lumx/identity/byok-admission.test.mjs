import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { admitLumxByok, LumxByokAdmissionError } from './byok-admission.mjs'
import { createLoopbackIdentityGateway } from './loopback-gateway.mjs'

const now = new Date('2026-10-17T12:00:00.000Z')
const future = '2026-10-17T13:00:00.000Z'
const validIdentity = Object.freeze({ credential: 'local-test-token', expiresAt: future, subject: 'user-42', type: 'lumx.local-auth.v1' })
const unusedGateway = { validate: async () => ({ active: true, expiresAt: future, subject: 'user-42' }) }

test('BYOK admission rejects missing, malformed, and anonymous local identity assertions', async () => {
  const cases = [
    [{ byokKey: 'key', gateway: unusedGateway }, 'identity_required'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: { ...validIdentity, subject: 'anonymous' } }, 'identity_required'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: { ...validIdentity, subject: ' AnOnYmOuS ' } }, 'identity_required'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: { ...validIdentity, type: 'lumx.remote-auth.v1' } }, 'identity_required'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: undefined, now }, 'identity_required'],
  ]
  for (const [input, code] of cases) {
    await assert.rejects(admitLumxByok(input), error => error instanceof LumxByokAdmissionError && error.code === code)
  }
})

test('BYOK admission rejects malformed, elapsed, and boundary-time identity expiries before gateway validation', async () => {
  let gatewayCalls = 0
  const gateway = { validate: async () => { gatewayCalls += 1; return { active: true, expiresAt: future, subject: 'user-42' } } }
  const cases = [
    { ...validIdentity, expiresAt: 'not-a-date' },
    { ...validIdentity, expiresAt: now.toISOString() },
    { ...validIdentity, expiresAt: '2026-10-17T11:59:59.999Z' },
  ]
  for (const identity of cases) {
    await assert.rejects(admitLumxByok({ byokKey: 'key', gateway, identity, now }), error => error instanceof LumxByokAdmissionError && error.code === 'identity_expired')
  }
  assert.equal(gatewayCalls, 0)
})

test('BYOK admission binds the local gateway response to the asserted subject and valid gateway expiry', async () => {
  const cases = [
    { active: true, expiresAt: future, subject: 'another-user' },
    { active: true, expiresAt: now.toISOString(), subject: 'user-42' },
    { active: true, expiresAt: 'not-a-date', subject: 'user-42' },
  ]
  for (const verified of cases) {
    await assert.rejects(admitLumxByok({ byokKey: 'key', gateway: { validate: async () => verified }, identity: validIdentity, now }), error => error instanceof LumxByokAdmissionError && error.code === 'identity_rejected')
  }
  await assert.rejects(admitLumxByok({
    byokKey: 'key', gateway: { validate: async () => { throw new Error('local gateway unavailable') } }, identity: validIdentity, now,
  }), error => error instanceof LumxByokAdmissionError && error.code === 'identity_rejected')
})

test('a loopback stub distinguishes valid, revoked, and forged synthetic credentials', async () => {
  const receivedCredentials = []
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/validate')
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      assert.equal(payload.audience, 'com.lumxai.desktop')
      assert.equal(payload.subject, 'user-42')
      receivedCredentials.push(payload.credential)
      if (payload.credential === 'forged-token') {
        response.writeHead(401)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ active: payload.credential === 'local-test-token', expiresAt: future, subject: 'user-42' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.notEqual(typeof address, 'string')
    const gateway = createLoopbackIdentityGateway({ endpoint: `http://127.0.0.1:${address.port}/validate` })
    await assert.doesNotReject(admitLumxByok({ byokKey: 'key', gateway, identity: validIdentity, now }))
    await assert.rejects(admitLumxByok({
      byokKey: 'key', gateway, identity: { ...validIdentity, credential: 'revoked-token' }, now,
    }), error => error instanceof LumxByokAdmissionError && error.code === 'identity_rejected')
    await assert.rejects(admitLumxByok({
      byokKey: 'key', gateway, identity: { ...validIdentity, credential: 'forged-token' }, now,
    }), error => error instanceof LumxByokAdmissionError && error.code === 'identity_rejected')
    assert.deepEqual(receivedCredentials, ['local-test-token', 'revoked-token', 'forged-token'])
  } finally {
    await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  }
})

test('local gateway construction rejects a non-loopback endpoint', () => {
  assert.throws(() => createLoopbackIdentityGateway({ endpoint: 'https://identity.example.test/validate' }), /loopback/)
  assert.throws(() => createLoopbackIdentityGateway({ endpoint: 'http://user:pass@127.0.0.1/validate' }), /userinfo/)
})

test('a redirect cannot forward a synthetic credential away from the loopback gateway', async () => {
  let targetRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/target` })
      response.end()
      return
    }
    targetRequests += 1
    response.writeHead(204)
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.notEqual(typeof address, 'string')
    const gateway = createLoopbackIdentityGateway({ endpoint: `http://127.0.0.1:${address.port}/redirect` })
    await assert.rejects(gateway.validate({ audience: 'com.lumxai.desktop', credential: 'synthetic-only', subject: 'user-42' }))
    assert.equal(targetRequests, 0)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  }
})
