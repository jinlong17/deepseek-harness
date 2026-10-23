import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('real child exits nonzero with original marker and reaps its owned child', async () => {
  const script = `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    const { listen } = await import(process.argv[1]);
    const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log('owned-pid', owned.pid);
    const marker = new Error('real-child-original-marker');
    const handle = await listen(async (_request, response) => { response.writeHead(200); response.end('complete'); throw marker });
    try {
      await (await fetch('http://127.0.0.1:' + handle.port + '/')).text();
      await handle.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      owned.kill(); await once(owned, 'exit');
      console.log('owned-reaped');
    }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('./b5-hook-common.mjs', import.meta.url).href], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stdout = ''; let stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const [code, signal] = await once(child, 'exit')
  assert.equal(signal, null); assert.equal(code, 1)
  assert.match(stderr, /real-child-original-marker/u)
  assert.doesNotMatch(stderr, /ERR_HTTP_HEADERS_SENT/u)
  assert.match(stdout, /owned-reaped/u)
  const pid = Number(stdout.match(/owned-pid (\d+)/u)?.[1])
  assert.ok(Number.isInteger(pid))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
