---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-external-engine-binding

[English](2026-10-17-external-engine-binding.md) | 中文

## 概述

新增 DSH Agent 会话与一个外部引擎会话之间的必需日志绑定事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有日志不包含外部引擎绑定，仍可读取。这个新的必需普通事件只由外部引擎 factory 在发布 live Agent 之前写入，并且不带 ignorable 标记。已知事件集合不含该类型的旧 reader 必须拒绝日志；它不能忽略该绑定或恢复外部引擎。

<a id="verification"></a>
## 验证

持久化生成器、历史校验器、schema 测试和 Agent 定向类型检查覆盖声明与生成的运行时目录。B4 集成测试验证外部 factory 的事务和重放行为。

<a id="dev-note"></a>
## 开发备注

无。
