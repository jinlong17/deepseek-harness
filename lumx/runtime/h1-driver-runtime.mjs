import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createH1DriverProfile } from '../profiles/h1-driver-profile.mjs'
import { installH1DriverRuntime } from './h1-driver-plugin.mjs'

let active = false

/** Lab-only qualification fixture. The probe owns its process-global launch state. */

function sourceModule(sourceRoot, relativePath) {
  return pathToFileURL(join(sourceRoot, relativePath)).href
}

/** Launch the actual base profile composition used by the governed H1 driver. */
export async function launchH1DriverRuntime(input) {
  if (active) throw new Error('only one H1 driver runtime may own process launch state')
  active = true
  const runtimeId = randomUUID()
  await mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 })
  const profile = await createH1DriverProfile({
    dataHomeDirectory: input.dataHomeDirectory,
    runtimeId,
    sourceRoot: input.sourceRoot,
  })
  const observations = installH1DriverRuntime(runtimeId)
  const previous = { cwd: process.cwd(), dshHome: process.env.DSH_HOME }
  process.chdir(input.workspaceDirectory)
  process.env.DSH_HOME = input.dataHomeDirectory
  let running
  try {
    const appBoot = await import(sourceModule(input.sourceRoot, 'packages/boot/app-boot/lib/index.js'))
    const launcher = await import(sourceModule(input.sourceRoot, 'apps/cli/lib/profile-boot.js'))
    const launchEnvironment = await import(sourceModule(input.sourceRoot, 'packages/util/launch-environment/lib/index.js'))
    const resolvedProfile = appBoot.loadProfileDirectory(
      'LUMX H1 driver', profile.profileDirectory, profile.installAnchor,
    )
    appBoot.reportSkippedBundles('LUMX H1 driver', resolvedProfile)
    running = await launcher.runProfile({
      environment: launchEnvironment.createLaunchEnvironmentSnapshot([
        { source: 'h1-driver', values: input.environment ?? {} },
      ]),
      profile: 'lumx-h1-driver',
      resolvedProfile: { profile: resolvedProfile, installAnchor: profile.installAnchor },
      patchFiles: [profile.runtimePatch],
      args: [],
    })
    let stopped
    const shutdown = () => stopped ??= (async () => {
      try { await running.shutdown.shutdown(0) } finally {
        observations.release()
        process.chdir(previous.cwd)
        if (previous.dshHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous.dshHome
        active = false
      }
    })()
    return Object.freeze({
      ctx: running.ctx,
      profile: {
        bundles: [...profile.bundles],
        disabledRows: [...profile.disabledRows],
        directory: profile.profileDirectory,
        privacyRows: [...profile.privacyRows],
      },
      shutdown,
      snapshot: observations.snapshot,
    })
  } catch (error) {
    observations.release()
    process.chdir(previous.cwd)
    if (previous.dshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.dshHome
    active = false
    throw error
  }
}
