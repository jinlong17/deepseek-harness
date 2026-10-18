import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyB5HostOwnershipAck } from './b5-owner-protocol.mjs'

const owner = Object.freeze({
  generation: 'e9a9cd0b-cc23-4cec-88be-0c58172624e3',
  nonce: '9b0ab3e4d8d12e7632d9afc57f712bc3',
  pid: 4123,
  pgid: 4123,
  runtime_anchor_sha256: 'f'.repeat(64),
})

function ack(overrides = {}) {
  return {
    schema: 'g9-b5-host-owner-ack/v1',
    nonce: owner.nonce,
    runtime_anchor_sha256: owner.runtime_anchor_sha256,
    generation: owner.generation,
    pid: owner.pid,
    pgid: owner.pgid,
    ...overrides,
  }
}

function rejects(value) {
  assert.throws(
    () => verifyB5HostOwnershipAck(value, owner),
    /Host ownership ACK identity mismatch/,
  )
}

test('owner ACK accepts the controller schema after lexical key normalization', () => {
  const permuted = {
    schema: 'g9-b5-host-owner-ack/v1',
    runtime_anchor_sha256: owner.runtime_anchor_sha256,
    pgid: owner.pgid,
    nonce: owner.nonce,
    generation: owner.generation,
    pid: owner.pid,
  }
  assert.doesNotThrow(() => verifyB5HostOwnershipAck(permuted, owner))
})

test('owner ACK rejects every missing or extra schema key', () => {
  for (const key of Object.keys(ack())) {
    const value = ack()
    delete value[key]
    rejects(value)
  }
  rejects({ ...ack(), unexpected: true })
})

test('owner ACK rejects each authenticated identity mismatch', () => {
  rejects(ack({ schema: 'wrong' }))
  rejects(ack({ nonce: 'wrong' }))
  rejects(ack({ runtime_anchor_sha256: '0'.repeat(64) }))
  rejects(ack({ generation: 'wrong' }))
  rejects(ack({ pid: owner.pid + 1 }))
  rejects(ack({ pgid: owner.pgid + 1 }))
})

test('owner ACK rejects non-object and array forms with the stable error', () => {
  rejects(null)
  rejects([])
  rejects('owner-ack')
})
