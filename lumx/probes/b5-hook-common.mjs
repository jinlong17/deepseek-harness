import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import WebSocket from '../../apps/cli/node_modules/ws/index.js'

const MAX_BODY = 1024 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
export const deferred = () => Promise.withResolvers()
export const timeout = (promise, label, ms = 30_000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
export function loadConfig() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
  const path = args.get('--scenario-config'); const expected = args.get('--scenario-config-sha256')
  if (path === undefined || !/^[a-f0-9]{64}$/u.test(expected ?? '')) throw new Error('scenario config path and SHA-256 required')
  const entry = lstatSync(path); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('scenario config must be a direct regular file')
  const bytes = readFileSync(path); if (hash(bytes) !== expected) throw new Error('scenario config differs from parent anchor')
  const value = JSON.parse(bytes)
  if (value?.schema !== 'g9-b5-runtime-scenario/v1' || typeof value.resultPath !== 'string') throw new Error('scenario config schema')
  return Object.freeze({ ...value, configPath: realpathSync(path), configSha256: expected })
}
export function writeResult(config, value) {
  writeFileSync(resolve(config.resultPath), `${JSON.stringify({ schema: 'g9-b5-runtime-result/v1', scenarioConfigSha256: config.configSha256, ...value }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}
export async function listen(handler) {
  const server = createServer((request, response) => Promise.resolve(handler(request, response)).catch(error => {
    response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }))
  }))
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('loopback server address')
  let closed
  return Object.freeze({ port: address.port, server, close: () => (closed ??= new Promise((ok, fail) => {
    server.closeAllConnections?.(); server.close(error => error ? fail(error) : ok())
  })) })
}
export async function freePort() {
  const holder = await listen((_request, response) => { response.writeHead(503); response.end() })
  const port = holder.port; await holder.close(); return port
}
export async function body(request) {
  let bytes = Buffer.alloc(0)
  for await (const chunk of request) { if (bytes.length + chunk.length > MAX_BODY) throw new Error('request body exceeds bound'); bytes = Buffer.concat([bytes, chunk]) }
  return JSON.parse(bytes)
}
export async function authenticate(readyUrl) {
  const response = await fetch(readyUrl, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]; const location = response.headers.get('location')
  if (response.status !== 303 || cookie === undefined || location === null) throw new Error(`authentication failed: ${response.status}`)
  const origin = new URL(readyUrl).origin
  return Object.freeze({ cookie, origin, page: new URL(location, origin).href })
}
export function rawRequest(url, headers = {}) {
  const target = new URL(url)
  return timeout(new Promise((resolveRequest, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk })
      response.on('end', () => resolveRequest({ body: text, headers: response.headers, status: response.statusCode ?? 0 }))
    })
    request.once('error', reject); request.end()
  }), 'raw HTTP request')
}
export async function remote(auth, endpoint, args) {
  const response = await fetch(`${auth.origin}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `b5-${randomUUID()}`, method: endpoint, payload: { args } }) })
  const text = await response.text(); if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${text}`)
  const value = JSON.parse(text); if (value?.result?.ok !== true) throw new Error(`${endpoint}: ${value?.result?.error?.message ?? 'failed'}`)
  return value.result.value
}
export async function follow(auth, sessionId) {
  const socket = new WebSocket(`${auth.origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers: { cookie: auth.cookie } })
  await timeout(new Promise((ok, fail) => { socket.once('open', ok); socket.once('error', fail) }), 'follow open')
  const streamId = `b5-${randomUUID()}`; const frames = []; const waiters = []
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()); if (frame.streamId !== streamId) return
    frames.push(frame)
    for (const waiter of [...waiters]) if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
  })
  const wait = predicate => frames.find(predicate) ?? new Promise(resolveFrame => waiters.push({ predicate, resolve: resolveFrame }))
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } }))
  await timeout(Promise.resolve(wait(frame => frame.type === 'item' && frame.value?.type === 'snapshot')), 'follow snapshot')
  return Object.freeze({ frames, wait: predicate => timeout(Promise.resolve(wait(predicate)), 'follow frame'), close: () => socket.close() })
}
export const check = (id, pass, evidence) => Object.freeze({ id, required: true, result: pass ? 'pass' : 'fail', evidence })
export const pending = (id, boundary) => Object.freeze({ id, required: true, result: 'pending', evidence: { boundary } })
export const unit = (id, checks, coverage) => Object.freeze({ id, status: checks.every(value => value.result === 'pass') ? 'pass' : 'fail', coverage, subchecks: checks })
function describeQualificationResponse(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}
export function qualificationFacts(response, operation) {
  const object = response !== null && typeof response === 'object' && !Array.isArray(response)
  const facts = object ? response.facts : undefined
  if (!object || response.type !== 'qualify' || response.operation !== operation || response.status !== 'pass' || facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new Error(`Host qualification ${operation} response rejected: ${describeQualificationResponse(response)}`)
  }
  return facts
}
export function baseLaunch(config, consumer, port) {
  return { consumer, forkRoot: realpathSync(config.forkRoot), launchId: randomUUID(), mode: config.mode, nodePath: realpathSync(config.nodePath), nodeSha256: config.nodeSha256,
    osHome: realpathSync(config.osHome), port, runtimeParent: realpathSync(config.runtimeParent), sourceRoot: realpathSync(config.sourceRoot), workspaceDirectory: realpathSync(config.workspaceDirectory),
    environment: {}, fdQualification: config.fdQualification }
}
