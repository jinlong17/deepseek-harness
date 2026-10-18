import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { observeFileDescriptors } from '../desktop/fd-observer.mjs'

const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const wait = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(undefined), ms) })])
    .finally(() => clearTimeout(timer))
}

export async function settleB5FdDirectChild(child, timeoutMs = 5_000) {
  const actions = []; let finished = false
  const terminal = new Promise(resolve => {
    const done = value => { if (!finished) { finished = true; resolve(value) } }
    child.once('error', error => done({ error }))
    child.once('close', (code, signal) => done({ code, signal }))
  })
  let outcome = await wait(terminal, timeoutMs)
  if (outcome === undefined) { actions.push('SIGTERM'); child.kill('SIGTERM'); outcome = await wait(terminal, 2_000) }
  if (outcome === undefined) { actions.push('SIGKILL'); child.kill('SIGKILL'); outcome = await wait(terminal, 2_000) }
  if (outcome === undefined) throw new Error('old-direct FD control child did not reap')
  if (outcome.error !== undefined) throw new Error('old-direct FD control spawn failed', { cause: outcome.error })
  return { actions: Object.freeze(actions), outcome }
}

function profile(host, qualification) {
  const rows = qualification?.materials?.filter(row => row.materialId === 'host-profile' && row.role === 'host') ?? []
  const path = realpathSync(host.hostProfile.path)
  const digest = hashFile(path)
  if (rows.length !== 1 || rows[0].sha256 !== digest || qualification.host?.profileSha256 !== digest
      || host.hostProfile.sha256 !== digest || host.execution?.argv?.[2] !== path) throw new Error('old-direct Host profile identity differs')
  return Object.freeze({ path, sha256: digest })
}

function exactObservation(value, canary) {
  if (value?.fd !== 3 || value.identityMatched !== true || value.contentMatched !== true
      || value.stat?.dev !== canary.dev || value.stat?.ino !== canary.ino
      || value.content?.bytes !== canary.bytes || value.content?.sha256 !== canary.sha256) throw new Error(`old-direct FD control did not recover the inherited canary: ${JSON.stringify(value)}`)
  return Object.freeze({ fd: 3, stat: Object.freeze({ dev: value.stat.dev, ino: value.stat.ino }),
    content: Object.freeze({ bytes: value.content.bytes, sha256: value.content.sha256 }), identityMatched: true, contentMatched: true })
}

export async function runB5HostFdDirectControl({ canary, config, host, qualification }) {
  const selectedProfile = profile(host, qualification)
  const node = realpathSync(host.execution.argv[3]); const observer = realpathSync(join(config.forkRoot, 'lumx/desktop/fd-observer.mjs'))
  const inheritedRaw = observeFileDescriptors([3], canary); const input = JSON.stringify({ targets: [3], canary })
  if (inheritedRaw.length !== 1) throw new Error('old-direct inherited FD3 is absent')
  const inherited = Object.freeze([exactObservation(inheritedRaw[0], canary)])
  const argv = ['/usr/bin/sandbox-exec', '-f', selectedProfile.path, node, observer, '--child', input]
  const child = spawn(argv[0], argv.slice(1), {
      cwd: realpathSync(config.workspaceDirectory), detached: false,
      env: { HOME: realpathSync(config.osHome), LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', PATH: '/usr/bin:/bin', TMPDIR: realpathSync(config.runtimeParent) },
      stdio: ['ignore', 'pipe', 'pipe', 3],
    })
  let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout = `${stdout}${value}`.slice(-64 * 1024) })
  child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(-64 * 1024) })
  const { actions, outcome } = await settleB5FdDirectChild(child)
  if (outcome.code !== 0 || outcome.signal !== null) throw new Error(`old-direct FD control failed (${outcome.code ?? outcome.signal}): ${stderr}`)
  const rawObservations = JSON.parse(stdout)
  if (!Array.isArray(rawObservations) || rawObservations.length !== 1) throw new Error('old-direct FD control observation coverage differs')
  const observations = Object.freeze([exactObservation(rawObservations[0], canary)])
  return Object.freeze({ schema: 'g9-b5-host-fd-direct-control/v1', argv: Object.freeze(argv),
    pid: child.pid, controllerPid: process.pid, ownership: 'controller-process-group', code: outcome.code, signal: outcome.signal,
    actions, childReaped: true, profile: selectedProfile, inherited, observations })
}
