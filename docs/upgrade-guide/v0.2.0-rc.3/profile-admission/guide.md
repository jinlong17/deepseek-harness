---
kind: upgrade-guide
description: "Profile launchers can install awaited pre-entry setup and Loader consumers can reject prospective entry activation synchronously."
---

# Profile setup and entry admission

English | [中文](guide.zh.md)

## Change

`runProfile()` accepts an optional `setup(ctx)` callback. It runs after the profile package-resolution service mounts and before configuration entries mount. The launcher awaits it and disposes startup resources if it rejects.

Loader publishes the typed synchronous `loader/entry-admit` waterfall before an entry mutation, import, activation, or removal, and again after asynchronous import. The candidate contains the qualified id, immutable prospective options, effective disabled state, same-loader resolution identity, phase, and imported callback when available. Throwing rejects the operation before provider activation and rolls rejected persistence back. Existing launchers and Loader consumers that omit these APIs keep their previous behavior.

## Migration

Applications that require a root-lifetime admission policy should install it from `setup(ctx)`. Resolve protected modules with `ctx.loader.resolveEntry()` so the policy uses the same Loader and profile package interception as the subsequent import. Keep the setup callback application-owned; generic CLI and Loader code must not contain product-specific ids.

Admission listeners must complete synchronously. Use the `pre-import` phase for identity checks and repeat callback checks during `pre-activate`. Treat a setup rejection as startup failure and use the returned shutdown controller for ordinary teardown.
