import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_RECEIPT_BYTES = 16 * 1024
const RECEIPT_SUFFIX = '.receipt'
const TEMP_SUFFIX = '.birth-tmp'

function canonicalFuturePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const missing = []; let cursor = resolve(value)
  while (true) {
    try {
      const metadata = lstatSync(cursor)
      if (metadata.isSymbolicLink()) throw new Error(`${label} must not contain a symbolic link`)
      if (!metadata.isDirectory()) throw new Error(`${label} existing ancestor must be a directory`)
      return join(realpathSync(cursor), ...missing.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error(`${label} has no existing parent`)
      missing.push(basename(cursor)); cursor = parent
    }
  }
}

function contains(parent, child) {
  const delta = relative(parent, child)
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta))
}

function ensureDirectDirectory(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(path) !== path) throw new Error(`${label} must be a direct directory`)
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

function readRegular(path) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) throw new Error('external session eligibility receipt is not a bounded regular file')
  return readFileSync(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })
}

export function createEligibilityFiles({ eligibilityRoot, persistenceRoot }) {
  const markerRoot = canonicalFuturePath(eligibilityRoot, 'eligibility root')
  const logRoot = canonicalFuturePath(persistenceRoot, 'persistence root')
  if (contains(markerRoot, logRoot) || contains(logRoot, markerRoot)) throw new Error('eligibility and persistence roots must be disjoint')
  if (markerRoot.split(sep).includes('.private')) throw new Error('eligibility root must not be inside private engine state')
  ensureDirectDirectory(markerRoot, 'eligibility root')
  return Object.freeze({
    markerRoot,
    logRoot,
    path(key) { return join(markerRoot, `${key}${RECEIPT_SUFFIX}`) },
    read(path) { return readRegular(path) },
    reserve(path, preparedBytes, committedBytes) {
      if (!path.endsWith(RECEIPT_SUFFIX) || path.endsWith('.jsonl') || path.endsWith('.jsonl.zstd')) throw new Error('eligibility receipt suffix is invalid')
      const temporary = join(markerRoot, `${basename(path, RECEIPT_SUFFIX)}.${crypto.randomUUID()}${TEMP_SUFFIX}`)
      if (temporary.endsWith('.jsonl') || temporary.endsWith('.jsonl.zstd')) throw new Error('eligibility temporary suffix is invalid')
      writeExclusive(path, preparedBytes)
      try { writeExclusive(temporary, committedBytes); syncDirectory(markerRoot) } catch (error) { try { unlinkSync(path); syncDirectory(markerRoot) } catch {}; throw error }
      return Object.freeze({ path, temporary })
    },
    replaceOwned({ path, temporary }, expectedBytes, replacementBytes) {
      const current = readRegular(path)
      if (!current.equals(expectedBytes)) throw new Error('eligibility receipt changed outside its birth capability')
      if (replacementBytes !== undefined) {
        const replacement = join(markerRoot, `${basename(path, RECEIPT_SUFFIX)}.${crypto.randomUUID()}${TEMP_SUFFIX}`)
        writeExclusive(replacement, replacementBytes); renameSync(replacement, path)
      } else renameSync(temporary, path)
      syncDirectory(markerRoot)
    },
    discardTemporary(temporary) { try { unlinkSync(temporary); syncDirectory(markerRoot) } catch (error) { if (error?.code !== 'ENOENT') throw error } },
    assertIdentity(path) {
      const metadata = statSync(path)
      if (!metadata.isFile()) throw new Error('eligibility receipt identity is invalid')
    },
  })
}

export { MAX_RECEIPT_BYTES, RECEIPT_SUFFIX, TEMP_SUFFIX }
