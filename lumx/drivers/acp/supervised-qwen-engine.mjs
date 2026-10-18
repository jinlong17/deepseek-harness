import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '../../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { captureBoundedTail, createBoundedNdjsonInput } from './bounded-ndjson.mjs'
import { verifyQwenLaunch } from './qwen-launch-materials.mjs'

const OPERATION_TIMEOUT_MS = 30_000
const CALLBACK_LIMIT = 64
const UPDATE_TYPES = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'plan_update', 'plan_removed', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update', 'usage_update', 'compaction_update', 'compaction_summary_chunk'])
const TURN_UPDATE_TYPES = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'plan_update', 'plan_removed', 'usage_update', 'compaction_update', 'compaction_summary_chunk'])
function timeout(promise, label, ms = OPERATION_TIMEOUT_MS) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function abortable(promise, signal) {
  signal.throwIfAborted(); const stopped = Promise.withResolvers()
  const abort = () => stopped.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  return Promise.race([promise, stopped.promise]).finally(() => signal.removeEventListener('abort', abort))
}
function outcome(child) { return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) }
function id(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error(`${label} is invalid`)
  return value
}
function fixedServers(value) {
  if (!Array.isArray(value) || value.length > 16 || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new Error('Qwen fixed MCP server catalog is invalid')
  return structuredClone(value)
}
function promptBlocks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128
    || value.some(block => block === null || typeof block !== 'object' || Array.isArray(block))
    || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Qwen prompt payload is invalid')
  return value
}
function updateParams(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Qwen update is invalid')
  id(value.sessionId, 'Qwen update sessionId')
  if (value.update === null || typeof value.update !== 'object' || Array.isArray(value.update) || !UPDATE_TYPES.has(value.update.sessionUpdate)) throw new Error('Qwen update type is unsupported')
  return value
}
function guardianControl(stream) {
  const pid = Promise.withResolvers(); const exited = Promise.withResolvers(); let buffer = Buffer.alloc(0); let settled = false
  const fail = error => { if (settled) return; settled = true; pid.reject(error); exited.reject(error) }
  pid.promise.catch(() => {}); exited.promise.catch(() => {})
  stream.on('data', chunk => {
    if (settled) return
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 4096) return fail(new Error('Qwen guardian control exceeds fixed byte limit'))
    for (;;) {
      const newline = buffer.indexOf(0x0a); if (newline < 0) break
      const line = buffer.subarray(0, newline).toString('utf8'); buffer = buffer.subarray(newline + 1)
      let match = /^pid:([1-9][0-9]*)$/u.exec(line)
      if (match) { pid.resolve(Number(match[1])); continue }
      match = /^exit:(-1|[0-9]+):([0-9]+)$/u.exec(line)
      if (!match) return fail(new Error('Qwen guardian control frame is invalid'))
      settled = true; exited.resolve({ code: Number(match[1]) < 0 ? null : Number(match[1]), signal: Number(match[2]) || null })
    }
  })
  stream.once('error', fail)
  stream.once('end', () => { if (!settled) fail(new Error('Qwen guardian ended before reporting engine exit')) })
  return { exited: exited.promise, pid: pid.promise }
}
function signalName(number) {
  if (number === null) return null
  return Object.entries(osConstants.signals).find(([, value]) => value === number)?.[0] ?? `SIG${number}`
}

/** Supervisor-owned official ACP client and Qwen process-group lifecycle. */
export function createSupervisedQwenEngine({ materials, relay, model, mcpServers = [], onUpdate = () => {}, onPermission = async () => ({ outcome: { outcome: 'cancelled' } }) }) {
  const handles = new Map(); const reservations = new Set(); const servers = fixedServers(mcpServers)
  const launched = new Map(); const terminal = new Map()
  let accepting = true; let launches = 0; let closing

  function assertActive(record, signal) {
    signal?.throwIfAborted()
    if (!accepting || (record !== undefined && handles.get(record.handleId) !== record)
      || record?.disposing !== undefined || record?.reaping !== undefined || record?.drainFailure !== undefined) throw new Error('Qwen engine lifecycle is not active')
  }
  function reserve(handleId) {
    if (!accepting) throw new Error('Qwen engine is disposed')
    if (handles.has(handleId) || reservations.has(handleId) || launched.has(handleId)) throw new Error('Qwen handle already exists')
    reservations.add(handleId)
  }
  function terminalFailure(record, error) {
    terminal.set(record.handleId, Object.freeze({ birth: record.birth, handleId: record.handleId,
      guardianPid: record.guardian.pid, qwenPid: record.qwenPid,
      state: 'cleanup-failed', error: String(error?.message ?? error) }))
  }
  function terminalSuccess(record, cleanup) {
    if (!Number.isSafeInteger(record.qwenPid)) throw new Error('Qwen cleanup has no owned engine PID')
    terminal.set(record.handleId, Object.freeze({ birth: record.birth, handleId: record.handleId,
      guardianPid: record.guardian.pid, qwenPid: record.qwenPid, state: 'reaped', cleanup }))
  }
  function callback(prompt, operation, fallback) {
    if (!prompt.accepting) return Promise.resolve(fallback)
    if (prompt.callbacks.size >= CALLBACK_LIMIT) return Promise.reject(new Error('Qwen prompt callback limit reached'))
    const task = Promise.resolve().then(() => operation(AbortSignal.any([prompt.signal, prompt.callbackAbort.signal]))); prompt.callbacks.add(task)
    task.finally(() => prompt.callbacks.delete(task)).catch(() => {})
    return task
  }
  async function drainCallbacks(prompt) {
    prompt.accepting = false; prompt.callbackAbort.abort(new Error('Qwen prompt callback generation closed'))
    const results = await timeout(Promise.allSettled([...prompt.callbacks]), 'Qwen prompt callback drain', 5_000)
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length === 1) throw failures[0].reason
    if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), 'Qwen prompt callbacks failed')
  }

  function reap(record) {
    return (record.reaping ??= (async () => {
      record.phase = 'reaping'; record.lifecycleAbort.abort(new Error('Qwen process group reaping')); record.guardian.stdin.end()
      let guardianResult = await Promise.race([record.guardianExited, new Promise(resolve => setTimeout(() => resolve(undefined), 3_000))])
      if (guardianResult === undefined && Number.isSafeInteger(record.qwenPid)) { try { process.kill(-record.qwenPid, 'SIGKILL') } catch {} }
      if (guardianResult === undefined) { record.guardian.kill('SIGKILL'); guardianResult = await timeout(record.guardianExited, 'Qwen guardian reap', 2_000) }
      if (guardianResult.code !== 0 || guardianResult.signal !== null) throw new Error('Qwen guardian failed to prove complete process-group cleanup')
      const qwenResult = await timeout(record.qwenExit, 'Qwen exit report', 1_000)
      const cleanup = Object.freeze({ guardian: Object.freeze({ pid: record.guardian.pid, exit: guardianResult }),
        qwen: Object.freeze({ pid: record.qwenPid, pgid: record.qwenPid, exit: { code: qwenResult.code, signal: signalName(qwenResult.signal) } }),
        processGroupReaped: true })
      terminalSuccess(record, cleanup)
      return { exit: { code: qwenResult.code, signal: signalName(qwenResult.signal) }, guardianExit: guardianResult,
        cleanup, stderr: record.qwenDiagnostic(), guardianError: record.guardianDiagnostic(), permissions: record.permissions, updates: record.updates }
    })())
  }

  function combined(failures, label) {
    if (failures.length === 1) return failures[0]
    if (failures.length > 1) return new AggregateError(failures, label)
  }

  async function launch(handleId, signal) {
    assertActive(undefined, signal)
    verifyQwenLaunch(materials, { requireInitialState: launches === 0 && materials.initialState }); launches += 1
    assertActive(undefined, signal)
    const qwenArgv = ['/usr/bin/sandbox-exec', '-f', materials.paths.profilePath, materials.nodePath, '--expose-gc', materials.qwenCliPath, '--acp', '--auth-type=openai']
    const env = { CI: '1', HOME: materials.paths.home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', NO_PROXY: '127.0.0.1,localhost',
      OPENAI_API_KEY: relay.capability, OPENAI_BASE_URL: relay.endpoint, PATH: '/usr/bin:/bin', QWEN_HOME: materials.paths.qwenHome,
      QWEN_TELEMETRY_ENABLED: '0', QWEN_USAGE_STATISTICS_ENABLED: '0', TMPDIR: materials.paths.tmp }
    const guardian = spawn(materials.paths.guardian, qwenArgv, { cwd: materials.paths.workspace, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
    const guardianExited = outcome(guardian); guardian.once('error', () => {})
    const birth = launches
    launched.set(handleId, Object.freeze({ birth, handleId, guardianPid: guardian.pid }))
    const control = guardianControl(guardian.stdout); const guardianDiagnostic = captureBoundedTail(guardian.stderr)
    const qwenInput = guardian.stdio[3]; const qwenOutput = guardian.stdio[4]; const qwenError = guardian.stdio[5]
    const qwenDiagnostic = captureBoundedTail(qwenError); const boundedOutput = createBoundedNdjsonInput(); qwenOutput.pipe(boundedOutput)
    const record = { birth, handleId, guardian, guardianExited, guardianDiagnostic, phase: 'starting', qwenDiagnostic, qwenExit: control.exited, qwenPid: undefined,
      nativeSessionId: undefined, prompt: undefined, updates: 0, permissions: 0, disposing: undefined, reaping: undefined,
      lifecycleAbort: new AbortController(), drainFailure: undefined, client: undefined }
    handles.set(handleId, record)
    try {
      record.client = new ClientSideConnection(() => ({
        requestPermission: async params => {
          record.permissions += 1; const prompt = record.prompt
          if (prompt === undefined) return { outcome: { outcome: 'cancelled' } }
          return callback(prompt, signal => onPermission({ handleId, promptId: prompt.id, params, signal }), { outcome: { outcome: 'cancelled' } })
        },
        sessionUpdate: async params => {
          record.updates += 1; updateParams(params)
          const prompt = record.prompt
          if (prompt !== undefined) await callback(prompt, signal => onUpdate({ handleId, promptId: prompt.id, params, signal }))
          else if (record.phase !== 'loading' && TURN_UPDATE_TYPES.has(params.update.sessionUpdate)) throw new Error('Qwen emitted a turn update without an active prompt')
        },
        readTextFile: async () => { throw new Error('Qwen client filesystem read capability is disabled') },
        writeTextFile: async () => { throw new Error('Qwen client filesystem write capability is disabled') },
      }), ndJsonStream(Writable.toWeb(qwenInput), Readable.toWeb(boundedOutput)))
      boundedOutput.once('error', () => { void dispose({ handleId }) })
      assertActive(record, signal); guardian.stdin.write('S')
      record.qwenPid = await abortable(timeout(control.pid, 'Qwen guarded spawn', 5_000), signal)
      launched.set(handleId, Object.freeze({ birth, handleId, guardianPid: guardian.pid, qwenPid: record.qwenPid }))
      assertActive(record, signal)
      return record
    } catch (error) { await dispose({ handleId }).catch(() => {}); throw error }
  }

  async function initialize(record, signal) {
    const initialized = await abortable(timeout(record.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), 'Qwen initialize'), signal)
    assertActive(record, signal)
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('Qwen negotiated an unexpected ACP protocol version')
    if (initialized.agentCapabilities?.loadSession !== true) throw new Error('Qwen did not advertise loadSession')
    return initialized
  }

  async function selectFixedMode(record, response, signal) {
    const modes = response?.modes
    if (!Array.isArray(modes?.availableModes) || !modes.availableModes.some(mode => mode?.id === 'default')) {
      throw new Error('Qwen did not advertise the fixed default approval mode')
    }
    await abortable(timeout(record.client.setSessionMode({ sessionId: record.nativeSessionId, modeId: 'default' }), 'Qwen fixed session mode'), signal)
    assertActive(record, signal)
  }

  async function create(_input, context) {
    const handleId = id(context.handleId, 'handleId'); assertActive(undefined, context.signal)
    reserve(handleId); let record
    try {
      await relay.admit('create', context.signal); assertActive(undefined, context.signal)
      if (!reservations.has(handleId)) throw new Error('Qwen handle reservation was revoked')
      record = await launch(handleId, context.signal); reservations.delete(handleId)
      const initialized = await initialize(record, context.signal)
      record.phase = 'loading'
      const session = await abortable(timeout(record.client.newSession({ cwd: materials.paths.workspace, mcpServers: servers }), 'Qwen newSession'), context.signal)
      assertActive(record, context.signal); record.nativeSessionId = id(session.sessionId, 'nativeSessionId')
      await selectFixedMode(record, session, context.signal); record.phase = 'ready'
      return { initialized, nativeSessionId: record.nativeSessionId }
    } catch (error) { reservations.delete(handleId); await dispose({ handleId }); throw error }
  }

  async function load(input, context) {
    const handleId = id(context.handleId, 'handleId'); const nativeSessionId = id(input.nativeSessionId, 'nativeSessionId'); assertActive(undefined, context.signal)
    reserve(handleId); let record
    try {
      await relay.admit('resume', context.signal); assertActive(undefined, context.signal)
      if (!reservations.has(handleId)) throw new Error('Qwen handle reservation was revoked')
      record = await launch(handleId, context.signal); reservations.delete(handleId)
      const initialized = await initialize(record, context.signal)
      record.phase = 'loading'
      const session = await abortable(timeout(record.client.loadSession({ cwd: materials.paths.workspace, mcpServers: servers, sessionId: nativeSessionId }), 'Qwen loadSession'), context.signal)
      assertActive(record, context.signal); record.nativeSessionId = nativeSessionId
      await selectFixedMode(record, session, context.signal); record.phase = 'ready'
      return { initialized, nativeSessionId }
    } catch (error) { reservations.delete(handleId); await dispose({ handleId }); throw error }
  }

  async function prompt(input, context) {
    const record = handles.get(id(context.handleId, 'handleId'))
    if (record === undefined) throw new Error('Qwen handle is not active')
    assertActive(record, context.signal)
    if (record.nativeSessionId === undefined || record.prompt !== undefined) throw new Error('Qwen handle is not ready for a prompt')
    const promptId = id(context.promptId, 'promptId'); const done = Promise.withResolvers()
    const prompt = { id: promptId, signal: context.signal, done, accepting: true, callbackAbort: new AbortController(), callbacks: new Set() }; record.prompt = prompt
    try { await relay.admit('prompt', context.signal); assertActive(record, context.signal); if (record.prompt !== prompt) throw new Error('Qwen prompt reservation was revoked') }
    catch (error) { if (record.prompt === prompt) record.prompt = undefined; throw error }
    const abort = () => { void record.client.cancel({ sessionId: record.nativeSessionId }).catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true }); record.phase = 'prompt'
    try {
      const operation = record.client.prompt({ sessionId: record.nativeSessionId, prompt: promptBlocks(input.prompt) })
      try {
        const result = await abortable(timeout(operation, 'Qwen prompt'), AbortSignal.any([context.signal, record.lifecycleAbort.signal]))
        await drainCallbacks(prompt)
        return { nativeSessionId: record.nativeSessionId, result }
      }
      catch (error) {
        const failures = [error]
        if (!record.lifecycleAbort.signal.aborted) await record.client.cancel({ sessionId: record.nativeSessionId }).catch(() => {})
        try { await timeout(operation.catch(() => {}), 'Qwen cancelled prompt settlement', 5_000) }
        catch (settlementError) {
          failures.push(settlementError); prompt.accepting = false
          try { await reap(record) } catch (reapError) { failures.push(reapError) }
          if (handles.get(record.handleId) === record && record.disposing === undefined) handles.delete(record.handleId)
        }
        try { await drainCallbacks(prompt) } catch (callbackError) { failures.push(callbackError); void reap(record).catch(() => {}) }
        const failure = combined(failures, 'Qwen prompt failed to settle cleanly')
        if (failures.length > 1) record.drainFailure ??= failure
        throw failure
      }
    } finally { context.signal.removeEventListener('abort', abort); if (record.prompt === prompt) record.prompt = undefined; done.resolve();
      if (handles.get(record.handleId) === record && record.disposing === undefined && record.reaping === undefined && record.drainFailure === undefined) record.phase = 'ready' }
  }

  async function cancel({ handleId, promptId }) {
    if (!accepting) throw new Error('Qwen engine is disposed')
    const record = handles.get(id(handleId, 'handleId')); const expected = id(promptId, 'promptId')
    if (record?.nativeSessionId !== undefined && record.prompt?.id === expected) {
      const prompt = record.prompt
      try {
        await timeout(record.client.cancel({ sessionId: record.nativeSessionId }), 'Qwen cancel request', 5_000)
        await timeout(prompt.done.promise, 'Qwen cancelled prompt drain', 5_000)
      } catch (error) {
        await dispose({ handleId })
        throw error
      }
    }
  }

  function dispose({ handleId }) {
    const record = handles.get(handleId)
    if (record === undefined) return Promise.resolve(undefined)
    return (record.disposing ??= (async () => {
      const failures = []
      try {
        record.phase = 'disposing'
        if (record.prompt !== undefined) {
          record.prompt.accepting = false; record.prompt.callbackAbort.abort(new Error('Qwen handle disposed'))
          try { await timeout(record.prompt.done.promise, 'Qwen active prompt disposal drain', 5_000) }
          catch (error) { failures.push(error) }
        }
        if (record.drainFailure !== undefined) failures.push(record.drainFailure)
        let result
        try { result = await reap(record) } catch (error) { failures.push(error); terminalFailure(record, error) }
        const error = combined(failures, 'Qwen handle disposal failed')
        if (error !== undefined) throw error
        return result
      } finally { if (handles.get(handleId) === record) handles.delete(handleId) }
    })())
  }

  function close() {
    return (closing ??= (async () => {
      accepting = false
      if (reservations.size !== 0) throw new Error('Qwen engine close found pending create/load reservations')
      const results = await Promise.allSettled([...handles.values()].map(record => dispose({ handleId: record.handleId })))
      const failures = results.filter(result => result.status === 'rejected')
      try { await relay.dispose() } catch (error) { failures.push({ reason: error }) }
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Qwen engine teardown failed')
      const launchesLedger = [...launched.values()].sort((first, second) => first.birth - second.birth)
      const terminalLedger = launchesLedger.map(row => terminal.get(row.handleId))
      if (terminalLedger.some(row => row === undefined || row.state !== 'reaped')) throw new Error('Qwen engine teardown has incomplete launch cleanup history')
      return Object.freeze({ launchedHandles: Object.freeze(launchesLedger), terminalCleanup: Object.freeze(terminalLedger) })
    })())
  }

  return Object.freeze({ cancel, close, create, dispose, load, prompt,
    stats: () => Object.freeze({ accepting, handles: handles.size, model,
      processes: [...handles.values()].map(record => Object.freeze({ guardianPid: record.guardian.pid, qwenPid: record.qwenPid })) }) })
}
