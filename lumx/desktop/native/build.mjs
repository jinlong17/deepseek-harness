import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('./bootstrap.c', import.meta.url))

/** Build the fixed native bootstrap with the installed Apple SDK toolchain. */
export function buildLumxNativeBootstrap(output) {
  const target = resolve(output)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  execFileSync('/usr/bin/xcrun', ['clang', '-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', target], {
    env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  chmodSync(target, 0o700)
  return realpathSync(target)
}

export function buildLumxNativeFdHarness(output) {
  const source = fileURLToPath(new URL('./fd-harness.c', import.meta.url))
  execFileSync('/usr/bin/xcrun', ['clang', '-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output], { stdio: 'pipe' })
  chmodSync(output, 0o700)
  return output
}

/** Build the fixed EOF guardian used to reap one detached engine process group. */
export function buildLumxNativeGuardian(output) {
  const source = fileURLToPath(new URL('./guardian.c', import.meta.url))
  const target = resolve(output)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  execFileSync('/usr/bin/xcrun', ['clang', '-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', target], {
    env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  chmodSync(target, 0o700)
  return realpathSync(target)
}
