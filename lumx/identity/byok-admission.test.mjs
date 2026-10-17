import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { admitLumxByok, LumxByokAdmissionError } from './byok-admission.mjs'
import { createLoopbackIdentityGateway } from './loopback-gateway.mjs'

const now = new Date('2026-10-17T12:00:00.000Z')
const future = '2026-10-17T13:00:00.000Z'
const validIdentity = Object.freeze({ credential: 'local-test-token', expiresAt: future, subject: 'user-42', type: 'lumx.local-auth.v1' })
const unusedGateway = { validate: async () => ({ active: true, expiresAt: future, subject: 'user-42' }) }

test('BYOK admission refuses absent, anonymous, forged, expired, and signed-out identities', async () => {
  const cases = [
    [{ byokKey: 'key', gateway: unusedGateway }, 'identity_required'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: { ...validIdentity, subject: 'anonymous' } }, 'identity_required'],
    [{ byokKey: 'key', gateway: { validate: async () => ({ active: false, expiresAt: future, subject: 'user-42' }) }, identity: validIdentity, now }, 'identity_rejected'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: { ...validIdentity, expiresAt: '2026-10-17T11:00:00.000Z' }, now }, 'identity_expired'],
    [{ byokKey: 'key', gateway: unusedGateway, identity: undefined, now }, 'identity_required'],
  ]
  for (const [input, code] of cases) {
    await assert.rejects(admitLumxByok(input), error => error instanceof LumxByokAdmissionError && error.code === code)
  }
})

test('a valid synthetic identity passes only through a loopback stub gateway', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/validate')
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), { audience: 'com.lumxai.desktop', credential: 'local-test-token', subject: 'user-42' })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ active: true, expiresAt: future, subject: 'user-42' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.notEqual(typeof address, 'string')
    const gateway = createLoopbackIdentityGateway({ endpoint: `http://127.0.0.1:${address.port}/validate` })
    await assert.doesNotReject(admitLumxByok({ byokKey: 'key', gateway, identity: validIdentity, now }))
  } finally {
    await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  }
})

test('local gateway construction rejects a non-loopback endpoint', () => {
  assert.throws(() => createLoopbackIdentityGateway({ endpoint: 'https://identity.example.test/validate' }), /loopback/)
})
