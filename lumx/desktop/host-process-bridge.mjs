import { randomUUID } from 'node:crypto'

import { ndJsonStream } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { createEngineRpcPeer } from '../drivers/acp/engine-rpc.mjs'
import { createAcpByteTransport } from './acp-byte-transport.mjs'
import { createTypedPipe } from './typed-pipe.mjs'

const CONTROL_TIMEOUT_MS = 30_000
function timeout(promise, ms, label) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]).finally(() => clearTimeout(timer)) }

/** Own the typed Host/supervisor transport over one native child's private pipes. */
export function createHostProcessBridge({ child, engine, generation }) {
  const ready = Promise.withResolvers(); const controls = new Map(); let accepting = true
  let rpc
  const pipe = createTypedPipe({ readable: child.stdout, writable: child.stdin, generation, incomingDirection: 'host-to-supervisor', outgoingDirection: 'supervisor-to-host', onFrame,
    onFailure(error) { fail(error) } })
  const acpBytes = createAcpByteTransport(pipe)
  rpc = createEngineRpcPeer({ pipe, handlers: {
    create: (input, ids) => engine.create(input, ids), load: (input, ids) => engine.load(input, ids),
    prompt: (input, ids) => engine.prompt(input, ids), cancel: (_input, ids) => engine.cancel(ids), dispose: (_input, ids) => engine.dispose(ids),
  } })
  function fail(error) {
    if (!accepting) return; accepting = false; ready.reject(error)
    for (const pending of controls.values()) pending.reject(error); controls.clear()
    void rpc.close(error).catch(() => {})
  }
  function onFrame(frame) {
    if (acpBytes.accept(frame) || rpc.onFrame(frame)) return
    if (frame.channel !== 'control') throw new Error('supervisor received an unsupported Host frame')
    if (frame.type === 'ready') { ready.resolve(frame.payload); return }
    if (frame.type !== 'response') throw new Error('supervisor received an invalid control frame')
    const pending = controls.get(frame.requestId); if (pending === undefined) throw new Error('Host control response has no pending request')
    controls.delete(frame.requestId); frame.payload.ok ? pending.resolve(frame.payload.value) : pending.reject(new Error(frame.payload.error))
  }
  engine.bind?.({
    onPermission: ({ handleId, promptId, params, signal }) => rpc.request('permission', params, { handleId, promptId, signal }),
    onUpdate: ({ handleId, promptId, params }) => rpc.event('update', params, { handleId, promptId }),
  })
  function request(command, label) {
    if (!accepting) return Promise.reject(new Error('Host bridge is closed'))
    const requestId = randomUUID(); const result = Promise.withResolvers(); controls.set(requestId, result)
    void pipe.send({ channel: 'control', type: 'command', requestId, payload: command }, { priority: command.command === 'shutdown' }).catch(error => { controls.delete(requestId); result.reject(error) })
    return timeout(result.promise, CONTROL_TIMEOUT_MS, label).finally(() => controls.delete(requestId))
  }
  async function close(reason = new Error('Host bridge closed')) {
    if (!accepting) return; accepting = false
    for (const pending of controls.values()) pending.reject(reason); controls.clear()
    await rpc.close(reason); await pipe.close().catch(() => {})
  }
  return Object.freeze({ acp: ndJsonStream(acpBytes.writable, acpBytes.readable), close, ready: ready.promise, request,
    stats: () => Object.freeze({ accepting, controls: controls.size, rpc: rpc.stats(), pipe: pipe.stats() }) })
}
