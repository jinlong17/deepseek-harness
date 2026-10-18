# LUMX Desktop boundary modules

English | [中文](README.zh.md)

`node lumx/desktop/launch.mjs <consumer|developer> <os-home> <workspace>` emits a consumable launch description for **LUMX Desktop** (`com.lumxai.desktop`, `lumx:///`). It only resolves settings; it never creates `~/.lumx`, migrates data, deletes data, launches Electron, signs artifacts, or sends telemetry.

The consumer profile derives its data home as `<os-home>/.lumx`; the developer profile uses the separate sibling `<os-home>/.lumx-developer`. Launch output names both `profile` and `dataHomeDirectory`. Callers supply the workspace separately, and a workspace overlapping either data home in either direction is rejected, including a common ancestor such as the OS home or filesystem root. The check normalizes lexical `.` and `..` path syntax, but this configuration module does not resolve filesystem aliases or symlinks and does not itself prove OS-level isolation. `LUMX_TELEMETRY_ENABLED` defaults to enabled and accepts `on/off`, `true/false`, `yes/no`, or `1/0`; the value is configuration only and no telemetry transport is included.

The launch description also records the current agent preference as `codex` before `claude-agent` (DD12). It does not install, launch, or authenticate either agent.

`desktop/release-config.mjs` exports `createLumxElectronBuilderOverlay(base)` for a downstream Electron Builder configuration. It provides the product name, app id, and protocol without changing upstream Desktop files or creating a signed build.

`identity/byok-admission.mjs` is a fail-closed BYOK login seam. Each request needs a current `lumx.local-auth.v1` identity plus a gateway confirmation. It has no DeepSeek account-plugin dependency. `identity/loopback-gateway.mjs` accepts only literal `http://127.0.0.1` endpoints without userinfo, rejects redirects, and applies a one-second request limit so the included tests can prove the positive path without a real identity provider.

Run the bounded checks with:

```sh
node --test lumx/desktop/launch-environment.test.mjs
node --test lumx/desktop/native-host.test.mjs lumx/desktop/host-supervisor.test.mjs
node --test lumx/identity/byok-admission.test.mjs
node --test lumx/patches/registry.test.mjs
```

The product patch registry currently contains eight entries of the 12-patch desktop budget. P7 adds three product-owned consumers: a local platform-stub, desktop BYOK, and governed H1 composition. All install the same root-lifetime seven-row privacy policy before profile entries mount; the platform-stub records local qualification only and does not claim a platform gateway. The supported Host payload selects desktop BYOK or platform-stub by name; the stub starts without a model relay. Governed H1 is product-owned but currently observed through a noncanonical in-process qualification launcher, so it does not qualify the native Host boundary. `lumx/runtime/launch.mjs` starts the official DSH Web profile through a compiled native bootstrap, `sandbox-exec`, and a fresh pinned Node process. The bootstrap uses `POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT` and preserves only fresh standard streams. The supervisor retains identity and provider credentials; the confined Host receives only a launch-scoped model-relay capability. The public launcher exposes process identity, bounded controls, and shutdown without returning the in-process Context.

`lumx/probes/native-host-boundary-probe.mjs` begins in an adversarial native process whose standard streams, fd3, duplicate descriptors and fd512 all reference the same canary after the soft descriptor limit is lowered. It proves the canary readable with `fstat` and positional reads, then records that neither the supported Host nor its fresh child can recover the canary; reused descriptor numbers are distinguished by device, inode and content. An old direct sandbox-to-Node control deliberately retains fd3 and remains readable. The probe also exercises a real model turn, revoked-identity denial with zero provider I/O, process reaping and shutdown.

`lumx/probes/live-host-runner.mjs` remains the earlier Lab runner for pinned source, Node and r3 artifact observations. Its inherited-descriptor result describes the old direct chain and is retained as historical evidence; it is not the supported P3 launcher.

The runner takes explicit `--fork-root`, `--source-root`, `--node`, `--source-lock`, `--artifact-manifest`, `--output`, `--host-port`, `--identity-port` and `--model-port` values. Use a fresh output directory and the original pinned source/artifact manifest; retain failed attempts. The A2K G9-1 report and cold evidence record exact commands, hashes and limitations. No probe uses a real provider, credential or gateway. Lab-only H1/ACP capability drivers under `lumx/probes/` are separate from the product patch ledger and do not constitute a complete H1 product.


The same runner selects the official rendered UI/Cordis/ACP durability probe with `--suite live-cordis-ui --browser <verified-local-browser>`. That suite launches a synthetic browser profile, closes the real preview notice, drives official prompt/cancel controls, and checks the persisted ACP session identity across a Host restart. Its browser execution profile has broader local OS permissions and explicit credential-path denials; it proves UI behavior, not the deny-default Host filesystem boundary. Physical networking remains denied and is tested. A/B results never substitute for the missing complete Electron wrapper qualification.

`lumx/probes/h1-driver-runner.mjs` uses the common source/runtime/manifest/output arguments without Host/model/identity port flags. It observes the product governed-H1 composition rather than importing the Lab H1 adapter: a literal-loopback model/Broker adapter exposes only `lumx_broker`, and a root-owned policy gives every root, child, or resumed Agent a scoped allowlist before publication while a global monotonic execution guard denies native tools. Removing or reconfiguring the adapter cannot remove that policy; Agent publication fails closed while the Broker capability is absent. Model and Broker response bodies are bounded while streaming and share an independent request deadline with caller cancellation. The probe records real scoped tools, Gateway/Broker loopback HTTP bodies, retry and refusal outcomes, and the native canary result. Its real ACP positive session is persisted before the AgentLoop-disabled new/resume capability test. It does not register or impersonate an external factory. The three original components own disjoint result sets (Host:2, Cordis/UI:3, H1/driver:2); A2K's strict receipt aggregator still validates exactly those seven historical units. P3, P7, P8 and P9 are separately registered product work and do not change those historical results.
