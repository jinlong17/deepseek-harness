# LUMX Desktop 边界模块

[English](README.md) | 中文

`node lumx/desktop/launch.mjs <consumer|developer> <os-home> <workspace>` 为 **LUMX Desktop**（`com.lumxai.desktop`、`lumx:///`）输出可供调用方使用的启动描述。它只解析设置，不会创建 `~/.lumx`、迁移或删除数据、启动 Electron、签名产物或发送遥测。

consumer profile 的数据目录为 `<os-home>/.lumx`；developer profile 使用独立的同级目录 `<os-home>/.lumx-developer`。启动输出同时包含 `profile` 和 `dataHomeDirectory`。调用方单独提供 workspace；workspace 与任一数据目录存在任一方向的包含关系时都会被拒绝，包括 OS home 或文件系统根目录等共同祖先。检查会对词法路径中的 `.` 和 `..` 进行规范化；配置模块不解析文件系统别名或符号链接，本身不证明 OS 层隔离。`LUMX_TELEMETRY_ENABLED` 默认启用，接受 `on/off`、`true/false`、`yes/no` 或 `1/0`；该值只用于配置，不包含遥测传输实现。

启动描述还记录当前的 agent 优先级：`codex` 先于 `claude-agent`（DD12）。它不会安装、启动或认证这两个 agent（智能体）。

`desktop/release-config.mjs` 导出 `createLumxElectronBuilderOverlay(base)`，供下游 Electron Builder 配置使用。它提供产品名、app id 和协议，不修改上游 Desktop 文件，也不创建签名构建。

`identity/byok-admission.mjs` 提供失败即拒绝的 BYOK 登录 seam。每次请求都需要有效的 `lumx.local-auth.v1` 身份和网关确认，不依赖 DeepSeek 账号插件。`identity/loopback-gateway.mjs` 仅接受不含 userinfo 的字面量 `http://127.0.0.1` endpoint，拒绝重定向，并设置一秒请求时限，使随附测试可在不连接真实身份提供方的情况下验证正向路径。

运行以下限定范围的检查：

```sh
node --test lumx/desktop/launch-environment.test.mjs
node --test lumx/desktop/native-host.test.mjs lumx/desktop/host-supervisor.test.mjs
node --test lumx/identity/byok-admission.test.mjs
node --test lumx/patches/registry.test.mjs
```

产品补丁登记表目前包含四项（`G9-1-B1`、`G9-1-B2`、`G9-1-P8`、`G9-1-P3`），占桌面 12 项补丁预算中的四项。`lumx/runtime/launch.mjs` 现在通过已编译的原生 bootstrap、`sandbox-exec` 和全新的 pinned Node 进程启动官方 DSH Web profile。bootstrap 使用 `POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT`，只保留新的标准流。supervisor 保留身份和 provider 凭据；受限 Host 只收到一次启动范围内的模型 relay capability。公共 launcher 返回进程身份、限定控制和 shutdown，不返回进程内 Context。

`lumx/probes/native-host-boundary-probe.mjs` 从对抗性原生进程开始：降低文件描述符软限制后，其标准流、fd3、重复描述符和 fd512 都指向同一 canary。探针先用 `fstat` 和定位读取证明 canary 可读，再记录受支持 Host 及其全新子进程都无法恢复 canary；描述符编号被复用时，用 device、inode 和内容作区分。旧的直接 sandbox-to-Node 对照会刻意保留 fd3，因此仍然可读。探针还执行真实模型 turn、撤销身份后的拒绝且 provider I/O 为零、进程回收和 shutdown。

`lumx/probes/live-host-runner.mjs` 保留为较早的 Lab runner，用于 pinned source、Node 和 r3 artifact 观测。其继承描述符结果描述旧的直接链，并作为历史证据保留；它不是受支持的 P3 launcher。

runner 接受显式的 `--fork-root`、`--source-root`、`--node`、`--source-lock`、`--artifact-manifest`、`--output`、`--host-port`、`--identity-port` 和 `--model-port`。使用全新的输出目录及原始 pinned source/artifact manifest，并保留失败尝试。A2K G9-1 报告和冷证据记录准确命令、摘要及限制。所有探针均不使用真实 provider、凭据或网关。`lumx/probes/` 下仅用于 Lab 的 H1/ACP 能力驱动与产品补丁登记表分开，不构成完整 H1 产品。


同一 runner 通过 `--suite live-cordis-ui --browser <verified-local-browser>` 选择官方渲染 UI/Cordis/ACP 持久化探针。该套件启动合成 browser profile，关闭真实预览提示，驱动官方 prompt/cancel 控件，并在 Host 重启前后检查持久化 ACP session identity。浏览器执行 profile 具有更广的本地 OS 权限，并显式拒绝凭据路径；它验证 UI 行为，不验证 deny-default Host 文件系统隔离。物理网络仍被拒绝，并接受实际测试。A/B 结果不能替代尚缺的完整 Electron 包装资格检查。

`lumx/probes/h1-driver-runner.mjs` 使用通用的 source/runtime/manifest/output 参数，不接收 Host/model/identity 端口参数。它仅用于 Lab、基于真实 base 的 governed composition，记录实际限定范围的 tools、Gateway/Broker loopback HTTP body、两条拒绝路径、一次原生 tool call 拒绝，以及完整 turn 的重试计数。真实 ACP 正控 session 会在禁用 AgentLoop 的 new/resume 能力测试前完成持久化。它不注册或冒充外部 factory。三个原始组件拥有互不重叠的结果集合（Host:2、Cordis/UI:3、H1/driver:2）；A2K 的严格收据聚合器仍只验证这七个历史 unit。P3 和 P8 是另行登记的产品 groundwork，不改变这些历史结果。
