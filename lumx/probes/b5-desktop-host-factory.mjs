import { createHash, randomUUID } from 'node:crypto'

import { authenticate, baseLaunch, check, freePort, loadConfig, qualificationFacts, rawRequest, unit, writeResult } from './b5-hook-common.mjs'
import { desktopStub } from './b5-fixed-stubs.mjs'
import { withB5FactoryCleanup } from './b5-factory-cleanup.mjs'

const config = loadConfig(); let model; let closePromise; let identity; let gatewayState = { active: true }
const digest = value => createHash('sha256').update(value).digest('hex')
const valid = () => ({ credential: 'synthetic-b5-credential', expiresAt: '2099-01-01T00:00:00.000Z', subject: 'synthetic-b5-user', type: 'lumx.local-auth.v1' })
function fact(name, value) { return { name, ...value } }
function coversExactly(rows, ids, predicate, identity = row => row.id) {
  return Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(identity)).size === ids.length
    && ids.every(id => predicate(rows.find(row => identity(row) === id), id))
}
async function attempt(host, id, configure) {
  identity = valid(); gatewayState = { active: true }; configure?.()
  const before = model.requests.length; const response = await host.control.healthCheck()
  return fact(id, { modelRequests: model.requests.length - before, response })
}
function passed(response) { return response.status === 'pass' }
export function closeB5HostFactory() {
  closePromise ??= (async () => {
    const current = model; model = undefined
    if (current !== undefined) await current.close()
  })()
  return closePromise
}
export async function makeB5HostLaunchInput({ consumer, sourceAnchorSha256 }) {
  if (consumer !== 'desktop-byok') throw new Error('desktop B5 factory consumer mismatch')
  closePromise = undefined; model = await desktopStub(); identity = config.scenario === 'desktop-alternate-anonymous' ? undefined : valid()
  const launchInput = { ...baseLaunch(config, consumer, await freePort()), launchId: randomUUID(), qualification: { version: 1,
    operations: config.scenario === 'desktop-main' ? ['isolation-network', 'privacy-lifecycle', 'byok-alternate'] : ['byok-alternate'] },
    auth: { byokKey: 'synthetic-b5-provider-key', endpoint: model.endpoint,
      gateway: { validate: async value => ({ active: gatewayState.active, expiresAt: gatewayState.expiresAt ?? identity?.expiresAt, subject: gatewayState.subject ?? value.subject }) },
      getIdentity: () => identity } }
  return { launchInput, sourceAnchorSha256 }
}
async function alternate(host, runtimeAnchorSha256, qualification) {
  const observed = await host.control.qualify({ operation: 'byok-alternate' })
  const facts = qualificationFacts(observed, 'byok-alternate'); const anonymous = config.scenario.endsWith('anonymous')
  const id = anonymous ? 'byok-other-adapter-anonymous-blocked' : 'byok-other-adapter-positive'
  const pass = anonymous ? facts.adapterCalls === 0 && facts.failure?.code === 'identity_required'
    : facts.adapterCalls === 1 && facts.chunks.at(-1)?.type === 'finish'
  writeResult(config, { runtimeAnchorSha256, qualification, observations: { qualification: observed }, counted_results: [unit('real/developer-Host-positive', [check(id, pass, facts)], 'actual supported Host fixed synthetic alternate adapter admission')] })
}
export async function runB5HostScenario({ host, runtimeAnchorSha256, qualification }) {
  return withB5FactoryCleanup(closeB5HostFactory, async () => {
    if (config.scenario !== 'desktop-main') return await alternate(host, runtimeAnchorSha256, qualification)
    const auth = await authenticate(host.readyUrl); const page = await fetch(auth.page, { headers: { cookie: auth.cookie } })
    const wrongToken = await fetch(`${auth.origin}/?token=wrong`, { redirect: 'manual' })
    const api = `${auth.origin}/api/settings/openSettingsDocument`; const authority = new URL(auth.origin).host
    const wrongOrigin = await rawRequest(api, { cookie: auth.cookie, host: authority, origin: 'http://evil.example' })
    const wrongHost = await rawRequest(api, { cookie: auth.cookie, host: 'evil.example' }); const missingOrigin = await rawRequest(api, { cookie: auth.cookie, host: authority })
    const isolation = await host.control.qualify({ operation: 'isolation-network' }); const isolationFacts = qualificationFacts(isolation, 'isolation-network')
    const privacy = await host.control.qualify({ operation: 'privacy-lifecycle' }); const privacyFacts = qualificationFacts(privacy, 'privacy-lifecycle')
    const cases = []
    cases.push(await attempt(host, 'positive'))
    cases.push(await attempt(host, 'anonymous', () => { identity = undefined }))
    cases.push(await attempt(host, 'wrongType', () => { identity.type = 'wrong.type' }))
    cases.push(await attempt(host, 'invalidExpiry', () => { identity.expiresAt = 'not-a-time' }))
    cases.push(await attempt(host, 'equalExpiry', () => { identity.expiresAt = new Date().toISOString() }))
    cases.push(await attempt(host, 'subjectMismatch', () => { gatewayState.subject = 'different-user' }))
    cases.push(await attempt(host, 'expired', () => { identity.expiresAt = '2000-01-01T00:00:00.000Z' }))
    cases.push(await attempt(host, 'revoked', () => { gatewayState.active = false }))
    const byName = Object.fromEntries(cases.map(value => [value.name, value])); const zero = name => byName[name].modelRequests === 0 && !passed(byName[name].response)
    const tokenChecks = [check('physical-network-denied', isolationFacts.denied === true, isolation),
      check('main-profile-path-denied', Object.keys(host.protectedPathErrors ?? {}).length > 0 && Object.values(host.protectedPathErrors).every(code => code !== 'READABLE'), host.protectedPathErrors),
      check('inherited-fd-read-denied', host.fdObservation?.length > 0 && host.fdObservation.every(row => !row.canaryRecovered) && host.childFdObservation?.observations?.length > 0 && host.childFdObservation.observations.every(row => !row.canaryRecovered), { host: host.fdObservation, child: host.childFdObservation }),
      check('host-token-cookie-positive', page.status === 200, { page: page.status }), check('wrong-token-rejected', wrongToken.status === 401, { status: wrongToken.status }),
      check('wrong-origin-rejected', wrongOrigin.status === 403, wrongOrigin), check('wrong-host-rejected', wrongHost.status === 403, wrongHost), check('missing-origin-observed', Number.isSafeInteger(missingOrigin.status), missingOrigin)]
    const positiveChecks = [check('byok-positive-model-response', byName.positive.modelRequests === 1 && passed(byName.positive.response), byName.positive),
      ...[['anonymous','byok-anonymous-zero-model'],['wrongType','byok-wrong-type-zero-model'],['invalidExpiry','byok-invalid-expiry-zero-model'],['equalExpiry','byok-equal-expiry-zero-model'],['subjectMismatch','byok-subject-mismatch-zero-model'],['expired','byok-expired-zero-model'],['revoked','byok-revoked-zero-model']].map(([name,id]) => check(id, zero(name), byName[name]))]
    const allRows = Array.isArray(privacyFacts.final) && privacyFacts.final.every(row => row.resolved && row.disabled === true && !row.fiberPresent)
    const shutdown = await host.shutdown(); const closingRows = shutdown.control?.qualificationShutdown?.privacy ?? []
    const shutdownRowsClosed = closingRows.length === 7 && closingRows.every(row => row.before.resolved && row.before.disabled === true
      && row.sameEntryAfterShutdown && row.postInventoryPresent && row.postDisabled === true && (!row.postFiberPresent || row.postFiberState === 4))
    const protectedLifecycle = coversExactly(privacyFacts.protectedActions, privacyFacts.privacyIds, row => row?.kind === 'protected-original'
      && row.executed && row.updateDisabled && row.removeRejected && row.retainedSameEntry && row.retainedSameOptions && row.retainedSameIdentity && row.retainedInactive)
    const aliasLifecycle = coversExactly(privacyFacts.aliasActions, privacyFacts.privacyIds, (row, id) => row?.kind === 'qualification-child-alias'
      && row.originalId === id && row.executed && row.createdSameIdentity && row.createdInactive && row.enableRejected && row.afterEnableInactive
      && row.absentAfterRemove && row.reinstallSameIdentity && row.reinstallInactive, row => row.originalId)
    const aliasesCleaned = privacyFacts.aliasCleanup?.groupAbsent === true
      && coversExactly(privacyFacts.aliasCleanup.aliases, privacyFacts.privacyIds,
        (row, id) => row?.id === `lumx-b5-privacy-alias-${id}` && row.absent === true,
        row => row.id.startsWith('lumx-b5-privacy-alias-') ? row.id.slice('lumx-b5-privacy-alias-'.length) : row.id)
    const cordisChecks = [check('privacy-seven-resolved-disabled-no-fiber', allRows, privacyFacts.final), check('privacy-safe-update-remove-reinstall', protectedLifecycle && aliasLifecycle && aliasesCleaned, { aliasActions: privacyFacts.aliasActions, aliasCleanup: privacyFacts.aliasCleanup, protectedActions: privacyFacts.protectedActions }),
      check('privacy-late-reenable-rejected', privacyFacts.lateEnable.rejected === true, privacyFacts.lateEnable), check('privacy-renamed-absent-uncomposed-inventory', privacyFacts.candidates.every(row => privacyFacts.privacyIds.includes(row.id)), privacyFacts.candidates),
      check('privacy-shutdown-no-fiber', shutdownRowsClosed, closingRows), check('consumer-profile-privacy-consumer', host.consumer === 'desktop-byok', { consumer: host.consumer }), check('governed-desktop-h1-adapter-capability', privacyFacts.governedCandidates.length > 0, privacyFacts.governedCandidates)]
    writeResult(config, { runtimeAnchorSha256, qualification, parent_exports: { agentLoopPositive: { modelRequests: byName.positive.modelRequests,
      response: byName.positive.response, sessionId: byName.positive.response.sessionId } }, observations: { cases, http: { missingOrigin, wrongHost, wrongOrigin }, isolation, privacy, shutdown }, counted_results: [unit('real/Cordis-shutdown', cordisChecks, 'actual Host privacy lifecycle including same-ctx post-runtime shutdown facts'), unit('real/developer-Host-token-boundary', tokenChecks, 'actual Host boundary'), unit('real/developer-Host-positive', positiveChecks, 'actual main BYOK adapter; alternate controls are separate retained Hosts')] })
  })
}
