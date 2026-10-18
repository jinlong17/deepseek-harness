import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

function live(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
function directFile(path) {
  const value = lstatSync(path)
  if (value.isSymbolicLink() || !value.isFile()) throw new Error('Qwen state lease is not a direct file')
  return value
}
function parse(path) {
  const bytes = readFileSync(path)
  if (bytes.length > 1024) throw new Error('Qwen state lease exceeds its byte limit')
  const value = JSON.parse(bytes)
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.nonce !== 'string' || value.nonce.length > 128) {
    throw new Error('Qwen state lease is invalid')
  }
  return value
}

/** Acquire one supervisor writer for a persistent Qwen state root. */
export function acquireQwenStateLease(path, nonce) {
  if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 128) throw new Error('Qwen state lease nonce is invalid')
  let retried = false
  for (;;) {
    let descriptor
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
      const record = `${JSON.stringify({ version: 1, pid: process.pid, nonce })}\n`
      writeFileSync(descriptor, record); fsyncSync(descriptor)
      const identity = fstatSync(descriptor); closeSync(descriptor); descriptor = undefined
      let released = false
      return Object.freeze({ path, release() {
        if (released) return; released = true
        const current = directFile(path); const value = parse(path)
        if (current.dev !== identity.dev || current.ino !== identity.ino || value.pid !== process.pid || value.nonce !== nonce) {
          throw new Error('Qwen state lease identity changed before release')
        }
        unlinkSync(path)
      } })
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      if (error?.code !== 'EEXIST' || retried) throw error
      directFile(path); const owner = parse(path)
      if (live(owner.pid)) throw new Error('Qwen mutable state already has a live owner')
      unlinkSync(path); retried = true
    }
  }
}
