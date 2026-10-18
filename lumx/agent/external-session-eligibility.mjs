import { createHash, randomUUID } from 'node:crypto'

import { createEligibilityFiles, MAX_RECEIPT_BYTES } from './external-session-eligibility-files.mjs'

const FIELDS = Object.freeze(['format', 'version', 'state', 'nonce', 'mode', 'scope', 'sessionId', 'inheritedEventCount', 'headerSha256', 'bindingSha256', 'prefixLength', 'prefixSha256'])
const STATES = new Set(['prepared', 'committed', 'revoked'])

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object') throw new Error('eligibility identity contains an unsupported value')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const encode = receipt => Buffer.from(`${canonical(receipt)}\n`)

function binding(events) {
  const values = events.filter(event => event.type === 'agent/external-engine-bound')
  if (values.length !== 1 || values[0].ignorable !== undefined) throw new Error('eligibility requires one non-ignorable external engine binding')
  return values[0]
}

function identity({ events, header, inheritedEventCount, mode, persistenceScope, sessionId }) {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) throw new Error('eligibility inherited event count is invalid')
  if (!Array.isArray(events) || events.length < 1) throw new Error('eligibility prefix is empty')
  const logicalHeader = { ...header, delegationDepth: header.delegationDepth ?? 0 }
  return Object.freeze({ format: 'lumx-external-session-eligibility', version: 1, mode, scope: digest(persistenceScope), sessionId,
    inheritedEventCount, headerSha256: digest(logicalHeader), bindingSha256: digest(binding(events)), prefixLength: events.length, prefixSha256: digest(events) })
}

function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RECEIPT_BYTES) throw new Error('eligibility receipt exceeds its bound')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('eligibility receipt is malformed') }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...FIELDS].sort().join('\0')
    || !STATES.has(value.state) || value.format !== 'lumx-external-session-eligibility' || value.version !== 1 || encode(value).compare(bytes) !== 0) {
    throw new Error('eligibility receipt schema is invalid')
  }
  for (const name of ['nonce', 'mode', 'scope', 'sessionId', 'headerSha256', 'bindingSha256', 'prefixSha256']) if (typeof value[name] !== 'string' || value[name].length < 1) throw new Error('eligibility receipt field is invalid')
  for (const name of ['inheritedEventCount', 'prefixLength']) if (!Number.isSafeInteger(value[name]) || value[name] < 0) throw new Error('eligibility receipt count is invalid')
  return value
}

function matches(receipt, expected) {
  return Object.entries(expected).every(([key, value]) => receipt[key] === value)
}
function fatal(error, cause) {
  const failure = new AggregateError(cause === undefined ? [error] : [error, cause], 'external session eligibility state is uncertain')
  failure.eligibilityFatal = true
  return failure
}

/** Product-owned recovery eligibility. The DSH log remains the transcript and binding authority. */
export function createExternalSessionEligibilityStore(input, filesOverride) {
  if (!['consumer', 'developer'].includes(input.mode)) throw new Error('eligibility mode is invalid')
  if (typeof input.persistenceScope !== 'string' || input.persistenceScope.length < 1) throw new Error('eligibility persistence scope is invalid')
  const files = filesOverride ?? createEligibilityFiles(input)
  const receiptPath = sessionId => files.path(digest([input.mode, input.persistenceScope, sessionId]))
  return Object.freeze({
    roots: Object.freeze({ eligibility: files.markerRoot, persistence: files.logRoot }),
    async prepareBirth({ ownedCreateHandle, events }) {
      const expected = identity({ events, header: ownedCreateHandle.header, inheritedEventCount: ownedCreateHandle.inheritedEventCount,
        mode: input.mode, persistenceScope: input.persistenceScope, sessionId: ownedCreateHandle.header.id })
      const nonce = randomUUID(); const prepared = Object.freeze({ ...expected, state: 'prepared', nonce })
      const committed = Object.freeze({ ...expected, state: 'committed', nonce })
      const preparedBytes = encode(prepared); const committedBytes = encode(committed)
      const reservation = files.reserve(receiptPath(expected.sessionId), preparedBytes, committedBytes)
      let state = 'prepared'
      const revoke = () => {
        const current = parse(files.read(reservation.path))
        if (!matches(current, expected) || current.nonce !== nonce || !['prepared', 'committed', 'revoked'].includes(current.state)) throw new Error('eligibility birth no longer owns its receipt')
        if (current.state !== 'revoked') files.replaceOwned(reservation, encode(current), encode(Object.freeze({ ...expected, state: 'revoked', nonce })))
        files.discardTemporary(reservation.temporary); state = 'revoked'
      }
      return Object.freeze({
        assertUnchanged(eventsNow) {
          if (state !== 'prepared' || eventsNow.length !== expected.prefixLength || digest(eventsNow) !== expected.prefixSha256) throw new Error('external session changed after its durable birth prefix was prepared')
        },
        commitSync() {
          if (state !== 'prepared') throw new Error('eligibility birth is not prepared')
          try { files.replaceOwned(reservation, preparedBytes); state = 'committed' } catch (error) {
            let current
            try { current = parse(files.read(reservation.path)) } catch (inspectError) { state = 'uncertain'; throw fatal(error, inspectError) }
            if (!matches(current, expected) || current.nonce !== nonce) { state = 'uncertain'; throw fatal(error) }
            if (current.state === 'committed') {
              state = 'committed'
              try { revoke() } catch (revokeError) { state = 'uncertain'; throw fatal(error, revokeError) }
            } else if (current.state !== 'prepared') { state = 'uncertain'; throw fatal(error) }
            throw error
          }
        },
        rejectSync() {
          if (state === 'accepted') throw new Error('accepted eligibility birth cannot be revoked')
          if (state === 'revoked') return
          try { revoke() } catch (error) { state = 'uncertain'; throw fatal(error) }
        },
        accept() { if (state !== 'committed') throw new Error('eligibility birth is not committed'); files.discardTemporary(reservation.temporary); state = 'accepted' },
        state() { return state },
      })
    },
    verifyCommitted({ ownedWriteHandle, events }) {
      const receipt = parse(files.read(receiptPath(ownedWriteHandle.header.id)))
      if (receipt.prefixLength > events.length) throw new Error('external session is not committed for qualified recovery (prefixLength)')
      const expected = identity({ events: events.slice(0, receipt.prefixLength), header: ownedWriteHandle.header,
        inheritedEventCount: ownedWriteHandle.inheritedEventCount, mode: input.mode, persistenceScope: input.persistenceScope, sessionId: ownedWriteHandle.header.id })
      if (receipt.state !== 'committed' || !matches(receipt, expected)) {
        const mismatch = Object.keys(expected).find(key => receipt[key] !== expected[key]) ?? (receipt.state !== 'committed' ? 'state' : 'prefixLength')
        throw new Error(`external session is not committed for qualified recovery (${mismatch})`)
      }
      return Object.freeze({ nonce: receipt.nonce, prefixLength: receipt.prefixLength })
    },
  })
}
