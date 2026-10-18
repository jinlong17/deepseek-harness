const PRIVACY_PACKAGES = Object.freeze({
  'session-log-deepseek': '@deepseek-ai/dsh-session-log-deepseek',
  'plugin-package-inventory-deepseek': '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  'session-telemetry-otel': '@deepseek-ai/dsh-session-telemetry-otel',
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
  'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'desktop-product-telemetry': '@deepseek-ai/dsh-host-product-telemetry-otel',
  'product-analytics': '@deepseek-ai/dsh-client-product-analytics',
})
const PRIVACY_IDS = Object.freeze(Object.keys(PRIVACY_PACKAGES))
const LATE_ID = 'product-analytics'
const ALIAS_PREFIX = 'lumx-b5-privacy-alias-'
export const PRIVACY_ALIAS_GROUP_ID = `${ALIAS_PREFIX}group`
function error(error) { return { code: error?.code, message: error instanceof Error ? error.message : String(error), name: error?.name ?? 'Error' } }
function aliasId(id) { return `${ALIAS_PREFIX}${id}` }
function entryFor(ctx, id) { return [...ctx.loader.entries()].find(candidate => candidate.options.id === id) }
function identityFromResolution(resolution) {
  return resolution === undefined ? undefined : { format: resolution.format, generation: resolution.generation, url: resolution.url }
}
function realIdentity(value) {
  return value !== undefined && typeof value.format === 'string' && value.format.length > 0
    && Number.isInteger(value.generation) && value.generation >= 0 && typeof value.url === 'string' && value.url.length > 0
}
function sameIdentity(left, right) {
  return realIdentity(left) && realIdentity(right)
    && left.format === right.format && left.generation === right.generation && left.url === right.url
}
function rowState(entry) {
  if (entry === undefined) return { present: false, resolved: false }
  const resolution = entry.loader.resolveEntry(entry.options.name, entry.parent.tree.ctx.baseUrl)
  return {
    present: true, resolved: true, id: entry.options.id, package: entry.options.name, identity: identityFromResolution(resolution),
    optionsFingerprint: JSON.stringify(entry.options), disabled: entry.disabled, fiberPresent: entry.fiber !== undefined,
    fiberState: entry.fiber?.state ?? null, unevaluated: resolution !== undefined && entry.loader.loadedPlugin(resolution) === undefined,
  }
}
function inactive(state) { return state?.present === true && state.disabled === true && state.fiberPresent === false && state.unevaluated === true }
function requiredRemovalError(cause, id) {
  return cause instanceof Error && cause.message === `LUMX governance denied include:${id}: protected row cannot be removed`
}
function aliasEntryId(id) { return `${PRIVACY_ALIAS_GROUP_ID}:${id}` }
function expectedAliasEnableError(cause, id, identity) {
  return cause instanceof Error && cause.message === `LUMX governance denied ${aliasEntryId(id)}: module aliases protected identity ${identity.url}`
}
function requiredLateEnableError(cause) {
  return cause instanceof Error && cause.message === `LUMX governance denied include:${LATE_ID}: protected row must remain disabled`
}
function exactCoverage(rows, ids, key = row => row.id) {
  return Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(key)).size === ids.length
    && ids.every(id => rows.some(row => key(row) === id))
}
function sameOptions(before, after) {
  return before?.optionsFingerprint !== undefined && before.optionsFingerprint === after?.optionsFingerprint
}
function matchingInactiveState(state, id, identity, packageName = PRIVACY_PACKAGES[id]) {
  return state?.id === id && state.package === packageName && sameIdentity(identity, state.identity) && inactive(state)
}
function originalActionComplete(row, id) {
  const identity = row?.packageIdentity
  return row?.id === id && row.kind === 'protected-original' && row.executed === true && row.package === PRIVACY_PACKAGES[id]
    && matchingInactiveState(row.before, id, identity) && sameOptions(row.before, row.updated) && matchingInactiveState(row.updated, id, identity)
    && row.removeRejected === true && row.removalError?.message === `LUMX governance denied include:${id}: protected row cannot be removed`
    && row.retainedSameEntry === true && row.retainedSameOptions === true && sameOptions(row.before, row.retained)
    && matchingInactiveState(row.retained, id, identity)
}
function aliasActionComplete(row, original) {
  const id = aliasId(original.id); const identity = original.packageIdentity
  return row?.id === id && row.kind === 'qualification-child-alias' && row.originalId === original.id && row.package === PRIVACY_PACKAGES[original.id]
    && row.executed === true && sameIdentity(identity, row.packageIdentity)
    && matchingInactiveState(row.created, id, identity, PRIVACY_PACKAGES[original.id])
    && row.updatedSameEntry === true && sameOptions(row.created, row.updated) && matchingInactiveState(row.updated, id, identity, PRIVACY_PACKAGES[original.id])
    && row.afterEnableSameEntry === true && row.afterEnableSameOptions === true && row.enableOutcome === 'governance-error'
    && row.aliasEntryId === aliasEntryId(id)
    && row.enableError?.message === `LUMX governance denied ${row.aliasEntryId}: module aliases protected identity ${identity.url}`
    && sameOptions(row.updated, row.afterEnable) && matchingInactiveState(row.afterEnable, id, identity, PRIVACY_PACKAGES[original.id])
    && row.absentInLoader === true && row.absentInGroupData === true
    && matchingInactiveState(row.reinstalled, id, identity, PRIVACY_PACKAGES[original.id])
}
export function privacyOriginalRowsInert(facts) {
  if (!exactCoverage(facts?.privacyIds, PRIVACY_IDS, value => value)
    || !exactCoverage(facts?.initial, PRIVACY_IDS) || !exactCoverage(facts?.final, PRIVACY_IDS)) return false
  const originals = new Map((facts.protectedActions ?? []).map(row => [row.id, row]))
  return exactCoverage(facts?.protectedActions, PRIVACY_IDS) && PRIVACY_IDS.every(id => {
    const original = originals.get(id)
    return originalActionComplete(original, id) && sameOptions(original.before, facts.initial.find(row => row.id === id))
      && matchingInactiveState(facts.initial.find(row => row.id === id), id, original.packageIdentity)
      && sameOptions(original.before, facts.final.find(row => row.id === id))
      && matchingInactiveState(facts.final.find(row => row.id === id), id, original.packageIdentity)
  })
}
export function privacyLifecycleComplete(facts) {
  if (!privacyOriginalRowsInert(facts)) return false
  const originals = new Map(facts.protectedActions.map(row => [row.id, row]))
  if (!exactCoverage(facts.aliasActions, PRIVACY_IDS, row => row.originalId)) return false
  if (!facts.aliasActions.every(row => aliasActionComplete(row, originals.get(row.originalId)))) return false
  if (facts.aliasCleanup?.groupId !== PRIVACY_ALIAS_GROUP_ID || facts.aliasCleanup.groupAbsent !== true) return false
  return exactCoverage(facts.aliasCleanup.aliases, PRIVACY_IDS, row => row.originalId)
    && facts.aliasCleanup.aliases.every(row => row.id === aliasId(row.originalId) && row.absent === true)
}
function snapshot(ctx) { return PRIVACY_IDS.map(id => rowState(entryFor(ctx, id))) }
async function protectedRowAction(ctx, id) {
  const entry = entryFor(ctx, id)
  if (entry === undefined) return { id, kind: 'protected-original', executed: false, reason: 'unresolved' }
  const before = rowState(entry); const beforeOptions = entry.options; const packageIdentity = before.identity; const parent = entry.parent
  await entry.update({ disabled: true }, false, true); await ctx.loader.await()
  const updated = rowState(entryFor(ctx, id))
  let removalError; let removeRejected = false
  try { parent.remove(id); await ctx.loader.await() } catch (cause) { removeRejected = requiredRemovalError(cause, id); removalError = error(cause); await ctx.loader.await() }
  const retainedEntry = entryFor(ctx, id); const retained = rowState(retainedEntry)
  return {
    id, kind: 'protected-original', executed: true, package: before.package, packageIdentity, before, updated, removalError, removeRejected,
    retained, retainedSameEntry: retainedEntry === entry, retainedSameOptions: retainedEntry?.options === beforeOptions,
  }
}
async function removeQualificationGroup(ctx, groupId, aliases) {
  const failures = []
  for (const id of aliases) {
    try {
      const alias = entryFor(ctx, id)
      if (alias !== undefined) alias.parent.remove(id)
      await ctx.loader.await()
    } catch (cause) { failures.push(cause) }
  }
  try {
    if (entryFor(ctx, groupId) !== undefined) ctx.loader.remove(groupId)
    await ctx.loader.await()
  } catch (cause) { failures.push(cause) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'privacy qualification alias cleanup failed')
}
async function childAliasActions(ctx, protectedActions) {
  const aliases = protectedActions.map(row => aliasId(row.id))
  if (new Set(aliases).size !== PRIVACY_IDS.length || entryFor(ctx, PRIVACY_ALIAS_GROUP_ID) !== undefined
    || aliases.some(id => entryFor(ctx, id) !== undefined)) throw new Error('privacy qualification alias collision')
  let groupId; let primary
  try {
    const created = ctx.loader.create({ id: PRIVACY_ALIAS_GROUP_ID, name: 'cordis:group', group: true, config: [] })
    groupId = PRIVACY_ALIAS_GROUP_ID
    const createdId = await created
    await ctx.loader.await()
    if (createdId !== groupId) throw new Error('privacy qualification group identity mismatch')
    const group = ctx.loader.resolve(groupId)?.subgroup
    if (group === undefined) throw new Error('privacy qualification group is unavailable')
    const actions = []
    for (const protectedRow of protectedActions) {
      if (!originalActionComplete(protectedRow, protectedRow.id)) throw new Error(`privacy qualification protected row unavailable: ${protectedRow.id}`)
      const id = aliasId(protectedRow.id)
      await group.update([{ id, name: protectedRow.package, disabled: true }]); await ctx.loader.await()
      const createdEntry = entryFor(ctx, id)
      if (createdEntry === undefined) throw new Error(`privacy qualification alias was not created: ${id}`)
      const createdState = rowState(createdEntry)
      await group.update([{ ...createdEntry.options, disabled: true }]); await ctx.loader.await()
      const updatedEntry = entryFor(ctx, id); const updated = rowState(updatedEntry)
      if (updatedEntry === undefined) throw new Error(`privacy qualification alias was not updated: ${id}`)
      const beforeEnableOptions = updatedEntry.options
      let enableError; let enableOutcome = 'unexpected-success'
      try {
        await updatedEntry.update({ disabled: false }, false, true)
        await ctx.loader.await()
      } catch (cause) {
        enableError = error(cause)
        if (!expectedAliasEnableError(cause, id, protectedRow.packageIdentity)) throw cause
        enableOutcome = 'governance-error'
        await ctx.loader.await()
      }
      const afterEnableEntry = entryFor(ctx, id); const afterEnable = rowState(afterEnableEntry)
      const afterEnableSameEntry = afterEnableEntry === updatedEntry
      const afterEnableSameOptions = afterEnableEntry?.options === beforeEnableOptions
      const action = {
        id, aliasEntryId: aliasEntryId(id), kind: 'qualification-child-alias', originalId: protectedRow.id, package: protectedRow.package, packageIdentity: protectedRow.packageIdentity,
        executed: true, created: createdState, updated, updatedSameEntry: updatedEntry === createdEntry, enableError, enableOutcome, afterEnable,
        afterEnableSameEntry, afterEnableSameOptions, absentInLoader: false, absentInGroupData: false, reinstalled: undefined,
      }
      const validEnable = action.updatedSameEntry && action.afterEnableSameEntry && action.afterEnableSameOptions
        && action.enableOutcome === 'governance-error'
        && action.enableError?.message === `LUMX governance denied ${action.aliasEntryId}: module aliases protected identity ${protectedRow.packageIdentity.url}`
        && matchingInactiveState(action.created, id, protectedRow.packageIdentity, protectedRow.package)
        && matchingInactiveState(action.updated, id, protectedRow.packageIdentity, protectedRow.package)
        && matchingInactiveState(action.afterEnable, id, protectedRow.packageIdentity, protectedRow.package)
      if (!validEnable) throw new Error(`privacy qualification alias enable was not rejected: ${id}`)
      group.remove(id); await ctx.loader.await()
      action.absentInLoader = entryFor(ctx, id) === undefined; action.absentInGroupData = !group.data.some(row => row.id === id)
      await group.update([{ id, name: protectedRow.package, disabled: true }]); await ctx.loader.await()
      action.reinstalled = rowState(entryFor(ctx, id))
      if (!aliasActionComplete(action, protectedRow)) throw new Error(`privacy qualification alias lifecycle rejected: ${id}`)
      actions.push(Object.freeze(action))
    }
    return { actions, groupId }
  } catch (cause) { primary = cause; throw cause } finally {
    if (groupId !== undefined && entryFor(ctx, groupId) !== undefined) {
      try { await removeQualificationGroup(ctx, groupId, aliases) } catch (cleanup) {
        if (primary === undefined) throw cleanup
        throw new AggregateError([primary, cleanup], 'privacy qualification lifecycle and cleanup failed')
      }
    }
  }
}
export function capturePrivacyShutdownRows(ctx) {
  const loader = ctx.loader; const entries = [...loader.entries()]
  const rows = PRIVACY_IDS.map(id => {
    const entry = entries.find(candidate => candidate.options.id === id)
    const resolution = entry === undefined ? undefined : entry.loader.resolveEntry(entry.options.name, entry.parent.tree.ctx.baseUrl)
    return entry === undefined ? { id, entry: undefined, before: { resolved: false } } : { id, entry,
      before: { resolved: true, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined, fiberState: entry.fiber?.state ?? null,
        name: entry.options.name, identity: resolution } }
  })
  return Object.freeze({ loader, rows: Object.freeze(rows) })
}
export function observePrivacyShutdownRows(captured) {
  if (captured?.loader === undefined || !Array.isArray(captured.rows)) throw new Error('privacy shutdown capture is invalid')
  const current = [...captured.loader.entries()]
  return captured.rows.map(row => {
    const entry = current.find(candidate => candidate.options.id === row.id)
    const selected = row.entry
    return { id: row.id, before: row.before, sameEntryAfterShutdown: entry === selected,
      postInventoryPresent: entry !== undefined, postDisabled: selected?.disabled ?? null,
      postFiberPresent: selected?.fiber !== undefined, postFiberState: selected?.fiber?.state ?? null,
      postName: selected?.options?.name ?? null }
  })
}
/** Exercise the governed loader through the actual supported Host ctx. */
export async function qualifyPrivacyLifecycle(ctx) {
  const initial = snapshot(ctx); const protectedActions = []
  for (const id of PRIVACY_IDS) protectedActions.push(await protectedRowAction(ctx, id))
  const aliasLifecycle = await childAliasActions(ctx, protectedActions)
  const aliasActions = aliasLifecycle.actions
  const aliasCleanup = Object.freeze({ groupId: aliasLifecycle.groupId, groupAbsent: entryFor(ctx, aliasLifecycle.groupId) === undefined,
    aliases: aliasActions.map(row => ({ id: row.id, originalId: row.originalId, absent: entryFor(ctx, row.id) === undefined })) })
  const late = [...ctx.loader.entries()].find(candidate => candidate.options.id === LATE_ID)
  let lateEnable; let latePrimary
  if (late === undefined) lateEnable = { id: LATE_ID, executed: false, reason: 'unresolved' }
  else {
    const beforeOptions = late.options
    try {
      await late.update({ disabled: false }, false, true); await ctx.loader.await()
      throw new Error(`privacy qualification late enable unexpectedly succeeded: ${LATE_ID}`)
    } catch (cause) {
      if (!requiredLateEnableError(cause)) { latePrimary = cause; throw cause }
      lateEnable = { id: LATE_ID, executed: true, rejected: true, error: error(cause) }
    } finally {
      try {
        await late.update({ disabled: true }, false, true); await ctx.loader.await()
        if (late.options !== beforeOptions) throw new Error(`privacy qualification late restore changed options: ${LATE_ID}`)
        lateEnable ??= { id: LATE_ID, executed: true, rejected: false }
        lateEnable.restored = snapshot(ctx).find(row => row.id === LATE_ID)
      } catch (cleanup) {
        if (latePrimary === undefined) throw cleanup
        throw new AggregateError([latePrimary, cleanup], 'privacy qualification late enable and restore failed')
      }
    }
  }
  const final = snapshot(ctx)
  const candidates = [...ctx.loader.entries()].flatMap(entry => {
    const value = `${entry.options.id} ${entry.options.name}`.toLowerCase()
    return /(deepseek|telemetry|analytics|inventory|session-log)/u.test(value)
      ? [{ id: entry.options.id, name: entry.options.name, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined }] : []
  })
  const governedCandidates = [...ctx.loader.entries()].flatMap(entry => /(^|[-_])h1($|[-_])|govern/iu.test(`${entry.options.id} ${entry.options.name}`)
    ? [{ id: entry.options.id, name: entry.options.name, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined }] : [])
  const facts = Object.freeze({ aliasActions, aliasCleanup, candidates, final, governedCandidates, initial, lateEnable, privacyIds: PRIVACY_IDS, protectedActions })
  if (!privacyLifecycleComplete(facts) || lateEnable?.rejected !== true || !matchingInactiveState(lateEnable.restored, LATE_ID, facts.protectedActions.find(row => row.id === LATE_ID)?.packageIdentity)) {
    throw new Error('privacy qualification lifecycle facts rejected')
  }
  return facts
}
