import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { h1Stubs, qwenStub } from './b5-fixed-stubs.mjs'
import { deferred, freePort, listen } from './b5-hook-common.mjs'

const url = handle => `http://127.0.0.1:${handle.port}/`
const tick = () => new Promise(resolve => setImmediate(resolve))
const contains = (error, marker) => error === marker || error instanceof AggregateError && error.errors.some(value => contains(value, marker))

test('normal response, deliberate disconnect, H1 refusal, and free port close normally', async () => {
  const normal = await listen((_request, response) => { response.writeHead(200); response.end('ok') })
  assert.equal(await (await fetch(url(normal))).text(), 'ok')
  await normal.close()
  assert.equal(normal.failure(), undefined)

  const entered = deferred(); const disconnected = deferred()
  const cancel = await listen((_request, response) => {
    response.writeHead(200); response.write('first')
    entered.resolve(); response.once('close', disconnected.resolve)
  })
  const controller = new AbortController()
  const response = await fetch(url(cancel), { signal: controller.signal })
  assert.equal(response.status, 200)
  await entered.promise
  controller.abort()
  await disconnected.promise
  await cancel.close()
  assert.equal(cancel.failure(), undefined)

  const h1 = await h1Stubs('/private/tmp/g9-b5-unused-native-canary')
  const payload = JSON.stringify({ messages: [{ role: 'user', content: 'gateway-refusal' }] })
  assert.equal((await fetch(h1.modelEndpoint, { method: 'POST', body: payload })).status, 403)
  assert.equal((await fetch(h1.brokerEndpoint, { method: 'POST', body: payload })).status, 403)
  await h1.close()
  assert.ok(Number.isInteger(await freePort()))
})

for (const kind of ['sync', 'async']) {
  test(`${kind} pre-header failure preserves original and bounded 500`, async () => {
    const marker = new Error(`${kind}-original-marker`)
    const handle = await listen(kind === 'sync' ? () => { throw marker } : async () => { throw marker })
    const response = await fetch(url(handle))
    assert.equal(response.status, 500)
    assert.match(await response.text(), /original-marker/u)
    await assert.rejects(handle.close(), error => contains(error, marker))
    assert.equal(handle.failure(), marker)
  })
}

test('post-200 partial stream failure destroys response and rejects close with original', async () => {
  const marker = new Error('partial-original-marker')
  const handle = await listen(async (_request, response) => {
    response.writeHead(200); response.write('partial')
    await tick(); throw marker
  })
  const response = await fetch(url(handle))
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  await assert.rejects(handle.close(), error => contains(error, marker) && !String(error).includes('ERR_HTTP_HEADERS_SENT'))
})

test('close drains a handler that ended 200 before its late rejection', async () => {
  const release = deferred(); const ended = deferred(); const marker = new Error('late-original-marker')
  const handle = await listen(async (_request, response) => {
    response.writeHead(200); response.end('complete'); ended.resolve()
    await release.promise; throw marker
  })
  assert.equal(await (await fetch(url(handle))).text(), 'complete')
  await ended.promise
  const closing = handle.close(); let settled = false
  closing.then(() => { settled = true }, () => { settled = true })
  await tick(); assert.equal(settled, false)
  release.resolve()
  await assert.rejects(closing, error => contains(error, marker))
  assert.equal(handle.close(), closing)
  await assert.rejects(handle.close(), error => contains(error, marker))
})

test('close drains a handler that ends normally after close begins', async () => {
  const release = deferred(); const ended = deferred()
  const handle = await listen(async (_request, response) => {
    response.writeHead(200); response.end('complete'); ended.resolve()
    await release.promise
  })
  await (await fetch(url(handle))).text(); await ended.promise
  const closing = handle.close(); let settled = false
  closing.then(() => { settled = true }, () => { settled = true })
  await tick(); assert.equal(settled, false)
  release.resolve(); await closing
  assert.equal(handle.failure(), undefined)
})

test('unexpected failure after client disconnect remains a failure', async () => {
  const release = deferred(); const entered = deferred(); const disconnected = deferred()
  const marker = new Error('disconnect-original-marker')
  const handle = await listen(async (_request, response) => {
    response.writeHead(200); response.write('first'); entered.resolve()
    response.once('close', disconnected.resolve)
    await release.promise; throw marker
  })
  const controller = new AbortController()
  await fetch(url(handle), { signal: controller.signal }); await entered.promise
  controller.abort(); await disconnected.promise
  const closing = handle.close(); release.resolve()
  await assert.rejects(closing, error => contains(error, marker))
})

test('response cleanup failure retains first handler error', async () => {
  const marker = new Error('primary-original-marker')
  const secondary = new Error('close-secondary-marker')
  const handle = await listen(async (_request, response) => { response.writeHead(200); response.end('done'); throw marker })
  handle.server.closeAllConnections = () => { throw secondary }
  await (await fetch(url(handle))).text()
  await assert.rejects(handle.close(), error => error instanceof AggregateError && contains(error, marker) && contains(error, secondary))
})

test('bounded close timeout fails, retains prior error and observes late rejection', async () => {
  const release = deferred(); const entered = deferred()
  const marker = new Error('late-after-timeout-marker')
  const handle = await listen(async (_request, response) => {
    response.writeHead(200); response.end('done'); entered.resolve()
    await release.promise; throw marker
  })
  await (await fetch(url(handle))).text(); await entered.promise
  const nativeTimer = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) => nativeTimer(callback, delay === 30_000 ? 20 : delay, ...args)
  let closing
  try { closing = handle.close() } finally { globalThis.setTimeout = nativeTimer }
  await assert.rejects(closing, /listener close\/drain timed out/u)
  release.resolve(); await tick()
  assert.equal(handle.failure(), marker)
  await assert.rejects(handle.close(), /listener close\/drain timed out/u)
})

test('bounded close retains an already latched cause alongside a drain timeout', async () => {
  const release = deferred(); const entered = deferred()
  const marker = new Error('before-timeout-original-marker')
  const handle = await listen(async (request, response) => {
    if (request.url === '/error') { response.writeHead(200); response.end('done'); throw marker }
    response.writeHead(200); response.end('done'); entered.resolve(); await release.promise
  })
  await (await fetch(`${url(handle)}hold`)).text(); await entered.promise
  await (await fetch(`${url(handle)}error`)).text()
  const nativeTimer = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) => nativeTimer(callback, delay === 30_000 ? 20 : delay, ...args)
  let closing
  try { closing = handle.close() } finally { globalThis.setTimeout = nativeTimer }
  await assert.rejects(closing, error => error instanceof AggregateError && contains(error, marker) && error.errors.some(value => /listener close\/drain timed out/u.test(String(value))))
  release.resolve(); await tick()
})

test('request arriving after close starts never enters the user handler', async () => {
  let entered = 0; let destroyed = 0
  const handle = await listen(() => { entered += 1 })
  const closing = handle.close()
  handle.server.emit('request', {}, { destroy: () => { destroyed += 1 } })
  await closing
  assert.equal(entered, 0)
  assert.equal(destroyed, 1)
})

test('non-Error and hostile diagnostic fields cannot replace the thrown primary', async () => {
  for (const marker of [{ get message() { throw new Error('hostile getter') } }, new Proxy(new Error('proxy primary'), {
    getPrototypeOf() { throw new Error('hostile prototype') },
  })]) {
    const handle = await listen(() => { throw marker })
    assert.equal((await fetch(url(handle))).status, 500)
    await assert.rejects(handle.close(), error => contains(error, marker))
    assert.equal(handle.failure(), marker)
  }
})

test('undefined and null handler rejections still fail close', async () => {
  for (const marker of [undefined, null]) {
    const handle = await listen(() => { throw marker })
    assert.equal((await fetch(url(handle))).status, 500)
    const outcome = await handle.close().then(() => ({ ok: true }), reason => ({ ok: false, reason }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.reason, marker)
  }
})

test('diagnostic write failure remains secondary to the original handler error', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'g9-b5-hook-write-fail-'))
  const sink = join(scratch, 'read-only-fd22')
  const writeFd = openSync(sink, 'wx', 0o600); closeSync(writeFd)
  const readFd = openSync(sink, 'r')
  const script = `
    const { listen } = await import(process.argv[1]);
    const marker = new Error('write-fail-original-marker');
    const handle = await listen(async (_request, response) => { response.writeHead(200); response.end('done'); throw marker });
    await (await fetch('http://127.0.0.1:' + handle.port)).text();
    try { await handle.close(); process.exitCode = 2 } catch (error) {
      const errors = error instanceof AggregateError ? error.errors : [error];
      if (errors[0] !== marker || !errors.some(value => value?.code === 'EBADF')) process.exitCode = 3;
      else { console.log('primary-preserved-diagnostic-failed'); process.exitCode = 1 }
    }
  `
  try {
    const stdio = ['ignore', 'pipe', 'pipe', ...Array(19).fill('ignore'), readFd]
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('./b5-hook-common.mjs', import.meta.url).href, '--diagnostic-fd', '22'], { stdio })
    let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
    const [code, signal] = await once(child, 'exit')
    assert.equal(signal, null); assert.equal(code, 1)
    assert.match(stdout, /primary-preserved-diagnostic-failed/u)
    assert.equal(readFileSync(sink, 'utf8'), '')
  } finally { closeSync(readFd); rmSync(scratch, { recursive: true, force: true }) }
})

test('diagnostic redacts bounded Error fields and emits only on first failure', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'g9-b5-hook-diagnostic-'))
  const sink = join(scratch, 'diagnostic-fd22'); const fd = openSync(sink, 'wx', 0o600)
  const script = `
    const { listen } = await import(process.argv[1]);
    const cause = new Error('causemarker token=topsecret http://example.invalid/?key=private');
    const marker = new Error('rootmarker password=secretvalue ' + 'x'.repeat(10000), { cause });
    cause.cause = marker;
    const handle = await listen(async (_request, response) => { response.writeHead(200); response.end('done'); throw marker });
    await (await fetch('http://127.0.0.1:' + handle.port)).text();
    try { await handle.close() } catch {}
    try { await handle.close() } catch {}
  `
  try {
    const stdio = ['ignore', 'pipe', 'pipe', ...Array(19).fill('ignore'), fd]
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('./b5-hook-common.mjs', import.meta.url).href, '--diagnostic-fd', '22'], { stdio })
    const [code, signal] = await once(child, 'exit')
    assert.equal(signal, null); assert.equal(code, 0)
    const diagnostic = readFileSync(sink, 'utf8')
    assert.equal(diagnostic.match(/B5 fixture handler failure:/gu)?.length, 1)
    assert.match(diagnostic, /rootmarker/u)
    assert.match(diagnostic, /causemarker/u)
    assert.match(diagnostic, /\[cause cycle\]/u)
    assert.doesNotMatch(diagnostic, /topsecret|secretvalue|example\.invalid/u)
    assert.ok(Buffer.byteLength(diagnostic) <= 4096)
  } finally { closeSync(fd); rmSync(scratch, { recursive: true, force: true }) }
})

test('Qwen STREAM terminal settles on connection close without an unexpected handler error', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'g9-b5-hook-stream-'))
  const barriers = { streamActive: false, streamFirst: deferred(), streamRelease: deferred(), streamFinished: deferred(), cancelStarted: deferred(), cancelObserved: deferred() }
  const stub = await qwenStub({ worldEffect: join(scratch, 'world'), rejectEffect: join(scratch, 'reject'), lateEffect: join(scratch, 'late'), toolCommand: 'true', rejectCommand: 'true', lateCommand: 'true' }, barriers)
  try {
    const controller = new AbortController()
    const response = await fetch(stub.endpoint, { method: 'POST', signal: controller.signal, body: JSON.stringify({ model: 'synthetic', messages: [{ role: 'user', content: 'B5 STREAM' }] }) })
    assert.equal(response.status, 200)
    await barriers.streamFirst.promise
    controller.abort(); barriers.streamRelease.resolve()
    await barriers.streamFinished.promise
    await stub.close()
  } finally {
    barriers.streamRelease.resolve()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('real controller cleanup chain reports original marker and reaps its owned child', async () => {
  const script = `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { writeSync } from 'node:fs';
    const { listen } = await import(process.argv[1]);
    const { withB5FactoryCleanup, closeB5HostOwners } = await import(process.argv[2]);
    const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log('owned-pid', owned.pid);
    const marker = new Error('real-child-original-marker');
    const handle = await listen(async (_request, response) => { response.writeHead(200); response.end('complete'); throw marker });
    const factory = { closeB5HostFactory: () => handle.close() };
    let primary;
    try {
      try {
        await withB5FactoryCleanup(factory.closeB5HostFactory, async () => {
          await (await fetch('http://127.0.0.1:' + handle.port + '/')).text();
          throw new Error('separate scenario primary');
        });
      } catch (error) { primary = error }
      try { await closeB5HostOwners({ factory, primary }) } catch (error) {
        const fd = process.argv.includes('--diagnostic-fd') ? 22 : 2;
        writeSync(fd, 'B5 retained-material controller: ' + (error.stack ?? error.message) + '\\n');
        process.exitCode = 1;
      }
    } finally {
      owned.kill(); await once(owned, 'exit');
      console.log('owned-reaped');
    }
  `
  for (const fd22 of [false, true]) {
    const scratch = mkdtempSync(join(tmpdir(), 'g9-b5-hook-child-'))
    const stderrFile = join(scratch, 'poisoned-fd2')
    const diagnosticFile = join(scratch, 'diagnostic-fd22')
    const poisoned = fd22 ? openSync(stderrFile, 'wx', 0o600) : undefined
    const diagnosticFd = fd22 ? openSync(diagnosticFile, 'wx', 0o600) : undefined
    try {
      const argv = ['--input-type=module', '-e', script, new URL('./b5-hook-common.mjs', import.meta.url).href,
        new URL('./b5-factory-cleanup.mjs', import.meta.url).href, ...(fd22 ? ['--diagnostic-fd', '22'] : [])]
      const stdio = fd22 ? ['ignore', 'pipe', poisoned, ...Array(19).fill('ignore'), diagnosticFd] : ['ignore', 'pipe', 'pipe']
      const child = spawn(process.execPath, argv, { stdio, detached: true })
      let stdout = ''; let diagnostic = ''
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
      if (!fd22) { child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { diagnostic += chunk }) }
      const [code, signal] = await once(child, 'exit')
      if (fd22) diagnostic = readFileSync(diagnosticFile, 'utf8')
      assert.equal(signal, null); assert.equal(code, 1)
      assert.equal(diagnostic.match(/real-child-original-marker/gu)?.length, 1)
      assert.doesNotMatch(diagnostic, /ERR_HTTP_HEADERS_SENT/u)
      assert.match(stdout, /owned-reaped/u)
      const pid = Number(stdout.match(/owned-pid (\d+)/u)?.[1])
      assert.ok(Number.isInteger(pid))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      if (fd22) assert.equal(readFileSync(stderrFile, 'utf8'), '')
    } finally {
      if (poisoned !== undefined) closeSync(poisoned)
      if (diagnosticFd !== undefined) closeSync(diagnosticFd)
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})
