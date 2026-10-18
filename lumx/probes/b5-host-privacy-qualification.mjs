const PRIVACY_IDS = Object.freeze([
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
])
const LATE_ID = 'product-analytics'
const ALIAS_PREFIX = 'lumx-b5-privacy-alias-'
function error(error) { return { code: error?.code, message: error instanceof Error ? error.message : String(error), name: error?.name ?? 'Error' } }
function aliasId(id) { return `${ALIAS_PREFIX}${id}` }
function entryFor(ctx, id) { return [...ctx.loader.entries()].find(candidate => candidate.options.id === id) }
function resolveOrUndefined(loader, id) {
  try { return loader.resolve(id) } catch { return undefined }
}
function identity(entry) {
  const resolution = entry.loader.resolveEntry(entry.options.name, entry.parent.tree.ctx.baseUrl)
  return resolution === undefined ? undefined : { format: resolution.format, generation: resolution.generation, url: resolution.url }
}
function sameIdentity(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function inactive(entry) { return entry?.disabled === true && entry.fiber === undefined }
function requiredRemovalError(cause, id) {
  return cause instanceof Error && cause.message === `LUMX governance denied include:${id}: protected row cannot be removed`
}
function snapshot(ctx) {
  const entries = [...ctx.loader.entries()]
  return PRIVACY_IDS.map(id => {
    const entry = entries.find(candidate => candidate.options.id === id)
    return entry === undefined ? { id, resolved: false, disabled: null, fiberPresent: false, fiberState: null }
      : { id, resolved: true, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined, fiberState: entry.fiber?.state ?? null, name: entry.options.name }
  })
}
async function protectedRowAction(ctx, id) {
  const entry = entryFor(ctx, id)
  if (entry === undefined) return { id, kind: 'protected-original', executed: false, reason: 'unresolved' }
  const options = entry.options; const packageIdentity = identity(entry); const parent = entry.parent
  await entry.update({ disabled: true }, false, true); await ctx.loader.await()
  const updated = entryFor(ctx, id)
  let removalError; let removeRejected = false
  try { parent.remove(id); await ctx.loader.await() } catch (cause) { removeRejected = requiredRemovalError(cause, id); removalError = error(cause); await ctx.loader.await() }
  const retained = entryFor(ctx, id)
  return {
    id, kind: 'protected-original', executed: true, package: options.name, packageIdentity,
    updateDisabled: inactive(updated), removeRejected, removalError,
    retainedSameEntry: retained === entry, retainedSameOptions: retained?.options === options,
    retainedSameIdentity: sameIdentity(identity(retained), packageIdentity), retainedInactive: inactive(retained),
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
    if (resolveOrUndefined(ctx.loader, groupId) !== undefined) ctx.loader.remove(groupId)
    await ctx.loader.await()
  } catch (cause) { failures.push(cause) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'privacy qualification alias cleanup failed')
}
async function childAliasActions(ctx, protectedActions) {
  const aliases = protectedActions.map(row => aliasId(row.id))
  if (new Set(aliases).size !== PRIVACY_IDS.length || aliases.some(id => entryFor(ctx, id) !== undefined)) {
    throw new Error('privacy qualification alias collision')
  }
  const groupId = await ctx.loader.create({ name: 'cordis:group', group: true, config: [] })
  await ctx.loader.await()
  const group = ctx.loader.resolve(groupId)?.subgroup
  if (group === undefined) throw new Error('privacy qualification group is unavailable')
  let primary
  try {
    const actions = []
    for (const protectedRow of protectedActions) {
      if (!protectedRow.executed) throw new Error(`privacy qualification protected row unavailable: ${protectedRow.id}`)
      const id = aliasId(protectedRow.id)
      await group.update([{ id, name: protectedRow.package, disabled: true }]); await ctx.loader.await()
      const created = entryFor(ctx, id); const createdIdentity = identity(created)
      let enableError; let enableRejected = false
      try { await group.update([{ ...created?.options, disabled: false }]); await ctx.loader.await() } catch (cause) { enableRejected = true; enableError = error(cause); await ctx.loader.await() }
      const afterEnable = entryFor(ctx, id)
      if (!enableRejected) enableRejected = afterEnable?.options === created?.options && inactive(afterEnable)
      group.remove(id); await ctx.loader.await()
      const absentAfterRemove = entryFor(ctx, id) === undefined && !group.data.some(row => row.id === id)
      await group.update([{ id, name: protectedRow.package, disabled: true }]); await ctx.loader.await()
      const reinstalled = entryFor(ctx, id)
      actions.push({
        id, kind: 'qualification-child-alias', originalId: protectedRow.id, package: protectedRow.package,
        packageIdentity: protectedRow.packageIdentity, executed: true, createdSameIdentity: sameIdentity(createdIdentity, protectedRow.packageIdentity),
        createdInactive: inactive(created), enableRejected, enableError, afterEnableInactive: inactive(afterEnable),
        absentAfterRemove, reinstallSameIdentity: sameIdentity(identity(reinstalled), protectedRow.packageIdentity), reinstallInactive: inactive(reinstalled),
      })
    }
    return { actions, groupId }
  } catch (cause) { primary = cause; throw cause } finally {
    try { await removeQualificationGroup(ctx, groupId, aliases) } catch (cleanup) {
      if (primary === undefined) throw cleanup
      throw new AggregateError([primary, cleanup], 'privacy qualification lifecycle and cleanup failed')
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
  const aliasCleanup = Object.freeze({ groupAbsent: resolveOrUndefined(ctx.loader, aliasLifecycle.groupId) === undefined,
    aliases: aliasActions.map(row => ({ id: row.id, absent: entryFor(ctx, row.id) === undefined })) })
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
