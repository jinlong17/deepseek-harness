import { connect } from 'node:net'

import { qualifyAlternateByok } from './b5-host-byok-qualification.mjs'
import { qualifyH1Runtime } from './b5-host-h1-qualification.mjs'
import { capturePrivacyShutdownRows, observePrivacyShutdownRows, qualifyPrivacyLifecycle } from './b5-host-privacy-qualification.mjs'

const OPERATIONS = new Set(['isolation-network', 'privacy-lifecycle', 'h1-observe', 'byok-alternate'])
function deadline(promise, milliseconds = 170_000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Host qualification timed out')), milliseconds) })])
    .finally(() => clearTimeout(timer))
}
function validateDeclaration(value) {
  if (value === undefined) return undefined
  if (value?.version !== 1 || !Array.isArray(value.operations) || value.operations.length === 0) throw new Error('Host qualification declaration')
  if (new Set(value.operations).size !== value.operations.length || value.operations.some(name => !OPERATIONS.has(name))) throw new Error('Host qualification operation set')
  return Object.freeze({ version: 1, operations: Object.freeze([...value.operations]) })
}
function deniedNetwork() {
  return new Promise(resolveAttempt => {
    const socket = connect({ host: '198.51.100.1', port: 9 })
    const timer = setTimeout(() => { socket.destroy(); resolveAttempt({ code: 'timeout', denied: false }) }, 2_000)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveAttempt({ code: 'connected', denied: false }) })
    socket.once('error', error => { clearTimeout(timer); resolveAttempt({ code: error.code ?? error.name, denied: error.code === 'EPERM' }) })
  })
}
/** Fixed qualification capability over a private, generation-bound Host pipe. */
export function installGate1HostQualification(runtime, input) {
  const declaration = validateDeclaration(input.qualification)
  if (declaration === undefined) return undefined
  let active; let closing = false; let privacyObserved = false; let privacyShutdownRows
  const used = new Set()
  async function execute(request) {
    if (closing) throw new Error('Host qualification is closing')
    const operation = request?.operation
    if (!declaration.operations.includes(operation) || used.has(operation)) throw new Error('Host qualification operation unavailable')
    if (operation !== 'h1-observe' && Object.keys(request).length !== 1) throw new Error('Host qualification operation takes no arguments')
    if (operation === 'h1-observe' && (Object.keys(request).sort().join(',') !== 'operation,runId' || !/^[a-f0-9]{16}$/u.test(request.runId))) throw new Error('H1 qualification correlation')
    if (active !== undefined) throw new Error('Host qualification is single-flight')
    used.add(operation)
    const task = (async () => {
      if (operation === 'isolation-network') return deniedNetwork()
      if (operation === 'privacy-lifecycle') {
        if (runtime.governance?.assertReady === undefined || !Array.isArray(runtime.governance.rows)) {
          throw new Error('Host qualification governance is unavailable')
        }
        runtime.governance.assertReady()
        const facts = await qualifyPrivacyLifecycle(runtime.ctx, runtime.governance.rows)
        privacyObserved = true
        return facts
      }
      if (operation === 'byok-alternate') return qualifyAlternateByok(runtime, input)
      return qualifyH1Runtime(runtime, input, request.runId)
    })()
    active = task; void task.then(() => { if (active === task) active = undefined }, () => { if (active === task) active = undefined })
    const facts = await deadline(task)
    const raw = JSON.stringify(facts); if (Buffer.byteLength(raw) > 512 * 1024) throw new Error('Host qualification facts exceed bound')
    return Object.freeze({ operation, pid: process.pid, consumer: runtime.consumer, surface: runtime.surface, facts })
  }
  async function close() { closing = true; await active; if (privacyObserved) privacyShutdownRows = capturePrivacyShutdownRows(runtime.ctx) }
  function closeAfterRuntime(runtimeShutdownCompleted) {
    if (!closing) throw new Error('Host qualification closing snapshot requires a closed dispatcher')
    if (privacyShutdownRows === undefined) return undefined
    const privacy = observePrivacyShutdownRows(privacyShutdownRows, runtimeShutdownCompleted)
    const raw = JSON.stringify(privacy); if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Host closing facts exceed bound')
    return Object.freeze({ privacy })
  }
  return Object.freeze({ declaration, execute, close, closeAfterRuntime })
}
