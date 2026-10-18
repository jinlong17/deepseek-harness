import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { buildLumxNativeBootstrap } from './native/build.mjs'
import { createLumxHostSandboxProfile } from './host-profile.mjs'
import { createAcpModelRelay } from '../drivers/acp/model-relay.mjs'
import { prepareExternalEngineOwner } from './external-engine-owner.mjs'
import { createHostProcessBridge } from './host-process-bridge.mjs'

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
function hostConsumer(value) {
  const consumer = value ?? 'desktop-byok'
  if (!['desktop-byok', 'external-qwen', 'governed-h1', 'platform-stub'].includes(consumer)) {
    throw new Error('Host product consumer is invalid')
  }
  return consumer
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
  const consumer = hostConsumer(input.consumer)
  const model = consumer === 'desktop-byok'
    ? loopback(input.auth?.endpoint, 'model endpoint') : undefined
  const h1 = consumer === 'governed-h1' ? {
    broker: loopback(input.h1?.brokerEndpoint, 'H1 Broker endpoint'),
    model: loopback(input.h1?.modelEndpoint, 'H1 model endpoint'),
  } : undefined
  let runtime
  let relay
  let externalOwner
  let bridge
  try {
    runtime = realpathSync(mkdtempSync(join(input.runtimeParent ?? tmpdir(), 'lumx-host-')))
    const hostRuntime = join(runtime, 'host'); mkdirSync(hostRuntime, { mode: 0o700 })
    const processHome = join(hostRuntime, 'home'); const temporary = join(hostRuntime, 'tmp')
    mkdirSync(processHome, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 })
    const bootstrap = buildLumxNativeBootstrap(join(hostRuntime, 'lumx-bootstrap'))
    if (consumer === 'desktop-byok') {
      relay = await createAcpModelRelay({
        engineId: 'dsh-host', gateway: input.auth.gateway, getIdentity: input.auth.getIdentity,
        launchId: input.launchId, model: 'lumx-loopback', providerEndpoint: model.url,
        providerKey: input.auth.byokKey, sessionId: input.launchId,
      })
    }
    if (consumer === 'external-qwen') externalOwner = await prepareExternalEngineOwner({ ...input, runtime, nodePath, workspaceDirectory })
    const profile = createLumxHostSandboxProfile({
      dataHome, forkRoot, nodePath, runtime: hostRuntime, sourceRoot, workspaceDirectory,
      ports: [port, ...relay === undefined ? [] : [Number(new URL(relay.endpoint).port)],
        ...h1 === undefined ? [] : [h1.broker.port, h1.model.port]],
    })
    const profilePath = join(hostRuntime, 'lumx-host.sb')
    writeFileSync(profilePath, profile, { mode: 0o600 })
    const payload = {
      consumer, mode: input.mode, osHome, workspaceDirectory,
      sourceRoot, port, environment, nodePath, generation: randomUUID(),
      ...consumer === 'desktop-byok' ? {
        modelEndpoint: `${relay.endpoint}/chat/completions`, relayCapability: relay.capability,
      } : {},
      ...consumer === 'external-qwen' ? { external: { artifactIdentity: externalOwner.artifactIdentity, engineId: externalOwner.engineId, model: externalOwner.model } } : {},
      ...consumer === 'governed-h1' ? { h1: { brokerEndpoint: h1.broker.url, modelEndpoint: h1.model.url } } : {},
      fdTargets: input.fdQualification?.targets ?? [0, 3, 10, 11, 512],
      canary: input.fdQualification?.canary ?? { path: join(runtime, 'absent-canary'), dev: -1, ino: -1, bytes: 0, sha256: sha256('') },
      protectedPaths: input.fdQualification?.protectedPaths ?? [],
    }
    const config = { version: 2, configSha256: sha256(Buffer.from(JSON.stringify(payload))), payload }
    const configPath = join(hostRuntime, 'host-config.json')
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })
    const argv = [profilePath, nodePath, HOST_ENTRY, configPath]
    const child = spawn(bootstrap, ['/usr/bin/sandbox-exec', ...argv], {
      cwd: payload.workspaceDirectory, detached: true,
      env: { HOME: processHome, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PATH: '/usr/bin:/bin', TMPDIR: temporary },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = processExit(child)
    child.stdin.on('error', () => {})
    let stderr = ''
    let alive = true
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(-64 * 1024) })
    const ready = new Promise((resolveReady, rejectReady) => {
      child.once('error', rejectReady)
      child.once('exit', (code, signal) => {
        alive = false
        const error = new Error(`Host exited (${code ?? signal}): ${stderr}`)
        rejectReady(error)
      })
      const unavailable = Object.freeze({ admit() { throw new Error('engine channel is unavailable') }, create() { throw new Error('engine channel is unavailable') }, load() { throw new Error('engine channel is unavailable') }, prompt() { throw new Error('engine channel is unavailable') }, cancel() {}, dispose() {} })
      bridge = createHostProcessBridge({ child, engine: externalOwner?.engine ?? unavailable, generation: payload.generation })
      bridge.ready.then(resolveReady, rejectReady)
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
      await relay?.dispose()
      await externalOwner?.close().catch(() => {})
      rmSync(runtime, { recursive: true, force: true })
      throw error
    }
    let stopping
    const stop = command => (stopping ??= (async () => {
      try {
        if (command !== undefined) void bridge.request({ command }, 'Host shutdown').catch(() => {})
        else await bridge.close().catch(() => {})
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
        await bridge?.close().catch(() => {})
        await relay?.dispose().catch(() => {})
        await externalOwner?.close().catch(() => {})
        rmSync(runtime, { recursive: true, force: true })
      }
    })())
    const shutdown = () => stop('shutdown')
    const disconnect = () => stop(undefined)
    const requestControl = (command, timeoutLabel) => {
      if (stopping !== undefined) return Promise.reject(new Error('Host is shutting down'))
      if (!alive) return Promise.reject(new Error('Host process is not running'))
      return bridge.request(command, timeoutLabel).then(value => ({ type: command.command, status: 'pass', ...value }), error => ({ type: command.command, status: 'fail', error: error.message }))
    }
    const healthCheck = () => requestControl({ command: 'health' }, 'Host health check')
    const inspectSession = sessionId => /^[0-9a-f-]{36}$/u.test(sessionId)
      ? requestControl({ command: 'inspect-session', sessionId }, 'Host session inspection')
      : Promise.reject(new Error('Host session identity is invalid'))
    return Object.freeze({
      baseUrl: readyValue.baseUrl, bootstrap: { path: bootstrap, sha256: sha256File(bootstrap) },
      consumer: readyValue.consumer, surface: readyValue.surface,
      canaryPathError: readyValue.canaryPathError, configSha256: readyValue.configSha256,
      control: Object.freeze({ disconnect, healthCheck, inspectSession, shutdown }), fdObservation: readyValue.fdObservation,
      childFdObservation: readyValue.childFdObservation, hostProfile: { bytes: profile, path: profilePath, sha256: sha256(profile) },
      governance: readyValue.governance,
      execution: Object.freeze({ argv: Object.freeze([bootstrap, '/usr/bin/sandbox-exec', ...argv]), envKeys: Object.freeze(['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR']) }),
      pid: child.pid, process: Object.freeze({ pid: child.pid }), readyUrl: readyValue.readyUrl,
      protectedPathErrors: readyValue.protectedPathErrors,
      ...consumer === 'external-qwen' ? { acp: bridge.acp, external: Object.freeze({ artifactIdentity: externalOwner.artifactIdentity, engineId: externalOwner.engineId, model: externalOwner.model, observations: externalOwner.observations }) } : {},
      shutdown, stderr: () => stderr, stdout: () => [],
    })
  } catch (error) {
    await relay?.dispose().catch(() => {})
    await externalOwner?.close().catch(() => {})
    if (runtime !== undefined) rmSync(runtime, { recursive: true, force: true })
    throw error
  }
}
