import { once } from 'node:events'
import { createInterface } from 'node:readline'

const VERSION = 1
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_QUEUE_BYTES = 4 * MAX_FRAME_BYTES
const MAX_QUEUE_FRAMES = 256
const CHANNELS = new Set(['acp', 'control', 'engine'])
const DIRECTIONS = new Set(['host-to-supervisor', 'supervisor-to-host'])
const TYPES = Object.freeze({
  'host-to-supervisor': Object.freeze({ acp: new Set(['bytes', 'eof']), control: new Set(['command']), engine: new Set(['cancel', 'dispose', 'request']) }),
  'supervisor-to-host': Object.freeze({ acp: new Set(['bytes', 'eof']), control: new Set(['event', 'ready', 'response']), engine: new Set(['event', 'response']) }),
})

function exactObject(value, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).every(key => allowed.has(key))
}

function validateFrame(value, expectedDirection, generation, expectedSeq) {
  const fields = new Set(['v', 'direction', 'channel', 'generation', 'seq', 'type', 'requestId', 'handleId', 'promptId', 'payload'])
  if (!exactObject(value, fields) || value.v !== VERSION || value.direction !== expectedDirection
    || value.generation !== generation || value.seq !== expectedSeq
    || !Number.isSafeInteger(value.seq) || value.seq < 1
    || !CHANNELS.has(value.channel) || typeof value.type !== 'string'
    || !TYPES[expectedDirection]?.[value.channel]?.has(value.type)) {
    throw new Error('LUMX typed pipe frame contract rejected')
  }
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
export function createTypedPipe({ readable, writable, incomingDirection, outgoingDirection, generation, onFrame }) {
  if (!DIRECTIONS.has(incomingDirection) || !DIRECTIONS.has(outgoingDirection) || incomingDirection === outgoingDirection) {
    throw new Error('LUMX typed pipe directions are invalid')
  }
  if (typeof generation !== 'string' || generation.length < 16 || generation.length > 128) {
    throw new Error('LUMX typed pipe generation is invalid')
  }
  let incomingSeq = 0
  let outgoingSeq = 0
  let queuedBytes = 0
  let queuedFrames = 0
  let closed = false
  let failed
  let tail = Promise.resolve()
  const lines = createInterface({ input: readable, crlfDelay: Infinity })
  lines.on('line', line => {
    if (failed !== undefined) return
    try {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('LUMX typed pipe frame exceeds byte limit')
      const frame = validateFrame(JSON.parse(line), incomingDirection, generation, incomingSeq + 1)
      incomingSeq = frame.seq
      Promise.resolve(onFrame(frame)).catch(fail)
    } catch (error) { fail(error) }
  })
  lines.once('close', () => { closed = true })
  lines.once('error', fail)
  writable.once('error', fail)

  function fail(error) {
    if (failed !== undefined) return
    failed = error instanceof Error ? error : new Error(String(error))
    closed = true
    lines.close()
  }

  function send(frame) {
    if (failed !== undefined) return Promise.reject(failed)
    if (closed) return Promise.reject(new Error('LUMX typed pipe is closed'))
    const value = { v: VERSION, direction: outgoingDirection, channel: frame.channel,
      generation, seq: ++outgoingSeq, type: frame.type,
      ...frame.requestId === undefined ? {} : { requestId: frame.requestId },
      ...frame.handleId === undefined ? {} : { handleId: frame.handleId },
      ...frame.promptId === undefined ? {} : { promptId: frame.promptId },
      ...frame.payload === undefined ? {} : { payload: frame.payload } }
    validateFrame(value, outgoingDirection, generation, outgoingSeq)
    const encoded = `${JSON.stringify(value)}\n`
    const size = Buffer.byteLength(encoded)
    if (size > MAX_FRAME_BYTES) return Promise.reject(new Error('LUMX typed pipe frame exceeds byte limit'))
    if (queuedFrames >= MAX_QUEUE_FRAMES || queuedBytes + size > MAX_QUEUE_BYTES) {
      return Promise.reject(new Error('LUMX typed pipe queue exceeds fixed limit'))
    }
    queuedFrames += 1; queuedBytes += size
    const writing = tail.then(async () => {
      if (failed !== undefined) throw failed
      if (!writable.write(encoded)) await once(writable, 'drain')
    }).finally(() => { queuedFrames -= 1; queuedBytes -= size })
    tail = writing.catch(() => {})
    return writing
  }

  async function close() {
    if (closed) return
    closed = true
    await tail
    writable.end()
    lines.close()
  }

  return Object.freeze({ close, send, stats: () => Object.freeze({ incomingSeq, outgoingSeq, queuedBytes, queuedFrames }) })
}
