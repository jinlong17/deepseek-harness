const PRIVACY_IDS = Object.freeze([
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
])
const LATE_ID = 'product-analytics'
function error(error) { return { code: error?.code, message: error instanceof Error ? error.message : String(error), name: error?.name ?? 'Error' } }
function snapshot(ctx) {
  const entries = [...ctx.loader.entries()]
  return PRIVACY_IDS.map(id => {
    const entry = entries.find(candidate => candidate.options.id === id)
    return entry === undefined ? { id, resolved: false, disabled: null, fiberPresent: false, fiberState: null }
      : { id, resolved: true, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined, fiberState: entry.fiber?.state ?? null, name: entry.options.name }
  })
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
  const initial = snapshot(ctx); const actions = []
  for (const id of PRIVACY_IDS) {
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
    if (entry === undefined) { actions.push({ id, executed: false, reason: 'unresolved' }); continue }
    await entry.update({ disabled: true }, false, true); await ctx.loader.await()
    const updated = snapshot(ctx).find(row => row.id === id); const parent = entry.parent
    const options = structuredClone(entry.options); const position = Math.max(0, parent.data.indexOf(entry.options))
    parent.remove(entry.options.id); await ctx.loader.await(); const absentAfterRemove = !snapshot(ctx).find(row => row.id === id)?.resolved
    parent.data.splice(position, 0, options); parent.tree.write(); await parent.create(options); await ctx.loader.await()
    const reinstalled = snapshot(ctx).find(row => row.id === id)
    actions.push({ id, executed: true, absentAfterRemove, updateDisabled: updated?.disabled, updateFiberPresent: updated?.fiberPresent,
      reinstallDisabled: reinstalled?.disabled, reinstallFiberPresent: reinstalled?.fiberPresent })
  }
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
  return Object.freeze({ actions, candidates, final, governedCandidates, initial, lateEnable, privacyIds: PRIVACY_IDS })
}
