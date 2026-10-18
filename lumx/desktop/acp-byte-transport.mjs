const MAX_CHUNK = 1024 * 1024
const MAX_QUEUED = 4 * MAX_CHUNK

/** Bounded byte transport carried by the fixed ACP typed-pipe channel. */
export function createAcpByteTransport(pipe) {
  let controller; let closed = false; let queued = 0; let lineBytes = 0
  const readable = new ReadableStream({
    start(value) { controller = value },
    pull() { queued = 0 },
    cancel() { closed = true },
  }, { highWaterMark: 4, size: value => value.byteLength })
  function accept(frame) {
    if (frame.channel !== 'acp') return false
    if (closed) throw new Error('ACP byte transport received a late frame')
    if (frame.type === 'eof') { closed = true; controller.close(); return true }
    const bytes = Buffer.from(frame.payload.base64, 'base64')
    if (bytes.length > MAX_CHUNK || queued + bytes.length > MAX_QUEUED) throw new Error('ACP byte transport input exceeds fixed limit')
    for (const byte of bytes) {
      lineBytes = byte === 0x0a ? 0 : lineBytes + 1
      if (lineBytes > MAX_CHUNK) throw new Error('ACP NDJSON line exceeds fixed limit')
    }
    queued += bytes.length; controller.enqueue(new Uint8Array(bytes)); return true
  }
  const writable = new WritableStream({
    async write(value) {
      if (closed) throw new Error('ACP byte transport is closed')
      const bytes = Buffer.from(value)
      if (bytes.length > MAX_CHUNK) throw new Error('ACP byte transport output exceeds fixed limit')
      await pipe.send({ channel: 'acp', type: 'bytes', payload: { base64: bytes.toString('base64') } })
    },
    async close() { if (!closed) { closed = true; await pipe.send({ channel: 'acp', type: 'eof' }, { priority: true }) } },
    async abort() { if (!closed) { closed = true; await pipe.send({ channel: 'acp', type: 'eof' }, { priority: true }).catch(() => {}) } },
  })
  return Object.freeze({ accept, readable, writable })
}
