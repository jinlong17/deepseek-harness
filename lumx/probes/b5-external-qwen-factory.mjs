import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { baseLaunch, check, deferred, freePort, loadConfig, pending, unit, writeResult } from './b5-hook-common.mjs'
import { qwenStub } from './b5-fixed-stubs.mjs'
import { withB5FactoryCleanup } from './b5-factory-cleanup.mjs'
import { binding, browserResume, effectFacts, front, history, initialize, readEvents, runCreate, runPermission } from './b5-external-qwen-support.mjs'

const config = loadConfig(); let provider; let barriers; let closePromise
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
function persistenceRoot() { return join(realpathSync(config.osHome), config.mode === 'consumer' ? '.lumx' : '.lumx-developer', 'sessions') }
function continuity() {
  const metadata = lstatSync(config.continuityPath); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('continuity receipt must be a direct file')
  const path = realpathSync(config.continuityPath)
  const bytes = readFileSync(path); if (hash(bytes) !== config.continuitySha256) throw new Error('continuity receipt differs from parent anchor')
  const value = JSON.parse(bytes); if (value.schema !== 'g9-b5-external-continuity/v1') throw new Error('continuity schema'); return value
}
export function closeB5HostFactory() {
  closePromise ??= (async () => {
    const currentBarriers = barriers; const current = provider
    barriers = undefined; provider = undefined
    currentBarriers?.streamRelease.resolve()
    if (currentBarriers?.streamActive === true) await currentBarriers.streamFinished.promise
    if (current !== undefined) await current.close()
  })()
  return closePromise
}
export async function makeB5HostLaunchInput({ consumer, sourceAnchorSha256 }) {
  if (consumer !== 'external-qwen') throw new Error('external Qwen B5 factory consumer mismatch')
  closePromise = undefined; barriers = { streamActive: false, streamFirst: deferred(), streamRelease: deferred(), streamFinished: deferred(), cancelStarted: deferred(), cancelObserved: deferred() }
  provider = await qwenStub({ worldEffect: config.worldEffect, rejectEffect: config.rejectEffect, lateEffect: config.lateEffect,
    toolCommand: `/usr/bin/printf %s B5_TOOL_OK >> ${quote(config.worldEffect)}`, rejectCommand: `/usr/bin/printf REJECTED > ${quote(config.rejectEffect)}`, lateCommand: `/usr/bin/printf LATE > ${quote(config.lateEffect)}` }, barriers)
  const identity = { credential: 'synthetic-b5-external', expiresAt: '2099-01-01T00:00:00.000Z', subject: 'synthetic-b5-user', type: 'lumx.local-auth.v1' }
  return { sourceAnchorSha256, launchInput: { ...baseLaunch(config, consumer, await freePort()), launchId: randomUUID(),
    auth: { byokKey: 'synthetic-b5-provider-key', endpoint: provider.endpoint, gateway: { validate: async value => ({ active: true, expiresAt: identity.expiresAt, subject: value.subject }) }, getIdentity: () => identity },
    external: { engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', qwenCliPath: realpathSync(config.qwenCliPath), qwenCliSha256: config.qwenCliSha256, qwenRoot: realpathSync(config.qwenRoot), qwenTreeSha256: config.qwenTreeSha256 } } }
}
async function createPhase(host, runtimeAnchorSha256, qualification) {
  const six = await runCreate(config, host, provider, barriers); const permission = await runPermission(config, host, barriers)
  const exit = await host.shutdown(); const events = await readEvents(persistenceRoot(), six.created.sessionId); const toolEvents = await readEvents(persistenceRoot(), six.tool.sessionId); const bound = binding(events); const facts = effectFacts(provider, config)
  const value = { schema: 'g9-b5-external-continuity/v1', runtimeAnchorSha256, sessionId: six.created.sessionId, nativeSessionId: bound.nativeSessionId,
    controlSessionId: six.ui.sessionId, history: history(events), create: { first: six.first, streamedBeforeFinal: six.streamedBeforeFinal, cancelResult: six.cancelResult,
      otherResult: six.otherResult, toolResult: six.toolResult, ui: six.ui, permission, effects: facts, providerRequests: provider.requests.length,
      cancelCloses: provider.cancelCloses(), toolCalls: toolEvents.filter(row => row.type === 'tool/call').length, toolResults: toolEvents.filter(row => row.type === 'tool/result').length }, exit }
  writeFileSync(config.continuityOutput, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  writeResult(config, { runtimeAnchorSha256, qualification, observations: value, counted_results: [] })
}
async function resumePhase(host, runtimeAnchorSha256, qualification) {
  const prior = continuity(); const client = front(host, async () => ({ outcome: { outcome: 'cancelled' } })); await initialize(client)
  await client.connection.resumeSession({ sessionId: prior.sessionId, cwd: config.workspaceDirectory, mcpServers: [] })
  const reopened = await client.connection.prompt({ sessionId: prior.sessionId, prompt: [{ type: 'text', text: 'B5 REOPEN' }] })
  const ui = await browserResume(config, host, prior); const exit = await host.shutdown(); const events = await readEvents(persistenceRoot(), prior.sessionId); const bound = binding(events); const after = history(events)
  const c = prior.create; const control = [check('official-ui-control-session-created', c.ui.created && c.ui.apiRequests.includes('/api/session/create'), c.ui),
    check('official-ui-cancel-reached-host', c.ui.cancelled && Number.isInteger(c.cancelCloses) && c.cancelCloses >= 1, { ui: c.ui, createCancelCloses: c.cancelCloses }),
    check('official-ui-control-session-restarted', ui.control.rendered && ui.control.selected, ui.control), check('browser-page-errors-empty', c.ui.pageErrors.length === 0 && ui.errors.length === 0, { create: c.ui.pageErrors, resume: ui.errors })]
  const durable = [check('durable-session-controller-restart', after.contiguous && after.count > prior.history.count, { before: prior.history, after }),
    check('durable-initial-ui-diagnostic', c.ui.durableInitial.rendered && c.ui.durableInitial.selected, c.ui.durableInitial),
    check('durable-restart-official-ui-same-id', ui.durable.rendered && ui.durable.selected, ui.durable),
    check('durable-external-acp-identity-join', bound.nativeSessionId === prior.nativeSessionId, { dsh: prior.sessionId, beforeNative: prior.nativeSessionId, afterNative: bound.nativeSessionId })]
  const driver = [pending('agent-loop-positive-session-new', 'Python merger authenticates the desktop Host AgentLoop-positive child'), check('persisted-session-load-visible', reopened.stopReason !== undefined, reopened),
    check('non-agent-loop-session-new-capability', c.streamedBeforeFinal && c.effects.worldCount === 1 && !c.effects.reject && !c.effects.late && c.toolCalls === 1 && c.toolResults === 1 && c.cancelResult.stopReason === 'cancelled', c),
    check('non-agent-loop-session-resume-capability', bound.nativeSessionId === prior.nativeSessionId && events.filter(row => row.type === 'agent/external-engine-bound').length === 1, { bound, after })]
  writeResult(config, { runtimeAnchorSha256, qualification, observations: { prior, after, bound, reopened, ui, exit }, counted_results: [unit('real/developer-Host-control', control, 'official browser UI create/cancel/restart'), unit('real/durable-UI-mapping', durable, 'same DSH/native identity over actual OS Host restart'), unit('real/DSH-non-AgentLoop-driver', driver, 'true external Qwen factory and official ACP')] })
}
export async function runB5HostScenario({ host, runtimeAnchorSha256, qualification }) {
  return withB5FactoryCleanup(closeB5HostFactory, async () => config.scenario === 'external-create'
    ? createPhase(host, runtimeAnchorSha256, qualification)
    : resumePhase(host, runtimeAnchorSha256, qualification))
}
