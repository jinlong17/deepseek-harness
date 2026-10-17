import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLumxLaunchEnvironment } from '../desktop/launch-environment.mjs'
import { installLumxByokRuntime } from './byok-plugin.mjs'
import { createLumxRuntimeProfile } from './profile.mjs'
import { installLumxGovernance } from './governance.mjs'

let active = false

function sourceModule(sourceRoot, relativePath) {
  return pathToFileURL(join(sourceRoot, relativePath)).href
}

async function qualifyGovernance(ctx, governance) {
  const loader = ctx.loader
  const target = governance.rows[0]
  const entry = [...loader.entries()].find(value => value.options.id === target.id)
  if (!entry) throw new Error(`LUMX governance row is absent: ${target.id}`)
  const group = entry.parent
  const original = entry.options
  await group.update(group.data.map(row => row.id === target.id ? { ...row, disabled: false } : row))
  const lateEnableDenied = entry.disabled && entry.options === original
  let removeDenied = false
  try { group.remove(target.id) } catch { removeDenied = true }
  let aliasDenied = false
  try { await group.create({ name: target.resolution.url }) } catch { aliasDenied = true }
  await group.update([
    ...group.data.filter(row => row.id !== target.id),
    { id: `${target.id}-renamed`, name: target.specifier },
  ])
  const renameDenied = entry.options === original
    && group.data.every(row => row.id !== `${target.id}-renamed`)
  return Object.freeze({ aliasDenied, lateEnableDenied, removeDenied, renameDenied })
}

/**
 * Launch the official DSH web profile as the current LUMX shared Host/UI surface.
 * This is private distribution glue, not the complete Electron Developer Host wrapper.
 *
 * @param {{ mode: 'consumer' | 'developer', osHome: string, workspaceDirectory: string, sourceRoot: string,
 *   port: number, auth: { byokKey: string, endpoint: string, gateway: object, getIdentity(): object | undefined, now?(): Date },
 *   environment?: Record<string, string> }} input
 */
export async function launchLumxRuntimeInProcess(input) {
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
    let governance
    running = await launcher.runProfile({
      environment: launchEnvironment.createLaunchEnvironmentSnapshot([
        { source: 'process', values: input.environment ?? {} },
      ]),
      profile: profileName,
      resolvedProfile: { profile: resolvedProfile, installAnchor: profile.installAnchor },
      patchFiles: [profile.runtimePatch],
      setup(hostCtx) {
        governance = installLumxGovernance(hostCtx)
        governance.assertInstalled()
      },
      args: ['--no-open', '--host', '127.0.0.1', '--port', String(input.port)],
    })
    if (!governance) throw new Error('LUMX governance setup was not invoked')
    const governanceQualification = await qualifyGovernance(running.ctx, governance)
    if (Object.values(governanceQualification).some(value => value !== true)) {
      throw new Error('LUMX governance qualification failed')
    }
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
      governance: Object.freeze({ rows: governance.rows.map(row => ({
        id: row.id, specifier: row.specifier, url: row.resolution.url,
        format: row.resolution.format, generation: row.resolution.generation,
      })), qualification: governanceQualification }),
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
