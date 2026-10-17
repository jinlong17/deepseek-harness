---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-external-engine-binding

English | [中文](2026-10-17-external-engine-binding.zh.md)

## Summary

Adds the required log-only binding between a DSH Agent session and one externally owned engine session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-external-engine-binding
baseline: false
changes:
  - root: "event:agent/external-engine-bound"
    previous: null
    after: "1df7c13db919676cd85ae7f07457ea25b50f08dfb857f2a9e746ed557bf0f2fb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no external-engine binding and remain readable. The new ordinary event is written only by the external-engine factory before publishing its live Agent. Older readers may retain or ignore the unknown event under the Session event-envelope contract; they cannot resume the external engine without the new adapter.

<a id="verification"></a>
## Verification

The persistence generator, history verifier, schema tests, and focused Agent typecheck cover the declaration and generated runtime catalog. The external factory transaction and replay behavior are verified by the B4 integration suite.

<a id="dev-note"></a>
## Dev Note

None.
