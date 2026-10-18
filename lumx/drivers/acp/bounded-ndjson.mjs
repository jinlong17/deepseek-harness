import { Transform } from 'node:stream'

const MAX_LINE_BYTES = 1024 * 1024

/** Preserve NDJSON bytes while rejecting an unterminated or complete oversized line. */
export function createBoundedNdjsonInput(maxLineBytes = MAX_LINE_BYTES) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('NDJSON byte limit is invalid')
  let lineBytes = 0
  return new Transform({
    readableHighWaterMark: 64 * 1024,
    writableHighWaterMark: 64 * 1024,
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let start = 0
      for (;;) {
        const newline = bytes.indexOf(0x0a, start)
        if (newline < 0) {
          lineBytes += bytes.length - start
          if (lineBytes > maxLineBytes) return callback(new Error('Qwen ACP NDJSON line exceeds fixed byte limit'))
          break
        }
        lineBytes += newline - start
        if (lineBytes > maxLineBytes) return callback(new Error('Qwen ACP NDJSON line exceeds fixed byte limit'))
        lineBytes = 0; start = newline + 1
      }
      callback(undefined, bytes)
    },
    flush(callback) {
      callback(lineBytes === 0 ? undefined : new Error('Qwen ACP NDJSON ended with a truncated line'))
    },
  })
}

/** Fixed-size tail capture for diagnostics from an untrusted child stream. */
export function captureBoundedTail(stream, limit = 64 * 1024) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('diagnostic byte limit is invalid')
  let tail = Buffer.alloc(0); let totalBytes = 0
  stream.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); totalBytes += bytes.length
    tail = Buffer.concat([tail, bytes]); if (tail.length > limit) tail = tail.subarray(tail.length - limit)
  })
  return () => Object.freeze({ bytes: tail.toString('utf8'), totalBytes, truncated: totalBytes > tail.length })
}
