import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { prepareLumxHostLaunch, verifyLumxHostLaunch } from './host-launch-materials.mjs'

const NODE = '/Users/jinlong/.local/opt/node-v24.20.0/bin/node'
const NODE_SHA256 = '9d050fd455b56426e25d4d603c7c501cbb2630348e836cf221dcce748e90588a'
const ROOT = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deepseek-harness'
async function freePort() {
  const server = (await import('node:net')).createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
function base(t) {
  const root = mkdtempSync(join(tmpdir(), 'lumx-prepared-host-')); const osHome = join(root, 'home'); const workspaceDirectory = join(root, 'workspace')
  mkdirSync(osHome); mkdirSync(workspaceDirectory)
  return { consumer: 'platform-stub', forkRoot: ROOT, launchId: crypto.randomUUID(), mode: 'developer', nodePath: NODE,
    nodeSha256: NODE_SHA256, osHome, root, runtimeParent: root, sourceRoot: ROOT, workspaceDirectory }
}
function cleanup(t, input, materials) { t.after(async () => { await materials.cleanup(); rmSync(input.root, { recursive: true, force: true }) }) }
function runSandbox(profile, args) {
  const script = `const fs=require('node:fs');const a=JSON.parse(process.argv[1]);const out={};for(const [k,op,p,q] of a){try{fs[op](p,...q===null?[]:[q]);out[k]='OK'}catch(e){out[k]=e.code||e.name}}process.stdout.write(JSON.stringify(out))`
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, NODE, '-e', script, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value }); child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', (code, signal) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`sandbox probe failed (${code ?? signal}): ${stderr}`)))
  })
}

test('prepared Host bytes and path identities are frozen before launch', async t => {
  const input = base(t); const materials = await prepareLumxHostLaunch({ ...input, port: await freePort() }); cleanup(t, input, materials)
  assert.equal(verifyLumxHostLaunch(materials), materials)
  chmodSync(materials.paths.frozen, 0o700); chmodSync(materials.paths.configPath, 0o600); writeFileSync(materials.paths.configPath, '{}\n')
  assert.throws(() => verifyLumxHostLaunch(materials), /config differs/)
  const runtime = materials.paths.runtime; await materials.cleanup(); assert.equal(existsSync(runtime), false)
})

test('actual Host profile denies frozen and private mutations including hard-link aliases', async t => {
  const input = base(t); const privateRoot = join(input.osHome, '.lumx-developer', '.private'); mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(privateRoot, 'canary'), 'private\n')
  const materials = await prepareLumxHostLaunch({ ...input, port: await freePort() }); cleanup(t, input, materials)
  const privateCanary = join(materials.dataHome, '.private', 'canary'); const workspace = materials.payload.workspaceDirectory
  const movedConfig = `${materials.paths.configPath}.moved`; const movedPrivate = `${privateCanary}.moved`
  const result = await runSandbox(materials.paths.profilePath, [
    ['frozen-write', 'writeFileSync', materials.paths.configPath, 'x'], ['frozen-chmod', 'chmodSync', materials.paths.configPath, 0o600],
    ['frozen-rename', 'renameSync', materials.paths.configPath, movedConfig], ['private-write', 'writeFileSync', privateCanary, 'x'],
    ['private-rename', 'renameSync', privateCanary, movedPrivate], ['private-unlink', 'unlinkSync', privateCanary, null],
    ['frozen-workspace-link', 'linkSync', materials.paths.configPath, join(workspace, 'frozen-link')],
    ['private-workspace-link', 'linkSync', privateCanary, join(workspace, 'private-link')],
    ['private-tmp-link', 'linkSync', privateCanary, join(materials.paths.temporary, 'private-link')],
    ['workspace-positive', 'writeFileSync', join(workspace, 'allowed'), 'ok'],
    ['tmp-positive', 'writeFileSync', join(materials.paths.temporary, 'allowed'), 'ok'],
  ])
  for (const name of ['frozen-write', 'frozen-chmod', 'frozen-rename', 'private-write', 'private-rename', 'private-unlink',
    'frozen-workspace-link', 'private-workspace-link', 'private-tmp-link']) assert.notEqual(result[name], 'OK', name)
  assert.equal(result['workspace-positive'], 'OK', JSON.stringify(result)); assert.equal(result['tmp-positive'], 'OK', JSON.stringify(result))
  assert.equal(readFileSync(privateCanary, 'utf8'), 'private\n')
})

test('prepared selected data home rejects replacement by a symbolic alias', async t => {
  const input = base(t); const materials = await prepareLumxHostLaunch({ ...input, port: await freePort() }); cleanup(t, input, materials)
  const original = `${materials.dataHome}.original`; renameSync(materials.dataHome, original); symlinkSync(original, materials.dataHome)
  assert.throws(() => verifyLumxHostLaunch(materials), /dataHome must be a direct directory/)
})
