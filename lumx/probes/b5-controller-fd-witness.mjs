import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'

import { observeFileDescriptors } from '../desktop/fd-observer.mjs'

const TARGETS = Object.freeze([0, 1, 2, 3, 10, 11, 512])
const CONTROLS = Object.freeze({ ack: 21, diagnostic: 22, ready: 20, receipt: 23 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exact = (value, expected) => JSON.stringify(value) === JSON.stringify(expected)

function direct(path, label) {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a direct regular file`)
  return realpathSync(path)
}

function configuration(path, expected) {
  const selected = direct(path, 'scenario config'); const bytes = readFileSync(selected)
  if (!/^[a-f0-9]{64}$/u.test(expected) || hash(bytes) !== expected) throw new Error('scenario config differs from parent anchor')
  const value = JSON.parse(bytes)
  const fd = value?.fdQualification
  if (value?.schema !== 'g9-b5-runtime-scenario/v1' || fd?.schema !== 'g9-b5-desktop-fd-qualification/v1'
      || !exact(fd.targets, TARGETS) || !exact(fd.controlFds, CONTROLS)
      || typeof fd.preexecReceiptPath !== 'string') throw new Error('desktop FD qualification config is invalid')
  const canary = fd.canary
  if (canary === null || typeof canary !== 'object' || Object.keys(canary).sort().join(',') !== 'bytes,dev,ino,path,sha256'
      || !Number.isSafeInteger(canary.dev) || !Number.isSafeInteger(canary.ino) || !Number.isSafeInteger(canary.bytes)
      || canary.bytes < 1 || canary.bytes > 4096 || !/^[a-f0-9]{64}$/u.test(canary.sha256)) throw new Error('desktop FD canary metadata is invalid')
  return Object.freeze({ canary: Object.freeze({ ...canary, path: direct(canary.path, 'desktop FD canary') }), config: value, fd })
}

function receipt(path, canary) {
  const selected = direct(path, 'FD preexec receipt'); const bytes = readFileSync(selected); const value = JSON.parse(bytes)
  if (value?.schema !== 'g9-b5-fd-controller-preexec/v1' || value.pid !== process.pid
      || !exact(value.targets, TARGETS) || !exact(value.controlFds, { ready: 20, ack: 21, diagnostic: 22 })
      || value.transientReceiptFd !== 23 || value.canaryFormatMatched !== true || value.softRlimitAfter !== 64
      || typeof value.softRlimitBefore !== 'string' || !/^\d+$/u.test(value.softRlimitBefore)
      || value.canary?.dev !== canary.dev || value.canary?.ino !== canary.ino || value.canary?.bytes !== canary.bytes
      || Object.keys(value).sort().join(',') !== 'canary,canaryFormatMatched,controlFds,pid,schema,softRlimitAfter,softRlimitBefore,targets,transientReceiptFd') throw new Error('FD preexec receipt is invalid')
  return Object.freeze({ path: selected, sha256: hash(bytes), value: Object.freeze(value) })
}

export function validateB5FdObservation(rows, canary) {
  if (!Array.isArray(rows) || rows.length !== TARGETS.length || !exact(rows.map(row => row?.fd), TARGETS)) throw new Error('FD attacker target coverage differs')
  if (rows.some(row => row.qualified !== true || row.identityMatched !== true || row.contentMatched !== true
      || row.stat?.dev !== canary.dev || row.stat?.ino !== canary.ino
      || row.content?.bytes !== canary.bytes || row.content?.sha256 !== canary.sha256)) throw new Error('FD attacker witness did not retain identity and content')
  return rows.map(row => Object.freeze({ fd: row.fd, stat: Object.freeze({ dev: row.stat.dev, ino: row.stat.ino }),
    content: Object.freeze({ bytes: row.content.bytes, sha256: row.content.sha256 }), identityMatched: true, contentMatched: true }))
}

export function observeB5ControllerFds({ configPath, configSha256, stage }) {
  if (!['beforeImports', 'beforeLaunch'].includes(stage)) throw new Error('FD attacker witness stage is invalid')
  const selected = configuration(configPath, configSha256); const preexec = receipt(selected.fd.preexecReceiptPath, selected.canary)
  return Object.freeze({ schema: 'g9-b5-fd-attacker-witness/v1', stage, pid: process.pid, targets: TARGETS,
    canary: selected.canary, preexecReceipt: Object.freeze({ path: preexec.path, sha256: preexec.sha256 }),
    observations: Object.freeze(validateB5FdObservation(observeFileDescriptors(TARGETS, selected.canary), selected.canary)) })
}

export function productFdQualification(config) {
  const fd = config?.fdQualification
  if (fd?.schema !== 'g9-b5-desktop-fd-qualification/v1') return undefined
  return Object.freeze({ canary: fd.canary, protectedPaths: fd.protectedPaths, targets: fd.targets })
}
