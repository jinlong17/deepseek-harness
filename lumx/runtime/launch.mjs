import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLumxLaunchEnvironment } from '../desktop/launch-environment.mjs'
import { installLumxByokRuntime } from './byok-plugin.mjs'
import { createLumxRuntimeProfile } from './profile.mjs'

let active = false

function sourceModule(sourceRoot, relativePath) {
  return pathToFileURL(join(sourceRoot, relativePath)).href
}

/**
 * Launch the official DSH web profile as the current LUMX shared Host/UI surface.
 * This is private distribution glue, not the complete Electron Developer Host wrapper.
 *
 * @param {{ mode: 'consumer' | 'developer', osHome: string, workspaceDirectory: string, sourceRoot: string,
 *   port: number, auth: { byokKey: string, endpoint: string, gateway: object, getIdentity(): object | undefined, now?(): Date },
 *   environment?: Record<string, string> }} input
 */
export async function launchLumxRuntime(input) {
  if (active) throw new Error('only one LUMX runtime may own process launch state')
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('LUMX runtime port is invalid')
  active = true
  let releaseByok
  let previous
  let cleaned = false
  let running
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    releaseByok?.()
    if (previous !== undefined) {
      process.chdir(previous.cwd)
      if (previous.dshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.dshHome
    }
    active = false
  }
  try {
    const launch = createLumxLaunchEnvironment(input)
    const runtimeId = randomUUID()
    const profileName = input.mode === 'developer' ? 'lumx-developer' : 'lumx'
    await mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 })
    const profile = await createLumxRuntimeProfile({
      dataHomeDirectory: launch.dataHomeDirectory,
      profileName,
      runtimeId,
      sourceRoot: input.sourceRoot,
    })
    releaseByok = installLumxByokRuntime({ runtimeId, ...input.auth })
    previous = { cwd: process.cwd(), dshHome: process.env.DSH_HOME }
    process.chdir(input.workspaceDirectory)
    process.env.DSH_HOME = launch.dataHomeDirectory
    const appBoot = await import(sourceModule(input.sourceRoot, 'packages/boot/app-boot/lib/index.js'))
    const launcher = await import(sourceModule(input.sourceRoot, 'apps/cli/lib/profile-boot.js'))
    const launchEnvironment = await import(sourceModule(input.sourceRoot, 'packages/util/launch-environment/lib/index.js'))
    const resolvedProfile = appBoot.loadProfileDirectory('LUMX Desktop', profile.profileDirectory, profile.installAnchor)
    appBoot.reportSkippedBundles('LUMX Desktop', resolvedProfile)
    running = await launcher.runProfile({
      environment: launchEnvironment.createLaunchEnvironmentSnapshot([
        { source: 'process', values: input.environment ?? {} },
      ]),
      profile: profileName,
      resolvedProfile: { profile: resolvedProfile, installAnchor: profile.installAnchor },
      patchFiles: [profile.runtimePatch],
      args: ['--no-open', '--host', '127.0.0.1', '--port', String(input.port)],
    })
    const port = running.ctx.webServer.port
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const readyUrl = running.ctx.connection.authenticatedUrl(baseUrl)
    let stopped
    const shutdown = () => stopped ??= (async () => {
      try { await running.shutdown.shutdown(0) } finally {
        cleanup()
      }
    })()
    return Object.freeze({
      baseUrl,
      ctx: running.ctx,
      dataHomeDirectory: launch.dataHomeDirectory,
      pid: process.pid,
      profileName,
      readyUrl,
      surface: 'official-dsh-web-profile-shared-host',
      shutdown,
    })
  } catch (error) {
    try { await running?.shutdown.shutdown(1) } catch {}
    cleanup()
    throw error
  }
}
