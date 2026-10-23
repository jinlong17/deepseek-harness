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
      'lumx/profiles/governed-h1-profile.mjs', 'lumx/probes/h1-driver-probe.mjs',
      'lumx/runtime/governed-h1-adapter.mjs', 'lumx/runtime/governed-h1-composition.mjs',
      'lumx/runtime/governed-session-policy.mjs',
      'lumx/runtime/h1-driver-runtime.mjs', 'lumx/runtime/internal-launch.mjs', 'lumx/runtime/profile.mjs',
    ]),
    id: 'G9-1-P7',
    purpose: 'Governed desktop platform-stub, desktop BYOK, and H1 product compositions with root-owned lifetime policy, Broker-only model tools, bounded loopback I/O, and monotonic native execution denial.',
    removal: 'Remove the governed profiles, H1 adapter/session policy, product composition wiring, and this registry entry together; P6 remains only as an unavailable policy seam without a consumer.',
    removalPaths: Object.freeze([
      'lumx/profiles/governed-h1-profile.mjs', 'lumx/runtime/governed-h1-adapter.mjs',
      'lumx/runtime/governed-h1-composition.mjs', 'lumx/runtime/governed-session-policy.mjs',
      'lumx/runtime/h1-driver-runtime.mjs',
      'lumx/patches/registry.mjs',
    ]),
    tests: Object.freeze([
      'node --test lumx/runtime/governed-h1-adapter.test.mjs lumx/runtime/governed-h1-lifecycle.test.mjs lumx/runtime/profile.test.mjs',
      'node lumx/probes/h1-driver-runner.mjs <caller-anchored arguments>',
    ]),
    upstream: 'No upstream patch: P7 consumes P4/P5 setup/admission through the LUMX product boundary.',
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/agent/external-agent-factory.mjs',
      'lumx/agent/external-agent.mjs',
      'lumx/desktop/external-engine-owner.mjs',
      'lumx/desktop/host-process-bridge.mjs',
      'lumx/desktop/typed-pipe.mjs',
      'lumx/drivers/acp/model-relay.mjs',
      'lumx/drivers/acp/supervised-qwen-engine.mjs',
      'lumx/identity/byok-admission.mjs',
      'lumx/runtime/external-qwen-composition.mjs',
    ]),
    id: 'G9-1-P8',
    purpose: 'Supervisor-owned external Qwen Agent factory, official ACP transport, durable native-session replay, bounded relay, prepared launch, and process-group lifecycle.',
    removal: 'Remove the external Agent, ACP driver, Host bridge, composition, restore the prior BYOK admission helper, and remove this registry entry to withdraw P8.',
    removalPaths: Object.freeze(['lumx/agent/', 'lumx/drivers/acp/', 'lumx/desktop/external-engine-owner.mjs', 'lumx/desktop/host-process-bridge.mjs', 'lumx/desktop/typed-pipe.mjs', 'lumx/identity/byok-admission.mjs', 'lumx/runtime/external-qwen-composition.mjs', 'lumx/patches/registry.mjs']),
    tests: Object.freeze([
      'node --test lumx/agent/external-agent-factory.test.mjs lumx/desktop/typed-pipe.test.mjs',
      'node --test lumx/drivers/acp/*.test.mjs',
      'node lumx/desktop/external-qwen-six-case.probe.mjs <caller-anchored arguments>',
    ]),
  }),
  Object.freeze({
    files: Object.freeze([
      'packages/core/agent/src/types.ts', 'packages/core/session/src/known-event-types.ts',
      'packages/core/agent-loop/src/engine-session-ownership.ts',
      'packages/core/agent-loop/src/configuration.ts', 'packages/core/agent-loop/src/factory-lifecycle.ts',
      'packages/core/agent-loop/src/turn-boundary.ts', 'packages/core/agent-loop/src/index.ts',
      'docs/persistence-changes/2026-10-17-external-engine-binding.md',
    ]),
    id: 'G9-1-P9',
    purpose: 'Required external-engine binding persistence contract and default AgentLoop ownership refusal before engine or storage mutation.',
    removal: 'Remove the binding event, generated persistence catalog rows, AgentLoop ownership guards, and this registry entry together.',
    removalPaths: Object.freeze(['packages/core/agent/src/types.ts', 'packages/core/session/src/known-event-types.ts', 'packages/core/agent-loop/src/', 'docs/persistence-changes/2026-10-17-external-engine-binding.md', 'lumx/patches/registry.mjs']),
    tests: Object.freeze([
      'node node_modules/vitest/vitest.mjs run packages/core/agent-loop/tests/external-engine-ownership.spec.ts',
      'pnpm run verify-persistence-catalog && pnpm run verify-persistence-changes',
    ]),
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/agent/external-session-eligibility-files.mjs',
      'lumx/agent/external-session-eligibility.mjs',
      'lumx/agent/external-agent-factory.mjs',
      'lumx/desktop/host-entry.mjs', 'lumx/desktop/host-launch-materials.mjs',
      'lumx/runtime/external-qwen-composition.mjs',
    ]),
    id: 'G9-1-P10',
    purpose: 'Product-owned creation eligibility receipt that keeps uncommitted external-engine logs inspectable but refuses their native recovery.',
    removal: 'Remove the eligibility store, its external factory and frozen Host wiring, and this registry entry together; P9 required binding ownership remains.',
    removalPaths: Object.freeze(['lumx/agent/external-session-eligibility-files.mjs', 'lumx/agent/external-session-eligibility.mjs', 'lumx/agent/external-agent-factory.mjs', 'lumx/runtime/external-qwen-composition.mjs', 'lumx/patches/registry.mjs']),
    tests: Object.freeze([
      'node --test lumx/agent/external-session-eligibility.test.mjs lumx/agent/external-session-eligibility-process.test.mjs',
      'node --test lumx/agent/external-agent-factory.test.mjs',
    ]),
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/desktop/external-engine-owner.mjs',
      'lumx/desktop/host-entry.mjs',
      'lumx/desktop/host-launch-materials.mjs',
      'lumx/desktop/host-process-bridge.mjs',
      'lumx/desktop/host-supervisor.mjs',
      'lumx/desktop/typed-pipe.mjs',
      'lumx/drivers/acp/supervised-qwen-engine.mjs',
      'lumx/probes/b5-desktop-host-factory.mjs',
      'lumx/probes/b5-external-qwen-factory.mjs',
      'lumx/probes/b5-external-qwen-support.mjs',
      'lumx/probes/b5-external-qwen-support.test.mjs',
      'lumx/probes/b5-fixed-stubs.mjs',
      'lumx/probes/b5-h1-host-factory.mjs',
      'lumx/probes/b5-hook-common.mjs',
      'lumx/probes/b5-host-byok-qualification.mjs',
      'lumx/probes/b5-host-h1-qualification.mjs',
      'lumx/probes/b5-host-privacy-qualification.mjs',
      'lumx/probes/b5-host-privacy-qualification.test.mjs',
      'lumx/probes/b5-host-qualification.mjs',
      'lumx/probes/b5-factory-cleanup.mjs', 'lumx/probes/b5-factory-cleanup.test.mjs',
      'lumx/probes/b5-owner-protocol.mjs',
      'lumx/probes/b5-owner-protocol.test.mjs',
      'lumx/probes/gate1-prepared-host-controller.mjs',
      'lumx/runtime/internal-launch.mjs',
      'scripts/b5-client-build-environment-helper.ts',
    ]),
    id: 'G9-1-P11',
    purpose: 'Bounded qualification-only Host lifecycle controls, retained material ACKs, private owner cleanup evidence, and a fail-closed Darwin build-environment normalizer for the canonical desktop gate.',
    removal: 'Remove the fixed qualification probes, retained-controller hooks, bounded Host lifecycle evidence, build-environment helper, and this registry entry together; production Host commands remain limited to their existing fixed surface.',
    removalPaths: Object.freeze([
      'lumx/probes/b5-*.mjs', 'lumx/probes/gate1-prepared-host-controller.mjs',
      'lumx/desktop/external-engine-owner.mjs', 'lumx/desktop/host-entry.mjs',
      'lumx/desktop/host-launch-materials.mjs', 'lumx/desktop/host-process-bridge.mjs',
      'lumx/desktop/host-supervisor.mjs', 'lumx/desktop/typed-pipe.mjs',
      'lumx/drivers/acp/supervised-qwen-engine.mjs', 'lumx/runtime/internal-launch.mjs',
      'scripts/b5-client-build-environment-helper.ts', 'lumx/patches/registry.mjs',
    ]),
    tests: Object.freeze([
      'node --test lumx/desktop/typed-pipe.test.mjs',
      'node --test lumx/probes/b5-external-qwen-support.test.mjs',
      'node --test lumx/probes/b5-owner-protocol.test.mjs', 'node --test lumx/probes/b5-factory-cleanup.test.mjs lumx/probes/b5-host-privacy-qualification.test.mjs',
      'node lumx/probes/gate1-prepared-host-controller.mjs <caller-anchored qualification arguments>',
      'node scripts/b5-client-build-environment-helper.ts <caller-anchored environment fixture>',
    ]),
  }),
  Object.freeze({
    files: Object.freeze([
      'lumx/desktop/byok-admission-peer.mjs',
      'lumx/desktop/host-entry.mjs',
      'lumx/desktop/host-process-bridge.mjs',
      'lumx/desktop/host-supervisor.mjs',
      'lumx/desktop/typed-pipe.mjs',
      'lumx/runtime/byok-plugin.mjs',
      'lumx/runtime/internal-launch.mjs',
    ]),
    id: 'G9-1-P12',
    purpose: 'Fresh supervisor-owned identity admission for every non-relay desktop Host adapter call over the existing private typed pipe.',
    removal: 'Remove the fixed admission peer and its Host/runtime wiring together; withdrawal restores the known alternate-adapter authorization bypass and is not release-safe.',
    removalPaths: Object.freeze([
      'lumx/desktop/byok-admission-peer.mjs', 'lumx/desktop/host-entry.mjs',
      'lumx/desktop/host-process-bridge.mjs', 'lumx/desktop/host-supervisor.mjs',
      'lumx/desktop/typed-pipe.mjs', 'lumx/runtime/byok-plugin.mjs',
      'lumx/runtime/internal-launch.mjs', 'lumx/patches/registry.mjs',
    ]),
    tests: Object.freeze([
      'node --test lumx/desktop/byok-admission-peer.test.mjs lumx/desktop/typed-pipe.test.mjs',
      'node --test lumx/desktop/host-supervisor.test.mjs lumx/probes/live-host.unit.test.mjs',
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
    purpose: 'Trusted native bootstrap, sandboxed fresh-process Host, descriptor closure, process lifecycle controls, named desktop consumer selection, and supervisor-owned BYOK relay wiring.',
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
