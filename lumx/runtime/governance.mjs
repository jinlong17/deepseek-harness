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

/** Install the root-owned LUMX privacy policy before any profile entry mounts. */
export function installLumxGovernance(ctx) {
  const loader = ctx.get('loader')
  if (!loader?.resolveEntry || !loader?.loadedPlugin || !loader?.identitiesOf) {
    throw new Error('LUMX governance requires the admission-capable candidate loader')
  }
  const byId = new Map()
  const forbiddenUrls = new Set()
  const forbiddenCallbacks = new WeakSet()
  for (const [id, specifier] of Object.entries(ROWS)) {
    const resolution = loader.resolveEntry(specifier, loader.ctx.baseUrl)
    if (!resolution?.url) throw new Error(`LUMX governance could not resolve ${id}`)
    byId.set(id, Object.freeze({ id, specifier, resolution }))
    forbiddenUrls.add(resolution.url)
    const loaded = loader.loadedPlugin(resolution)
    if (loaded !== undefined) {
      if (callbackObject(loaded)) forbiddenCallbacks.add(loaded)
      throw new Error(`LUMX governance found forbidden module already loaded: ${id}`)
    }
  }
  const reject = (id, detail) => { throw new Error(`LUMX governance denied ${id}: ${detail}`) }
  const isForbiddenCallback = (plugin) => callbackObject(plugin)
    && (forbiddenCallbacks.has(plugin) || loader.identitiesOf(plugin).some(url => forbiddenUrls.has(url)))
  const check = (candidate) => {
    const row = byId.get(candidate.id) ?? byId.get(candidate.options.id)
    if (row && candidate.phase === 'remove') reject(candidate.id, 'protected row cannot be removed')
    if (row && !candidate.effectiveDisabled) reject(candidate.id, 'protected row must remain disabled')
    if (!candidate.effectiveDisabled && candidate.resolution && forbiddenUrls.has(candidate.resolution.url)) {
      reject(candidate.id, `module aliases protected identity ${candidate.resolution.url}`)
    }
    if (!candidate.effectiveDisabled && isForbiddenCallback(candidate.plugin)) {
      reject(candidate.id, 'callback aliases a protected module')
    }
  }
  ctx.on('loader/entry-admit', (candidate, next) => { check(candidate); next() }, { global: true, prepend: true })
  ctx.on('internal/plugin', (fiber) => {
    if (isForbiddenCallback(fiber.runtime?.callback)) reject(fiber.entry?.id ?? '<direct>', 'direct protected callback activation')
  }, { global: true, prepend: true })
  ctx.on('internal/config', function (config, next) {
    if (isForbiddenCallback(this.runtime?.callback)) reject(this.entry?.id ?? '<direct>', 'protected callback config')
    return next()
  }, { global: true, prepend: true })
  return Object.freeze({
    rows: Object.freeze([...byId.values()]),
    assertInstalled() {
      if (byId.size !== Object.keys(ROWS).length || forbiddenUrls.size !== Object.keys(ROWS).length) {
        throw new Error('LUMX governance identity set is incomplete')
      }
    },
  })
}

export const LUMX_GOVERNED_ROWS = Object.freeze(Object.keys(ROWS))
