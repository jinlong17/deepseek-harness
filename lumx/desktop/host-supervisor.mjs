import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { buildLumxNativeBootstrap } from './native/build.mjs'
import { createLumxHostSandboxProfile } from './host-profile.mjs'
import { createAcpModelRelay } from '../drivers/acp/model-relay.mjs'

const HOST_ENTRY = fileURLToPath(new URL('./host-entry.mjs', import.meta.url))
const BOOT_FRAME = 'LUMX_BOOTSTRAP_V1\n'

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function sha256File(path) { return sha256(readFileSync(path)) }
function plainFile(path, label) {
  const absolute = resolve(path)
  if (!lstatSync(absolute).isFile()) throw new Error(`${label} must be a regular file`)
  return realpathSync(absolute)
}
function loopback(value, label) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash) {
    throw new Error(`${label} must use literal IPv4 loopback HTTP`)
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${label} needs an explicit port`)
  return { url: url.href, port }
}
function tcpPort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('Host port is invalid')
  return value
}
function launchEnvironment(value = {}) {
  const allowed = new Set(['LUMX_TELEMETRY_ENABLED'])
  for (const [name, setting] of Object.entries(value)) {
    if (!allowed.has(name) || typeof setting !== 'string') throw new Error(`Host environment entry is not allowed: ${name}`)
  }
  return { ...value }
}
function overlaps(first, second) {
  const inside = (candidate, parent) => {
    const value = relative(parent, candidate)
    return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  }
  return inside(first, second) || inside(second, first)
}
function dataHomeFor(mode, osHome, workspaceDirectory) {
  const selectedPath = join(osHome, mode === 'developer' ? '.lumx-developer' : '.lumx')
  const siblingPath = join(osHome, mode === 'developer' ? '.lumx' : '.lumx-developer')
  let selected = selectedPath
  try {
    const metadata = lstatSync(selectedPath)
    if (metadata.isSymbolicLink()) throw new Error('selected LUMX data home must not be a symbolic link')
    if (!metadata.isDirectory()) throw new Error('selected LUMX data home must be a directory')
    selected = realpathSync(selectedPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    // selectedPath is a direct child of the already-resolved OS home, so its
    // closest existing parent is the trusted osHome value.
  }
  let sibling = siblingPath
  try {
    const metadata = lstatSync(siblingPath)
    if (metadata.isSymbolicLink()) throw new Error('sibling LUMX data home must not be a symbolic link')
    if (!metadata.isDirectory()) throw new Error('sibling LUMX data home must be a directory')
    sibling = realpathSync(siblingPath)
  } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (overlaps(selected, sibling)) throw new Error('consumer and developer data homes must remain distinct')
  if (overlaps(workspaceDirectory, selected) || overlaps(workspaceDirectory, sibling)) {
    throw new Error('Host workspace must remain outside both LUMX data homes')
  }
  return selected
}
function processExit(child) { return new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal }))) }
async function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function withAbort(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Host launch cancelled'))
  return new Promise((resolveValue, rejectValue) => {
    const aborted = () => rejectValue(signal.reason ?? new Error('Host launch cancelled'))
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolveValue, rejectValue).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Launch the supported LUMX Host in a fresh native-bootstrap/sandbox/Node process. */
export async function launchLumxHost(input) {
  input.signal?.throwIfAborted()
  if (input.mode !== 'consumer' && input.mode !== 'developer') throw new Error('Host mode is invalid')
  const nodePath = plainFile(input.nodePath, 'Node executable')
  if (sha256File(nodePath) !== input.nodeSha256) throw new Error('Node executable differs from caller anchor')
  const sourceRoot = realpathSync(input.sourceRoot)
  const forkRoot = realpathSync(input.forkRoot)
  const osHome = realpathSync(input.osHome)
  const workspaceDirectory = realpathSync(input.workspaceDirectory)
  const dataHome = dataHomeFor(input.mode, osHome, workspaceDirectory)
  const port = tcpPort(input.port)
  const environment = launchEnvironment(input.environment)
  const model = loopback(input.auth.endpoint, 'model endpoint')
  let runtime
  let relay
  try {
    runtime = realpathSync(mkdtempSync(join(input.runtimeParent ?? tmpdir(), 'lumx-host-')))
    const processHome = join(runtime, 'home'); const temporary = join(runtime, 'tmp')
    mkdirSync(processHome, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 })
    const bootstrap = buildLumxNativeBootstrap(join(runtime, 'lumx-bootstrap'))
    relay = await createAcpModelRelay({
      engineId: 'dsh-host', gateway: input.auth.gateway, getIdentity: input.auth.getIdentity,
      launchId: input.launchId, model: 'lumx-loopback', providerEndpoint: model.url,
      providerKey: input.auth.byokKey, sessionId: input.launchId,
    })
    const relayPort = Number(new URL(relay.endpoint).port)
    const profile = createLumxHostSandboxProfile({
      dataHome, forkRoot, nodePath, runtime, sourceRoot, workspaceDirectory, ports: [port, relayPort],
    })
    const profilePath = join(runtime, 'lumx-host.sb')
    writeFileSync(profilePath, profile, { mode: 0o600 })
    const payload = {
      mode: input.mode, osHome, workspaceDirectory,
      sourceRoot, port, environment, nodePath,
      modelEndpoint: `${relay.endpoint}/chat/completions`, relayCapability: relay.capability,
      fdTargets: input.fdQualification?.targets ?? [0, 3, 10, 11, 512],
      canary: input.fdQualification?.canary ?? { path: join(runtime, 'absent-canary'), dev: -1, ino: -1, bytes: 0, sha256: sha256('') },
      protectedPaths: input.fdQualification?.protectedPaths ?? [],
    }
    const config = { version: 1, configSha256: sha256(Buffer.from(JSON.stringify(payload))), payload }
    const configPath = join(runtime, 'host-config.json')
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })
    const argv = [profilePath, nodePath, HOST_ENTRY, configPath]
    const child = spawn(bootstrap, ['/usr/bin/sandbox-exec', ...argv], {
      cwd: payload.workspaceDirectory, detached: true,
      env: { HOME: processHome, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PATH: '/usr/bin:/bin', TMPDIR: temporary },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = processExit(child)
    child.stdin.on('error', () => {})
    let stderr = ''; const stdout = []
    let alive = true
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
    const pending = new Map()
    const ready = new Promise((resolveReady, rejectReady) => {
      child.once('error', rejectReady)
      child.once('exit', (code, signal) => {
        alive = false
        const error = new Error(`Host exited (${code ?? signal}): ${stderr}`)
        rejectReady(error)
        for (const waiter of pending.values()) waiter.reject(error)
        pending.clear()
      })
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      lines.on('line', line => {
        stdout.push(line)
        try {
          const value = JSON.parse(line)
          if (value.type === 'ready') resolveReady(value)
          if ((value.type === 'health' || value.type === 'inspect-session') && pending.has(value.id)) { pending.get(value.id).resolve(value); pending.delete(value.id) }
        } catch {}
      })
    })
    child.stdin.write(BOOT_FRAME)
    let readyValue
    try {
      const startup = withTimeout(ready, input.startupTimeoutMs ?? 30_000, 'Host startup')
      readyValue = await withAbort(startup, input.signal)
    } catch (error) {
      child.stdin.end()
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 250))])
      if (Number.isSafeInteger(child.pid)) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000))])
      if (Number.isSafeInteger(child.pid)) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      await exited
      await relay.dispose()
      rmSync(runtime, { recursive: true, force: true })
      throw error
    }
    let stopping
    const stop = command => (stopping ??= (async () => {
      try {
        if (command !== undefined) child.stdin.write(`${command}\n`)
        child.stdin.end()
        let outcome = await Promise.race([exited, new Promise(resolveWait => setTimeout(() => resolveWait(undefined), 10_000))])
        if (outcome === undefined) {
          try { process.kill(-child.pid, 'SIGTERM') } catch {}
          outcome = await Promise.race([exited, new Promise(resolveWait => setTimeout(() => resolveWait(undefined), 2_000))])
        }
        if (outcome === undefined) {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
          outcome = await withTimeout(exited, 2_000, 'Host reap after SIGKILL')
        }
        return outcome
      } finally {
        await relay.dispose().catch(() => {})
        rmSync(runtime, { recursive: true, force: true })
      }
    })())
    const shutdown = () => stop('{"command":"shutdown"}')
    const disconnect = () => stop(undefined)
    const requestControl = (command, timeoutLabel) => {
      if (stopping !== undefined) return Promise.reject(new Error('Host is shutting down'))
      if (!alive) return Promise.reject(new Error('Host process is not running'))
      const id = randomUUID()
      const response = new Promise((resolveResponse, rejectResponse) => pending.set(id, { resolve: resolveResponse, reject: rejectResponse }))
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
      return withTimeout(response, 30_000, timeoutLabel).finally(() => pending.delete(id))
    }
    const healthCheck = () => requestControl({ command: 'health' }, 'Host health check')
    const inspectSession = sessionId => /^[0-9a-f-]{36}$/u.test(sessionId)
      ? requestControl({ command: 'inspect-session', sessionId }, 'Host session inspection')
      : Promise.reject(new Error('Host session identity is invalid'))
    return Object.freeze({
      baseUrl: readyValue.baseUrl, bootstrap: { path: bootstrap, sha256: sha256File(bootstrap) },
      canaryPathError: readyValue.canaryPathError, configSha256: readyValue.configSha256,
      control: Object.freeze({ disconnect, healthCheck, inspectSession, shutdown }), fdObservation: readyValue.fdObservation,
      childFdObservation: readyValue.childFdObservation, hostProfile: { bytes: profile, path: profilePath, sha256: sha256(profile) },
      execution: Object.freeze({ argv: Object.freeze([bootstrap, '/usr/bin/sandbox-exec', ...argv]), envKeys: Object.freeze(['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR']) }),
      pid: child.pid, process: Object.freeze({ pid: child.pid }), readyUrl: readyValue.readyUrl,
      protectedPathErrors: readyValue.protectedPathErrors,
      shutdown, stderr: () => stderr, stdout: () => [...stdout],
    })
  } catch (error) {
    await relay?.dispose().catch(() => {})
    if (runtime !== undefined) rmSync(runtime, { recursive: true, force: true })
    throw error
  }
}
