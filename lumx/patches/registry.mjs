/** Product patch metadata validated by probes; a release consumer is not yet wired. */
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
  Object.freeze({
    files: Object.freeze([
      'lumx/runtime/launch.mjs',
      'lumx/runtime/profile.mjs',
      'lumx/runtime/byok-plugin.mjs',
      'lumx/runtime/privacy.patch.yml',
    ]),
    id: 'G9-1-B2',
    purpose: 'Launch the official Web profile as the LUMX shared Host/UI surface with the seven-row privacy overlay and per-call BYOK admission.',
    removal: 'Remove lumx/runtime and this registry entry to withdraw the private LUMX profile launcher and BYOK adapter.',
    removalPaths: Object.freeze(['lumx/runtime/', 'lumx/patches/registry.mjs']),
    tests: Object.freeze([
      'node --test lumx/probes/live-host.unit.test.mjs',
      'node lumx/probes/live-host-probe.mjs --source-root <pinned-source> --output <capture>',
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
