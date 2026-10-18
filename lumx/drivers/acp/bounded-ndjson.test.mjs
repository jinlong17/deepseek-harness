import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { captureBoundedTail, createBoundedNdjsonInput } from './bounded-ndjson.mjs'

test('preserves split NDJSON lines and rejects an oversized unterminated line', async () => {
  const bounded = createBoundedNdjsonInput(8); const received = []
  bounded.on('data', chunk => received.push(chunk))
  bounded.write('{"a":'); bounded.write('1}\n'); bounded.end('{}\n')
  await once(bounded, 'end'); assert.equal(Buffer.concat(received).toString(), '{"a":1}\n{}\n')

  const oversized = createBoundedNdjsonInput(8); oversized.on('error', () => {})
  oversized.write('12345678')
  const failed = once(oversized, 'error'); oversized.write('9')
  const [error] = await failed; assert.match(error.message, /exceeds fixed byte limit/)
})

test('diagnostic capture retains only a fixed tail', () => {
  const stream = new PassThrough(); const snapshot = captureBoundedTail(stream, 4)
  stream.write('abcdef')
  assert.deepEqual(snapshot(), { bytes: 'cdef', totalBytes: 6, truncated: true })
})
