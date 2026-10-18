import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildLumxNativeFdHarness } from './native/build.mjs'

const NODE = '/Users/jinlong/.local/opt/node-v24.20.0/bin/node'
const FLAGS = ['--consumer', 'desktop-byok', '--runtime-role', 'host', '--source-anchor-sha256', 'a'.repeat(64),
  '--preparation-anchor-sha256', 'b'.repeat(64), '--materials-module', '/tmp/materials', '--supervisor-module', '/tmp/supervisor',
  '--factory-module', '/tmp/factory', '--scenario-config', '', '--scenario-config-sha256', 'c'.repeat(64),
  '--ready-fd', '3', '--ack-fd', '4', '--ack-timeout-ms', '1000']

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `g9-fd-controller-${name}-`))
  const harness = buildLumxNativeFdHarness(join(root, 'fd-harness')); const canary = join(root, 'canary')
  const receipt = join(root, 'receipt.json'); const output = join(root, 'output.json'); const controller = join(root, 'controller.mjs')
  await writeFile(canary, `native-host-canary/v1:${'d'.repeat(64)}\n`, { mode: 0o600 })
  await writeFile(controller, `import { createHash } from 'node:crypto'; import { fstatSync, readSync, writeFileSync, writeSync } from 'node:fs';
const args=new Map(); for(let i=2;i<process.argv.length;i+=2) args.set(process.argv[i],process.argv[i+1]);
const canary=${JSON.stringify(`native-host-canary/v1:${'d'.repeat(64)}\n`)}; const rows=[];
for(const fd of [0,1,2,3,10,11,512]){const s=fstatSync(fd);const b=Buffer.alloc(4096);const n=readSync(fd,b,0,b.length,0);rows.push({fd,dev:s.dev,ino:s.ino,bytes:n,sha256:createHash('sha256').update(b.subarray(0,n)).digest('hex'),text:b.subarray(0,n).toString()});}
const ack=Buffer.alloc(1);readSync(21,ack,0,1,null);writeSync(20,Buffer.from('R'));writeSync(22,Buffer.from('diagnostic-control\\n'));
writeFileSync(args.get('--scenario-config'),JSON.stringify({ack:ack.toString(),pid:process.pid,rows,canary}));`)
  const flags = [...FLAGS]; flags[flags.indexOf('--scenario-config') + 1] = output
  return { canary, controller, flags, harness, output, receipt, root }
}

function launch(state, stdio) {
  const args = ['--b5-controller', '--receipt', state.receipt, '--canary', state.canary, '--node', NODE, '--controller', state.controller, ...state.flags]
  return spawn(state.harness, args, { env: { PATH: '/usr/bin:/bin' }, stdio })
}

test('controller mode preserves all poison descriptors through same-PID exec and writes receipt before exec', async t => {
  const state = await fixture('positive'); t.after(() => rm(state.root, { force: true, recursive: true }))
  const child = launch(state, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']); let diagnostic = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { diagnostic += value })
  child.stdio[4].write('A'); child.stdio[4].end()
  const ready = await new Promise(resolve => child.stdio[3].once('data', value => resolve(value.toString())))
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  assert.deepEqual(result, { code: 0, signal: null }); assert.equal(ready, 'R'); assert.match(diagnostic, /diagnostic-control/u)
  const evidence = JSON.parse(await readFile(state.output, 'utf8')); const receipt = JSON.parse(await readFile(state.receipt, 'utf8'))
  assert.equal(evidence.pid, receipt.pid); assert.equal(evidence.ack, 'A'); assert.ok(evidence.rows.every(row => row.text === evidence.canary))
  assert.deepEqual(receipt.targets, [0, 1, 2, 3, 10, 11, 512]); assert.deepEqual(receipt.controlFds, { ready: 20, ack: 21, diagnostic: 22 })
  assert.equal(receipt.transientReceiptFd, 23); assert.equal(receipt.softRlimitAfter, 64); assert.match(receipt.softRlimitBefore, /^\d+$/u)
})

test('controller mode rejects an occupied fixed destination before receipt or poison mutation', async t => {
  const state = await fixture('collision'); t.after(() => rm(state.root, { force: true, recursive: true }))
  const stdio = Array.from({ length: 21 }, (_, fd) => fd === 0 || fd === 1 ? 'ignore' : fd === 2 ? 'pipe' : fd === 3 || fd === 4 || fd === 20 ? 'pipe' : 'ignore')
  const child = launch(state, stdio); let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  assert.deepEqual(result, { code: 70, signal: null }); assert.match(stderr, /controller-destination-occupied/u)
  await assert.rejects(stat(state.receipt), { code: 'ENOENT' })
})

test('controller mode rejects a diagnostic/source collision before mutation', async t => {
  const state = await fixture('source'); t.after(() => rm(state.root, { force: true, recursive: true }))
  state.flags[state.flags.indexOf('--ready-fd') + 1] = '2'
  const child = launch(state, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']); let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  assert.deepEqual(result, { code: 70, signal: null }); assert.match(stderr, /controller-source-collision/u)
  await assert.rejects(stat(state.receipt), { code: 'ENOENT' })
})
