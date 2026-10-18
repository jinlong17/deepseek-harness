const PRIVACY_IDS = Object.freeze([
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
])
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
function expectedAliasEnableError(cause) {
  return cause instanceof Error && /^LUMX governance denied .*protected row must remain disabled$/u.test(cause.message)
}
function exactCoverage(rows, ids, key = row => row.id) {
  return Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(key)).size === ids.length
    && ids.every(id => rows.some(row => key(row) === id))
}
function sameOptions(before, after) {
  return before?.optionsFingerprint !== undefined && before.optionsFingerprint === after?.optionsFingerprint
}
function originalActionComplete(row, id) {
  const identity = row?.packageIdentity
  return row?.id === id && row.kind === 'protected-original' && row.executed === true && typeof row.package === 'string'
    && sameIdentity(identity, row.before?.identity) && inactive(row.before) && inactive(row.updated)
    && row.removeRejected === true && row.removalError?.message === `LUMX governance denied include:${id}: protected row cannot be removed`
    && row.retainedSameEntry === true && row.retainedSameOptions === true && sameOptions(row.before, row.retained)
    && sameIdentity(identity, row.retained?.identity) && inactive(row.retained)
}
function aliasActionComplete(row, original) {
  const id = aliasId(original.id); const identity = original.packageIdentity
  const acceptableEnable = row?.enableOutcome === 'governance-error' || row?.enableOutcome === 'rejected-state'
  return row?.id === id && row.kind === 'qualification-child-alias' && row.originalId === original.id && row.package === original.package
    && row.executed === true && sameIdentity(identity, row.packageIdentity)
    && sameIdentity(identity, row.created?.identity) && inactive(row.created)
    && row.updatedSameEntry === true && sameOptions(row.created, row.updated) && sameIdentity(identity, row.updated?.identity) && inactive(row.updated)
    && acceptableEnable && sameIdentity(identity, row.afterEnable?.identity) && inactive(row.afterEnable)
    && row.absentInLoader === true && row.absentInGroupData === true
    && sameIdentity(identity, row.reinstalled?.identity) && inactive(row.reinstalled)
}
export function privacyOriginalRowsInert(facts) {
  if (!exactCoverage(facts?.privacyIds, PRIVACY_IDS, value => value)
    || !exactCoverage(facts?.final, PRIVACY_IDS)) return false
  const originals = new Map((facts.protectedActions ?? []).map(row => [row.id, row]))
  return exactCoverage(facts?.protectedActions, PRIVACY_IDS) && PRIVACY_IDS.every(id => {
    const original = originals.get(id)
    return originalActionComplete(original, id) && sameIdentity(original.packageIdentity, facts.final.find(row => row.id === id)?.identity)
      && inactive(facts.final.find(row => row.id === id))
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
  const before = rowState(entry); const packageIdentity = before.identity; const parent = entry.parent
  await entry.update({ disabled: true }, false, true); await ctx.loader.await()
  const updated = rowState(entryFor(ctx, id))
  let removalError; let removeRejected = false
  try { parent.remove(id); await ctx.loader.await() } catch (cause) { removeRejected = requiredRemovalError(cause, id); removalError = error(cause); await ctx.loader.await() }
  const retainedEntry = entryFor(ctx, id); const retained = rowState(retainedEntry)
  return {
    id, kind: 'protected-original', executed: true, package: before.package, packageIdentity, before, updated, removalError, removeRejected,
    retained, retainedSameEntry: retainedEntry === entry, retainedSameOptions: retainedEntry?.options === entry.options,
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
    groupId = await ctx.loader.create({ id: PRIVACY_ALIAS_GROUP_ID, name: 'cordis:group', group: true, config: [] })
    await ctx.loader.await()
    if (groupId !== PRIVACY_ALIAS_GROUP_ID) throw new Error('privacy qualification group identity mismatch')
    const group = ctx.loader.resolve(groupId)?.subgroup
    if (group === undefined) throw new Error('privacy qualification group is unavailable')
    const actions = []
    for (const protectedRow of protectedActions) {
      if (!originalActionComplete(protectedRow, protectedRow.id)) throw new Error(`privacy qualification protected row unavailable: ${protectedRow.id}`)
      const id = aliasId(protectedRow.id)
      await group.update([{ id, name: protectedRow.package, disabled: true }]); await ctx.loader.await()
      const createdEntry = entryFor(ctx, id)
      if (createdEntry === undefined) throw new Error(`privacy qualification alias was not created: ${id}`)
      const created = rowState(createdEntry)
      await group.update([{ ...createdEntry.options, disabled: true }]); await ctx.loader.await()
      const updatedEntry = entryFor(ctx, id); const updated = rowState(updatedEntry)
      let enableError; let enableOutcome = 'rejected-state'
      try { await group.update([{ ...updatedEntry?.options, disabled: false }]); await ctx.loader.await() } catch (cause) {
        enableError = error(cause); enableOutcome = expectedAliasEnableError(cause) ? 'governance-error' : 'unexpected-error'; await ctx.loader.await()
      }
      const afterEnable = rowState(entryFor(ctx, id))
      if (enableOutcome === 'rejected-state' && !inactive(afterEnable)) enableOutcome = 'unexpected-success'
      group.remove(id); await ctx.loader.await()
      const absentInLoader = entryFor(ctx, id) === undefined; const absentInGroupData = !group.data.some(row => row.id === id)
      await group.update([{ id, name: protectedRow.package, disabled: true }]); await ctx.loader.await()
      const reinstalled = rowState(entryFor(ctx, id))
      actions.push({
        id, kind: 'qualification-child-alias', originalId: protectedRow.id, package: protectedRow.package, packageIdentity: protectedRow.packageIdentity,
        executed: true, created, updated, updatedSameEntry: updatedEntry === createdEntry, enableError, enableOutcome, afterEnable,
        absentInLoader, absentInGroupData, reinstalled,
      })
    }
    return { actions, groupId }
  } catch (cause) { primary = cause; throw cause } finally {
    if (groupId !== undefined) {
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
  let lateEnable
  if (late === undefined) lateEnable = { id: LATE_ID, executed: false, reason: 'unresolved' }
  else {
    try {
      await late.update({ disabled: false }, false, true); await ctx.loader.await()
      const enabled = snapshot(ctx).find(row => row.id === LATE_ID)
      lateEnable = { id: LATE_ID, executed: true, rejected: false, enabled }
    } catch (cause) { lateEnable = { id: LATE_ID, executed: true, rejected: true, error: error(cause) } }
    finally {
      await late.update({ disabled: true }, false, true); await ctx.loader.await()
      lateEnable.restored = snapshot(ctx).find(row => row.id === LATE_ID)
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
  return Object.freeze({ aliasActions, aliasCleanup, candidates, final, governedCandidates, initial, lateEnable, privacyIds: PRIVACY_IDS, protectedActions })
}
