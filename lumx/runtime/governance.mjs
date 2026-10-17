const ROWS = Object.freeze({
  'session-log-deepseek': '@deepseek-ai/dsh-session-log-deepseek',
  'plugin-package-inventory-deepseek': '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  'session-telemetry-otel': '@deepseek-ai/dsh-session-telemetry-otel',
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
  'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'desktop-product-telemetry': '@deepseek-ai/dsh-host-product-telemetry-otel',
  'product-analytics': '@deepseek-ai/dsh-client-product-analytics',
})

function callbackObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Install activation guards from caller-frozen module identities and callbacks. */
export function installLumxActivationGuards(ctx, options) {
  const loader = ctx.get('loader')
  if (!loader?.identitiesOf) throw new Error('LUMX activation guards require the admission-capable candidate loader')
  const forbiddenUrls = new Map((options.urls ?? []).map(row => [row.url, row]))
  const forbiddenCallbacks = new WeakSet((options.callbacks ?? []).filter(callbackObject))
  const reject = (id, detail) => { throw new Error(`LUMX governance denied ${id}: ${detail}`) }
  const isForbiddenCallback = plugin => callbackObject(plugin)
    && (forbiddenCallbacks.has(plugin) || loader.identitiesOf(plugin).some(url => forbiddenUrls.has(url)))
  const check = candidate => {
    options.validate?.()
    const frozen = candidate.resolution && forbiddenUrls.get(candidate.resolution.url)
    if (!candidate.effectiveDisabled && frozen) {
      if (candidate.resolution.generation !== frozen.generation) reject(candidate.id, 'resolver generation changed')
      reject(candidate.id, `module aliases protected identity ${candidate.resolution.url}`)
    }
    if (!candidate.effectiveDisabled && isForbiddenCallback(candidate.plugin)) {
      reject(candidate.id, 'callback aliases a protected module')
    }
  }
  ctx.on('loader/entry-admit', (candidate, next) => { check(candidate); next() }, { global: true, prepend: true })
  ctx.on('internal/plugin', fiber => {
    options.validate?.()
    if (isForbiddenCallback(fiber.runtime?.callback)) reject(fiber.entry?.id ?? '<direct>', 'direct protected callback activation')
  }, { global: true, prepend: true })
  ctx.on('internal/config', function (config, next) {
    options.validate?.()
    if (isForbiddenCallback(this.runtime?.callback)) reject(this.entry?.id ?? '<direct>', 'protected callback config')
    return next()
  }, { global: true, prepend: true })
}

/** Install the root-owned LUMX privacy policy before any profile entry mounts. */
export function installLumxGovernance(ctx) {
  const loader = ctx.get('loader')
  if (!loader?.resolveEntry || !loader?.loadedPlugin || !loader?.identitiesOf) {
    throw new Error('LUMX governance requires the admission-capable candidate loader')
  }
  const byId = new Map()
  for (const [id, specifier] of Object.entries(ROWS)) {
    const resolution = loader.resolveEntry(specifier, loader.ctx.baseUrl)
    if (!resolution?.url) throw new Error(`LUMX governance could not resolve ${id}`)
    byId.set(id, Object.freeze({ id, specifier, resolution }))
    if (loader.loadedPlugin(resolution) !== undefined) {
      throw new Error(`LUMX governance found forbidden module already loaded: ${id}`)
    }
  }
  const validateResolver = () => {
    for (const row of byId.values()) {
      const current = loader.resolveEntry(row.specifier, loader.ctx.baseUrl)
      if (!current || current.url !== row.resolution.url || current.format !== row.resolution.format
        || current.generation !== row.resolution.generation) {
        throw new Error(`LUMX governance denied resolver identity change for ${row.id}`)
      }
    }
  }
  installLumxActivationGuards(ctx, {
    urls: [...byId.values()].map(row => row.resolution),
    validate: validateResolver,
  })
  ctx.on('loader/entry-admit', (candidate, next) => {
    const row = byId.get(candidate.id) ?? byId.get(candidate.options.id)
    if (row) {
      if (candidate.phase === 'remove') throw new Error(`LUMX governance denied ${candidate.id}: protected row cannot be removed`)
      const actual = candidate.resolution
      if (candidate.options.name !== row.specifier || !actual
        || actual.url !== row.resolution.url || actual.format !== row.resolution.format
        || actual.generation !== row.resolution.generation) {
        throw new Error(`LUMX governance denied ${candidate.id}: protected row identity changed`)
      }
      if (!candidate.effectiveDisabled) throw new Error(`LUMX governance denied ${candidate.id}: protected row must remain disabled`)
    }
    next()
  }, { global: true, prepend: true })
  return Object.freeze({
    rows: Object.freeze([...byId.values()]),
    assertReady() {
      if (byId.size !== Object.keys(ROWS).length) throw new Error('LUMX governance identity set is incomplete')
      validateResolver()
      for (const row of byId.values()) {
        const entry = [...loader.entries()].find(value => value.options.id === row.id)
        if (!entry || !entry.disabled || entry.options.name !== row.specifier
          || loader.loadedPlugin(row.resolution) !== undefined) {
          throw new Error(`LUMX governance readiness failed: ${row.id}`)
        }
      }
    },
  })
}

export const LUMX_GOVERNED_ROWS = Object.freeze(Object.keys(ROWS))
