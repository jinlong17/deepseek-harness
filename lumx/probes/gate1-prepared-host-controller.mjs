/* B5 test-harness draft. Do not execute before B5 writer handoff. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const MAX_FRAME = 64 * 1024
const TYPES = ['runtime-profile', 'runtime-config', 'runtime-bootstrap', 'runtime-entry']
const ROLES = new Set(['host', 'engine-qualification', 'h1-grant'])
const SELF = fileURLToPath(import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
const fileHash = path => hash(readFileSync(path))
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith('--') && all[index + 1] && !all[index + 1].startsWith('--') ? [[value.slice(2), all[index + 1]]] : []))

function arg(name) { if (typeof args[name] !== 'string') throw new Error(`missing --${name}`); return args[name] }
function hex(value, label) { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be SHA-256`); return value }
function ackTimeout(value) { const parsed = Number(value ?? 120_000); if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) throw new Error('ACK timeout is invalid'); return parsed }
function fd(name) { const value = Number(arg(name)); if (!Number.isInteger(value) || value < 3) throw new Error(`invalid --${name}`); return value }
function same(left, right) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
function canonical(value) { return JSON.stringify(value, Object.keys(value).sort()) }
function primaryRole(consumer) { return consumer === 'governed-h1' ? 'h1-grant' : 'host' }

function direct(path, label) {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} is not direct regular file`)
  return realpathSync(path)
}
function row(materialId, materialType, role, path, expected) {
  if (!materialId || !TYPES.includes(materialType) || !ROLES.has(role)) throw new Error('unsupported material role/type')
  const actualPath = direct(path, materialId); const entry = statSync(actualPath); const actual = fileHash(actualPath)
  if (!same(actual, expected)) throw new Error(`${materialId} differs from retained anchor`)
  return Object.freeze({ material_id: materialId, material_type: materialType, role, path: actualPath, sha256: actual, size: entry.size, mode: entry.mode & 0o777 })
}
function write(stream, value) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > MAX_FRAME) throw new Error('frame exceeds bound')
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length)
  return new Promise((resolveWrite, rejectWrite) => stream.write(Buffer.concat([prefix, body]), error => error ? rejectWrite(error) : resolveWrite()))
}
function read(stream, timeoutMs) {
  return new Promise((resolveRead, rejectRead) => {
    let buffered = Buffer.alloc(0); let wanted; let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError)
      error ? rejectRead(error) : resolveRead(value)
    }
    const onEnd = () => finish(new Error('ACK EOF'))
    const onError = error => finish(error)
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (wanted === undefined && buffered.length >= 4) {
        wanted = buffered.readUInt32BE(0)
        if (wanted > MAX_FRAME) return finish(new Error('ACK frame exceeds bound'))
      }
      if (wanted !== undefined && buffered.length >= wanted + 4) {
        if (buffered.length !== wanted + 4) return finish(new Error('multiple ACK frames'))
        try { finish(undefined, JSON.parse(buffered.subarray(4).toString('utf8'))) } catch { finish(new Error('ACK invalid JSON')) }
      }
    }
    const timer = setTimeout(() => finish(new Error('ACK timeout')), timeoutMs)
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError)
  })
}
function verifyAck(ack, ready) {
  if (ack?.schema !== 'g9-b5-host-ack/v1' || !same(ack.nonce ?? '', ready.nonce) || !same(ack.source_anchor_sha256 ?? '', ready.source_anchor_sha256) || !same(ack.preparation_anchor_sha256 ?? '', ready.preparation_anchor_sha256)) throw new Error('ACK identity mismatch')
  hex(ack.runtime_anchor_sha256, 'runtime anchor')
  const wanted = Object.fromEntries(ready.materials.map(value => [value.material_id, value.sha256]))
  if (canonical(ack.material_sha256) !== canonical(wanted)) throw new Error('ACK material hash mismatch')
}
async function cleanup(retained, host, primary) {
  const failures = []
  if (host !== undefined) try { await host.shutdown() } catch (error) { failures.push(error) }
  if (retained !== undefined) try { await retained.cleanup() } catch (error) { failures.push(error) }
  if (primary !== undefined && failures.length) throw new AggregateError([primary, ...failures], 'controller failure plus cleanup failure')
  if (primary !== undefined) throw primary
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'controller cleanup failed')
}
async function main() {
  const source = hex(arg('source-anchor-sha256'), 'source anchor'); const preparation = hex(arg('preparation-anchor-sha256'), 'preparation anchor'); const consumer = arg('consumer')
  const role = primaryRole(consumer)
  if (arg('runtime-role') !== role) throw new Error('consumer requires a different primary runtime role')
  const ready = createWriteStream(null, { fd: fd('ready-fd'), autoClose: false })
  const ack = createReadStream(null, { fd: fd('ack-fd'), autoClose: false })
  let retained; let host; let primary
  try {
    const materials = await import(pathToFileURL(resolve(arg('materials-module'))).href)
    const supervisor = await import(pathToFileURL(resolve(arg('supervisor-module'))).href)
    const factory = await import(pathToFileURL(resolve(arg('factory-module'))).href)
    if (typeof materials.prepareLumxHostLaunch !== 'function' || typeof supervisor.launchLumxHost !== 'function' || typeof factory.makeB5HostLaunchInput !== 'function') throw new Error('controller module contract')
    const supplied = await factory.makeB5HostLaunchInput({ consumer, sourceAnchorSha256: source })
    if (!supplied?.launchInput) throw new Error('factory must supply the exact launch input')
    retained = await materials.prepareLumxHostLaunch(supplied.launchInput)
    const rows = [
      row('host-profile', 'runtime-profile', role, retained.paths.profilePath, retained.anchors.profileSha256),
      row('host-config', 'runtime-config', role, retained.paths.configPath, retained.anchors.configFileSha256),
      row('host-bootstrap', 'runtime-bootstrap', role, retained.paths.bootstrap, retained.anchors.bootstrapSha256),
      row('host-entry', 'runtime-entry', role, retained.paths.hostEntry, retained.anchors.hostEntrySha256),
    ]
    if (consumer === 'external-qwen') {
      const qwen = retained.externalOwner?.materials
      if (!qwen) throw new Error('external Qwen materials unavailable')
      rows.push(
        row('qwen-profile', 'runtime-profile', 'engine-qualification', qwen.paths.profilePath, qwen.anchors.profileSha256),
        row('qwen-settings-template', 'runtime-config', 'engine-qualification', qwen.paths.settingsTemplate, qwen.anchors.settingsSha256),
        row('qwen-guardian', 'runtime-bootstrap', 'engine-qualification', qwen.paths.guardian, qwen.anchors.guardianSha256),
        row('qwen-cli', 'runtime-entry', 'engine-qualification', qwen.qwenCliPath, qwen.anchors.qwenCliSha256),
      )
    }
    const readyFrame = Object.freeze({
      schema: 'g9-b5-host-ready/v1', nonce: randomBytes(32).toString('hex'), source_anchor_sha256: source,
      controller_entry_sha256: fileHash(SELF), consumer, runtime_role: role, port_reservation: true,
      materials: rows, preparation_anchor_sha256: preparation,
      launch_argv: [retained.paths.bootstrap, '/usr/bin/sandbox-exec', retained.paths.profilePath, retained.nodePath, retained.paths.hostEntry, retained.paths.configPath],
    })
    await write(ready, readyFrame)
    const ackFrame = await read(ack, ackTimeout(args['ack-timeout-ms']))
    verifyAck(ackFrame, readyFrame)
    host = await supervisor.launchLumxHost(retained)
    if (typeof factory.runB5HostScenario !== 'function') throw new Error('scenario runner required')
    const qualification = Object.freeze({ consumer, host: Object.freeze({ configSha256: host.configSha256, generation: host.generation, pid: host.pid,
      profileSha256: host.hostProfile.sha256, role }), materials: Object.freeze(rows.map(value => Object.freeze({
      materialId: value.material_id, materialType: value.material_type, role: value.role, sha256: value.sha256,
    }))), runtimeAnchorSha256: ackFrame.runtime_anchor_sha256 })
    await factory.runB5HostScenario({ host, qualification, runtimeAnchorSha256: ackFrame.runtime_anchor_sha256 })
  } catch (error) { primary = error } finally { ready.end(); ack.destroy() }
  await cleanup(retained, host, primary)
}
main().catch(error => { process.stderr.write(`B5 retained-material controller: ${error.stack ?? error.message}\n`); process.exitCode = 1 })
