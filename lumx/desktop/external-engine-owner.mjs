import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { createAcpModelRelay } from '../drivers/acp/model-relay.mjs'
import { prepareQwenLaunch, releaseQwenLaunch } from '../drivers/acp/qwen-launch-materials.mjs'
import { createSupervisedQwenEngine } from '../drivers/acp/supervised-qwen-engine.mjs'
import { acquireQwenStateLease } from '../drivers/acp/state-lease.mjs'

/** Prepare frozen Qwen material and its supervisor-only relay before Host spawn. */
export async function prepareExternalEngineOwner(input) {
  const config = input.external
  if (config === undefined) throw new Error('external Qwen launch configuration is unavailable')
  let engineRoot = input.dataHome
  for (const segment of ['.private', 'engines', 'qwen']) {
    const candidate = join(engineRoot, segment)
    try { mkdirSync(candidate, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
    const metadata = lstatSync(candidate)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Qwen private engine path is not a direct directory')
    engineRoot = realpathSync(candidate)
  }
  const stateRoot = join(engineRoot, 'state'); const leasePath = join(engineRoot, 'owner.lease')
  const stateLease = acquireQwenStateLease(leasePath, input.launchId)
  let relay
  try { relay = await createAcpModelRelay({ engineId: config.engineId, gateway: input.auth.gateway, getIdentity: input.auth.getIdentity,
    launchId: input.launchId, model: config.model, providerEndpoint: input.auth.endpoint, providerKey: input.auth.byokKey, sessionId: input.launchId })
  } catch (error) { stateLease.release(); throw error }
  const runtime = join(input.runtime, 'engine'); mkdirSync(runtime, { mode: 0o700 })
  let materials
  try {
    materials = prepareQwenLaunch({ runtime, stateRoot, workspace: input.workspaceDirectory, relayPort: Number(new URL(relay.endpoint).port),
      nodePath: input.nodePath, nodeSha256: input.nodeSha256, qwenRoot: config.qwenRoot, qwenCliPath: config.qwenCliPath,
      qwenCliSha256: config.qwenCliSha256, qwenTreeSha256: config.qwenTreeSha256, launchId: input.launchId,
      forbiddenFiles: [leasePath], forbiddenSubpaths: [join(input.osHome, input.mode === 'developer' ? '.lumx' : '.lumx-developer', '.private')] })
  } catch (error) { await relay.dispose(); stateLease.release(); throw error }
  let callbacks
  const engine = createSupervisedQwenEngine({ materials, relay, model: config.model,
    onUpdate: value => callbacks.onUpdate(value), onPermission: value => callbacks.onPermission(value), mcpServers: config.mcpServers ?? [] })
  let closing
  return Object.freeze({ artifactIdentity: config.qwenTreeSha256, engineId: config.engineId, materials, model: config.model,
    engine: Object.freeze({
      bind(value) { if (callbacks !== undefined) throw new Error('external engine bridge already bound'); callbacks = value },
      cancel: engine.cancel,
      create: engine.create,
      dispose: engine.dispose,
      load: engine.load,
      prompt: engine.prompt,
    }),
    close: () => (closing ??= (async () => {
      const failures = []; let cleanup
      try { cleanup = await engine.close() } catch (error) { failures.push(error) }
      try { releaseQwenLaunch(materials) } catch (error) { failures.push(error) }
      try { stateLease.release() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'external engine owner teardown failed')
      const launchedHandles = cleanup?.launchedHandles
      const terminalCleanup = cleanup?.terminalCleanup
      if (!Array.isArray(launchedHandles) || !Array.isArray(terminalCleanup) || launchedHandles.length !== terminalCleanup.length) {
        throw new Error('external owner cleanup launch ledger is incomplete')
      }
      const groups = terminalCleanup.flatMap(handle => [
        Object.freeze({ handleId: handle.handleId, owner: 'guardian', pid: handle.cleanup.guardian.pid, pgid: null,
          exit: handle.cleanup.guardian.exit, result: 'exited' }),
        Object.freeze({ handleId: handle.handleId, owner: 'qwen', pid: handle.cleanup.qwen.pid, pgid: handle.cleanup.qwen.pgid,
          exit: handle.cleanup.qwen.exit, result: handle.cleanup.processGroupReaped ? 'reaped' : 'unproven' }),
      ])
      const expectedIds = new Set(launchedHandles.map(handle => handle.handleId))
      if (expectedIds.size !== launchedHandles.length || groups.length !== launchedHandles.length * 2
        || groups.some(row => !expectedIds.has(row.handleId) || (row.owner === 'qwen' && row.result !== 'reaped'))
        || new Set(groups.map(row => `${row.handleId}:${row.owner}`)).size !== groups.length) {
        throw new Error('external owner cleanup result is incomplete')
      }
      return Object.freeze({ schema: 'g9-b5-external-owner-cleanup/v1', launchedHandles: Object.freeze(launchedHandles),
        groups: Object.freeze(groups), shutdownSucceeded: true })
    })()),
  })
}
