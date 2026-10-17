import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installLumxActivationGuards, installLumxGovernance, LUMX_GOVERNED_ROWS } from './governance.mjs'

function fixture({ loaded = false } = {}) {
  const listeners = new Map()
  const identities = new WeakMap()
  const rows = new Map()
  const loader = {
    ctx: { baseUrl: 'file:///candidate/apps/cli/lib/profile-boot.js' },
    resolveEntry(specifier) { return { builtin: false, format: 'module', generation: 4, url: `file:///candidate/${specifier}/lib/index.js` } },
    loadedPlugin() { return loaded ? () => {} : undefined },
    identitiesOf(plugin) { return identities.get(plugin) ?? [] },
    * entries() { yield* rows.values() },
  }
  const ctx = {
    get(name) { return name === 'loader' ? loader : undefined },
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      options?.prepend ? list.unshift(listener) : list.push(listener)
      listeners.set(name, list)
      return () => list.splice(list.indexOf(listener), 1)
    },
  }
  const dispatch = (name, ...args) => {
    const list = listeners.get(name) ?? []
    let index = 0
    const next = () => list[index++]?.(...args, next)
    return next()
  }
  return { ctx, dispatch, identities, loader, rows }
}

test('freezes all seven identities and blocks root, child, rename, generation, removal, and callback aliases', () => {
  const { ctx, dispatch, identities, loader, rows } = fixture()
  const policy = installLumxGovernance(ctx)
  for (const row of policy.rows) rows.set(row.id, { disabled: true, options: { id: row.id, name: row.specifier } })
  policy.assertReady()
  assert.deepEqual(policy.rows.map(row => row.id), LUMX_GOVERNED_ROWS)
  const candidate = (id, overrides = {}) => ({
    id, phase: 'update', effectiveDisabled: true,
    options: { id: id.split(':').at(-1), name: policy.rows[0].specifier },
    resolution: policy.rows[0].resolution, ...overrides,
  })
  assert.throws(() => dispatch('loader/entry-admit', candidate(policy.rows[0].id, { effectiveDisabled: false })), /must remain disabled/)
  assert.throws(() => dispatch('loader/entry-admit', candidate(`child:${policy.rows[0].id}`, { effectiveDisabled: false })), /must remain disabled/)
  assert.throws(() => dispatch('loader/entry-admit', candidate(policy.rows[0].id, { options: { id: policy.rows[0].id, name: 'cordis:safe' } })), /identity changed/)
  assert.throws(() => dispatch('loader/entry-admit', candidate(policy.rows[0].id, { phase: 'remove' })), /cannot be removed/)
  assert.throws(() => dispatch('loader/entry-admit', candidate('alias', { effectiveDisabled: false,
    options: { id: 'alias', name: 'file:alias' }, resolution: { ...policy.rows[0].resolution, generation: 5 } })), /generation changed/)
  const callback = () => {}
  identities.set(callback, [policy.rows[1].resolution.url])
  assert.throws(() => dispatch('loader/entry-admit', candidate('alias-callback', { effectiveDisabled: false,
    options: { id: 'alias-callback', name: 'cordis:safe' }, resolution: undefined, plugin: callback })), /callback aliases/)
  assert.throws(() => dispatch('internal/plugin', { runtime: { callback } }), /direct protected callback activation/)
  loader.resolveEntry = specifier => ({ builtin: false, format: 'module', generation: 5, url: `file:///candidate/${specifier}/lib/index.js` })
  assert.throws(() => policy.assertReady(), /readiness failed/)
})

test('refuses governed readiness for a preloaded namespace', () => {
  const { ctx } = fixture({ loaded: true })
  assert.throws(() => installLumxGovernance(ctx), /already loaded/)
})

test('non-governed declarative fixture installs activation-only guards for a known callback', () => {
  const { ctx, dispatch } = fixture()
  const callback = () => {}
  installLumxActivationGuards(ctx, { callbacks: [callback] })
  assert.throws(() => dispatch('internal/plugin', { runtime: { callback } }), /direct protected callback activation/)
  assert.doesNotThrow(() => dispatch('loader/entry-admit', {
    id: 'unrelated', phase: 'pre-import', effectiveDisabled: false,
    options: { id: 'unrelated', name: 'file:unknown' }, resolution: { url: 'file:///unknown', generation: 1 },
  }))
})

test('NON-GOVERNED fixture blocks activation of a real preloaded namespace without a readiness rowset', async () => {
  const [{ Context }, { default: Loader }, namespace] = await Promise.all([
    import('../../vendor/cordis/lib/index.js'),
    import('../../vendor/loader/lib/index.js'),
    import('../../packages/client/product-analytics/lib/index.js'),
  ])
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  const callback = ctx.loader.unwrapExports(namespace)
  installLumxActivationGuards(ctx, { callbacks: [callback] })
  assert.throws(() => ctx.plugin(callback), /direct protected callback activation/)
  await ctx.fiber.dispose()
})
