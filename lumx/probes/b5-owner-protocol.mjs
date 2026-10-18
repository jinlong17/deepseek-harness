import { timingSafeEqual } from 'node:crypto'

const OWNER_ACK_KEYS = 'generation,nonce,pgid,pid,runtime_anchor_sha256,schema'
const OWNER_ACK_SCHEMA = 'g9-b5-host-owner-ack/v1'
const OWNER_ACK_ERROR = 'Host ownership ACK identity mismatch'

function same(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyB5HostOwnershipAck(ack, owner) {
  const keys = Object.keys(ack ?? {}).sort().join(',')
  if (
    keys !== OWNER_ACK_KEYS
    || ack?.schema !== OWNER_ACK_SCHEMA
    || !same(ack.nonce ?? '', owner.nonce)
    || !same(ack.runtime_anchor_sha256 ?? '', owner.runtime_anchor_sha256)
    || !same(ack.generation ?? '', owner.generation)
    || ack.pid !== owner.pid
    || ack.pgid !== owner.pgid
  ) {
    throw new Error(OWNER_ACK_ERROR)
  }
}
