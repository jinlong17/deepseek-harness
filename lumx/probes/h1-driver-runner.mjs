import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const PINNED_SOURCE = '639ed015397290b3745d163aafe02ffee4aa3f84'
const EXPECTED_UNITS = ['real/DSH-non-AgentLoop-driver', 'real/H1-inventory']

/** Lab-only executable: freeze inputs, deny physical networking, and preserve probe evidence. */

function realpathOrResolved(path) {
  const absolute = resolve(path)
  return existsSync(absolute) ? realpathSync(absolute) : absolute
}

function argsOf(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1])
  const path = name => {
    const value = args.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return realpathOrResolved(value)
  }
  return {
    artifactManifest: path('--artifact-manifest'),
    forkRoot: path('--fork-root'),
    node: path('--node'),
    output: resolve(args.get('--output') ?? ''),
    sourceLock: path('--source-lock'),
    sourceRoot: path('--source-root'),
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function command(executable, argv, cwd) {
  return execFileSync(executable, argv, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  }).trim()
}

function git(root, ...argv) {
  return command('/usr/bin/git', argv, root)
}

function filesUnder(root, relativeRoot) {
  const base = join(root, relativeRoot)
  if (!existsSync(base)) return []
  const output = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        output.push({ path: relative(root, path), sha256: sha256(path), size: statSync(path).size })
      }
    }
  }
  visit(base)
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function dirtyPaths(root) {
  const raw = execFileSync('/usr/bin/git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  })
  const fields = raw.split('\0').filter(Boolean)
  const paths = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    paths.push(field.slice(3))
    if (field.startsWith('R') || field.startsWith('C')) index += 1
  }
  return paths
}

function sourceSnapshot(sourceRoot) {
  const head = git(sourceRoot, 'rev-parse', 'HEAD')
  if (head !== PINNED_SOURCE) throw new Error(`source is not pinned at ${PINNED_SOURCE}`)
  const dirty = dirtyPaths(sourceRoot)
  if (dirty.length > 0) throw new Error(`pinned source has tracked/untracked changes: ${dirty.join(', ')}`)
  return { commit: head, tree: git(sourceRoot, 'rev-parse', 'HEAD^{tree}'), dirty }
}

function artifactSnapshot(options, sourceLock) {
  const manifest = JSON.parse(readFileSync(options.artifactManifest, 'utf8'))
  const manifestSha256 = sha256(options.artifactManifest)
  if (manifestSha256 !== sourceLock.dsh.build_artifacts_sha256) {
    throw new Error('build artifact manifest differs from source lock')
  }
  if (manifest.source_commit !== PINNED_SOURCE) throw new Error('artifact manifest source commit differs from pin')
  const digest = createHash('sha256')
  const mismatches = []
  for (const row of manifest.artifacts) {
    const path = join(options.sourceRoot, row.path)
    const actual = existsSync(path) ? sha256(path) : null
    if (actual !== row.sha256) mismatches.push({ path: row.path, expected: row.sha256, actual })
    digest.update(`${row.path}\0${actual ?? '<missing>'}\n`)
  }
  if (mismatches.length > 0) throw new Error(`pinned build artifact verification failed (${mismatches.length})`)
  return {
    count: manifest.artifacts.length,
    currentFilesDigest: digest.digest('hex'),
    manifestSha256,
    sourceCommit: manifest.source_commit,
    verified: true,
  }
}

function provenance(options) {
  const sourceLock = JSON.parse(readFileSync(options.sourceLock, 'utf8'))
  if (sourceLock.dsh.commit !== PINNED_SOURCE) throw new Error('source lock differs from pinned source')
  const lockedNode = sourceLock.runtime.engine_node
  const node = {
    path: options.node,
    sha256: sha256(options.node),
    version: command(options.node, ['--version'], options.sourceRoot),
  }
  if (node.path !== realpathOrResolved(lockedNode.path)
    || node.sha256 !== lockedNode.sha256
    || node.version !== lockedNode.version) {
    throw new Error('Node executable differs from runtime.engine_node lock')
  }
  const committed = git(options.forkRoot, 'diff', '--name-only', `${PINNED_SOURCE}..HEAD`)
    .split('\n').filter(Boolean)
  const dirty = dirtyPaths(options.forkRoot)
  const outside = [...committed, ...dirty].filter(path => !path.startsWith('lumx/'))
  if (outside.length > 0) throw new Error(`fork change escaped lumx/: ${outside.join(', ')}`)
  return {
    artifacts: artifactSnapshot(options, sourceLock),
    fork: {
      committed,
      dirty,
      head: git(options.forkRoot, 'rev-parse', 'HEAD'),
      lumxFiles: filesUnder(options.forkRoot, 'lumx'),
      pinnedAncestor: PINNED_SOURCE,
    },
    node,
    source: sourceSnapshot(options.sourceRoot),
    sourceLock: { path: options.sourceLock, sha256: sha256(options.sourceLock) },
  }
}

function sbQuote(path) {
  return JSON.stringify(realpathOrResolved(path))
}

function parents(path) {
  const output = []
  let cursor = resolve(path)
  while (dirname(cursor) !== cursor) {
    cursor = dirname(cursor)
    output.push(cursor)
  }
  return output
}

function sandboxProfile({ forkRoot, node, runtime, sourceRoot }) {
  const readable = [forkRoot, sourceRoot, dirname(dirname(node))]
  const lines = [
    '(version 1)',
    '(deny default)',
    '(deny network*)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read* (literal "/"))',
    '(allow file-read-metadata (literal "/tmp"))',
  ]
  for (const path of [...readable, runtime]) {
    for (const ancestor of [path, ...parents(path)]) {
      lines.push(`(allow file-read-metadata (literal ${sbQuote(ancestor)}))`)
    }
  }
  for (const path of ['/System', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/Library/Apple']) {
    lines.push(`(allow file-read* (subpath ${sbQuote(path)}))`)
  }
  lines.push(
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
  )
  for (const path of readable) lines.push(`(allow file-read* (subpath ${sbQuote(path)}))`)
  lines.push(
    `(allow file-read* (subpath ${sbQuote(runtime)}))`,
    `(allow file-write* (subpath ${sbQuote(runtime)}))`,
  )
  return `${[...new Set(lines)].join('\n')}\n`
}

function runChild(options, output) {
  const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'lumx-h1-driver-')))
  const profile = join(runtime, 'h1-driver.sb')
  const capture = join(runtime, 'h1-driver.json')
  const osHome = join(runtime, 'os-home')
  const processHome = join(runtime, 'process-home')
  const temporary = join(runtime, 'tmp')
  const workspace = join(runtime, 'workspace')
  for (const path of [osHome, processHome, temporary, workspace]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  writeFileSync(profile, sandboxProfile({ ...options, runtime }), { mode: 0o600 })
  const argv = [
    '-f', profile,
    options.node,
    join(options.forkRoot, 'lumx/probes/h1-driver-probe.mjs'),
    '--source-root', options.sourceRoot,
    '--output', capture,
    '--os-home', osHome,
    '--workspace', workspace,
  ]
  const stdoutPath = join(runtime, 'stdout.log')
  const stderrPath = join(runtime, 'stderr.log')
  const stdoutFd = openSync(stdoutPath, 'wx', 0o600)
  const stderrFd = openSync(stderrPath, 'wx', 0o600)
  const env = {
    CI: '1',
    HOME: processHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: '/usr/bin:/bin',
    TMPDIR: temporary,
  }
  const startedAt = new Date().toISOString()
  const child = spawn('/usr/bin/sandbox-exec', argv, {
    cwd: workspace,
    detached: true,
    env,
    stdio: ['ignore', stdoutFd, stderrFd],
  })
  return new Promise(resolveChild => {
    let timedOut = false
    let timeoutSignalSent = false
    const timeout = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGTERM')
        timeoutSignalSent = true
      } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 2_000).unref()
    }, 180_000)
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      closeSync(stdoutFd)
      closeSync(stderrFd)
      writeFileSync(join(output, 'stdout.log'), readFileSync(stdoutPath), { mode: 0o600 })
      writeFileSync(join(output, 'stderr.log'), readFileSync(stderrPath), { mode: 0o600 })
      mkdirSync(join(output, 'captures'))
      writeFileSync(join(output, 'captures', 'h1-driver.sb'), readFileSync(profile), { mode: 0o600 })
      if (existsSync(capture)) {
        writeFileSync(join(output, 'captures', 'h1-driver.json'), readFileSync(capture), { mode: 0o600 })
      }
      const result = {
        argv: ['/usr/bin/sandbox-exec', ...argv],
        capturePresent: existsSync(capture),
        code,
        cwd: workspace,
        envKeys: Object.keys(env).sort(),
        finishedAt: new Date().toISOString(),
        signal,
        startedAt,
        timedOut,
        timeoutSignalSent,
      }
      rmSync(runtime, { force: true, recursive: true })
      resolveChild(result)
    })
  })
}

function validateCapture(path) {
  const capture = JSON.parse(readFileSync(path, 'utf8'))
  const units = Array.isArray(capture.counted_results) ? capture.counted_results : []
  const ids = units.map(row => row.id).sort()
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_UNITS)) {
    throw new Error(`capture counted_results ids differ: ${ids.join(', ')}`)
  }
  for (const row of units) {
    if (row.status !== 'pass' && row.status !== 'fail') throw new Error(`invalid status for ${row.id}`)
    if (!Array.isArray(row.subchecks) || row.subchecks.length === 0) throw new Error(`missing subchecks for ${row.id}`)
  }
  return { capture, qualificationStatus: units.every(row => row.status === 'pass') ? 'pass' : 'fail' }
}

async function main() {
  const options = argsOf(process.argv.slice(2))
  if (options.output === resolve('')) throw new Error('missing --output')
  if (!options.output.startsWith('/')) throw new Error('--output must be absolute')
  if (existsSync(options.output)) throw new Error(`refusing to overwrite ${options.output}`)
  const before = provenance(options)
  mkdirSync(options.output, { recursive: false, mode: 0o700 })
  const processResult = await runChild(options, options.output)
  const after = provenance(options)
  const sourceFrozenDuringRun = JSON.stringify(before.source) === JSON.stringify(after.source)
    && JSON.stringify(before.sourceLock) === JSON.stringify(after.sourceLock)
  const artifactsFrozenDuringRun = JSON.stringify(before.artifacts) === JSON.stringify(after.artifacts)
  const forkFrozenDuringRun = JSON.stringify(before.fork) === JSON.stringify(after.fork)
  let captureValidation
  let captureError
  if (processResult.capturePresent) {
    try {
      captureValidation = validateCapture(join(options.output, 'captures', 'h1-driver.json'))
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error)
    }
  }
  const expectedCode = captureValidation?.qualificationStatus === 'pass' ? 0 : 1
  const executionStatus = !processResult.timedOut
    && processResult.signal === null
    && processResult.code === expectedCode
    && captureValidation !== undefined
    && sourceFrozenDuringRun
    && artifactsFrozenDuringRun
    && forkFrozenDuringRun ? 'pass' : 'fail'
  const qualificationStatus = captureValidation?.qualificationStatus ?? 'fail'
  const receipt = {
    after,
    artifactsFrozenDuringRun,
    before,
    captures: filesUnder(options.output, '.').filter(row => row.path !== 'receipt.json'),
    counted_results: captureValidation?.capture.counted_results ?? [],
    execution: {
      ...processResult,
      expectedCode,
      ...captureError === undefined ? {} : { captureError },
    },
    executionStatus,
    forkFrozenDuringRun,
    generatedAt: new Date().toISOString(),
    qualificationStatus,
    scope: 'actual governed H1 inventory/Broker turn and actual DSH ACP non-AgentLoop capability',
    sourceFrozenDuringRun,
    status: executionStatus === 'pass' ? qualificationStatus : 'fail',
  }
  writeFileSync(join(options.output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({
    output: options.output,
    executionStatus,
    qualificationStatus,
    status: receipt.status,
  })}\n`)
  return receipt.status === 'pass' ? 0 : 1
}

process.exitCode = await main()
