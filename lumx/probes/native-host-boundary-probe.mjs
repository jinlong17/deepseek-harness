import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'

import { observeFileDescriptors } from '../desktop/fd-observer.mjs'
import { launchLumxHost } from '../desktop/host-supervisor.mjs'

const NODE = '/Users/jinlong/.local/opt/node-v24.20.0/bin/node'
const NODE_SHA256 = '9d050fd455b56426e25d4d603c7c501cbb2630348e836cf221dcce748e90588a'
const SOURCE = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deps-source'
const FORK = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deepseek-harness'
const TARGETS = [0, 1, 2, 3, 10, 11, 512]

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`missing ${name}`)
  return resolve(process.argv[index + 1])
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady); server.listen(0, '127.0.0.1', resolveReady)
  })
  return server
}
async function freePort() {
  const server = await listen((_, response) => response.end())
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}
function directControl(profile, canary) {
  return new Promise((resolveControl, rejectControl) => {
    const observer = join(FORK, 'lumx/desktop/fd-observer.mjs')
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, NODE, observer, '--child', JSON.stringify({ targets: [3], canary })], {
      env: { HOME: dirname(profile), PATH: '/usr/bin:/bin', TMPDIR: dirname(profile) },
      stdio: ['ignore', 'pipe', 'pipe', 3],
    })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
    child.once('error', rejectControl)
    child.once('close', (code, signal) => code === 0
      ? resolveControl({ code, signal, observations: JSON.parse(stdout) })
      : rejectControl(new Error(`direct control failed (${code ?? signal}): ${stderr}`)))
  })
}

const output = argument('--output')
const canaryPath = argument('--canary')
const root = dirname(output)
const osHome = join(root, 'os-home'); const workspace = join(root, 'workspace')
mkdirSync(osHome, { recursive: true, mode: 0o700 }); mkdirSync(workspace, { recursive: true, mode: 0o700 })
const consumerHome = join(osHome, '.lumx'); mkdirSync(consumerHome, { mode: 0o700 })
const siblingCanary = join(consumerHome, 'consumer-account-canary'); writeFileSync(siblingCanary, 'consumer-secret\n', { mode: 0o600 })
const osHomeCanary = join(osHome, 'os-home-canary'); writeFileSync(osHomeCanary, 'os-home-secret\n', { mode: 0o600 })
const canaryBytes = readFileSync(canaryPath)
const canaryStat = fstatSync(3)
const positional = Buffer.alloc(canaryBytes.length)
const positionalBytes = readSync(3, positional, 0, positional.length, 0)
const canary = { path: canaryPath, dev: canaryStat.dev, ino: canaryStat.ino, bytes: positionalBytes, sha256: sha256(positional.subarray(0, positionalBytes)) }
const attackerObservation = observeFileDescriptors(TARGETS, canary)
let providerRequests = 0
const provider = await listen(async (request, response) => {
  providerRequests += 1
  for await (const _ of request) { /* consume */ }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ text: 'host-relay-positive' }))
})
let identity = { credential: 'synthetic-identity', expiresAt: '2099-01-01T00:00:00.000Z', subject: 'b1-user', type: 'lumx.local-auth.v1' }
let host
try {
  host = await launchLumxHost({
    auth: {
      byokKey: 'synthetic-provider-only', endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      gateway: { validate: async value => ({ active: true, expiresAt: identity?.expiresAt, subject: value.subject }) },
      getIdentity: () => identity,
    },
    fdQualification: { canary, protectedPaths: [siblingCanary, osHomeCanary], targets: TARGETS },
    forkRoot: FORK, launchId: randomUUID(), mode: 'developer',
    nodePath: NODE, nodeSha256: NODE_SHA256, osHome, port: await freePort(), sourceRoot: SOURCE,
    workspaceDirectory: workspace,
  })
  const ready = await fetch(host.readyUrl, { redirect: 'manual' })
  const oldDirect = await directControl(host.hostProfile.path, canary)
  const positive = await host.control.healthCheck()
  const providerRequestsAfterPositive = providerRequests
  identity = undefined
  const denied = await host.control.healthCheck()
  const firstShutdown = host.shutdown()
  const secondShutdown = host.shutdown()
  const repeatedShutdownSamePromise = firstShutdown === secondShutdown
  const shutdown = await firstShutdown
  writeFileSync(output, `${JSON.stringify({
    attackerObservation, bootstrap: host.bootstrap, canary, canaryPathError: host.canaryPathError,
    childObservation: host.childFdObservation, configSha256: host.configSha256, denied, execution: host.execution,
    hostObservation: host.fdObservation, hostProfile: { bytes: host.hostProfile.bytes, sha256: host.hostProfile.sha256 },
    oldDirect, positive, providerRequests, readyStatus: ready.status, repeatedShutdownSamePromise, shutdown,
    protectedPathErrors: host.protectedPathErrors,
    supportedChain: ['native-adversarial-parent', 'supervisor', 'native-bootstrap', 'sandbox-exec', 'fresh-node-host'],
    unauthorizedProviderIo: providerRequests - providerRequestsAfterPositive,
  }, null, 2)}\n`, { mode: 0o600 })
} finally {
  await host?.shutdown().catch(() => {})
  closeSync(3)
  await new Promise(resolveClose => provider.close(resolveClose))
}
