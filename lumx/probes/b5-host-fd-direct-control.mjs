import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, closeSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const wait = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(undefined), ms))])

function profile(host, qualification) {
  const rows = qualification?.materials?.filter(row => row.materialId === 'host-profile' && row.role === 'host') ?? []
  const path = realpathSync(host.hostProfile.path)
  const digest = hashFile(path)
  if (rows.length !== 1 || rows[0].sha256 !== digest || qualification.host?.profileSha256 !== digest
      || host.hostProfile.sha256 !== digest || host.execution?.argv?.[2] !== path) throw new Error('old-direct Host profile identity differs')
  return Object.freeze({ path, sha256: digest })
}

export async function runB5HostFdDirectControl({ canary, config, host, qualification }) {
  const selectedProfile = profile(host, qualification)
  const node = realpathSync(host.execution.argv[3]); const observer = realpathSync(join(config.forkRoot, 'lumx/desktop/fd-observer.mjs'))
  const descriptor = openSync(canary.path, 'r'); let child; let outcome; const actions = []
  try {
    child = spawn('/usr/bin/sandbox-exec', ['-f', selectedProfile.path, node, observer, '--child', JSON.stringify({ targets: [3], canary })], {
      cwd: realpathSync(config.workspaceDirectory), detached: true,
      env: { HOME: realpathSync(config.osHome), LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', PATH: '/usr/bin:/bin', TMPDIR: realpathSync(config.runtimeParent) },
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
    })
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout = `${stdout}${value}`.slice(-64 * 1024) })
    child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(-64 * 1024) })
    const exited = new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })))
    outcome = await wait(exited, 5_000)
    if (outcome === undefined) { actions.push('SIGTERM'); process.kill(-child.pid, 'SIGTERM'); outcome = await wait(exited, 2_000) }
    if (outcome === undefined) { actions.push('SIGKILL'); process.kill(-child.pid, 'SIGKILL'); outcome = await wait(exited, 2_000) }
    if (outcome === undefined || outcome.code !== 0 || outcome.signal !== null) throw new Error(`old-direct FD control failed (${outcome?.code ?? outcome?.signal ?? 'timeout'}): ${stderr}`)
    const observations = JSON.parse(stdout)
    if (!Array.isArray(observations) || observations.length !== 1 || observations[0].fd !== 3
        || observations[0].identityMatched !== true || observations[0].contentMatched !== true) throw new Error('old-direct FD control did not recover the canary')
    let groupGone = false
    try { process.kill(-child.pid, 0) } catch (error) { groupGone = error.code === 'ESRCH' }
    if (!groupGone) throw new Error('old-direct FD control group survived')
    return Object.freeze({ schema: 'g9-b5-host-fd-direct-control/v1', argv: Object.freeze(['/usr/bin/sandbox-exec', '-f', selectedProfile.path, node, observer, '--child']),
      pid: child.pid, pgid: child.pid, code: outcome.code, signal: outcome.signal, actions: Object.freeze(actions), groupGone,
      profile: selectedProfile, observations: Object.freeze(observations) })
  } finally { closeSync(descriptor) }
}
