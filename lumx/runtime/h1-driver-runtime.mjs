import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createGovernedH1Profile } from '../profiles/governed-h1-profile.mjs'
import { installGovernedH1Runtime } from './governed-h1-adapter.mjs'
import { installLumxGovernance } from './governance.mjs'

let active = false

/** Lab-owned launcher that exercises the product governed-H1 composition. */

function sourceModule(sourceRoot, relativePath) {
  return pathToFileURL(join(sourceRoot, relativePath)).href
}

/** Create an Agent through the product policy installed before agent publication. */
export function createH1GovernedAgent(ctx, input) {
  return ctx.agents.create({
    sessionId: input.sessionId,
    agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' },
    meta: { cwd: input.workspaceDirectory },
  })
}

/** Launch the actual product profile composition used by the H1 qualification probe. */
export async function launchH1DriverRuntime(input) {
  if (active) throw new Error('only one H1 driver runtime may own process launch state')
  active = true
  let observations
  let governance
  let previous
  let cleaned = false
  let running
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    observations?.release()
    if (previous !== undefined) {
      process.chdir(previous.cwd)
      if (previous.dshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.dshHome
    }
    active = false
  }
  try {
    const runtimeId = randomUUID()
    await mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 })
    const profile = await createGovernedH1Profile({
      dataHomeDirectory: input.dataHomeDirectory,
      runtimeId,
      sourceRoot: input.sourceRoot,
    })
    observations = installGovernedH1Runtime({
      brokerEndpoint: input.brokerEndpoint,
      modelEndpoint: input.modelEndpoint,
      runtimeId,
    })
    previous = { cwd: process.cwd(), dshHome: process.env.DSH_HOME }
    process.chdir(input.workspaceDirectory)
    process.env.DSH_HOME = input.dataHomeDirectory
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
      profile: 'lumx-governed-h1',
      resolvedProfile: { profile: resolvedProfile, installAnchor: profile.installAnchor },
      patchFiles: [profile.runtimePatch],
      setup(hostCtx) { governance = installLumxGovernance(hostCtx) },
      args: [],
    })
    if (governance === undefined) throw new Error('governed H1 governance setup was not invoked')
    governance.assertReady()
    let stopped
    const shutdown = () => stopped ??= (async () => {
      try { await running.shutdown.shutdown(0) } finally {
        cleanup()
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
      assertAgent: observations.assertAgent,
    })
  } catch (error) {
    try { await running?.shutdown.shutdown(1) } catch {}
    cleanup()
    throw error
  }
}
