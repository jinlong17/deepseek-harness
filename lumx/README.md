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
node --test lumx/identity/byok-admission.test.mjs
node --test lumx/patches/registry.test.mjs
```

The product patch registry currently contains two entries (`G9-1-B1`, `G9-1-B2`) of the 12-patch desktop budget. `lumx/runtime/launch.mjs` launches the official DSH Web profile through the pinned `loadProfileDirectory` and `runProfile`, with the seven-row privacy overlay and a per-request BYOK identity gate on the real `llm/stream` waterfall. The loopback adapter supplies only synthetic transport; alternate registered provider routes pass through the same login gate. Its shared Host, connection and SessionController are real framework components. This is private distribution glue; it does not produce or qualify the complete Electron DesktopHost wrapper, real account service, signing chain or product distribution.

`lumx/probes/live-host-runner.mjs` verifies pinned source, Node and r3 artifacts before launching a synthetic developer runtime under Seatbelt, then records actual token/cookie/Origin/Host controls, BYOK model-request counts, restart and filesystem/descriptor observations. It saves execution argv, stdout, stderr, exit, signal and timeout separately. A failed qualification returns nonzero. The adversarial inherited-descriptor control currently demonstrates a real gap: the protected path is denied while the already-open inherited descriptor remains readable. Omitted descriptors only demonstrate spawn hygiene and do not qualify OS descriptor enforcement.

The runner takes explicit `--fork-root`, `--source-root`, `--node`, `--source-lock`, `--artifact-manifest`, `--output`, `--host-port`, `--identity-port` and `--model-port` values. Use a fresh output directory and the original pinned source/artifact manifest; retain failed attempts. The A2K G9-1 report and cold evidence record exact commands, hashes and limitations. No probe uses a real provider, credential or gateway. Lab-only H1/ACP capability drivers under `lumx/probes/` are separate from the product patch ledger and do not constitute a complete H1 product.


The same runner selects the official rendered UI/Cordis/ACP durability probe with `--suite live-cordis-ui --browser <verified-local-browser>`. That suite launches a synthetic browser profile, closes the real preview notice, drives official prompt/cancel controls, and checks the persisted ACP session identity across a Host restart. Its browser execution profile has broader local OS permissions and explicit credential-path denials; it proves UI behavior, not the deny-default Host filesystem boundary. Physical networking remains denied and is tested. A/B results never substitute for the missing complete Electron wrapper qualification.

`lumx/probes/h1-driver-runner.mjs` uses the common source/runtime/manifest/output arguments without Host/model/identity port flags. Its Lab-only base-backed governed composition records actual scoped tools, Gateway/Broker loopback HTTP bodies, two refusal paths, a native tool-call denial and complete-turn retry counts. Its real ACP positive session is persisted before the AgentLoop-disabled new/resume capability test. It does not register or impersonate an external factory. The three components own disjoint result sets (Host:2, Cordis/UI:3, H1/driver:2); A2K's strict receipt aggregator validates exactly the original seven units. Product patch metadata remains two desktop entries; probes and their Lab fixtures create no new patch pool.
