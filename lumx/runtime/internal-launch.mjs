import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLumxLaunchEnvironment } from '../desktop/launch-environment.mjs'
import { installLumxByokRuntime } from './byok-plugin.mjs'
import { createLumxRuntimeProfile } from './profile.mjs'
import { installLumxGovernance } from './governance.mjs'
import { installExternalQwenComposition } from './external-qwen-composition.mjs'
import { createGovernedH1Profile } from '../profiles/governed-h1-profile.mjs'
import { installGovernedH1Composition } from './governed-h1-composition.mjs'
import { installGovernedH1Runtime } from './governed-h1-adapter.mjs'

let active = false

function sourceModule(sourceRoot, relativePath) {
  return pathToFileURL(join(sourceRoot, relativePath)).href
}

/**
 * Launch the official DSH web profile as the current LUMX shared Host/UI surface.
 * This is private distribution glue, not the complete Electron Developer Host wrapper.
 *
 * @param {{ consumer?: 'desktop-byok' | 'platform-stub', mode: 'consumer' | 'developer', osHome: string, workspaceDirectory: string, sourceRoot: string,
 *   port: number, auth?: { byokKey: string, endpoint: string, gateway: object, getIdentity(): object | undefined, now?(): Date },
 *   environment?: Record<string, string> }} input
 */
export async function launchLumxRuntimeInProcess(input) {
  if (active) throw new Error('only one LUMX runtime may own process launch state')
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('LUMX runtime port is invalid')
  active = true
  let releaseByok
  let releaseH1
  let previous
  let cleaned = false
  let running
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    releaseByok?.()
    releaseH1?.()
    if (previous !== undefined) {
      process.chdir(previous.cwd)
      if (previous.dshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.dshHome
    }
    active = false
  }
  try {
    const consumer = input.consumer ?? 'desktop-byok'
    if (!['desktop-byok', 'external-qwen', 'governed-h1', 'platform-stub'].includes(consumer)) throw new Error('LUMX product consumer is invalid')
    if (consumer === 'desktop-byok' && input.auth === undefined) throw new Error('desktop BYOK consumer requires launch-scoped admission')
    const launch = createLumxLaunchEnvironment(input)
    const runtimeId = randomUUID()
    const profileName = consumer === 'governed-h1' ? 'lumx-governed-h1' : input.mode === 'developer' ? 'lumx-developer' : 'lumx'
    await mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 })
    const profile = consumer === 'governed-h1' ? await createGovernedH1Profile({
      dataHomeDirectory: launch.dataHomeDirectory, runtimeId, sourceRoot: input.sourceRoot,
    }) : await createLumxRuntimeProfile({
      consumer,
      dataHomeDirectory: launch.dataHomeDirectory,
      profileName,
      runtimeId,
      sourceRoot: input.sourceRoot,
    })
    if (consumer === 'desktop-byok') releaseByok = installLumxByokRuntime({ runtimeId, ...input.auth })
    if (consumer === 'governed-h1') {
      if (input.h1 === undefined) throw new Error('governed H1 ports are unavailable')
      releaseH1 = installGovernedH1Runtime({ runtimeId, ...input.h1 }).release
    }
    previous = { cwd: process.cwd(), dshHome: process.env.DSH_HOME }
    process.chdir(input.workspaceDirectory)
    process.env.DSH_HOME = launch.dataHomeDirectory
    const appBoot = await import(sourceModule(input.sourceRoot, 'packages/boot/app-boot/lib/index.js'))
    const launcher = await import(sourceModule(input.sourceRoot, 'apps/cli/lib/profile-boot.js'))
    const launchEnvironment = await import(sourceModule(input.sourceRoot, 'packages/util/launch-environment/lib/index.js'))
    const resolvedProfile = appBoot.loadProfileDirectory('LUMX Desktop', profile.profileDirectory, profile.installAnchor)
    appBoot.reportSkippedBundles('LUMX Desktop', resolvedProfile)
    let governance; let external
    const externalReady = Promise.withResolvers(); externalReady.promise.catch(() => {})
    running = await launcher.runProfile({
      environment: launchEnvironment.createLaunchEnvironmentSnapshot([
        { source: 'process', values: input.environment ?? {} },
      ]),
      profile: profileName,
      resolvedProfile: { profile: resolvedProfile, installAnchor: profile.installAnchor },
      patchFiles: [profile.runtimePatch],
      async setup(hostCtx) {
        governance = consumer === 'governed-h1' ? installGovernedH1Composition(hostCtx) : installLumxGovernance(hostCtx)
        if (consumer === 'external-qwen') {
          if (input.external === undefined) throw new Error('external Qwen composition input is unavailable')
          hostCtx.inject(['agents', 'llm', 'sessionPersistence', 'sessionProjections', 'sessions'], injected => {
            void installExternalQwenComposition(injected, { ...input.external, sourceRoot: input.sourceRoot })
              .then(value => { external = value; externalReady.resolve(value) }, externalReady.reject)
          })
        }
      },
      args: ['--no-open', '--host', '127.0.0.1', '--port', String(input.port)],
    })
    if (consumer === 'external-qwen') await externalReady.promise
    if (!governance) throw new Error('LUMX governance setup was not invoked')
    governance.assertReady()
    const port = running.ctx.webServer.port
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const readyUrl = running.ctx.connection.authenticatedUrl(baseUrl)
    let stopped
    const shutdown = () => stopped ??= (async () => {
      try { await external?.close(); await running.shutdown.shutdown(0) } finally {
        cleanup()
      }
    })()
    return Object.freeze({
      baseUrl,
      ctx: running.ctx,
      dataHomeDirectory: launch.dataHomeDirectory,
      consumer,
      pid: process.pid,
      profileName,
      governance: Object.freeze({ rows: governance.rows.map(row => ({
        id: row.id, specifier: row.specifier, url: row.resolution.url,
        format: row.resolution.format, generation: row.resolution.generation,
      })) }),
      ...external === undefined ? {} : { external },
      readyUrl,
      surface: consumer === 'platform-stub' ? 'local-platform-stub' : consumer === 'external-qwen'
        ? 'official-dsh-web-acp-shared-host' : 'official-dsh-web-profile-shared-host',
      shutdown,
    })
  } catch (error) {
    try { await running?.shutdown.shutdown(1) } catch {}
    cleanup()
    throw error
  }
}
