---
kind: upgrade-guide
description: "Profile 启动器可安装受 await 的 entry 前置 setup，Loader 使用方可同步拒绝候选 entry 激活。"
---

# Profile setup 与 entry admission

[English](guide.md) | 中文

## 变更

`runProfile()` 新增可选的 `setup(ctx)` 回调。它在 profile package-resolution 服务挂载后、配置 entry 挂载前运行。启动器会等待该回调；如果回调拒绝，启动资源会被释放。

Loader 在 entry 变更、导入、激活或移除前发布带类型的同步 `loader/entry-admit` waterfall，并在异步导入后再次发布。候选对象包含完整 id、不可变的候选配置、实际 disabled 状态、同一 Loader 得到的解析身份、阶段，以及可用时的已导入回调。监听器抛错会在 provider 激活前拒绝操作，并回滚被拒绝的持久化内容。不使用这些 API 的既有启动器和 Loader 使用方保持原有行为。

## 迁移

需要 root 生命周期准入策略的应用，应从 `setup(ctx)` 安装策略。使用 `ctx.loader.resolveEntry()` 解析受保护模块，确保策略与后续 import 经过同一个 Loader 和 profile package interception。setup 回调应归应用所有；通用 CLI 与 Loader 代码不得包含产品专用 id。

准入监听器必须同步完成。在 `pre-import` 阶段检查身份，并在 `pre-activate` 阶段再次检查回调。setup 拒绝应作为启动失败处理；普通关闭继续使用返回的 shutdown controller。
