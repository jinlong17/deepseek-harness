# LUMX Desktop boundary modules

`node lumx/desktop/launch.mjs <consumer|developer> <os-home> <workspace>` emits a consumable launch description for **LUMX Desktop** (`com.lumxai.desktop`, `lumx:///`). It only resolves settings; it never creates `~/.lumx`, migrates data, deletes data, launches Electron, signs artifacts, or sends telemetry.

The consumer profile derives its data home as `<os-home>/.lumx`; the developer profile uses the separate sibling `<os-home>/.lumx-developer`. Launch output names both `profile` and `dataHomeDirectory`. Callers supply the workspace separately, and a workspace inside either data home is rejected. The check normalizes lexical `.` and `..` path syntax, but this configuration module does not resolve filesystem aliases or symlinks and does not itself prove OS-level isolation. `LUMX_TELEMETRY_ENABLED` defaults to enabled and accepts `on/off`, `true/false`, `yes/no`, or `1/0`; the value is configuration only and no telemetry transport is included.

The launch description also records the current agent preference as `codex` before `claude-agent` (DD12). It does not install, launch, or authenticate either agent.

`desktop/release-config.mjs` exports `createLumxElectronBuilderOverlay(base)` for a downstream Electron Builder configuration. It provides the product name, app id, and protocol without changing upstream Desktop files or creating a signed build.

`identity/byok-admission.mjs` is a fail-closed BYOK login seam. Each request needs a current `lumx.local-auth.v1` identity plus a gateway confirmation. It has no DeepSeek account-plugin dependency. `identity/loopback-gateway.mjs` accepts only loopback endpoints so the included tests can prove the positive path without a real identity provider.

Run the bounded checks with:

```sh
node --test lumx/desktop/launch-environment.test.mjs
node --test lumx/identity/byok-admission.test.mjs
node --test lumx/patches/registry.test.mjs
```

The product patch registry contains one entry (`G9-1-B1`) of the 12-patch desktop budget. These modules are release-boundary inputs only; they do not claim that the upstream Desktop UI, Electron process, real account service, or full product distribution is integrated.
