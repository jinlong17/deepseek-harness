import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { baseLaunch, check, freePort, loadConfig, pending, unit, writeResult } from './b5-hook-common.mjs'
import { h1Stubs } from './b5-fixed-stubs.mjs'

const config = loadConfig(); let stubs
const count = (events, type) => events.filter(value => value === type).length
function calls(summary, name) { return summary.calls.filter(value => value.name === name) }
function results(summary, ids) { return summary.results.filter(value => ids.includes(value.callId) && value.isError) }
export async function closeB5HostFactory() {
  const current = stubs; stubs = undefined
  if (current !== undefined) await current.close()
}
export async function makeB5HostLaunchInput({ consumer, sourceAnchorSha256 }) {
  if (consumer !== 'governed-h1') throw new Error('H1 B5 factory consumer mismatch')
  if (config.scenario === 'h1-invalid-prepare') return { sourceAnchorSha256, launchInput: { ...baseLaunch(config, consumer, await freePort()), launchId: randomUUID(),
    h1: { brokerEndpoint: 'https://invalid.example/broker', modelEndpoint: 'https://invalid.example/model' } } }
  stubs = await h1Stubs(config.nativeCanaryPath)
  return { sourceAnchorSha256, launchInput: { ...baseLaunch(config, consumer, await freePort()), launchId: randomUUID(),
    h1: { brokerEndpoint: stubs.brokerEndpoint, modelEndpoint: stubs.modelEndpoint }, qualification: { version: 1, operations: ['isolation-network', 'privacy-lifecycle', 'h1-observe'] } } }
}
export async function runB5HostScenario({ host, runtimeAnchorSha256, qualification }) {
  try {
    const isolation = await host.control.qualify({ operation: 'isolation-network' })
    const privacy = await host.control.qualify({ operation: 'privacy-lifecycle' })
    const observed = await host.control.qualify({ operation: 'h1-observe', runId: config.runId })
    if (observed.status !== 'pass') throw new Error(`H1 qualification failed: ${observed.error}`)
    const f = observed.facts; const wire = stubs.wire; const brokerCalls = calls(f.broker, 'lumx_broker'); const nativeCalls = calls(f.native, 'bash')
    const brokerResults = results(f.broker, brokerCalls.map(row => row.callId)); const nativeResults = results(f.native, nativeCalls.map(row => row.callId))
    const model = scenario => wire.model.filter(row => row.scenario === scenario); const names = value => value.map(row => row.name)
    const inventories = Object.values(f.inventories); const privacyInert = privacy.facts.final.every(row => row.disabled === true && !row.fiberPresent)
    const canary = readFileSync(config.nativeCanaryPath, 'utf8')
    const checks = [
      check('runProfile-composition', host.consumer === 'governed-h1' && JSON.stringify(f.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']), { consumer: host.consumer, bundles: f.bundles, loaderIds: f.loaderIds }),
      pending('preparation-failure-recovery', 'Python expected-failure controller followed by this retained Host'),
      check('privacy-rows-inert', privacyInert, privacy.facts.final), check('physical-network-denied', isolation.facts.denied === true, isolation),
      check('actual-agent-inventory', JSON.stringify(names(f.inventories.root)) === JSON.stringify(['lumx_broker']), f.inventories.root),
      check('actual-model-request-tools', wire.model.length > 0 && wire.model.every(row => JSON.stringify(row.payload.tools.map(tool => tool.name)) === JSON.stringify(['lumx_broker'])), wire.model.map(row => row.payload.tools)),
      check('actual-model-gateway-io', model('broker-refusal').length === 2, model('broker-refusal')),
      check('actual-broker-io', wire.broker.length === 1 && wire.broker[0].responseStatus === 403, wire.broker),
      check('actual-broker-invocation', brokerCalls.length === 1 && brokerResults.length === 1 && wire.broker.length === 1, { brokerCalls, brokerResults, wire: wire.broker }),
      check('broker-refusal-observed', brokerResults.length === 1, brokerResults), check('broker-full-turn-completed', f.broker.turnEnds === 1, f.broker),
      check('broker-repeat-count', wire.broker.length === 1, wire.broker), check('broker-retry-count', f.broker.retries + f.broker.retryStarted === 0, f.broker),
      check('model-gateway-refusal-io', model('gateway-refusal').length === 1 && model('gateway-refusal')[0].responseStatus === 403, model('gateway-refusal')),
      check('model-gateway-failure-observed', f.gateway.assistantAttempts >= 1, f.gateway), check('model-gateway-turn-completed', f.gateway.turnEnds === 1, f.gateway),
      check('model-gateway-retry-count', f.gateway.retries + f.gateway.retryStarted === 0, f.gateway),
      check('retry-detector-positive-control', f.retry.retries === 1 && f.retry.retryStarted === 1, f.retry),
      check('retry-positive-model-io', model('retry-positive').length === 2 && model('retry-positive')[0].responseStatus === 503 && model('retry-positive')[1].responseStatus === 200, model('retry-positive')),
      check('retry-positive-turn-completed', f.retry.turnEnds === 1, f.retry),
      check('native-tool-row-disabled', f.nativeRow.resolved && f.nativeRow.disabled && !f.nativeRow.fiberPresent, f.nativeRow),
      check('native-tool-runtime-refusal', nativeCalls.length === 1 && nativeResults.length === 1, { nativeCalls, nativeResults }),
      check('native-tool-canary-unchanged', canary === config.nativeCanaryExpected, { actual: canary, expected: config.nativeCanaryExpected }),
      check('native-tool-negative-model-io', model('native-tool-negative').length === 2, model('native-tool-negative')),
      check('native-tool-negative-turn-completed', f.native.turnEnds === 1, f.native), check('native-tool-negative-retry-count', f.native.retries + f.native.retryStarted === 0, f.native),
    ]
    writeResult(config, { runtimeAnchorSha256, qualification, observations: { qualification: observed, isolation, privacy, wire,
      childInventory: f.inventories.child, resumedInventory: f.inventories.resumed }, counted_results: [unit('real/H1-inventory', checks, 'actual governed H1 supported Host')] })
  } finally { await closeB5HostFactory() }
}
