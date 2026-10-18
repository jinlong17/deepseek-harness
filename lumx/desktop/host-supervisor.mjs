import { spawn } from 'node:child_process'
import { createHostProcessBridge } from './host-process-bridge.mjs'
import { verifyLumxHostLaunch } from './host-launch-materials.mjs'

const BOOT_FRAME = 'LUMX_BOOTSTRAP_V1\n'
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

/** Launch only caller-prepared and revalidated LUMX Host material. */
export async function launchLumxHost(prepared, { beforeBootstrap } = {}) {
  const materials = verifyLumxHostLaunch(prepared)
  const { externalOwner, input, nodePath, paths, payload, profile, relay } = materials
  const { bootstrap, configPath, hostEntry, processHome, profilePath, temporary } = paths
  const consumer = payload.consumer
  let bridge
  try {
    input.signal?.throwIfAborted(); await materials.releaseReservation(); verifyLumxHostLaunch(materials)
    const argv = [profilePath, nodePath, hostEntry, configPath]
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
    if (beforeBootstrap !== undefined) {
      if (typeof beforeBootstrap !== 'function') throw new Error('Host pre-bootstrap hook is invalid')
      await withTimeout(beforeBootstrap(Object.freeze({ pgid: child.pid, pid: child.pid })), input.startupTimeoutMs ?? 30_000, 'Host ownership acknowledgement')
    }
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
      await materials.cleanup()
      throw error
    }
    let stopping
    const stop = command => (stopping ??= (async () => {
      let control; let controlError; let outcome; let cleanup
      try {
        if (command !== undefined) try { control = await bridge.request({ command }, 'Host shutdown') } catch (error) { controlError = error }
        else await bridge.close().catch(() => {})
        outcome = await Promise.race([exited, new Promise(resolveWait => setTimeout(() => resolveWait(undefined), 10_000))])
        if (outcome === undefined) {
          try { process.kill(-child.pid, 'SIGTERM') } catch {}
          outcome = await Promise.race([exited, new Promise(resolveWait => setTimeout(() => resolveWait(undefined), 2_000))])
        }
        if (outcome === undefined) {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
          outcome = await withTimeout(exited, 2_000, 'Host reap after SIGKILL')
        }
      } finally {
        await bridge?.close().catch(() => {})
        cleanup = await materials.cleanup()
      }
      if (controlError !== undefined) throw new AggregateError([controlError], 'Host shutdown control failed after process cleanup')
      return { ...outcome, control, ...(cleanup === undefined ? {} : { ownerCleanup: cleanup.externalCleanup }) }
    })())
    const shutdown = () => stop('shutdown')
    const disconnect = () => stop(undefined)
    const requestControl = (command, timeoutLabel, timeoutMs) => {
      if (stopping !== undefined) return Promise.reject(new Error('Host is shutting down'))
      if (!alive) return Promise.reject(new Error('Host process is not running'))
      return bridge.request(command, timeoutLabel, timeoutMs).then(value => ({ type: command.command, status: 'pass', ...value }), error => ({ type: command.command, status: 'fail', error: error.message }))
    }
    const healthCheck = () => requestControl({ command: 'health' }, 'Host health check')
    const qualify = request => requestControl({ command: 'qualify', request }, 'Host qualification', 180_000)
    const inspectSession = sessionId => /^[0-9a-f-]{36}$/u.test(sessionId)
      ? requestControl({ command: 'inspect-session', sessionId }, 'Host session inspection')
      : Promise.reject(new Error('Host session identity is invalid'))
    return Object.freeze({
      baseUrl: readyValue.baseUrl, bootstrap: { path: bootstrap, sha256: materials.anchors.bootstrapSha256 },
      consumer: readyValue.consumer, generation: payload.generation, surface: readyValue.surface,
      canaryPathError: readyValue.canaryPathError, configSha256: readyValue.configSha256,
      control: Object.freeze({ disconnect, healthCheck, inspectSession, ...payload.qualification === undefined ? {} : { qualify }, shutdown }), fdObservation: readyValue.fdObservation,
      childFdObservation: readyValue.childFdObservation, hostProfile: { bytes: profile, path: profilePath, sha256: materials.anchors.profileSha256 },
      governance: readyValue.governance,
      execution: Object.freeze({ argv: Object.freeze([bootstrap, '/usr/bin/sandbox-exec', ...argv]), envKeys: Object.freeze(['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR']) }),
      pid: child.pid, process: Object.freeze({ pid: child.pid }), readyUrl: readyValue.readyUrl,
      protectedPathErrors: readyValue.protectedPathErrors,
      ...consumer === 'external-qwen' ? { acp: bridge.acp, external: Object.freeze({ artifactIdentity: externalOwner.artifactIdentity, engineId: externalOwner.engineId, model: externalOwner.model }) } : {},
      shutdown, stderr: () => stderr, stdout: () => [],
    })
  } catch (error) {
    await materials.cleanup()
    throw error
  }
}
