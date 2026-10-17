/** Product patch metadata validated by probes; a release consumer is not yet wired. */
export const PATCH_BUDGET = 12

export const PRODUCT_PATCHES = Object.freeze([
  Object.freeze({
    files: Object.freeze([
      'lumx/README.md',
      'lumx/README.zh.md',
      'lumx/README.i18n.yaml',
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
  Object.freeze({
    files: Object.freeze(['apps/cli/src/profile-boot.ts']),
    id: 'G9-1-P4',
    purpose: 'Await application-owned root setup after package resolution and before profile entries mount.',
    removal: 'Remove the profile setup option and this registry entry together.',
    removalPaths: Object.freeze(['apps/cli/src/profile-boot.ts', 'lumx/patches/registry.mjs']),
    tests: Object.freeze(['vitest run apps/cli/tests/resolved-profile-boot.spec.ts']),
  }),
  Object.freeze({
    files: Object.freeze([
      'vendor/loader/src/index.ts', 'vendor/loader/src/config/entry.ts',
      'vendor/loader/src/config/group.ts', 'vendor/loader/src/config/tree.ts',
    ]),
    id: 'G9-1-P5',
    purpose: 'Expose synchronous typed entry admission before mutation, import, activation, and removal.',
    removal: 'Remove the loader admission event and transactional entry changes with this registry entry.',
    removalPaths: Object.freeze(['vendor/loader/src/', 'lumx/patches/registry.mjs']),
    tests: Object.freeze(['vitest run apps/cli/tests/loader-entry-admission.spec.ts']),
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/runtime/governance.mjs', 'lumx/runtime/internal-launch.mjs',
    ]),
    id: 'G9-1-P6',
    purpose: 'Own the fixed seven-row LUMX privacy policy for the complete Host lifetime.',
    removal: 'Remove governance setup and this registry entry together.',
    removalPaths: Object.freeze(['lumx/runtime/governance.mjs', 'lumx/runtime/internal-launch.mjs', 'lumx/patches/registry.mjs']),
    tests: Object.freeze(['node --test lumx/runtime/governance.test.mjs']),
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/drivers/acp/model-relay.mjs',
      'lumx/drivers/acp/qwen-feasibility.mjs',
      'lumx/identity/byok-admission.mjs',
    ]),
    id: 'G9-1-P8',
    purpose: 'Launch-scoped ACP model relay and non-canonical native Qwen create, prompt, cancel, and load-session feasibility groundwork.',
    removal: 'Remove lumx/drivers/acp, restore the prior BYOK admission helper, and remove this registry entry to withdraw P8 groundwork.',
    removalPaths: Object.freeze(['lumx/drivers/acp/', 'lumx/identity/byok-admission.mjs', 'lumx/patches/registry.mjs']),
    tests: Object.freeze([
      'node --test lumx/drivers/acp/*.test.mjs',
      'node lumx/drivers/acp/qwen-feasibility.mjs <caller-anchored arguments>',
    ]),
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/desktop/native/bootstrap.c',
      'lumx/desktop/native/build.mjs',
      'lumx/desktop/fd-observer.mjs',
      'lumx/desktop/host-entry.mjs',
      'lumx/desktop/host-profile.mjs',
      'lumx/desktop/host-supervisor.mjs',
      'lumx/runtime/internal-launch.mjs',
      'lumx/runtime/launch.mjs',
      'lumx/runtime/byok-plugin.mjs',
    ]),
    id: 'G9-1-P3',
    purpose: 'Trusted native bootstrap, sandboxed fresh-process Host, descriptor closure, process lifecycle controls, and supervisor-owned BYOK relay wiring.',
    removal: 'Remove the native Host modules, restore the in-process runtime launcher and BYOK wiring, and remove this registry entry to withdraw P3.',
    removalPaths: Object.freeze([
      'lumx/desktop/native/', 'lumx/desktop/fd-observer.mjs', 'lumx/desktop/host-entry.mjs',
      'lumx/desktop/host-profile.mjs', 'lumx/desktop/host-supervisor.mjs',
      'lumx/runtime/internal-launch.mjs', 'lumx/runtime/launch.mjs', 'lumx/runtime/byok-plugin.mjs',
      'lumx/patches/registry.mjs',
    ]),
    tests: Object.freeze([
      'node --test lumx/desktop/native-host.test.mjs lumx/desktop/host-supervisor.test.mjs',
      'node lumx/probes/native-host-boundary-probe.mjs <native-harness arguments>',
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
