import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAcpModelRelay } from '../drivers/acp/model-relay.mjs'
import { buildLumxNativeBootstrap } from './native/build.mjs'
import { prepareExternalEngineOwner } from './external-engine-owner.mjs'
import { createLumxHostSandboxProfile } from './host-profile.mjs'

const HOST_ENTRY = fileURLToPath(new URL('./host-entry.mjs', import.meta.url))
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function sha256File(path) { return sha256(readFileSync(path)) }
function plainFile(path, label) {
  const absolute = resolve(path)
  if (!lstatSync(absolute).isFile()) throw new Error(`${label} must be a regular file`)
  return realpathSync(absolute)
}
function directory(path, label) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a direct directory`)
  const identity = statSync(path)
  return Object.freeze({ dev: identity.dev, ino: identity.ino, path: realpathSync(path) })
}
function sameDirectory(path, expected, label) {
  const current = directory(path, label)
  if (current.path !== expected.path || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`${label} identity changed after preparation`)
}
function loopback(value, label) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash) throw new Error(`${label} must use literal IPv4 loopback HTTP`)
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${label} needs an explicit port`)
  return { url: url.href, port }
}
function tcpPort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('Host port is invalid')
  return value
}
function consumer(value) {
  const selected = value ?? 'desktop-byok'
  if (!['desktop-byok', 'external-qwen', 'governed-h1', 'platform-stub'].includes(selected)) throw new Error('Host product consumer is invalid')
  return selected
}
function launchEnvironment(value = {}) {
  const allowed = new Set(['LUMX_TELEMETRY_ENABLED'])
  for (const [name, setting] of Object.entries(value)) if (!allowed.has(name) || typeof setting !== 'string') throw new Error(`Host environment entry is not allowed: ${name}`)
  return { ...value }
}
function overlaps(first, second) {
  const inside = (candidate, parent) => { const value = relative(parent, candidate); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)) }
  return inside(first, second) || inside(second, first)
}
function dataHomeFor(mode, osHome, workspace) {
  const selectedPath = join(osHome, mode === 'developer' ? '.lumx-developer' : '.lumx')
  const siblingPath = join(osHome, mode === 'developer' ? '.lumx' : '.lumx-developer')
  const inspect = (path, create) => {
    try { return directory(path, 'LUMX data home').path } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (!create) return resolve(path)
      mkdirSync(path, { mode: 0o700 }); return directory(path, 'LUMX data home').path
    }
  }
  const selected = inspect(selectedPath, true); const sibling = inspect(siblingPath, false)
  if (overlaps(selected, sibling)) throw new Error('consumer and developer data homes must remain distinct')
  if (overlaps(workspace, selected) || overlaps(workspace, sibling)) throw new Error('Host workspace must remain outside both LUMX data homes')
  return selected
}
async function reservePort(port) {
  const server = createServer()
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady) })
  let released
  return () => (released ??= new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())))
}

/** Prepare, freeze, and anchor every Host launch input before any Host process exists. */
export async function prepareLumxHostLaunch(input) {
  input.signal?.throwIfAborted()
  if (input.mode !== 'consumer' && input.mode !== 'developer') throw new Error('Host mode is invalid')
  const nodePath = plainFile(input.nodePath, 'Node executable')
  if (sha256File(nodePath) !== input.nodeSha256) throw new Error('Node executable differs from caller anchor')
  const sourceRoot = realpathSync(input.sourceRoot); const forkRoot = realpathSync(input.forkRoot)
  const osHome = directory(realpathSync(input.osHome), 'OS home').path
  const workspaceDirectory = directory(realpathSync(input.workspaceDirectory), 'Host workspace').path
  const dataHome = dataHomeFor(input.mode, osHome, workspaceDirectory); const port = tcpPort(input.port)
  const selectedConsumer = consumer(input.consumer); const environment = launchEnvironment(input.environment)
  const model = selectedConsumer === 'desktop-byok' ? loopback(input.auth?.endpoint, 'model endpoint') : undefined
  const h1 = selectedConsumer === 'governed-h1' ? { broker: loopback(input.h1?.brokerEndpoint, 'H1 Broker endpoint'), model: loopback(input.h1?.modelEndpoint, 'H1 model endpoint') } : undefined
  const releasePort = await reservePort(port)
  const runtime = realpathSync(mkdtempSync(join(input.runtimeParent ?? tmpdir(), 'lumx-host-')))
  let relay; let externalOwner
  try {
    const hostRuntime = join(runtime, 'host'); const frozen = join(hostRuntime, 'frozen')
    const processHome = join(hostRuntime, 'home'); const temporary = join(hostRuntime, 'tmp')
    for (const path of [hostRuntime, frozen, processHome, temporary]) mkdirSync(path, { mode: 0o700 })
    const bootstrap = buildLumxNativeBootstrap(join(frozen, 'lumx-bootstrap'))
    if (selectedConsumer === 'desktop-byok') relay = await createAcpModelRelay({ engineId: 'dsh-host', gateway: input.auth.gateway, getIdentity: input.auth.getIdentity,
      launchId: input.launchId, model: 'lumx-loopback', providerEndpoint: model.url, providerKey: input.auth.byokKey, sessionId: input.launchId })
    if (selectedConsumer === 'external-qwen') externalOwner = await prepareExternalEngineOwner({ ...input, dataHome, runtime, nodePath, workspaceDirectory })
    const privateRoots = [join(osHome, '.lumx', '.private'), join(osHome, '.lumx-developer', '.private')]
    const profile = createLumxHostSandboxProfile({ dataHome, forkRoot, nodePath, privateRoots, processHome, runtime: hostRuntime, sourceRoot, temporary, workspaceDirectory,
      ports: [port, ...relay === undefined ? [] : [Number(new URL(relay.endpoint).port)], ...h1 === undefined ? [] : [h1.broker.port, h1.model.port]] })
    const profilePath = join(frozen, 'lumx-host.sb'); writeFileSync(profilePath, profile, { mode: 0o400 })
    const payload = { consumer: selectedConsumer, mode: input.mode, osHome, workspaceDirectory, sourceRoot, port, environment, nodePath, generation: randomUUID(),
      ...selectedConsumer === 'desktop-byok' ? { modelEndpoint: `${relay.endpoint}/chat/completions`, relayCapability: relay.capability } : {},
      ...selectedConsumer === 'external-qwen' ? { external: { artifactIdentity: externalOwner.artifactIdentity, engineId: externalOwner.engineId, model: externalOwner.model } } : {},
      ...selectedConsumer === 'governed-h1' ? { h1: { brokerEndpoint: h1.broker.url, modelEndpoint: h1.model.url } } : {},
      fdTargets: input.fdQualification?.targets ?? [0, 3, 10, 11, 512], canary: input.fdQualification?.canary ?? { path: join(runtime, 'absent-canary'), dev: -1, ino: -1, bytes: 0, sha256: sha256('') },
      protectedPaths: input.fdQualification?.protectedPaths ?? [] }
    const config = { version: 2, configSha256: sha256(Buffer.from(JSON.stringify(payload))), payload }
    const configPath = join(frozen, 'host-config.json'); writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o400 })
    chmodSync(bootstrap, 0o500); chmodSync(frozen, 0o500)
    const paths = Object.freeze({ bootstrap, configPath, frozen, hostEntry: HOST_ENTRY, hostRuntime, processHome, profilePath, runtime, temporary })
    const anchors = Object.freeze({ bootstrapSha256: sha256File(bootstrap), configFileSha256: sha256File(configPath), hostEntrySha256: sha256File(HOST_ENTRY), nodeSha256: input.nodeSha256,
      profileSha256: sha256File(profilePath), directories: Object.freeze(Object.fromEntries(['dataHome', 'frozen', 'hostRuntime', 'processHome', 'runtime', 'temporary', 'workspaceDirectory']
        .map(name => [name, directory({ dataHome, frozen, hostRuntime, processHome, runtime, temporary, workspaceDirectory }[name], name)]))) })
    let consumed = false; let cleaned = false
    const materials = { anchors, dataHome, externalOwner, forkRoot, h1, input, nodePath, paths, payload, port, profile, relay, sourceRoot,
      async releaseReservation() { if (consumed) throw new Error('Host launch material was already consumed'); consumed = true; await releasePort() },
      cleanup: async () => { if (cleaned) return; cleaned = true; await releasePort().catch(() => {}); await relay?.dispose().catch(() => {}); await externalOwner?.close().catch(() => {});
        try { chmodSync(frozen, 0o700) } catch {}; rmSync(runtime, { recursive: true, force: true }) } }
    return Object.freeze(materials)
  } catch (error) {
    await releasePort().catch(() => {}); await relay?.dispose().catch(() => {}); await externalOwner?.close().catch(() => {})
    rmSync(runtime, { recursive: true, force: true }); throw error
  }
}

/** Revalidate exact prepared bytes and path identities immediately before launch. */
export function verifyLumxHostLaunch(materials) {
  for (const [name, path, expected] of [
    ['bootstrap', materials.paths.bootstrap, materials.anchors.bootstrapSha256],
    ['config', materials.paths.configPath, materials.anchors.configFileSha256],
    ['entry', materials.paths.hostEntry, materials.anchors.hostEntrySha256],
    ['profile', materials.paths.profilePath, materials.anchors.profileSha256],
  ]) if (sha256File(path) !== expected) throw new Error(`Host ${name} differs from frozen launch material`)
  if (sha256File(materials.nodePath) !== materials.anchors.nodeSha256) throw new Error('Node differs from frozen Host launch material')
  for (const [name, expected] of Object.entries(materials.anchors.directories)) sameDirectory(expected.path, expected, name)
  return materials
}
