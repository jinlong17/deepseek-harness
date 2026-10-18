const VERSION = 1
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_QUEUE_BYTES = 4 * MAX_FRAME_BYTES
const MAX_QUEUE_FRAMES = 256
const WRITE_DEADLINE_MS = 5_000
const CHANNELS = new Set(['acp', 'control', 'engine'])
const DIRECTIONS = new Set(['host-to-supervisor', 'supervisor-to-host'])
const TYPES = Object.freeze({
  'host-to-supervisor': Object.freeze({ acp: new Set(['bytes', 'eof']), control: new Set(['ready', 'response']), engine: new Set(['cancel', 'dispose', 'request', 'response']) }),
  'supervisor-to-host': Object.freeze({ acp: new Set(['bytes', 'eof']), control: new Set(['command']), engine: new Set(['cancel', 'dispose', 'event', 'request', 'response']) }),
})

function exactObject(value, allowed) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.has(key))
}

function validateFrame(value, expectedDirection, generation, expectedSeq) {
  const fields = new Set(['v', 'direction', 'channel', 'generation', 'seq', 'type', 'requestId', 'handleId', 'promptId', 'payload'])
  const reject = reason => { throw new Error(`LUMX typed pipe frame contract rejected: ${reason}`) }
  if (!exactObject(value, fields)) reject('shape')
  if (value.v !== VERSION) reject('version')
  if (value.direction !== expectedDirection) reject('direction')
  if (value.generation !== generation) reject('generation')
  if (!Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq !== expectedSeq) reject('sequence')
  if (!CHANNELS.has(value.channel)) reject('channel')
  if (typeof value.type !== 'string' || !TYPES[expectedDirection]?.[value.channel]?.has(value.type)) reject(`type ${expectedDirection}/${String(value.channel)}/${String(value.type)}`)
  for (const key of ['requestId', 'handleId', 'promptId']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 128)) {
      throw new Error(`LUMX typed pipe ${key} is invalid`)
    }
  }
  if ((value.type === 'command' || value.type === 'request' || value.type === 'response') && value.requestId === undefined) {
    throw new Error('LUMX typed pipe correlated frame lacks requestId')
  }
  if (value.channel === 'acp' && value.type === 'bytes'
    && (!exactObject(value.payload, new Set(['base64'])) || typeof value.payload.base64 !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.payload.base64))) {
    throw new Error('LUMX typed pipe ACP payload is invalid')
  }
  return Object.freeze(value)
}

/** Versioned bounded newline transport for the private Host/supervisor pipes. */
export function createTypedPipe({ readable, writable, incomingDirection, outgoingDirection, generation, onFrame, onFailure = () => {}, endWritableOnClose = true }) {
  if (!DIRECTIONS.has(incomingDirection) || !DIRECTIONS.has(outgoingDirection) || incomingDirection === outgoingDirection) throw new Error('LUMX typed pipe directions are invalid')
  if (typeof generation !== 'string' || generation.length < 16 || generation.length > 128) throw new Error('LUMX typed pipe generation is invalid')
  if (typeof endWritableOnClose !== 'boolean') throw new Error('LUMX typed pipe close ownership is invalid')
  let incomingSeq = 0; let outgoingSeq = 0; let buffered = Buffer.alloc(0)
  let incomingBytes = 0; let outgoingBytes = 0; let incomingActive = false; let writing = false
  let ended = false; let closing = false; let failure
  let finishOutput
  const incoming = []; const urgent = []; const ordinary = []
  const lifecycle = Promise.withResolvers()

  function settleFailure(error) {
    if (failure !== undefined || lifecycleSettled()) return
    failure = error instanceof Error ? error : new Error(String(error))
    closing = true
    readable.pause()
    try { onFailure(failure) } catch {}
    rejectAll(urgent, failure); rejectAll(ordinary, failure)
    lifecycle.reject(failure)
  }
  let settled = false
  function lifecycleSettled() { return settled }
  lifecycle.promise.then(() => { settled = true }, () => { settled = true })
  lifecycle.promise.catch(() => {})
  function rejectAll(queue, error) { for (const item of queue.splice(0)) item.result.reject(error) }
  function maybeClosed() {
    if (settled || failure !== undefined || !ended || incomingActive || incoming.length > 0 || writing || urgent.length > 0 || ordinary.length > 0) return
    if (endWritableOnClose && !writable.writableFinished) {
      void finishWritable().then(maybeClosed, settleFailure)
      return
    }
    settled = true; lifecycle.resolve()
  }

  function finishWritable() {
    if (finishOutput !== undefined) return finishOutput
    finishOutput = new Promise((resolveEnd, rejectEnd) => {
      if (writable.writableFinished) { resolveEnd(); return }
      if (writable.destroyed) { rejectEnd(new Error('LUMX typed pipe output was destroyed before finish')); return }
      let settledEnd = false
      const finish = error => {
        if (settledEnd) return
        settledEnd = true; clearTimeout(timer); writable.removeListener('error', onError); writable.removeListener('finish', onFinish)
        if (error == null) resolveEnd(); else rejectEnd(error)
      }
      const onError = error => finish(error)
      const onFinish = () => finish()
      const timer = setTimeout(() => finish(new Error('LUMX typed pipe close completion timed out')), WRITE_DEADLINE_MS)
      writable.once('error', onError); writable.once('finish', onFinish)
      if (writable.writableEnded) return
      try { writable.end() } catch (error) { finish(error) }
    })
    return finishOutput
  }

  async function drainIncoming() {
    if (incomingActive || failure !== undefined) return
    incomingActive = true
    readable.pause()
    try {
      while (incoming.length > 0 && failure === undefined) {
        const item = incoming.shift(); incomingBytes -= item.bytes
        await onFrame(item.frame)
      }
    } catch (error) { settleFailure(error) }
    finally {
      incomingActive = false
      if (!closing && !ended && failure === undefined) readable.resume()
      maybeClosed()
    }
  }

  function acceptChunk(chunk) {
    if (closing || failure !== undefined) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (buffered.length + bytes.length > MAX_FRAME_BYTES + MAX_QUEUE_BYTES) return settleFailure(new Error('LUMX typed pipe input exceeds fixed buffer limit'))
    buffered = Buffer.concat([buffered, bytes])
    for (;;) {
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) {
        if (buffered.length > MAX_FRAME_BYTES) settleFailure(new Error('LUMX typed pipe unterminated frame exceeds byte limit'))
        break
      }
      if (newline > MAX_FRAME_BYTES) return settleFailure(new Error('LUMX typed pipe frame exceeds byte limit'))
      const line = buffered.subarray(0, newline)
      buffered = buffered.subarray(newline + 1)
      if (line.length === 0) return settleFailure(new Error('LUMX typed pipe empty frame rejected'))
      try {
        const frame = validateFrame(JSON.parse(line.toString('utf8')), incomingDirection, generation, incomingSeq + 1)
        if (incoming.length >= MAX_QUEUE_FRAMES || incomingBytes + line.length > MAX_QUEUE_BYTES) throw new Error('LUMX typed pipe incoming queue exceeds fixed limit')
        incomingSeq = frame.seq; incomingBytes += line.length; incoming.push({ frame, bytes: line.length })
      } catch (error) { return settleFailure(error) }
    }
    void drainIncoming()
  }

  readable.on('data', acceptChunk)
  readable.once('end', () => {
    ended = true; closing = true
    if (buffered.length !== 0) settleFailure(new Error('LUMX typed pipe ended with a truncated frame'))
    else maybeClosed()
  })
  readable.once('error', settleFailure)
  writable.once('error', settleFailure)

  async function pump() {
    if (writing || failure !== undefined) return
    writing = true
    try {
      for (;;) {
        const item = urgent.shift() ?? ordinary.shift()
        if (item === undefined) break
        outgoingBytes -= item.bytes
        const value = { ...item.value, seq: ++outgoingSeq }
        const encoded = `${JSON.stringify(value)}\n`
        try {
          await new Promise((resolveWrite, rejectWrite) => {
            let settledWrite = false
            const finish = error => {
              if (settledWrite) return
              settledWrite = true; clearTimeout(timer); writable.removeListener('error', onError)
              if (error == null) resolveWrite(); else rejectWrite(error)
            }
            const onError = error => finish(error)
            const timer = setTimeout(() => finish(new Error('LUMX typed pipe write completion timed out')), WRITE_DEADLINE_MS)
            writable.once('error', onError)
            try { writable.write(encoded, finish) } catch (error) { finish(error) }
          })
          item.result.resolve()
        } catch (error) {
          item.result.reject(error)
          settleFailure(error)
          break
        }
      }
    } finally {
      writing = false
      if (closing && failure === undefined && endWritableOnClose) {
        try { await finishWritable() } catch (error) { settleFailure(error) }
      }
      maybeClosed()
    }
  }

  function send(frame, { priority = false } = {}) {
    if (failure !== undefined) return Promise.reject(failure)
    if (closing) return Promise.reject(new Error('LUMX typed pipe is closed'))
    const value = { v: VERSION, direction: outgoingDirection, channel: frame.channel, generation, seq: outgoingSeq + 1, type: frame.type,
      ...frame.requestId === undefined ? {} : { requestId: frame.requestId }, ...frame.handleId === undefined ? {} : { handleId: frame.handleId },
      ...frame.promptId === undefined ? {} : { promptId: frame.promptId }, ...frame.payload === undefined ? {} : { payload: frame.payload } }
    let encoded
    try { validateFrame(value, outgoingDirection, generation, outgoingSeq + 1); encoded = `${JSON.stringify(value)}\n` }
    catch (error) { settleFailure(error); return Promise.reject(error) }
    const size = Buffer.byteLength(encoded)
    const count = urgent.length + ordinary.length + (writing ? 1 : 0)
    if (size > MAX_FRAME_BYTES || count >= MAX_QUEUE_FRAMES || outgoingBytes + size > MAX_QUEUE_BYTES) {
      const error = new Error(size > MAX_FRAME_BYTES ? 'LUMX typed pipe frame exceeds byte limit' : 'LUMX typed pipe queue exceeds fixed limit')
      settleFailure(error); return Promise.reject(error)
    }
    const result = Promise.withResolvers(); const item = { value, bytes: size, result }
    outgoingBytes += size; (priority ? urgent : ordinary).push(item); void pump()
    return result.promise
  }

  async function close() {
    if (settled) return lifecycle.promise
    closing = true; ended = true; readable.pause()
    rejectAll(urgent, new Error('LUMX typed pipe closed')); rejectAll(ordinary, new Error('LUMX typed pipe closed'))
    if (!writing && endWritableOnClose) {
      try { await finishWritable() } catch (error) { settleFailure(error); throw error }
    }
    maybeClosed()
    return lifecycle.promise
  }

  return Object.freeze({ close, closed: lifecycle.promise, send, stats: () => Object.freeze({ incomingSeq, outgoingSeq, incomingBytes, outgoingBytes, incomingFrames: incoming.length, outgoingFrames: urgent.length + ordinary.length }) })
}
