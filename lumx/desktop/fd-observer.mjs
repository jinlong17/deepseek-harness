import { createHash } from 'node:crypto'
import { fstatSync, readSync } from 'node:fs'

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export function observeFileDescriptors(targets, canary) {
  return targets.map(fd => {
    let stat
    let statError
    try {
      const value = fstatSync(fd)
      stat = { dev: value.dev, ino: value.ino, mode: value.mode, size: value.size }
    } catch (error) { statError = error.code ?? error.name }
    let content
    let readError
    try {
      const buffer = Buffer.alloc(4096)
      const count = readSync(fd, buffer, 0, buffer.length, 0)
      content = { bytes: count, sha256: sha256(buffer.subarray(0, count)) }
    } catch (error) { readError = error.code ?? error.name }
    const canaryRecovered = stat?.dev === canary.dev && stat?.ino === canary.ino
      || (content?.bytes === canary.bytes && content?.sha256 === canary.sha256)
    return { fd, stat, statError, content, readError, canaryRecovered,
      classification: canaryRecovered ? 'canary-recovered' : stat === undefined ? 'closed' : 'reused-noncanary' }
  })
}

if (process.argv[2] === '--child') {
  const input = JSON.parse(process.argv[3])
  process.stdout.write(`${JSON.stringify(observeFileDescriptors(input.targets, input.canary))}\n`)
}
