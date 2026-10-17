import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installLumxGovernance, LUMX_GOVERNED_ROWS } from './governance.mjs'

function fixture({ loaded = false } = {}) {
  const listeners = new Map()
  const identities = new WeakMap()
  const loader = {
    ctx: { baseUrl: 'file:///candidate/apps/cli/lib/profile-boot.js' },
    resolveEntry(specifier) { return { builtin: false, format: 'module', generation: 4, url: `file:///candidate/${specifier}/lib/index.js` } },
    loadedPlugin() { return loaded ? () => {} : undefined },
    identitiesOf(plugin) { return identities.get(plugin) ?? [] },
  }
  const ctx = {
    get(name) { return name === 'loader' ? loader : undefined },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
  }
  return { ctx, identities, listeners }
}

test('freezes all seven resolved identities and blocks row, module, and callback aliases', () => {
  const { ctx, identities, listeners } = fixture()
  const policy = installLumxGovernance(ctx)
  policy.assertInstalled()
  assert.deepEqual(policy.rows.map(row => row.id), LUMX_GOVERNED_ROWS)
  assert(policy.rows.every(row => row.resolution.generation === 4 && row.resolution.format === 'module'))
  const admit = listeners.get('loader/entry-admit')
  assert.throws(() => admit({ id: policy.rows[0].id, effectiveDisabled: false, options: {} }, () => {}), /must remain disabled/)
  assert.doesNotThrow(() => admit({ id: policy.rows[0].id, effectiveDisabled: true, options: {} }, () => {}))
  assert.throws(() => admit({ id: policy.rows[0].id, phase: 'remove', effectiveDisabled: true, options: {} }, () => {}), /cannot be removed/)
  assert.throws(() => admit({ id: 'renamed', effectiveDisabled: false, options: {}, resolution: policy.rows[0].resolution }, () => {}), /aliases protected identity/)
  const callback = () => {}
  identities.set(callback, [policy.rows[1].resolution.url])
  assert.throws(() => admit({ id: 'alias-callback', effectiveDisabled: false, options: {}, plugin: callback }, () => {}), /callback aliases/)
  assert.throws(() => listeners.get('internal/plugin')({ runtime: { callback } }), /direct protected callback activation/)
})

test('refuses readiness if a protected namespace is already loaded', () => {
  const { ctx } = fixture({ loaded: true })
  assert.throws(() => installLumxGovernance(ctx), /already loaded/)
})
