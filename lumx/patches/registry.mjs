/** Product patch registry. The entries are imported by downstream release tooling. */
export const PATCH_BUDGET = 12

export const PRODUCT_PATCHES = Object.freeze([
  Object.freeze({
    files: Object.freeze([
      'lumx/README.md',
      'lumx/desktop/release-config.mjs',
      'lumx/desktop/launch-environment.mjs',
      'lumx/desktop/launch.mjs',
      'lumx/identity/byok-admission.mjs',
      'lumx/identity/loopback-gateway.mjs',
    ]),
    id: 'G9-1-B1',
    purpose: 'LUMX Desktop identity, isolated home/workspace launch inputs, BYOK fail-closed admission, and configuration-only telemetry.',
    removal: 'Remove the listed LUMX modules and this registry entry together; no upstream source is patched by this entry.',
    removalPaths: Object.freeze(['lumx/desktop/', 'lumx/identity/', 'lumx/patches/registry.mjs']),
    tests: Object.freeze([
      'node --test lumx/desktop/launch-environment.test.mjs',
      'node --test lumx/identity/byok-admission.test.mjs',
      'node --test lumx/patches/registry.test.mjs',
    ]),
  }),
])

/** @returns {readonly object[]} */
export function listProductPatches() {
  return PRODUCT_PATCHES
}

/** @returns {void} */
export function assertProductPatchBudget() {
  if (PRODUCT_PATCHES.length > PATCH_BUDGET) {
    throw new Error(`LUMX patch budget exceeded: ${PRODUCT_PATCHES.length}/${PATCH_BUDGET}`)
  }
  const identifiers = new Set(PRODUCT_PATCHES.map(patch => patch.id))
  if (identifiers.size !== PRODUCT_PATCHES.length) throw new Error('LUMX patch registry has duplicate ids')
}
