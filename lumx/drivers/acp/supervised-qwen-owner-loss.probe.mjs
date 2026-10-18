import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createAcpModelRelay } from './model-relay.mjs'
import { prepareQwenLaunch } from './qwen-launch-materials.mjs'
import { createSupervisedQwenEngine } from './supervised-qwen-engine.mjs'

function parse(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1])
  const required = name => { const value = values.get(name); if (!value) throw new Error(`missing ${name}`); return value }
  return { helper: values.get('--helper') === 'true', nodePath: required('--node'), nodeSha256: required('--node-sha256'),
    qwenCliPath: required('--qwen-cli'), qwenCliSha256: required('--qwen-cli-sha256'), qwenRoot: required('--qwen-root'),
    qwenTreeSha256: required('--qwen-tree-sha256'), runtime: required('--runtime'), workspace: required('--workspace') }
}
function argumentsFor(options) {
  return ['--node', options.nodePath, '--node-sha256', options.nodeSha256, '--qwen-cli', options.qwenCliPath,
    '--qwen-cli-sha256', options.qwenCliSha256, '--qwen-root', options.qwenRoot,
    '--qwen-tree-sha256', options.qwenTreeSha256, '--runtime', options.runtime, '--workspace', options.workspace]
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}
function outcome(child) { return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) }
function timeout(promise, label, ms) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function gone(pid, group = false) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!alive(pid, group)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}
function firstLine(readable) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const cleanup = () => { readable.off('data', data); readable.off('error', error); readable.off('end', end) }
    const error = value => { cleanup(); reject(value) }
    const end = () => error(new Error('owner-loss helper ended before readiness'))
    const data = chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 64 * 1024) return error(new Error('owner-loss helper output exceeded fixed limit'))
      const newline = bytes.indexOf(0x0a)
      if (newline >= 0) { cleanup(); resolve(bytes.subarray(0, newline).toString('utf8')) }
    }
    readable.on('data', data); readable.once('error', error); readable.once('end', end)
  })
}
async function requestBody(request) { let body = ''; for await (const chunk of request) body += chunk; return JSON.parse(body) }
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
function toolResponse(response, payload, command) {
  const tool = payload.tools.find(value => value.function?.name === 'run_shell_command')
  if (tool === undefined) throw new Error('owner-loss Qwen request omitted run_shell_command')
  const base = { id: 'owner-loss-tool', object: 'chat.completion.chunk', created: 0, model: payload.model }
  const args = JSON.stringify({ command, description: 'owner-loss process-group qualification' })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owner-loss-call', type: 'function', function: { name: tool.function.name, arguments: args } }] }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`); response.end('data: [DONE]\n\n')
}
async function waitForFile(path) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { if (existsSync(path)) return; await new Promise(resolveWait => setTimeout(resolveWait, 25)) }
  throw new Error('owner-loss native tool marker timed out')
}

async function helper(options) {
  const marker = join(options.workspace, 'owner-loss-tool.marker')
  const provider = createServer(async (request, response) => {
    const payload = await requestBody(request)
    const command = `printf '%s' \"$$\" > ${quote(marker)}; /bin/sleep 30`
    toolResponse(response, payload, command)
  })
  const port = await listen(provider); const expiresAt = '2099-01-01T00:00:00.000Z'
  const identity = { credential: 'owner-loss-identity', expiresAt, subject: 'owner-loss-user', type: 'lumx.local-auth.v1' }
  const relay = await createAcpModelRelay({ engineId: 'qwen-code-0.24.0', gateway: { validate: async input => ({ active: true, expiresAt, subject: input.subject }) },
    getIdentity: () => identity, launchId: 'owner-loss', model: 'qwen3.7-max', providerEndpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    providerKey: 'local-provider-key', sessionId: 'owner-loss-session' })
  const materials = prepareQwenLaunch({ ...options, runtime: realpathSync(options.runtime), workspace: realpathSync(options.workspace), relayPort: Number(new URL(relay.endpoint).port) })
  const engine = createSupervisedQwenEngine({ materials, relay, model: 'qwen3.7-max',
    onPermission: ({ params }) => { const option = params.options.find(value => value.kind === 'allow_once'); return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } } } })
  await engine.create({}, { handleId: 'owner-loss-handle', signal: new AbortController().signal })
  void engine.prompt({ prompt: [{ type: 'text', text: 'Use run_shell_command exactly once with the command provided by the model response.' }] },
    { handleId: 'owner-loss-handle', promptId: 'owner-loss-prompt', signal: new AbortController().signal }).catch(() => {})
  await waitForFile(marker); const toolPid = Number(readFileSync(marker, 'utf8').trim())
  const toolPgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(toolPid)], { encoding: 'utf8' }).trim())
  await new Promise(resolve => process.stdout.write(`${JSON.stringify({ ...engine.stats().processes[0], toolPid, toolPgid })}\n`, resolve))
  await new Promise(() => {})
}

export async function runOwnerLossProbe(options) {
  const script = resolve(new URL(import.meta.url).pathname)
  const child = spawn(options.nodePath, [script, '--helper', 'true', ...argumentsFor(options)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = outcome(child); let stderr = ''
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  const ready = JSON.parse(await timeout(firstLine(child.stdout), 'owner-loss helper readiness', 30_000))
  child.kill('SIGKILL'); const helperExit = await exited
  const guardianGone = await gone(ready.guardianPid); const qwenGone = await gone(ready.qwenPid); const groupGone = await gone(ready.qwenPid, true)
  const toolGone = await gone(ready.toolPid); const toolGroupGone = await gone(ready.toolPgid, true)
  if (!guardianGone || !qwenGone || !groupGone || !toolGone || !toolGroupGone) {
    try { process.kill(-ready.qwenPid, 'SIGKILL') } catch {}
    try { process.kill(ready.guardianPid, 'SIGKILL') } catch {}
    throw new Error('owner-loss guardian did not reap the complete Qwen process group')
  }
  return { guardianGone, groupGone, helperExit, qwenGone, toolGone, toolGroupGone, ready, stderr }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const options = parse(process.argv.slice(2)); mkdirSync(options.runtime, { recursive: true, mode: 0o700 }); mkdirSync(options.workspace, { recursive: true, mode: 0o700 })
  if (options.helper) await helper(options)
  else {
    try { process.stdout.write(`${JSON.stringify(await runOwnerLossProbe(options), null, 2)}\n`) }
    finally { try { chmodSync(resolve(options.runtime, 'frozen-engine'), 0o700) } catch {}; rmSync(options.runtime, { recursive: true, force: true }) }
  }
}
