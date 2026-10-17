import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const PINNED_SOURCE = '639ed015397290b3745d163aafe02ffee4aa3f84'

function argsOf(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1])
  const path = name => {
    const value = args.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return realpathOrResolved(value)
  }
  const port = name => {
    const value = Number(args.get(name))
    if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error(`invalid ${name}`)
    return value
  }
  const suite = args.get('--suite') ?? 'live-host'
  if (!['live-host', 'live-cordis-ui'].includes(suite)) throw new Error(`invalid --suite ${suite}`)
  const browser = args.get('--browser') === undefined ? undefined : path('--browser')
  if (suite === 'live-cordis-ui' && browser === undefined) throw new Error('missing --browser')
  return {
    artifactManifest: path('--artifact-manifest'), forkRoot: path('--fork-root'),
    hostPort: port('--host-port'), identityPort: port('--identity-port'),
    modelPort: port('--model-port'), node: path('--node'), output: resolve(args.get('--output') ?? ''),
    sourceLock: path('--source-lock'), sourceRoot: path('--source-root'), suite, browser,
  }
}

function realpathOrResolved(path) {
  const absolute = resolve(path)
  return existsSync(absolute) ? realpathSync(absolute) : absolute
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function redactedLog(path) {
  return readFileSync(path, 'utf8').replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>')
}

function command(command, argv, cwd) {
  return execFileSync(command, argv, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim()
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
      else if (entry.isFile()) output.push({ path: relative(root, path), sha256: sha256(path), size: statSync(path).size })
    }
  }
  visit(base)
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

function generatedBuildSnapshot(sourceRoot) {
  const rows = [
    ...filesUnder(sourceRoot, 'apps/web/dist'),
    ...filesUnder(sourceRoot, 'packages/client'),
    ...filesUnder(sourceRoot, 'packages/typert/registry/lib'),
  ].filter(row => row.path.includes(`${sep}lib${sep}`) || row.path.startsWith(`apps${sep}web${sep}dist${sep}`))
  if (rows.length === 0) throw new Error('generated Host/client/Web build outputs are absent')
  return { artifactCount: rows.length, artifacts: rows }
}

function dirtyPaths(root) {
  const raw = execFileSync('/usr/bin/git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
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

function forkSnapshot(forkRoot) {
  execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', PINNED_SOURCE, 'HEAD'], { cwd: forkRoot })
  const committed = git(forkRoot, 'diff', '--name-only', `${PINNED_SOURCE}..HEAD`).split('\n').filter(Boolean)
  const dirty = dirtyPaths(forkRoot)
  const outside = [...committed, ...dirty].filter(path => !path.startsWith('lumx/'))
  if (outside.length > 0) throw new Error(`fork change escaped lumx/: ${outside.join(', ')}`)
  return { committed, dirty, head: git(forkRoot, 'rev-parse', 'HEAD'), pinnedAncestor: PINNED_SOURCE }
}

function sourceSnapshot(sourceRoot) {
  const head = git(sourceRoot, 'rev-parse', 'HEAD')
  if (head !== PINNED_SOURCE) throw new Error(`source is not pinned at ${PINNED_SOURCE}`)
  const dirty = dirtyPaths(sourceRoot)
  if (dirty.length > 0) throw new Error(`pinned source has tracked/untracked changes: ${dirty.join(', ')}`)
  return { commit: head, tree: git(sourceRoot, 'rev-parse', 'HEAD^{tree}') }
}

function provenance(options) {
  const sourceLock = JSON.parse(readFileSync(options.sourceLock, 'utf8'))
  const manifest = JSON.parse(readFileSync(options.artifactManifest, 'utf8'))
  if (sha256(options.artifactManifest) !== sourceLock.dsh.build_artifacts_sha256) {
    throw new Error('build artifact manifest differs from source lock')
  }
  if (manifest.source_commit !== PINNED_SOURCE || sourceLock.dsh.commit !== PINNED_SOURCE) {
    throw new Error('source commit differs from pinned source lock')
  }
  const bad = manifest.artifacts.filter(row => {
    const path = join(options.sourceRoot, row.path)
    return !existsSync(path) || sha256(path) !== row.sha256
  })
  if (bad.length > 0) throw new Error(`pinned build artifact verification failed (${bad.length})`)
  const lockedNode = sourceLock.runtime.engine_node
  if (options.node !== realpathOrResolved(lockedNode.path)
    || sha256(options.node) !== lockedNode.sha256
    || command(options.node, ['--version'], options.sourceRoot) !== lockedNode.version) {
    throw new Error('Node executable differs from runtime.engine_node lock')
  }
  const product = filesUnder(options.forkRoot, 'lumx')
  if (product.length === 0) throw new Error('fork lumx source snapshot is empty')
  return {
    artifactManifest: { count: manifest.artifacts.length, sha256: sha256(options.artifactManifest), verified: true },
    build: generatedBuildSnapshot(options.sourceRoot),
    fork: forkSnapshot(options.forkRoot),
    node: { path: options.node, sha256: sha256(options.node), version: lockedNode.version },
    product,
    source: sourceSnapshot(options.sourceRoot),
  }
}

function sbQuote(path) {
  return JSON.stringify(realpathOrResolved(path))
}

function sandboxProfile({ browser, forkRoot, node, protectedRoot, runtime, sourceRoot }, ports) {
  const browserRoot = browser === undefined ? undefined : dirname(dirname(dirname(browser)))
  const readable = [forkRoot, sourceRoot, dirname(dirname(node)), ...(browserRoot === undefined ? [] : [browserRoot])]
  const lines = [
    '(version 1)', browser === undefined ? '(deny default)' : '(allow default)', '(deny network*)',
    '(allow process*)', '(allow sysctl-read)',
    '(allow file-read* (literal "/"))', '(allow file-read-metadata (literal "/tmp"))',
  ]
  for (const path of [...readable, runtime]) {
    for (const ancestor of [path, ...parents(path)]) lines.push(`(allow file-read-metadata (literal ${sbQuote(ancestor)}))`)
  }
  for (const path of ['/System', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/Library/Apple', '/Library/Fonts']) {
    lines.push(`(allow file-read* (subpath ${sbQuote(path)}))`)
  }
  lines.push('(allow file-read* (literal "/dev/null"))', '(allow file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))')
  for (const path of readable) lines.push(`(allow file-read* (subpath ${sbQuote(path)}))`)
  lines.push(`(allow file-read* (subpath ${sbQuote(runtime)}))`, `(allow file-write* (subpath ${sbQuote(runtime)}))`)
  for (const port of ports) {
    lines.push(`(allow network-bind (local tcp4 "localhost:${String(port)}"))`)
    // On macOS the inbound operation carries the listen permission; the bind
    // rule alone is insufficient even for a literal loopback port.
    lines.push(`(allow network-inbound (local tcp4 "localhost:${String(port)}"))`)
    lines.push(`(allow network-outbound (remote tcp4 "localhost:${String(port)}"))`)
  }
  if (browser !== undefined) {
    for (const path of [
      protectedRoot,
      '/Users/jinlong/.a2k', '/Users/jinlong/.aws', '/Users/jinlong/.config', '/Users/jinlong/.ssh',
      '/Users/jinlong/Library/Application Support/Google/Chrome', '/Users/jinlong/Library/Keychains',
      '/Users/jinlong/Desktop/Jinlong_project',
    ]) lines.push(`(deny file-read* file-write* (subpath ${sbQuote(path)}))`)
    lines.push('(allow mach-lookup)')
    lines.push('(allow ipc-posix-shm)')
    lines.push('(allow ipc-posix-sem)')
    lines.push(`(allow network-bind network-inbound (local unix-socket (subpath ${sbQuote(runtime)})))`)
    lines.push(`(allow network-outbound (remote unix-socket (subpath ${sbQuote(runtime)})))`)
    const tempRoots = [dirname(runtime), dirname(runtime).replace(/^\/private/u, '')]
    for (const value of new Set(tempRoots)) {
      const tempRoot = value.replaceAll('\\', '\\\\').replaceAll('.', '\\.')
      const singleton = `^${tempRoot}/\\.org\\.chromium\\.Chromium\\.[^/]+(/.*)?$`
      lines.push(`(allow file-read* file-write* (regex #"${singleton}"))`)
      lines.push(`(allow network-bind network-inbound (local unix-socket (regex #"${singleton}")))`)
      lines.push(`(allow network-outbound (remote unix-socket (regex #"${singleton}")))`)
    }
  }
  return `${[...new Set(lines)].join('\n')}\n`
}

function parents(path) {
  const output = []
  let cursor = resolve(path)
  while (dirname(cursor) !== cursor) { cursor = dirname(cursor); output.push(cursor) }
  return output
}

function runChild(options, output) {
  const runtime = realpathSync(mkdtempSync(join(tmpdir(), `lumx-${options.suite}-`)))
  const protectedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lumx-protected-main-')))
  const canary = join(protectedRoot, 'main-profile-credential.canary')
  writeFileSync(canary, 'synthetic-main-profile-secret\n', { mode: 0o600 })
  const canaryFd = openSync(canary, 'r')
  const profile = join(runtime, `${options.suite}.sb`)
  const capture = join(runtime, `${options.suite}.json`)
  const osHome = join(runtime, 'os-home')
  const workspace = join(runtime, 'workspace')
  const processHome = join(runtime, 'process-home')
  const temporary = join(runtime, 'tmp')
  for (const path of [osHome, workspace, processHome, temporary]) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(profile, sandboxProfile({ ...options, protectedRoot, runtime }, [options.hostPort, options.identityPort, options.modelPort]))
  const argv = [
    '-f', profile, options.node, join(options.forkRoot, `lumx/probes/${options.suite}-probe.mjs`),
    '--source-root', options.sourceRoot, '--output', capture, '--os-home', osHome, '--workspace', workspace,
    '--host-port', String(options.hostPort), '--identity-port', String(options.identityPort),
    '--model-port', String(options.modelPort),
    ...(options.browser === undefined ? [] : ['--browser', options.browser]),
  ]
  // Seatbelt must not receive a write grant to the evidence tree. Capture in
  // the isolated runtime and let the unsandboxed parent copy bytes afterward.
  const stdoutPath = join(runtime, 'stdout.log')
  const stderrPath = join(runtime, 'stderr.log')
  const stdoutFd = openSync(stdoutPath, 'wx', 0o600)
  const stderrFd = openSync(stderrPath, 'wx', 0o600)
  const env = {
    CI: '1', HOME: processHome, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PATH: '/usr/bin:/bin',
    TMPDIR: temporary, LUMX_CANARY_FD: '3', LUMX_CANARY_PATH: canary,
  }
  const startedAt = new Date().toISOString()
  const child = spawn('/usr/bin/sandbox-exec', argv, {
    // Adversarially inherit the already-open protected descriptor. This tests
    // the actual OS boundary instead of treating close-fds hygiene as proof.
    cwd: workspace, detached: true, env, stdio: ['ignore', stdoutFd, stderrFd, canaryFd],
  })
  return new Promise(resolveChild => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 2_000).unref()
    }, 120_000)
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      closeSync(canaryFd)
      closeSync(stdoutFd)
      closeSync(stderrFd)
      writeFileSync(join(output, 'stdout.log'), redactedLog(stdoutPath), { mode: 0o600 })
      writeFileSync(join(output, 'stderr.log'), redactedLog(stderrPath), { mode: 0o600 })
      mkdirSync(join(output, 'captures'))
      writeFileSync(join(output, 'captures', `${options.suite}.sb`), readFileSync(profile), { mode: 0o600 })
      if (existsSync(capture)) writeFileSync(join(output, 'captures', `${options.suite}.json`), readFileSync(capture), { mode: 0o600 })
      const screenshot = join(runtime, 'live-cordis-ui.png')
      if (existsSync(screenshot)) writeFileSync(join(output, 'captures', 'live-cordis-ui.png'), readFileSync(screenshot), { mode: 0o600 })
      const result = {
        argv: ['/usr/bin/sandbox-exec', ...argv], capturePresent: existsSync(capture), code, cwd: workspace,
        envKeys: Object.keys(env).sort(), finishedAt: new Date().toISOString(), signal, startedAt, timedOut,
      }
      rmSync(runtime, { force: true, recursive: true })
      rmSync(protectedRoot, { force: true, recursive: true })
      resolveChild(result)
    })
  })
}

async function main() {
  const options = argsOf(process.argv.slice(2))
  if (options.output === resolve('')) throw new Error('missing --output')
  if (existsSync(options.output)) throw new Error(`refusing to overwrite ${options.output}`)
  const before = provenance(options)
  mkdirSync(options.output, { recursive: false, mode: 0o700 })
  const processResult = await runChild(options, options.output)
  const after = provenance(options)
  const frozen = JSON.stringify(before) === JSON.stringify(after)
  const success = processResult.code === 0 && !processResult.timedOut && processResult.capturePresent && frozen
  const files = filesUnder(options.output, '.').filter(row => row.path !== 'receipt.json')
  const receipt = {
    after, before, captures: files, generatedAt: new Date().toISOString(), process: processResult,
    scope: 'official DSH Web profile shared Host/UI; this is not the Electron DesktopHost wrapper',
    sourceFrozenDuringRun: frozen, status: success ? 'pass' : 'fail',
  }
  writeFileSync(join(options.output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ output: options.output, status: receipt.status })}\n`)
  return success ? 0 : 1
}

process.exitCode = await main()
