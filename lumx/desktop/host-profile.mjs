import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function actual(path) { return existsSync(path) ? realpathSync(path) : resolve(path) }
function quote(path) { return JSON.stringify(actual(path)) }
function parents(path) {
  const output = []
  let cursor = resolve(path)
  while (dirname(cursor) !== cursor) { cursor = dirname(cursor); output.push(cursor) }
  return output
}

/** Exact product Host profile grants retained from the original live Host runner. */
export function createLumxHostSandboxProfile({ dataHome, forkRoot, nodePath, privateRoots, processHome, runtime, sourceRoot, temporary, workspaceDirectory, ports }) {
  const readable = [forkRoot, sourceRoot, dirname(dirname(nodePath)), runtime]
  const writable = [processHome, temporary, dataHome, workspaceDirectory]
  const lines = [
    '(version 1)', '(deny default)', '(deny network*)', '(allow process*)', '(allow sysctl-read)',
    '(allow file-read* (literal "/"))', '(allow file-read-metadata (literal "/tmp"))',
  ]
  for (const path of [...readable, ...writable]) {
    for (const ancestor of [path, ...parents(path)]) lines.push(`(allow file-read-metadata (literal ${quote(ancestor)}))`)
  }
  for (const path of ['/System', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/Library/Apple', '/Library/Fonts']) {
    lines.push(`(allow file-read* (subpath ${quote(path)}))`)
  }
  lines.push('(allow file-read* (literal "/dev/null"))', '(allow file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))')
  for (const path of readable) lines.push(`(allow file-read* (subpath ${quote(path)}))`)
  for (const path of writable) lines.push(`(allow file-read* (subpath ${quote(path)}))`, `(allow file-write* (subpath ${quote(path)}))`)
  for (const path of privateRoots) lines.push(`(deny file-read* file-write* (subpath ${quote(path)}))`)
  for (const port of ports) {
    lines.push(`(allow network-bind (local tcp4 "localhost:${port}"))`)
    lines.push(`(allow network-inbound (local tcp4 "localhost:${port}"))`)
    lines.push(`(allow network-outbound (remote tcp4 "localhost:${port}"))`)
  }
  return `${[...new Set(lines)].join('\n')}\n`
}
