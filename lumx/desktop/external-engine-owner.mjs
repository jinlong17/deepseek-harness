import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createAcpModelRelay } from '../drivers/acp/model-relay.mjs'
import { prepareQwenLaunch, releaseQwenLaunch } from '../drivers/acp/qwen-launch-materials.mjs'
import { createSupervisedQwenEngine } from '../drivers/acp/supervised-qwen-engine.mjs'
import { acquireQwenStateLease } from '../drivers/acp/state-lease.mjs'

/** Prepare frozen Qwen material and its supervisor-only relay before Host spawn. */
export async function prepareExternalEngineOwner(input) {
  const config = input.external
  if (config === undefined) throw new Error('external Qwen launch configuration is unavailable')
  const stateRoot = join(input.osHome, '.lumx-engine-qwen')
  const stateLease = acquireQwenStateLease(`${stateRoot}.owner`, input.launchId)
  let relay
  try { relay = await createAcpModelRelay({ engineId: config.engineId, gateway: input.auth.gateway, getIdentity: input.auth.getIdentity,
    launchId: input.launchId, model: config.model, providerEndpoint: input.auth.endpoint, providerKey: input.auth.byokKey, sessionId: input.launchId })
  } catch (error) { stateLease.release(); throw error }
  const runtime = join(input.runtime, 'engine'); mkdirSync(runtime, { mode: 0o700 })
  let materials
  try {
    materials = prepareQwenLaunch({ runtime, stateRoot, workspace: input.workspaceDirectory, relayPort: Number(new URL(relay.endpoint).port),
      nodePath: input.nodePath, nodeSha256: input.nodeSha256, qwenRoot: config.qwenRoot, qwenCliPath: config.qwenCliPath,
      qwenCliSha256: config.qwenCliSha256, qwenTreeSha256: config.qwenTreeSha256, launchId: input.launchId })
  } catch (error) { await relay.dispose(); stateLease.release(); throw error }
  let callbacks
  const observations = []
  const engine = createSupervisedQwenEngine({ materials, relay, model: config.model,
    onUpdate: value => callbacks.onUpdate(value), onPermission: value => callbacks.onPermission(value), mcpServers: config.mcpServers ?? [] })
  let closing
  return Object.freeze({ artifactIdentity: config.qwenTreeSha256, engineId: config.engineId, materials, model: config.model,
    engine: Object.freeze({
      bind(value) { if (callbacks !== undefined) throw new Error('external engine bridge already bound'); callbacks = value },
      cancel: engine.cancel,
      async create(input, context) { const value = await engine.create(input, context); observations.push({ operation: 'create', handleId: context.handleId, nativeSessionId: value.nativeSessionId }); return value },
      dispose: engine.dispose,
      async load(input, context) { const value = await engine.load(input, context); observations.push({ operation: 'load', handleId: context.handleId, nativeSessionId: value.nativeSessionId }); return value },
      async prompt(input, context) { try { const value = await engine.prompt(input, context); observations.push({ operation: 'prompt', handleId: context.handleId, nativeSessionId: value.nativeSessionId, promptId: context.promptId }); return value } catch (error) { observations.push({ operation: 'prompt-error', handleId: context.handleId, message: error.message, promptId: context.promptId }); throw error } },
    }),
    close: () => (closing ??= (async () => {
      const failures = []
      try { await engine.close() } catch (error) { failures.push(error) }
      try { releaseQwenLaunch(materials) } catch (error) { failures.push(error) }
      try { stateLease.release() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'external engine owner teardown failed')
    })()),
    observations: () => structuredClone(observations),
  })
}
