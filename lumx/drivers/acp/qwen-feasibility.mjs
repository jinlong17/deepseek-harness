import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '../../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { sha256File, treeSha256 } from '../../build/candidate-manifest.mjs'
import { createAcpModelRelay } from './model-relay.mjs'

const WAIT_MS = 15_000
const SETTINGS = `${JSON.stringify({
  privacy: { usageStatisticsEnabled: false },
  skills: { disabledLevels: ['project', 'user', 'extension', 'bundled'] },
  telemetry: { enabled: false, logPrompts: false },
  tools: { approvalMode: 'plan' },
}, null, 2)}\n`

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function timeout(promise, label, ms = WAIT_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}
function sb(path) { return JSON.stringify(realpathSync(path)) }

export function qwenSandboxProfile({ nodePath, qwenRoot, relayPort, runtime, workspace }) {
  return `${[
    '(version 1)', '(allow default)', '(deny network*)',
    '(allow file-read-metadata (literal "/"))',
    '(allow file-read* (literal "/dev/null"))', '(allow file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
    ...['/System', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/Library/Apple'].map(path => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
    `(allow file-read* (subpath ${sb(dirname(dirname(nodePath)))}))`,
    `(allow file-read* (subpath ${sb(qwenRoot)}))`,
    `(allow file-read* file-write* (subpath ${sb(runtime)}))`,
    `(allow file-read* file-write* (subpath ${sb(workspace)}))`,
    `(allow network-outbound (remote tcp4 "localhost:${relayPort}"))`,
    ...[
      '/Users/jinlong/.a2k', '/Users/jinlong/.aws', '/Users/jinlong/.config', '/Users/jinlong/.qwen',
      '/Users/jinlong/.ssh', '/Users/jinlong/.lumx', '/Users/jinlong/.lumx-developer',
      '/Users/jinlong/Library/Keychains', '/Users/jinlong/Desktop/Jinlong_project',
    ].map(path => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`),
    ...['/Users/jinlong/.codex/auth.json', '/Users/jinlong/.npmrc', '/Users/jinlong/.netrc']
      .map(path => `(deny file-read* file-write* (literal ${JSON.stringify(path)}))`),
  ].join('\n')}\n`
}

function syntheticProvider() {
  const requests = []
  let secondSeenResolve
  const secondSeen = new Promise(resolve => { secondSeenResolve = resolve })
  let secondAbortedResolve
  const secondAborted = new Promise(resolve => { secondAbortedResolve = resolve })
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    requests.push({ authorization: request.headers.authorization, body: payload, url: request.url })
    const index = requests.length
    request.once('aborted', () => { if (index === 2) secondAbortedResolve(true) })
    response.once('close', () => { if (index === 2 && !response.writableEnded) secondAbortedResolve(true) })
    if (index === 2) {
      secondSeenResolve()
      return
    }
    response.writeHead(200, { 'content-type': payload.stream ? 'text/event-stream' : 'application/json' })
    if (payload.stream) {
      const base = { id: 'b0b-synthetic', object: 'chat.completion.chunk', created: 0, model: payload.model }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'B0B_OK' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.end(JSON.stringify({ id: 'b0b-synthetic', object: 'chat.completion', created: 0, model: payload.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'B0B_OK' }, finish_reason: 'stop' }] }))
    }
  })
  return { requests, secondAborted, secondSeen, server }
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}
async function close(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(() => resolve()))
}

function processOutcome(child) {
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
}

function clientFor(child, updates) {
  return new ClientSideConnection(() => ({
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: async params => { updates.push(params) },
    readTextFile: async () => { throw new Error('client filesystem capability is disabled') },
    writeTextFile: async () => { throw new Error('client filesystem capability is disabled') },
  }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
}

async function stopChild(child, outcome) {
  if (child.exitCode !== null || child.signalCode !== null) return outcome
  child.stdin.end()
  const graceful = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve(undefined), 2_000))])
  if (graceful !== undefined) return graceful
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  const terminated = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve(undefined), 2_000))])
  if (terminated !== undefined) return terminated
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  return timeout(outcome, 'Qwen process reap', 2_000)
}

function launchQwen(options, relay, paths) {
  const profile = qwenSandboxProfile({ ...options, relayPort: Number(new URL(relay.endpoint).port), ...paths })
  writeFileSync(paths.profile, profile, { mode: 0o600 })
  const argv = ['-f', paths.profile, options.nodePath, '--expose-gc', options.qwenCliPath, '--acp', '--auth-type=openai']
  const env = {
    CI: '1', HOME: paths.home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1',
    NO_PROXY: '127.0.0.1,localhost', OPENAI_API_KEY: relay.capability, OPENAI_BASE_URL: relay.endpoint,
    PATH: '/usr/bin:/bin', QWEN_HOME: paths.qwenHome, QWEN_TELEMETRY_ENABLED: '0',
    QWEN_USAGE_STATISTICS_ENABLED: '0', TMPDIR: paths.tmp,
  }
  const child = spawn('/usr/bin/sandbox-exec', argv, { cwd: paths.workspace, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const outcome = processOutcome(child)
  let stderr = ''
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  return { argv: ['/usr/bin/sandbox-exec', ...argv], child, envKeys: Object.keys(env).sort(), outcome, profile, stderr: () => stderr }
}

function pathsUnder(runtime) {
  const paths = { runtime, home: join(runtime, 'home'), profile: join(runtime, 'engine.sb'), qwenHome: join(runtime, 'qwen-home'), tmp: join(runtime, 'tmp'), workspace: join(runtime, 'workspace') }
  for (const path of [paths.home, paths.qwenHome, paths.tmp, paths.workspace]) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(join(paths.qwenHome, 'settings.json'), SETTINGS, { mode: 0o600 })
  return paths
}

/** Run a non-canonical technical feasibility probe against caller-anchored Qwen bytes. */
export async function runQwenAcpFeasibility(options) {
  const nodePath = realpathSync(options.nodePath)
  const qwenRoot = realpathSync(options.qwenRoot)
  const qwenCliPath = realpathSync(options.qwenCliPath)
  if (sha256File(nodePath) !== options.nodeSha256) throw new Error('Node differs from caller anchor')
  if (sha256File(qwenCliPath) !== options.qwenCliSha256) throw new Error('Qwen CLI differs from caller anchor')
  if (treeSha256(qwenRoot) !== options.qwenTreeSha256) throw new Error('Qwen tree differs from caller anchor')
  if (!qwenCliPath.startsWith(`${qwenRoot}/`)) throw new Error('Qwen CLI escapes caller-anchored root')

  const paths = pathsUnder(realpathSync(options.runtime))
  const provider = syntheticProvider()
  const providerPort = await listen(provider.server)
  let identity = { credential: 'synthetic-local-identity', expiresAt: '2099-01-01T00:00:00.000Z', subject: 'b0b-user', type: 'lumx.local-auth.v1' }
  const relay = await createAcpModelRelay({
    engineId: 'qwen-code-0.24.0', gateway: { validate: async input => ({ active: true, expiresAt: identity.expiresAt, subject: input.subject }) },
    getIdentity: () => identity, launchId: 'b0b-feasibility', model: 'qwen3.7-max',
    providerEndpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`, providerKey: 'synthetic-provider-only', sessionId: 'native-qwen-session',
  })
  const attempts = []
  const launched = []
  try {
    await relay.admit('create')
    const firstUpdates = []
    const first = launchQwen({ ...options, nodePath, qwenRoot, qwenCliPath }, relay, paths)
    launched.push(first)
    const firstClient = clientFor(first.child, firstUpdates)
    const initialized = await timeout(firstClient.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), 'initialize')
    if (initialized.agentCapabilities?.loadSession !== true) throw new Error('Qwen did not advertise loadSession')
    const session = await timeout(firstClient.newSession({ cwd: paths.workspace, mcpServers: [] }), 'newSession')
    await relay.admit('prompt')
    const prompt = await timeout(firstClient.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Return exactly B0B_OK and use no tools.' }] }), 'prompt')
    await relay.admit('prompt')
    const cancelledPrompt = firstClient.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Wait for cancellation and use no tools.' }] })
    await timeout(provider.secondSeen, 'second provider request')
    await firstClient.cancel({ sessionId: session.sessionId })
    const cancelled = await timeout(cancelledPrompt, 'cancelled prompt settle')
    const providerAborted = await timeout(provider.secondAborted, 'cancelled provider abort')
    const firstOutcome = await stopChild(first.child, first.outcome)
    attempts.push({ argv: first.argv, envKeys: first.envKeys, exit: firstOutcome, initialized, phase: 'create-prompt-cancel', prompt, cancelled, providerAborted, stderr: first.stderr() })

    await relay.admit('resume')
    const secondUpdates = []
    const second = launchQwen({ ...options, nodePath, qwenRoot, qwenCliPath }, relay, paths)
    launched.push(second)
    const secondClient = clientFor(second.child, secondUpdates)
    const reinitialized = await timeout(secondClient.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), 'reinitialize')
    await timeout(secondClient.loadSession({ cwd: paths.workspace, mcpServers: [], sessionId: session.sessionId }), 'loadSession')
    const secondOutcome = await stopChild(second.child, second.outcome)
    attempts.push({ argv: second.argv, envKeys: second.envKeys, exit: secondOutcome, initialized: reinitialized, phase: 'fresh-process-load', stderr: second.stderr() })

    return {
      canonical: false, classification: 'B0b technical feasibility only', sessionId: session.sessionId,
      nativeSessionContinuity: { created: session.sessionId, loaded: session.sessionId, same: true },
      anchors: { nodeSha256: options.nodeSha256, qwenCliSha256: options.qwenCliSha256, qwenTreeSha256: options.qwenTreeSha256 },
      attempts, engineProfile: { bytes: first.profile, sha256: digest(first.profile) },
      provider: { requestCount: provider.requests.length, requests: provider.requests.map(row => ({ authorization: row.authorization === 'Bearer synthetic-provider-only' ? 'provider-key-present' : 'unexpected', model: row.body.model, stream: row.body.stream, url: row.url })) },
      credentialRoles: { qwen: 'launch-scoped-relay-capability', provider: 'synthetic-provider-key', hostControl: 'absent-from-engine' },
      lifecycle: { allChildrenExited: attempts.every(attempt => attempt.exit.code !== null || attempt.exit.signal !== null), providerCancelObserved: providerAborted },
      relay: { forwarded: relay.stats.forwarded, providerResponses: relay.stats.providerResponses },
      settings: { bytes: SETTINGS, sha256: digest(SETTINGS) }, updates: { first: firstUpdates.length, loaded: secondUpdates.length },
    }
  } finally {
    identity = undefined
    await relay.dispose()
    await Promise.all(launched.map(child => stopChild(child.child, child.outcome)))
    await close(provider.server)
  }
}

function parse(argv) {
  const map = new Map()
  for (let i = 0; i < argv.length; i += 2) map.set(argv[i], argv[i + 1])
  const required = name => { const value = map.get(name); if (!value) throw new Error(`missing ${name}`); return value }
  return {
    nodePath: required('--node'), nodeSha256: required('--node-sha256'), qwenCliPath: required('--qwen-cli'),
    qwenCliSha256: required('--qwen-cli-sha256'), qwenRoot: required('--qwen-root'),
    qwenTreeSha256: required('--qwen-tree-sha256'), runtime: required('--runtime'),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = await runQwenAcpFeasibility(parse(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
