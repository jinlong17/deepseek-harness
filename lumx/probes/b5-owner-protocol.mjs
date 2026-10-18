import { timingSafeEqual } from 'node:crypto'

const OWNER_ACK_KEYS = Object.freeze([
  'schema',
  'nonce',
  'runtime_anchor_sha256',
  'generation',
  'pid',
  'pgid',
])
const SORTED_OWNER_ACK_KEYS = Object.freeze([...OWNER_ACK_KEYS].sort())
const OWNER_ACK_SCHEMA = 'g9-b5-host-owner-ack/v1'
const OWNER_ACK_ERROR = 'Host ownership ACK identity mismatch'

function exactObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function same(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyB5HostOwnershipAck(ack, owner) {
  const keys = exactObject(ack) ? Object.keys(ack).sort() : []
  if (
    keys.length !== OWNER_ACK_KEYS.length
    || keys.some((key, index) => key !== SORTED_OWNER_ACK_KEYS[index])
    || ack.schema !== OWNER_ACK_SCHEMA
    || !same(ack.nonce, owner.nonce)
    || !same(ack.runtime_anchor_sha256, owner.runtime_anchor_sha256)
    || !same(ack.generation, owner.generation)
    || ack.pid !== owner.pid
    || ack.pgid !== owner.pgid
  ) {
    throw new Error(OWNER_ACK_ERROR)
  }
}
