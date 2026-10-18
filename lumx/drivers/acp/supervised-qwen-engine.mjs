import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '../../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { verifyQwenLaunch } from './qwen-launch-materials.mjs'

const OPERATION_TIMEOUT_MS = 30_000
function withTimeout(promise, label, ms = OPERATION_TIMEOUT_MS) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function outcome(child) { return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) }
function id(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error(`${label} is invalid`)
  return value
}
function fixedServers(value) {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Qwen fixed MCP server catalog is invalid')
  return structuredClone(value)
}
function promptBlocks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128
    || value.some(block => block === null || typeof block !== 'object' || Array.isArray(block))
    || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Qwen prompt payload is invalid')
  return value
}

/** Supervisor-owned official ACP client and Qwen process-group lifecycle. */
export function createSupervisedQwenEngine({ materials, relay, model, mcpServers = [], onUpdate = () => {}, onPermission = async () => ({ outcome: { outcome: 'cancelled' } }) }) {
  const handles = new Map()
  const servers = fixedServers(mcpServers)
  let accepting = true; let launches = 0

  function launch(handleId) {
    if (!accepting) throw new Error('Qwen engine is disposed')
    verifyQwenLaunch(materials, { requireInitialState: launches === 0 }); launches += 1
    const argv = ['-f', materials.paths.profilePath, materials.nodePath, '--expose-gc', materials.qwenCliPath, '--acp', '--auth-type=openai']
    const env = { CI: '1', HOME: materials.paths.home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', NO_PROXY: '127.0.0.1,localhost',
      OPENAI_API_KEY: relay.capability, OPENAI_BASE_URL: relay.endpoint, PATH: '/usr/bin:/bin', QWEN_HOME: materials.paths.qwenHome,
      QWEN_TELEMETRY_ENABLED: '0', QWEN_USAGE_STATISTICS_ENABLED: '0', TMPDIR: materials.paths.tmp }
    const child = spawn('/usr/bin/sandbox-exec', argv, { cwd: materials.paths.workspace, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = outcome(child); child.once('error', () => {})
    let stderr = ''
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
    const guardian = spawn(materials.paths.guardian, [String(child.pid)], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'ignore', 'pipe'] })
    const guardianExited = outcome(guardian); guardian.once('error', () => {})
    let guardianError = ''
    guardian.stderr.setEncoding('utf8'); guardian.stderr.on('data', chunk => { guardianError += chunk })
    const record = { handleId, child, exited, guardian, guardianExited, stderr: () => stderr, guardianError: () => guardianError,
      nativeSessionId: undefined, prompt: undefined, updates: 0, permissions: 0 }
    const client = new ClientSideConnection(() => ({
      requestPermission: async params => {
        record.permissions += 1
        if (record.prompt === undefined) throw new Error('Qwen permission request has no active prompt')
        return onPermission({ handleId, promptId: record.prompt.id, params, signal: record.prompt.signal })
      },
      sessionUpdate: async params => {
        record.updates += 1
        if (record.prompt !== undefined) await onUpdate({ handleId, promptId: record.prompt.id, params })
      },
      readTextFile: async () => { throw new Error('Qwen client filesystem read capability is disabled') },
      writeTextFile: async () => { throw new Error('Qwen client filesystem write capability is disabled') },
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
    record.client = client
    void exited.then(() => { guardian.stdin.end() })
    handles.set(handleId, record)
    return record
  }

  async function initialize(record) {
    const initialized = await withTimeout(record.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), 'Qwen initialize')
    if (initialized.agentCapabilities?.loadSession !== true) throw new Error('Qwen did not advertise loadSession')
    return initialized
  }

  async function create(input, context) {
    const handleId = id(context.handleId, 'handleId')
    if (handles.has(handleId)) throw new Error('Qwen handle already exists')
    await relay.admit('create', context.signal)
    const record = launch(handleId)
    try {
      const initialized = await initialize(record)
      context.signal.throwIfAborted()
      const session = await withTimeout(record.client.newSession({ cwd: materials.paths.workspace, mcpServers: servers }), 'Qwen newSession')
      record.nativeSessionId = id(session.sessionId, 'nativeSessionId')
      return { initialized, nativeSessionId: record.nativeSessionId }
    } catch (error) { await dispose({ handleId }); throw error }
  }

  async function load(input, context) {
    const handleId = id(context.handleId, 'handleId')
    const nativeSessionId = id(input.nativeSessionId, 'nativeSessionId')
    if (handles.has(handleId)) throw new Error('Qwen handle already exists')
    await relay.admit('resume', context.signal)
    const record = launch(handleId)
    try {
      const initialized = await initialize(record)
      context.signal.throwIfAborted()
      await withTimeout(record.client.loadSession({ cwd: materials.paths.workspace, mcpServers: servers, sessionId: nativeSessionId }), 'Qwen loadSession')
      record.nativeSessionId = nativeSessionId
      return { initialized, nativeSessionId }
    } catch (error) { await dispose({ handleId }); throw error }
  }

  async function prompt(input, context) {
    const record = handles.get(id(context.handleId, 'handleId'))
    if (record === undefined || record.nativeSessionId === undefined) throw new Error('Qwen handle is not active')
    if (record.prompt !== undefined) throw new Error('Qwen handle already has a prompt')
    const promptId = id(context.promptId, 'promptId')
    await relay.admit('prompt', context.signal)
    const abort = () => { void record.client.cancel({ sessionId: record.nativeSessionId }).catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) abort()
    record.prompt = { id: promptId, signal: context.signal }
    try {
      const operation = record.client.prompt({ sessionId: record.nativeSessionId, prompt: promptBlocks(input.prompt) })
      let result
      try { result = await withTimeout(operation, 'Qwen prompt') }
      catch (error) {
        if (!context.signal.aborted) await record.client.cancel({ sessionId: record.nativeSessionId }).catch(() => {})
        throw error
      }
      return { nativeSessionId: record.nativeSessionId, result }
    } finally {
      context.signal.removeEventListener('abort', abort)
      record.prompt = undefined
    }
  }

  async function cancel({ handleId }) {
    const record = handles.get(handleId)
    if (record?.nativeSessionId !== undefined) await record.client.cancel({ sessionId: record.nativeSessionId })
  }

  async function dispose({ handleId }) {
    const record = handles.get(handleId)
    if (record === undefined) return
    handles.delete(handleId)
    record.guardian.stdin.end()
    record.child.stdin.end()
    let result = await Promise.race([record.exited, new Promise(resolve => setTimeout(() => resolve(undefined), 2_000))])
    if (result === undefined) { try { process.kill(-record.child.pid, 'SIGTERM') } catch {}; result = await Promise.race([record.exited, new Promise(resolve => setTimeout(() => resolve(undefined), 2_000))]) }
    if (result === undefined) { try { process.kill(-record.child.pid, 'SIGKILL') } catch {}; result = await withTimeout(record.exited, 'Qwen reap', 2_000) }
    const guardianExit = await withTimeout(record.guardianExited, 'Qwen guardian reap', 2_000)
    return { exit: result, guardianExit, stderr: record.stderr(), guardianError: record.guardianError(), permissions: record.permissions, updates: record.updates }
  }

  async function close() {
    if (!accepting) return
    accepting = false
    const results = await Promise.allSettled([...handles.keys()].map(handleId => dispose({ handleId })))
    await relay.dispose()
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Qwen engine teardown failed')
  }

  return Object.freeze({ cancel, close, create, dispose, load, prompt,
    stats: () => Object.freeze({ handles: handles.size, model,
      processes: [...handles.values()].map(record => Object.freeze({ guardianPid: record.guardian.pid, qwenPid: record.child.pid })) }) })
}
