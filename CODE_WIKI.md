# Browser Pilot Code Wiki

## 目录

1. [项目概览](#1-项目概览)
2. [仓库结构](#2-仓库结构)
3. [整体架构](#3-整体架构)
4. [端到端运行链路](#4-端到端运行链路)
5. [主要模块职责](#5-主要模块职责)
6. [关键类与函数索引](#6-关键类与函数索引)
7. [命令工具层](#7-命令工具层)
8. [Bridge、Daemon 与 Extension 协议链路](#8-bridgedaemon-与-extension-协议链路)
9. [Kernel、Runtime、Capture 与 Native 边界](#9-kernelruntimecapture-与-native-边界)
10. [依赖关系与架构边界](#10-依赖关系与架构边界)
11. [构建、运行与验证](#11-构建运行与验证)
12. [配置、产物与状态目录](#12-配置产物与状态目录)
13. [测试体系](#13-测试体系)
14. [维护指南](#14-维护指南)
15. [架构原则摘要](#15-架构原则摘要)

---

## 1. 项目概览

Browser Pilot 是一个面向 AI Agent 的真实浏览器控制系统。它通过 Chrome/Edge Manifest V3 扩展连接本地 Node.js bridge/daemon，并通过 `browser-pilot` CLI 暴露一组固定的 `browser_*` 工具，用于：

- DOM/文本/HTML/页面结构感知；
- JavaScript 执行与 CDP 物理输入；
- tab、frame、session、lease 管理；
- network/hook/evidence/screenshot/artifact 采集；
- HTTP replay、crawl、fuzz、SQLi、template、cookie 分析等 Web Security 工作流；
- 本地 artifact 与 evidence envelope 管理。

项目包信息位于 [`package.json`](package.json)：

- 包名：`browser-pilot`
- 运行时：Node.js `>=22`
- 模块系统：ESM，`"type": "module"`
- CLI bin：`browser-pilot -> ./dist/src/apps/cli/bin.js`
- 公共导出入口：[`index.ts`](index.ts)

---

## 2. 仓库结构

```text
browser-pilot/
├─ index.ts                         公共 API 导出入口
├─ README.md                        产品说明与快速开始
├─ AGENTS.md                        Agent 操作入口与文档路由
├─ CODE_WIKI.md                     项目架构与开发地图
├─ REPO_GOVERNANCE.md               贡献者工作流、边界与验证门禁权威
├─ mise.toml                        canonical 验证入口
├─ package.json                     npm 包、脚本、依赖
├─ src/
│  ├─ apps/
│  │  ├─ cli/                       browser-pilot CLI
│  │  └─ daemon/                    用户本地 daemon
│  ├─ bridge/
│  │  ├─ server/                    Node bridge server
│  │  ├─ extension/                 MV3 extension 源码
│  │  └─ protocol/                  native command schema
│  ├─ commands/                     browser_* 工具层
│  ├─ kernels/                      纯逻辑内核
│  ├─ browser-runtime/              浏览器 I/O runtime
│  ├─ browser-command-runtime/      command runtime 辅助
│  ├─ browser-page-runtime/         页面脚本评估辅助
│  ├─ artifacts/                    artifact 读写与检索
│  ├─ resources/                    browser-result resource/ref 存储
│  ├─ scan/                         scan script 构建与页面摘要
│  ├─ content/                      content extraction script 构建
│  ├─ native/                       TS native kernel adapter
│  ├─ ports/                        runtime port 类型
│  ├─ types/                        schema 生成类型
│  ├─ utils/                        通用工具
│  └─ validation/                   TypeBox 参数校验
├─ capture-src/
│  └─ entries/                      注入页面世界的脚本模板源
├─ native/browser-pilot-kernels/    可选 Rust native kernels
├─ scripts/                         构建、验证、协议同步脚本
├─ tests/                           Node test runner 测试
└─ bridge/
   ├─ browser_bridge_config.json    bridge 配置
   └─ browser_pilot_bridge/         扩展打包产物，生成目录，不手改
```

重要生成目录：

- `dist/`：TypeScript build 输出，不手动编辑。
- `bridge/browser_pilot_bridge/`：MV3 扩展打包输出，不手动编辑。

---

## 3. 整体架构

Browser Pilot 的架构可以理解为自上而下的五层：

```text
CLI / daemon
  │ loopback HTTP
  ▼
BrowserBridgeServer
  │ local WebSocket 127.0.0.1:18765-18784
  ▼
MV3 extension service worker + offscreen transport
  │ Chrome APIs / CDP / page scripts
  ▼
Live Chrome/Edge tabs
```

更完整的代码层依赖关系：

```text
src/apps/cli + src/apps/daemon
        │
        ▼
src/bridge/server  ◀──WebSocket──▶  src/bridge/extension
        │
        ▼
src/commands
        │
        ▼
src/browser-runtime + src/browser-command-runtime + src/browser-page-runtime
        │
        ▼
src/kernels
```

核心设计点：

1. CLI 是唯一用户入口，负责参数解析、本地 help/schema/validate、daemon 调用。
2. Daemon 是用户级单例，持有 `BrowserBridgeServer`，拥有 live browser session。
3. Bridge Server 是 Node 侧 WebSocket/HTTP 桥，管理 extension client、tab/session、pending request、operation、lease。
4. Extension 负责实际 Chrome API、CDP、page script、network、input、screenshot 等浏览器侧能力。
5. Commands 层把底层能力组织为稳定的 `browser_*` 工具公共面。
6. Kernels 层只做纯逻辑，不依赖 browser、Node 或 npm runtime。

---

## 4. 端到端运行链路

### 4.1 `browser-pilot execute` 链路

```text
用户命令
  │ browser-pilot execute --script ...
  ▼
src/apps/cli/bin.ts
  ▼
src/apps/cli/main.ts
  │ runToolCommand()
  ▼
src/apps/cli/client.ts
  │ ensureDaemon()
  │ POST /invoke { tool:"browser_execute", params, cwd }
  ▼
src/apps/daemon/server.ts
  │ validateCommandArgs()
  │ def.execute(...)；HTTP 请求保持到 operation 终态
  ▼
src/commands/executeCommand.ts
│ withBrowserOperation()
│ 0. mutation replay guard（同 intent 复用完成结果；未 observe 的 ACK mutation 拒绝再次 dispatch）
│ 1. daemon ledger begin + target generation lock
│ 2. internal operation.begin（等待 observers armed）
▼
extension OperationCoordinator
  │ tabs/webNavigation/download/debugger/MutationObserver listeners 已安装
  ▼
dispatch server.executeJavaScript(...) / programEngine physical frames
  ▼
extension exec.ts
  │ foreground chrome.scripting.executeScript；background/CSP fallback 复用 persistent CDP Runtime.evaluate
  │ concurrent attach 按 tab 合并；operation domains 并行 arm；domain/focus 按需配置；one-shot script 直接 evaluate
  │ operation_event 持续上行到 daemon ledger
  ▼
script postcondition（仅显式声明时）
│ action 返回后立即求值；未通过时由 MutationObserver 在 DOM 变化后重验
│ 只有 true / {verified:true} 产生 script-postcondition-verified
  ▼
command-specific resolver
│ 普通 JavaScript resolve、显式 script postcondition、navigation/download，或 physical program 最终 verify:true 后置条件产生 completed
│ 否则按 activity/pending/deadline 分类终态
  ▼
operation.finish + bounded page evidence
  ▼
browserOperationCommandResult()
  │ 保留 browser-operation/v2 根终态、分类与机械 completion source
  │ 超预算 completion/effect/diagnostics 保存一次并替换为 typed summary
  │ 返回 continuation + saved.path + verified artifact_hints
  ▼
browser-operation/v2
  ▼
CLI renderResult()
```

### 4.2 `browser-pilot command` 链路

```text
browser-pilot command --command '{"cmd":"tabs","method":"list"}'
  ▼
CLI → daemon /invoke: browser_command
  ▼
src/commands/nativeCommand.ts
  │ validate BridgeCommandSchema
  │ rejectUnsafeExecuteCommand
  │ read command: server.sendCommand(...) 后立即返回
  │ write command: withBrowserOperation() 后返回 browser-operation/v2
  ▼
src/bridge/server/BrowserBridgeCommandService.ts
  │ validateBridgeCommand
  │ resolve targetRef/tabId
  │ sendPayload(object command)
  ▼
extension router
  │ object command
  │ ack
  ▼
src/bridge/extension/service_worker/core_commands.ts
  │ dispatchBrowserPilotBridgeCommand
  ▼
Chrome API / CDP / extension handler
  ▼
read result 或 write terminal outcome → bridge server → daemon → CLI
```

### 4.3 ACK 与 timeout 语义

Bridge Server 为每个 transport request 分配 `id`。Extension 收到请求后先返回 `ack`，执行完成后返回 `result` 或 `error`。这让 server 可以区分：

- 请求未到达 extension：没有 ACK；
- 请求已到达但执行慢：有 ACK，pending request 仍在运行；
- 单个 transport dispatch 完成：收到 result/error。

ACK 或单个 dispatch result 不等于浏览器 operation 完成。write command 的 `/invoke` 会继续保持，直到 command-specific resolver 或通用 liveness 分类器产生 `browser-operation/v2` 终态。CLI transport timeout 为 `max(120s, timeoutMs + 10s)`，上限 310 秒；命令 hard deadline 仍由最多 300 秒的内部 `timeoutMs` 控制。

`/invoke` 为每个控制连接创建 AbortSignal。控制客户端断开或 operation hard deadline 到达时，signal 依次传入 command handler、`withBrowserOperation()`、per-tab queue、pending bridge request 与 program engine。仍在 queue 中的 write 会以 `dispatch.started:false` 退出并永不补发；已经送入 WebSocket 的 request 会删除 pending waiter，但保留是否 ACK 的事实。Program 的 delay/wait/eval/input 帧共享同一 signal，取消后不再执行后续帧。已 ACK 动作不能被取消事实反推为“未发生”，因此仍按 ambiguous/deadline 与 at-most-once barrier 处理。

对应实现：[`BrowserBridgePendingRequests.ts`](src/bridge/server/BrowserBridgePendingRequests.ts)、[`BrowserBridgeClientMessageService.ts`](src/bridge/server/BrowserBridgeClientMessageService.ts)。

---

## 5. 主要模块职责

### 5.1 `src/apps/cli`

CLI 层负责：

- `browser-pilot` 二进制入口；
- 本地命令分发；
- 工具命令参数解析和 schema coerce；
- 自动启动或连接 daemon；
- 调用 daemon `/invoke`；
- 渲染 text/json 输出；
- 提供 `commands`、`schema`、`validate`、`doctor`、`connect`、`status`、`daemon`、`pair`、`lease` 等本地命令。

关键文件：

| 文件 | 职责 |
|---|---|
| [`bin.ts`](src/apps/cli/bin.ts) | CLI shebang 入口，按需加载 help 或 main。 |
| [`main.ts`](src/apps/cli/main.ts) | 主命令分发。 |
| [`registry.ts`](src/apps/cli/registry.ts) | 从 commands 定义生成 CLI 子命令。 |
| [`client.ts`](src/apps/cli/client.ts) | `invokeTool()`，ensure daemon 并 POST `/invoke`。 |
| [`render.ts`](src/apps/cli/render.ts) | CLI 输出渲染。 |
| [`cliLocalCommands.ts`](src/apps/cli/cliLocalCommands.ts) | commands/schema/validate/doctor/selftest。 |
| [`cliConnectionCommands.ts`](src/apps/cli/cliConnectionCommands.ts) | connect/status/daemon 控制。 |
| [`cliPairCommand.ts`](src/apps/cli/cliPairCommand.ts) | pairing。 |
| [`cliLeaseCommand.ts`](src/apps/cli/cliLeaseCommand.ts) | lease 控制。 |

### 5.2 `src/apps/daemon`

Daemon 层负责：

- 用户级单例进程；
- 懒启动 `BrowserBridgeServer`；
- 暴露 token-guarded loopback HTTP 控制面；
- 收集和执行所有 `browser_*` command definitions；
- 在 loopback 控制客户端断开时取消对应 invocation；
- pairing token 与 tenant lease 管理；
- 维护 daemon lockfile 与状态发现。

关键文件：

| 文件 | 职责 |
|---|---|
| [`server.ts`](src/apps/daemon/server.ts) | daemon 主体，`startDaemon()` 与 HTTP routes。 |
| [`daemonControl.ts`](src/apps/daemon/daemonControl.ts) | lockfile、spawn、find、ensure、stop、control request。 |
| [`contractIdentity.ts`](src/apps/daemon/contractIdentity.ts) | canonical command contract serialization/hash、local/daemon identity compare。 |
| [`authStore.ts`](src/apps/daemon/authStore.ts) | pairing agent/token 存储。 |
| [`authTypes.ts`](src/apps/daemon/authTypes.ts) | auth/pairing/lease 类型与常量。 |
| [`tenantLease.ts`](src/apps/daemon/tenantLease.ts) | 多 agent 互斥 lease。 |

Daemon HTTP 控制面：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/status` | GET | bridge、extension、tabs、tools 状态。 |
| `/connect` | POST | 启动 bridge，可等待 extension ready。 |
| `/invoke` | POST | 执行 `browser_*` 工具。 |
| `/shutdown` | POST | 关闭 daemon 和 bridge。 |
| `/pair/start` | POST | 发起 agent pairing。 |
| `/pair/wait` | POST | 等待 pairing 审批。 |
| `/lease` | POST | acquire/release/status lease。 |
| `/revoke` | POST | 撤销 pairing。 |
| `/pairings` | GET | 列出 pairing agents。 |

### 5.3 `src/bridge/server`

Bridge Server 是 Node 侧浏览器桥。它不直接调用 Chrome API，而是通过 WebSocket 与 extension 通信。

关键职责：

- 监听本地 HTTP/WebSocket endpoint；
- 管理 extension WebSocket clients；
- 维护 browser sessions、tabs、leases、operations、observation snapshots；
- 将 command 发送给 extension；
- 管理 pending request 的 ACK/result/error/timeout；
- 心跳与 stale client 清理；
- readiness、diagnostics、recovery artifacts。

关键文件：

| 文件 | 职责 |
|---|---|
| [`BrowserBridgeServer.ts`](src/bridge/server/BrowserBridgeServer.ts) | 聚合所有 bridge server 子系统的主类。 |
| [`BrowserBridgeHttpServer.ts`](src/bridge/server/BrowserBridgeHttpServer.ts) | HTTP + WebSocket endpoint，端口绑定。 |
| [`BrowserBridgeCommandService.ts`](src/bridge/server/BrowserBridgeCommandService.ts) | `sendCommand()`、`executeJavaScript()`、`refreshTabs()`。 |
| [`BrowserBridgePendingRequests.ts`](src/bridge/server/BrowserBridgePendingRequests.ts) | pending request ACK/result/timeout/cancellation 生命周期。 |
| [`BrowserBridgeClientMessageService.ts`](src/bridge/server/BrowserBridgeClientMessageService.ts) | extension 上行消息处理。 |
| [`BrowserBridgeClientRegistry.ts`](src/bridge/server/BrowserBridgeClientRegistry.ts) | WebSocket client registry。 |
| [`BrowserTabSessionRouter.ts`](src/bridge/server/BrowserTabSessionRouter.ts) | tab/session/targetRef 路由。 |
| [`BrowserBridgeSessionState.ts`](src/bridge/server/BrowserBridgeSessionState.ts) | session kernel state 聚合。 |
| [`BrowserCommandQueueRegistry.ts`](src/bridge/server/BrowserCommandQueueRegistry.ts) | 可取消的 per-tab write queue；取消的 queued item 不会晚到 dispatch。 |
| [`BrowserBridgeClientHeartbeat.ts`](src/bridge/server/BrowserBridgeClientHeartbeat.ts) | WebSocket heartbeat。 |

### 5.4 `src/bridge/extension`

Extension 是 MV3 浏览器侧实现。它执行实际浏览器能力：Chrome APIs、CDP、content scripts、network recorder、hook、screenshot、transfer，以及内部 operation observers。selector/navigation/network-idle wait 实现不属于公共工具面。

关键结构：

```text
src/bridge/extension/
├─ service-worker.ts                MV3 service worker 入口
├─ static/manifest.json             Manifest 源
├─ offscreen/transport.ts           offscreen WebSocket transport
├─ page_scripts/                    content/hook/disable dialogs scripts
└─ service_worker/                  service worker 模块
```

关键文件：

| 文件 | 职责 |
|---|---|
| [`service-worker.ts`](src/bridge/extension/service-worker.ts) | 安装 keepalive、router、transport。 |
| [`offscreen/transport.ts`](src/bridge/extension/offscreen/transport.ts) | 实际持有 WebSocket，扫描 18765-18784 端口。 |
| [`service_worker/transport.ts`](src/bridge/extension/service_worker/transport.ts) | offscreen 协调、probe、`ext_ready` 握手。 |
| [`service_worker/router.ts`](src/bridge/extension/service_worker/router.ts) | WebSocket/internal message 分发。 |
| [`service_worker/core_commands.ts`](src/bridge/extension/service_worker/core_commands.ts) | native command dispatch。 |
| [`service_worker/runtimeSupport.ts`](src/bridge/extension/service_worker/runtimeSupport.ts) | Extension 共享错误、response normalization、persistent CDP 访问与页面 evaluate。 |
| [`service_worker/runtime.ts`](src/bridge/extension/service_worker/runtime.ts) | Browser Pilot command composition 与 handler dispatch。 |
| [`service_worker/state_store.ts`](src/bridge/extension/service_worker/state_store.ts) | MV3 持久化恢复、hook session 与 per-tab queue 状态。 |
| [`service_worker/tab_sync.ts`](src/bridge/extension/service_worker/tab_sync.ts) | tab 同步、replacement/activation 与统一 tab cleanup。 |
| [`service_worker/tab_identity.ts`](src/bridge/extension/service_worker/tab_identity.ts) | `chrome.storage.session` 内的 logical tab identity；tab close 删除、`tabs.onReplaced` 迁移。 |
| [`service_worker/page_identity.ts`](src/bridge/extension/service_worker/page_identity.ts) | top-level document commit、SPA/BFCache lineage 与 per-tab page epoch。 |
| [`service_worker/exec.ts`](src/bridge/extension/service_worker/exec.ts) | JavaScript 执行；foreground 走 MAIN world，background/CSP fallback 复用 persistent CDP。 |
| [`service_worker/cdp.ts`](src/bridge/extension/service_worker/cdp.ts) | 按 tab 合并并发 attach，按需配置 domain/focus，send/detach/targets/frameTree 与 hot-script bounded cache。 |
| [`service_worker/input.ts`](src/bridge/extension/service_worker/input.ts) | CDP 输入、pointer/key/touch/ref。 |
| [`service_worker/network.ts`](src/bridge/extension/service_worker/network.ts) | network recorder、HAR/body/wait。 |
| [`service_worker/network_events.ts`](src/bridge/extension/service_worker/network_events.ts) | CDP network/page 事件分发与 bounded request/response/WebSocket/SSE 投影。 |
| [`service_worker/operation_coordinator.ts`](src/bridge/extension/service_worker/operation_coordinator.ts) | `operation.begin/finish/cancel`、事件监听、30 秒 passive late-effect 窗口与清理。 |
| [`service_worker/operation_event_transport.ts`](src/bridge/extension/service_worker/operation_event_transport.ts) | `operation_event` WebSocket 上行。 |
| [`service_worker/wait.ts`](src/bridge/extension/service_worker/wait.ts) | 内部 selector/navigation/network-idle/composite observer primitives。 |
| [`service_worker/hook.ts`](src/bridge/extension/service_worker/hook.ts) | Hook action 分发、安装/卸载生命周期与 session 状态。 |
| [`service_worker/screenshot.ts`](src/bridge/extension/service_worker/screenshot.ts) | screenshot capture。 |

MV3 service worker 不能稳定持有长期 WebSocket，因此项目使用 offscreen document 作为 WebSocket transport，service worker 专注于命令调度和 Chrome API/CDP 调用。
Daemon/bridge stop 是 terminal lifecycle：daemon 会关闭残留 loopback keep-alive，bridge 会终止已连接的 extension sockets，并等待 WebSocket 与 HTTP listener 都关闭；foreground daemon 另有短于 managed replacement proof window 的 bounded terminal-exit fallback，避免 CLI/offscreen 自动重连或丢失的 close callback 把旧 daemon 留在 draining 状态。

### 5.5 `src/commands`

Commands 层是 `browser_*` 公共工具面。它向上服务 CLI/daemon，向下调用 bridge server、browser runtime、kernel 与 artifacts/resource 层。

职责：

- 定义公开工具名称、描述、prompt、TypeBox 参数 schema；
- 注册所有工具；
- 统一 timeout、maxChars、targetRef/tabId、operation tracking；
- 统一结果 envelope、summary、artifact fallback、redaction、evidence；
- 实现 core browser tools 与 Web Security tools。

核心文件：

| 文件 | 职责 |
|---|---|
| [`commandCatalog.ts`](src/commands/commandCatalog.ts) | 公开工具注册器的权威清单。 |
| [`defineBrowserCommands.ts`](src/commands/defineBrowserCommands.ts) | 命令注册总入口。 |
| [`commandDefinition.ts`](src/commands/commandDefinition.ts) | `BrowserCommandDefinition` 等基础类型。 |
| [`commandManifestIndex.ts`](src/commands/commandManifestIndex.ts) | command definition 收集器。 |
| [`commandRuntime.ts`](src/commands/commandRuntime.ts) | timeout、target、operation、result helper。 |
| [`browserOperation.ts`](src/commands/browserOperation.ts) | `withBrowserOperation()` 事务编排、liveness 终态与统一 outcome。 |
| [`browserOperationResult.ts`](src/commands/browserOperationResult.ts) | 所有 write outcome 的唯一公开结果出口：终态续行决策、预算压缩、完整 evidence artifact 与渐进读取 hints。 |
| [`commandValidation.ts`](src/commands/commandValidation.ts) | CLI/daemon 共享的严格 key → coercion → schema → semantic validation pipeline。 |
| [`publicActionCatalog.ts`](src/commands/publicActionCatalog.ts) | 合并 generated native action 与 command-owned synthetic action 的 canonical catalog。 |
| [`operationResolvers.ts`](src/commands/operationResolvers.ts) | write command completion resolver registry 与治理检查。 |
| [`resultMiddleware.ts`](src/commands/resultMiddleware.ts) | distilled envelope、artifact、summary、evidence。 |
| [`validationMiddleware.ts`](src/commands/validationMiddleware.ts) | schema validation helper。 |
| [`distillerRegistry.ts`](src/commands/distillerRegistry.ts) | summary distiller registry。 |

核心工具文件：

| 工具 | 文件 |
|---|---|
| `browser_tabs` | [`tabsCommand.ts`](src/commands/tabsCommand.ts) |
| `browser_execute` | [`executeCommand.ts`](src/commands/executeCommand.ts) |
| `browser_observe` | [`observeCommand.ts`](src/commands/observeCommand.ts)、[`observe/scanRunner.ts`](src/commands/observe/scanRunner.ts) |
| `browser_command` | [`nativeCommand.ts`](src/commands/nativeCommand.ts) |
| `browser_network`、`browser_hook`、`browser_frame` | [`nativeActionCommands.ts`](src/commands/nativeActionCommands.ts) |
| `browser_evidence` | [`evidenceCommand.ts`](src/commands/evidenceCommand.ts) |
| `browser_artifact` | [`artifactCommand.ts`](src/commands/artifactCommand.ts) |
| `browser_download`、`browser_upload` | [`transferCommands.ts`](src/commands/transferCommands.ts) |
| `browser_screenshot` | [`screenshotCommand.ts`](src/commands/screenshotCommand.ts) |

`browser_observe` 的 scan/text/tabs 实现按阶段拆分，`scanRunner.ts` 只负责编排；这些阶段由 ESLint 约束为单函数复杂度不超过 20、单函数不超过 150 行，避免重新长成单体流程：

| Observe 阶段 | 文件 | 职责 |
|---|---|---|
| 编排 | [`observe/scanRunner.ts`](src/commands/observe/scanRunner.ts) | 规范化请求并串联各阶段，不持有投影细节。 |
| session | [`observe/scanSession.ts`](src/commands/observe/scanSession.ts) | fingerprint、render cache、ledger baseline 与扫描预算准备。 |
| page identity | [`observe/pageIdentity.ts`](src/commands/observe/pageIdentity.ts) | current/baseline PageIdentity 解析、re-anchor 分类与 full-frame fallback。 |
| cache | [`observe/scanCache.ts`](src/commands/observe/scanCache.ts) | render-cache 命中、artifact 恢复与 ledger 延续。 |
| capture | [`observe/scanCapture.ts`](src/commands/observe/scanCapture.ts) | 可选导航、页面 scan 与 ABML structure 采集。 |
| providers | [`observe/scanProviders.ts`](src/commands/observe/scanProviders.ts) | recorder 高水位、causal、axe 与 Readability provider。 |
| assembly | [`observe/scanAssembly.ts`](src/commands/observe/scanAssembly.ts) | entity attribution、diff/treeDiff、relations、identity、relevance 与 summary 组装。 |
| output | [`observe/scanOutput.ts`](src/commands/observe/scanOutput.ts) | diagnostics、PageObservation、artifact、ledger 与最终 result 输出。 |
| tabs | [`observe/scanTabs.ts`](src/commands/observe/scanTabs.ts) | tabs-only 兼容投影。 |

### 5.6 `src/kernels`

Kernels 是纯逻辑层。这里的代码不做浏览器 I/O、不读写文件、不依赖 runtime/commands/bridge。除 `src/kernels/session/*` 可显式导入 `node:crypto` 用于随机 ID 与不可逆诊断哈希外，kernel 不依赖 Node-only API。

主要子目录：

| 目录 | 职责 |
|---|---|
| [`kernels/abml`](src/kernels/abml) | Agent Browser Markup Language，页面实体、AX/DOM 融合、diff、relations、collections、causal、verbs。 |
| [`kernels/refs`](src/kernels/refs) | 通用 ref descriptor 类型，以及 `bp-ref://` ref mint/parse/id/policy/text extraction。 |
| [`kernels/evidence/distill`](src/kernels/evidence/distill) | fact、budget、projection、artifact plan、recovery、salience envelope。 |
| [`kernels/session`](src/kernels/session) | session、lease、operation、snapshot、perception ledger、intent refs。 |
| [`kernels/security`](src/kernels/security) | SQLi oracle、replay diff 等安全工具纯逻辑。 |
| [`kernels/temporal`](src/kernels/temporal) | timeout、state loss、staleness、deadline pressure 判断。 |

### 5.7 `src/browser-runtime` 与 `src/browser-command-runtime`

`browser-runtime` 是 kernel 的浏览器 I/O 适配层，负责调用 bridge/CDP/scan/screenshot/resource，然后把采集结果交给 kernel 纯函数处理。ABML structure 读取会先取得 DOM scan 与 observation snapshot，再通过 CDP `Accessibility.getFullAXTree` 和 `DOMSnapshot.captureSnapshot` 采集页面级 AX tree/geometry；runtime 负责 bounded CDP fallback、diagnostics 与 ref/resource 注册，纯合并策略仍在 ABML kernel 中执行。DOM scan 的 selector/ref/actionability/evidence 是执行权威，full AX 只做 page-wide role/name/description/state/structure enrichment 或追加 AX-only entity；backendNodeId 优先匹配，其次保守 geometry，无歧义时才允许 semantic fallback，歧义、缺失几何或 unsafe semantic name 会被记录为 skipped/degraded。`Accessibility.getPartialAXTree` 只作为 runtime 层局部优化，用于已有可靠 `backendNodeId` 的 local read/pierce refinement 或 action-adjacent enrichment；它默认 `fetchRelatives:false`、短 timeout、小节点上限，diagnostics 使用 `provider:"partial-ax"` 与 `ok/skipped/failed/degraded` 状态表达 missing backend、empty、unsupported/error 或 over-budget，不替代 canonical no-mode observe 的 full AX fusion，也不创建请求 scope 外的 page-wide AX-only entities。

关键文件：

| 文件 | 职责 |
|---|---|
| [`browser-runtime/abml/runtime.ts`](src/browser-runtime/abml/runtime.ts) | ABML runtime 入口，提供 read/pierce/frame。 |
| [`browser-runtime/abml/axRuntime.ts`](src/browser-runtime/abml/axRuntime.ts) | CDP AX tree、DOMSnapshot、DOM/AX entity merge。 |
| [`browser-runtime/abml/frameRuntime.ts`](src/browser-runtime/abml/frameRuntime.ts) | frame list、frame entity、frame ref。 |
| [`browser-runtime/abml/pierceRuntime.ts`](src/browser-runtime/abml/pierceRuntime.ts) | subtree/AX piercing。 |
| [`browser-runtime/abml/visionRuntime.ts`](src/browser-runtime/abml/visionRuntime.ts) | vision probe、screenshot、artifact。 |
| [`browser-command-runtime/abml/integration.ts`](src/browser-command-runtime/abml/integration.ts) | commands 与 ABML runtime 集成点。 |
| [`browser-command-runtime/programEngine.ts`](src/browser-command-runtime/programEngine.ts) | physical input program engine。 |
| [`browser-command-runtime/waitSupervisor.ts`](src/browser-command-runtime/waitSupervisor.ts) | operation supervisor 使用的内部 temporal/wait coordination。 |

### 5.8 `capture-src`

`capture-src` 存放会注入页面世界执行的 TypeScript source template。

| 文件 | 职责 |
|---|---|
| [`capture-src/entries/scanTemplate.ts`](capture-src/entries/scanTemplate.ts) | 页面 scan 脚本模板。 |
| [`capture-src/entries/contentTemplate.ts`](capture-src/entries/contentTemplate.ts) | 页面正文内容提取模板。 |
| [`capture-src/entries/visionTemplate.ts`](capture-src/entries/visionTemplate.ts) | viewport/target vision probe 模板。 |
| [`src/capture/inject.ts`](src/capture/inject.ts) | template 渲染与 inline JSON 安全注入。 |

### 5.9 `native/browser-pilot-kernels`

Rust native kernels 是可选加速层，用于：

- `abml.diff`
- `abml.treeDiff`

TS adapter 位于 [`src/native/browserPilotNativeKernels.ts`](src/native/browserPilotNativeKernels.ts)。Native 缺失、禁用、spawn 失败、退出非 0、JSON 解析失败时返回 `undefined`，调用方必须回退到 TypeScript 纯实现。

---

## 6. 关键类与函数索引

### 6.1 CLI / Daemon

| 名称 | 文件 | 说明 |
|---|---|---|
| `run(argv)` | [`src/apps/cli/bin.ts`](src/apps/cli/bin.ts) | CLI 入口，选择 help 或 main。 |
| `main(argv)` | [`src/apps/cli/main.ts`](src/apps/cli/main.ts) | CLI 主分发。 |
| `buildCliCommands()` | [`src/apps/cli/registry.ts`](src/apps/cli/registry.ts) | 从 command definitions 生成 CLI commands。 |
| `invokeTool()` | [`src/apps/cli/client.ts`](src/apps/cli/client.ts) | ensure daemon 并调用 `/invoke`。 |
| `startDaemon()` | [`src/apps/daemon/server.ts`](src/apps/daemon/server.ts) | 创建 bridge server、command registry、control server。 |
| `ensureDaemon()` | [`src/apps/daemon/daemonControl.ts`](src/apps/daemon/daemonControl.ts) | 查找或启动 daemon。 |
| `controlRequest()` | [`src/apps/daemon/daemonControl.ts`](src/apps/daemon/daemonControl.ts) | token-guarded HTTP control request。 |
| `TenantLeaseRegistry` | [`src/apps/daemon/tenantLease.ts`](src/apps/daemon/tenantLease.ts) | pairing agent lease 管理。 |

### 6.2 Bridge Server

| 名称 | 文件 | 说明 |
|---|---|---|
| `BrowserBridgeServer` | [`src/bridge/server/BrowserBridgeServer.ts`](src/bridge/server/BrowserBridgeServer.ts) | Node bridge server 主类。 |
| `BrowserBridgeHttpServer` | [`src/bridge/server/BrowserBridgeHttpServer.ts`](src/bridge/server/BrowserBridgeHttpServer.ts) | HTTP/WS endpoint。 |
| `BrowserBridgeCommandService` | [`src/bridge/server/BrowserBridgeCommandService.ts`](src/bridge/server/BrowserBridgeCommandService.ts) | 命令发送、JS 执行、tabs refresh。 |
| `sendCommand()` | [`src/bridge/server/BrowserBridgeCommandService.ts`](src/bridge/server/BrowserBridgeCommandService.ts) | 发送 native command。 |
| `executeJavaScript()` | [`src/bridge/server/BrowserBridgeCommandService.ts`](src/bridge/server/BrowserBridgeCommandService.ts) | 发送 JS 字符串执行请求。 |
| `BrowserBridgePendingRequests` | [`src/bridge/server/BrowserBridgePendingRequests.ts`](src/bridge/server/BrowserBridgePendingRequests.ts) | request id、ack、result、timeout。 |
| `BrowserBridgeClientMessageService` | [`src/bridge/server/BrowserBridgeClientMessageService.ts`](src/bridge/server/BrowserBridgeClientMessageService.ts) | 处理 extension 上行消息。 |
| `BrowserTabSessionRouter` | [`src/bridge/server/BrowserTabSessionRouter.ts`](src/bridge/server/BrowserTabSessionRouter.ts) | targetRef/tabId/session 路由。 |

### 6.3 Extension

| 名称 | 文件 | 说明 |
|---|---|---|
| `installBrowserPilotServiceWorker()` | [`src/bridge/extension/service-worker.ts`](src/bridge/extension/service-worker.ts) | 安装 keepalive/router/transport。 |
| `installBrowserPilotTransport()` | [`src/bridge/extension/service_worker/transport.ts`](src/bridge/extension/service_worker/transport.ts) | 安装 offscreen transport、probe、tab sync。 |
| `handleBrowserPilotBridgeWsMessage()` | [`src/bridge/extension/service_worker/router.ts`](src/bridge/extension/service_worker/router.ts) | WebSocket payload 分发。 |
| `dispatchBrowserPilotBridgeCommand()` | [`src/bridge/extension/service_worker/core_commands.ts`](src/bridge/extension/service_worker/core_commands.ts) | native command dispatch。 |
| `handleWsExec()` | [`src/bridge/extension/service_worker/exec.ts`](src/bridge/extension/service_worker/exec.ts) | JS 执行与 CDP fallback。 |
| `handleBrowserPilotOperationCommand()` | [`src/bridge/extension/service_worker/operation_coordinator.ts`](src/bridge/extension/service_worker/operation_coordinator.ts) | 在 dispatch 前 arm observers，并管理 terminal/passive cleanup。 |
| `connectWS()` | [`src/bridge/extension/offscreen/transport.ts`](src/bridge/extension/offscreen/transport.ts) | offscreen WebSocket 连接。 |

### 6.4 Commands

| 名称 | 文件 | 说明 |
|---|---|---|
| `BrowserCommandDefinition` | [`src/commands/commandDefinition.ts`](src/commands/commandDefinition.ts) | 单个 browser tool 的标准定义。 |
| `CommandManifestIndex` | [`src/commands/commandManifestIndex.ts`](src/commands/commandManifestIndex.ts) | 命令定义收集器。 |
| `defineBrowserCommands()` | [`src/commands/defineBrowserCommands.ts`](src/commands/defineBrowserCommands.ts) | 注册所有命令。 |
| `resolveBrowserCommandRegistrars()` | [`src/commands/commandCatalog.ts`](src/commands/commandCatalog.ts) | 返回公开工具注册器清单。 |
| `sharedTabScopedToolParams()` | [`src/commands/commandRuntime.ts`](src/commands/commandRuntime.ts) | tab/session/detail/output 参数 schema。 |
| `commandTimeoutMs()` | [`src/commands/commandRuntime.ts`](src/commands/commandRuntime.ts) | timeout 规范化，硬上限 300 秒。 |
| `targetTabId()` | [`src/commands/commandRuntime.ts`](src/commands/commandRuntime.ts) | 从 params/body 解析目标 tab。 |
| `withTrackedOperation()` | [`src/commands/commandRuntime.ts`](src/commands/commandRuntime.ts) | operation 生命周期和进度。 |
| `withBrowserOperation()` | [`src/commands/browserOperation.ts`](src/commands/browserOperation.ts) | write command 统一事务、事件消费与 `browser-operation/v2` 终态。 |
| `browserOperationCommandResult()` | [`src/commands/browserOperationResult.ts`](src/commands/browserOperationResult.ts) | 保留根终态契约；按预算保存/压缩 operation evidence，并输出安全 `continuation` 与 artifact JSON path。 |
| `resolveBrowserOperationCompletion()` | [`src/commands/operationResolvers.ts`](src/commands/operationResolvers.ts) | command-specific mechanical completion evidence。 |
| `jsonCommandResult()` | [`src/commands/commandRuntime.ts`](src/commands/commandRuntime.ts) | JSON 结果 envelope 入口。 |
| `distilledJsonResult()` | [`src/commands/resultMiddleware.ts`](src/commands/resultMiddleware.ts) | 摘要、artifact、redaction、evidence envelope。 |
| `validateCommandArgs()` | [`src/validation/commandArgs.ts`](src/validation/commandArgs.ts) | TypeBox 参数转换与校验。 |
| `validateBrowserCommandArguments()` | [`src/commands/commandValidation.ts`](src/commands/commandValidation.ts) | 共享严格参数流水线，返回 normalized args 或完整 issue list。 |
| `publicCommandActionCatalog()` | [`src/commands/publicActionCatalog.ts`](src/commands/publicActionCatalog.ts) | 返回带 raw action、kebab CLI action、owner 与 schemaRef 的 action catalog。 |

### 6.5 Kernels / Runtime / Native

| 名称 | 文件 | 说明 |
|---|---|---|
| `Entity` | [`src/kernels/abml/entity.ts`](src/kernels/abml/entity.ts) | ABML 实体模型。 |
| `diffEntities()` | [`src/kernels/abml/diff.ts`](src/kernels/abml/diff.ts) | entity diff 纯实现。 |
| `SessionKernel` | [`src/kernels/session/SessionKernel.ts`](src/kernels/session/SessionKernel.ts) | session/lease/operation/snapshot kernel 聚合。 |
| `SessionOperationRegistry` | [`src/kernels/session/operationRegistry.ts`](src/kernels/session/operationRegistry.ts) | active/terminal ledger、sequence、200-event bound、TTL 与 owner-isolated late effects。 |
| `classifyBrowserOperationLiveness()` | [`src/kernels/session/browserOperationState.ts`](src/kernels/session/browserOperationState.ts) | 纯逻辑 `no_effect`/`stalled`/`deadline` 分类；不能产生 `completed`。 |
| `mintRef()` / `parseRef()` | [`src/kernels/refs/core.ts`](src/kernels/refs/core.ts) | `bp-ref://` URI 创建与解析。 |
| `RefDescriptor` | [`src/kernels/refs/types.ts`](src/kernels/refs/types.ts) | ABML 与 resource port 共享的 locator、owner、policy、snapshot、epoch、geometry 类型。 |
| `createBrowserAbmlRuntime()` | [`src/browser-runtime/abml/runtime.ts`](src/browser-runtime/abml/runtime.ts) | 创建 ABML runtime context。 |
| `buildScanScript()` | [`src/scan/buildScanScript.ts`](src/scan/buildScanScript.ts) | 渲染 scan 页面脚本，并注入 scan signals、growth probe 与 accessible-name provider。 |
| `DOM_ACCESSIBILITY_API_BUNDLE` | [`src/scan/domAccessibilityApiBundle.ts`](src/scan/domAccessibilityApiBundle.ts) | `dom-accessibility-api` 的页面世界 bundle，用于 scan 命名链路。 |
| `renderCaptureTemplate()` | [`src/capture/inject.ts`](src/capture/inject.ts) | capture template 参数注入。 |
| `invokeNativeKernel()` | [`src/native/browserPilotNativeKernels.ts`](src/native/browserPilotNativeKernels.ts) | 调用 Rust native binary，失败返回 `undefined`。 |

---

## 7. 命令工具层

### 7.1 工具清单

公开工具列表由 [`src/commands/commandCatalog.ts`](src/commands/commandCatalog.ts) 维护，是公共工具面的单一来源。

Core tools：

- `browser_tabs`
- `browser_command`
- `browser_execute`
- `browser_observe`
- `browser_download`
- `browser_upload`
- `browser_network`
- `browser_hook`
- `browser_evidence`
- `browser_frame`
- `browser_screenshot`
- `browser_artifact`

Web Security tools：

- `browser_crawl`
- `browser_fuzz`
- `browser_sqli`
- `browser_template`
- `browser_callback_oast`
- `browser_cookie_analyze`
- `browser_http_replay`

CLI 子命令由工具名映射而来：去掉 `browser_` 前缀，并把 `_` 转为 `-`。例如：

- `browser_execute` → `execute`
- `browser_cookie_analyze` → `cookie-analyze`
- `browser_http_replay` → `http-replay`

带 action 的公开命令额外使用 [`publicActionCatalog.ts`](src/commands/publicActionCatalog.ts) 作为 routing/help/schema/validate 的共同来源。Catalog 合并 native schema 生成 metadata 与 command definition 上的 `actionMetadata`；CLI token 固定 kebab-case，raw JSON `action` 保持 schema spelling。例如 raw `captureReload` 的唯一 canonical CLI route 是 `network capture-reload`，`network captureReload` 不是 alias。对既有 top-level 参数的 canonical positional route 由同一 command definition 的 `cliSubcommands` 唯一声明；`tabs list/snapshot/switch/create/close` 映射各自 `action`，`artifact inspect/paths/json` 映射对应 `mode`，parser/help/schema/validate/catalog/contract hash 不另建手写 route 表。

公共 discovery 直接使用 contract v3，不双写旧形态。`commands --json` 由 command registry 派生 `browser-pilot-command-catalog/v3`：root 只出现一次 contract identity 与 artifact read 规则，每个 command 只保留 `cli/tool/group/summary/schemaArgv`、canonical kebab-case action references 和 bounded command-owned subcommand references；19-tool catalog 的 UTF-8 硬上限为 25 KiB。`schema <command> --json` 返回公共参数与 route references，`schema <command> <subcommand> --json` 展开 `browser-pilot-command-schema/v3`：action route 返回 closed action schema，top-level route 则把已有 discriminant 参数收窄为对应 `const`。Action schema 固定包含 raw action `const`、公共 target/session/output 字段、该 action 唯一允许的 nested `params`、required/required-any 和 `additionalProperties:false`。Native network/hook/frame metadata 由 protocol schema 生成，`captureReload` 等 synthetic action 与 top-level `cliSubcommands` 都由 command definition 自己持有；help、schema、offline validate、daemon validate、execution routing 与 contract hash 读取同一 owner。

### 7.2 命令定义模型

每个工具都是一个 `BrowserCommandDefinition`，包含：

- `name`
- `label`
- `description`
- `promptSnippet`
- `promptGuidelines`
- `parameters`
- 可选 `actionMetadata`
- 可选 `coerceArguments`
- 可选纯函数 `validateArguments`
- `execute`

注册流程：

```text
commandCatalog.ts
  ▼
defineBrowserCommands()
  ▼
CommandManifestIndex.define(definition)
  ▼
CLI 用于 help/schema/validate
Daemon 用于真实 execute
```

### 7.3 参数校验

大多数命令使用 `strictCommandParameters()` 构造 TypeBox schema，默认拒绝未知参数。CLI offline `validate` 与 daemon `/invoke` 共同调用 [`validateBrowserCommandArguments()`](src/commands/commandValidation.ts)，固定顺序为：

1. CLI 解析 file/value reference；
2. 在任何 normalization 前拒绝 unknown、internal、removed key；
3. 应用 command 显式声明的 canonical `coerceArguments`；
4. 对已规范化的值做 TypeBox schema check（daemon JSON 不做通用类型转换）；
5. 调用纯函数 `validateArguments` 做跨字段/action semantic validation；
6. 成功返回最终 normalized args，失败返回全部 `{code,path,message}` issues；
7. 只有通过后才执行 `def.execute(...)`。

Semantic validation 不启动 daemon/bridge、不访问浏览器、不写 artifact。通用 deprecated-key stripping 已删除；execute 的 script/program exactly-one、program/postcondition 互斥、script intent 必须带 postcondition、observe mode/diff/baseline/add-on 互斥、artifact target/read/search 组合及 action-dependent required/illegal 参数都在共享层校验。

### 7.4 结果 Envelope

命令结果统一经过 `jsonCommandResult()` 或 `textCommandResult()`，最终由 `resultMiddleware.ts` 生成 distilled envelope。

浏览器状态改变型 core command 是例外的稳定公共契约：它们直接返回 `browser-operation/v2`，字段包含 `operationId`、`commandName`、终态 `status`、`classification`、`completionVerified`、`ok`、稳定 `code`、原样 `continuation`、锁定的 `target`/generation、`dispatch` ACK 生命周期、browser/page `signals`、可选 command-specific `completion`、bounded `pageEffect`/`diagnostics` 和同 owner 下一次相关调用自动浮现的 `lateEffects`。只有 `completed` 是 `success` / `completionVerified:true` / `ok:true` 并映射 CLI exit 0；其他终态按固定表归为 `inconclusive` 或 `failure`，均映射 exit 1。`completed` 只能由 [`operationResolvers.ts`](src/commands/operationResolvers.ts) 的 command-specific 证据产生；通用 supervisor 只能产生 `effect_observed`、`no_effect`、`stalled`、`target_lost`、`failed` 或 `deadline`，明确歧义由 command resolver/error mapping 产生 `ambiguous`。普通 `script-resolved` 只证明 JavaScript resolve；script mutation 的业务完成必须显式声明 `postcondition`，其 `true` / `{verified:true}` 结果才产生 `script-postcondition-verified`。JSON 与 TTY renderer 共享 [`browserOperation.ts`](src/kernels/session/browserOperation.ts) 的纯 classifier，通用 error-shape 检测不决定 operation 成功。每个 `withBrowserOperation()` 调用点都必须经 [`browserOperationResult.ts`](src/commands/browserOperationResult.ts) 返回：小 outcome 原样保留根终态；大 outcome 保存完整 redacted evidence，并用 typed count/keys/preview summary 替换高体积 `completion.evidence.result`、page effect、late effect data 或 diagnostics details，同时返回 `limits.truncated`、`saved.path` 与仅指向实际存在路径的 `artifact_hints`。artifact 写入位于浏览器终态之后并 fail-open：若落盘失败或最终文件超过 reader ceiling，返回 `ARTIFACT_SAVE_FAILED` / `evidenceUnavailable` 与 `replay:"do_not_retry"`，但不得发布不可读路径，也不得擦除或改写已证明的 `status` 和 `completion.source`。

`continuation` 按 evidence domain 映射最小安全决策，而不是把所有非理想状态都变成页面观察：页面状态未验证时用 `observe`；target lost、tab close、new-tab fan-out 或 current target 不再可靠时用 `reacquire_target`；只有 outcome 确有 diagnostics 时才用 `inspect_diagnostics`；非页面不确定状态且没有 diagnostics 时用只读 `verify_command_state`；成功但纯结果被压缩时用 `inspect_artifact`。非成功状态均标记 `replay:"do_not_retry"`，已完成的后续读取标记 `replay:"not_needed"`。读取型命令仍立即返回既有 envelope。

所有 `withBrowserOperation()` write route 共享 daemon 内的 at-most-once mutation guard。相同 owner、browser session 与 stable `targetRef`（generation suffix 归一化；无 ref 时退回 tabId）的 active mutation 在 dispatch 前串行，不能由 `browser_command` 绕过 `browser_execute` barrier。Script intent 必须把 `postcondition` 放进同一 transaction；action 返回后先求值，未通过时只在 DOM mutation event 上重验，不创建 public wait/sleep loop。Program engine 把 eval/mouse/key/text/wait frame 的 ACK（包括 frame transport error 的 `acked:true`）聚合到顶层；`expand` 完成后会对真实最终序列重新执行唯一/final verifier 校验，动态生成的 physical frame 也按 physical program 结算。含 physical frame且不发生 navigation/download 的 program，只有唯一最后一个 `{eval:"...",verify:true}` 返回 `true` 或 `{verified:true}` 才产生 `completed/program-verified`。ACK 后未完成的 mutation 建立 observation barrier；只有在 mutation 结算后开始、强制 fresh capture、且结束时仍是同一 page identity/target generation 的 canonical no-mode `browser_observe` 才能清障。Program abort、显式验证失败和 frame summary 进入 bounded diagnostics，不再丢失物理输入是否已 ACK 的事实。

`browser_execute.intentId` 与原始 script/program/postcondition payload 分别只保存 SHA hash。带 intent 的 completed tombstone 与未 observe barrier 不受普通五分钟 operation TTL 或 256 项 operation 容量淘汰，并在同一 bridge server stop/start 时保留；当前 retention 边界是 daemon process。相同 intent + 相同 payload 的完成调用复用旧 outcome 而不 dispatch，不确定 intent 即使 observe 后仍拒绝重放；相同 intent + 不同 payload 返回 `intent_conflict`。Protected mutation evidence 独立上限为 4096，达到上限时新 intent write fail closed，不得通过淘汰旧证据腾位。若 operation 在 action WebSocket dispatch 前因 arming、queue cancellation 或 caller disconnect 失败，`dispatch.started:false` 会清除 intent hash，不污染可安全重试的 intent；一旦送出或 ACK，则保留证据并禁止盲重放。

Extension `ext_ready` 在同一 socket 或已断开的同 instance replacement socket 上报告新的 `workerBootId` 时按 `sw-restart` 计数；最近 boot 按 `extensionInstanceId` 保留，restart 不复用无关 disconnect 的 reconnect latency。Bridge 只向由该 extension instance 选中的 browser session active operation 写入 `observer_lost`，不得污染其他浏览器。该证据在缺少 command-specific completion proof 时覆盖 dispatch failure/target-loss 映射并产生 `ambiguous`；transport/frame error 中的 `acked:true` 会回填根 `dispatch.acknowledged`，确保 mutation guard 不把结果未知误当作未发送。

Envelope 常见字段：

- `tool`
- `command`
- `browserSessionId`
- `detailLevel`
- `summary`
- `diagnostics`
- `target`
- `limits`
- `privacy`
- `entities`
- `gist`
- `outline`
- `relations`
- `identity`
- `diff`
- `causal`
- `treeDiff`
- `snapshotProjection`
- `collections`
- `operation`
- `snapshot`
- `activeContext`
- `saved`
- `evidence`
- `artifact_hints`

该列表描述 generic result envelope；canonical `browser_observe` 是明确例外。Observe 的公共结果、cache value 与 saved artifact 都直接是 `browser-page-observation/v3` root，不再由 generic middleware 重建 nested observation、generic summary/evidence、第二份 artifact mirror 或重复 correlation/content/templates/actionable records。Inline 预算压缩只折叠同一 v3 schema 中的可选 plane，并通过 `frontier` 指向完整 saved root，不产生另一种 compact observation schema。

大结果会保存 artifact，并在输出中给出读取方式。`artifact_hints` 是 compact descriptor：包含 `kind`、`schemaVersion`、可用 `jsonPaths`、`preferredReads` 和可选 `saved` descriptor，只指向实际存在的 summary / primary items / body-text / provider-specific / saved artifact 路径，不复制大型 artifact 内容；既有 `PageObservation.artifact_hints.jsonPaths` 与 `preferredReads` 继续兼容。`resultMiddleware.ts` 只允许最终 persisted layout 中经验证的 preferred read 进入 `nextActions`，不会再从 operation/snapshot/request/wait/listener correlation ID 合成猜测路径；最终 envelope 覆写 artifact 后会重新收敛 descriptor，使响应、内嵌 envelope 与磁盘真实 UTF-16 chars / UTF-8 bytes 一致。Canonical CLI `browser-pilot artifact inspect` 用于读取 artifact metadata、compact summary、preferredReads 和 path descriptions；`artifact paths` 用于先列出实际可用 JSON path，再通过 `artifact json` / `--pick` 精读。文档、CLI help 和 recovery guidance 不应推荐猜测的 JSON path 或固定样例 artifact 文件；应引用上一个工具返回的 `saved.path`，并通过 inspect/paths 验证路径存在。

Observation/distillation cost 的唯一纯 owner 是 [`src/kernels/evidence/cost.ts`](src/kernels/evidence/cost.ts)，shape 固定为 `{chars,bytes,estimatedTokens}`。Stable JSON chars、UTF-8 bytes 与 estimated tokens 由同一函数计算；fact allocation 以 tokens 为主、bytes 为 tie-break，公开 `maxChars` 仍是硬上限。PageObservation renderer 与 artifact descriptor 使用固定点拟合，最终 `limits.cost` 必须逐项等于实际 serialized root，不能留下写入前的 estimate。

CLI JSON enrichment 把实际 artifact path 仅保存在 `artifacts[].path`；`readCommands` 是 bounded placeholder template descriptor，固定给出 inspect、paths 和至多一个 verified targeted-read 模板，并用 `pathRef` / `jsonPathRef` 解析结构化字段。可读 `command` / `argvTemplate` 不插入实际 path、JSON path 或 snapshot ID，避免 shell 展开与重复长路径造成的 token 膨胀。TTY 对直接 `browser-operation/v2` 至少显示 command/status、classification、completion verification、operation ID、dispatch ACK、completion source、continuation 与 saved path。

Envelope budget 的最后一级仍是严格预算，不是“尽量压缩”：[`ladder.ts`](src/kernels/evidence/distill/ladder.ts) 的 extreme fallback 会保留 canonical `PageObservation` marker、可操作 error、compact `saved` descriptor 与至多一个必要续行，再删除重复 artifact diagnostics/privacy 和低密度结构面。最终 artifact 固定点更新只回填原 envelope 已保留的 hints，并使用 compact descriptor，不能把已经拟合到预算内的响应重新膨胀。

`nextActions` 与 `artifact_hints` 分工明确：前者只表达当前事实要求的恢复/续行 frontier，后者描述可选的渐进展开入口。结果层不会因为 artifact 恰好存在就把多个读取动作重复塞进 `nextActions`，也不会从排序第一的 entity 猜测不存在于公共面上的 `read(ref)` / `click(ref)` / `inspect(ref)` / `frame(ref)` 伪工具。Agent 应从 canonical observation 的 task entry points 自己选择目标，再通过 `browser_execute` 或 `browser_command` 执行动作。

### 7.5 关键工具说明

#### `browser_observe`

用于读取当前浏览器状态的 canonical ABML `browser-page-observation/v3` 页面模型。正常 agent 工作流应省略 `mode`，只传目标、deadline/output budget、增量边界（如 `tabId`、`targetRef`、`url`、`fresh`、`diff`、`baseline*`、`actionRef`）或显式可选 add-on（如 `content:"readability"` / `readability:true` / `axe:true`）。返回值本身就是唯一 v3 root：`target`、`snapshot`、gist/outline、entities、compact ref-based `actionables`、relations/identity/inference、diff/causal/treeDiff、snapshotProjection、compact collections、`providers`、`frontier`、diagnostics、exact `limits.cost`、saved/artifact hints 与 next actions；不再嵌套或镜像 generic summary/evidence。`diff:true` 的自动 baseline 只会从相同 `browserSessionId`、effective tab、target generation 与 page epoch 的最近 scan snapshot 中选择，避免跨页面身份复用 snapshot。Browser Pilot 不持久化或自动注入跨调用知识；需要复用的任务上下文由调用方显式携带。

Provider scheduling 的纯 owner 是 [`observeProviderPlan.ts`](src/kernels/abml/observeProviderPlan.ts)。Plan 在 optional I/O 前按 mode、baseline/cache、requested add-ons、deadline、output budget 与已知 recorder state 决定执行面：core scan/structure 不可被 optional provider 耗尽；render/persist 保留总 deadline 的 10% 且至少 500ms；剩余预算固定按 causal:axe:readability = 2:1:1；单项不足 500ms 时确定性 `skipped/budget-preflight`。普通无 baseline/add-on 的 full observe 不探测 network/hook；只有 causal baseline 需要且 high-water 未知时允许一次 bounded batch status probe。依赖满足后 optional providers 并行、各自 deadline、fail-open。公共 root 的 `providers` item 固定记录 `planned`、`status`、可选 `reason`、`reservedMs`、`actualMs`、`bridgeRoundTrips` 与 `CostVector`；大型 provider diagnostics 只进入 saved observation 的 diagnostics frontier，不复制进 inline telemetry，也不得改变 actionables/entities/relations/collections。

`frontier.items` 是 template/collection/content/diagnostics 的唯一渐进展开面。Template instance refs 超过 inline sample、collection evidence/item window 被折叠、content 或 diagnostics 未内联时，builder 创建 stable frontier ref；result middleware 只有在 artifact 最终写入后验证 JSON path 存在才保留 `read:{tool:"browser_artifact",mode:"json",pathRef:"saved.path",jsonPath,...}`。验证失败会把 item 改为 `state:"unavailable"` 并写明 `unavailableReason`，不得猜测 index/collection id，也不得为 pagination/virtualized control 自动生成点击、滚动或 replay 建议。

任何显式 `mode` 都是 legacy/debug/projection 兼容入口，并在 summary/details/diagnostics 可见面中标记为非 canonical；这包括显式 `mode=scan`。显式 `mode=content/html/text/tabs` 只能作为正文、可见文本、精确 DOM/HTML evidence 或 tab context/diagnostics 投影来源，不能替代省略 `mode` 的 canonical 页面模型。

可选 accessibility diagnostics 通过 `diagnostics:"axe"`、`diagnostics:"accessibility"`、`debug:"axe"`、`axe:true` 或 `axeDiagnostics:true` 在省略 `mode` 的 canonical observe 路径显式触发。实现位于 [`observe/axeDiagnosticsRunner.ts`](src/commands/observe/axeDiagnosticsRunner.ts)，按需从 `axe-core` 读取浏览器脚本并通过现有 page runtime 注入当前页面，使用自己的 bounded deadline 与最大 sample 数。Inline 只保留 provider execution report 和必要 failure summary；完整 issue/node/html 只随 saved v3 observation 的 diagnostics frontier 保存并经过 redaction。axe issue 不创建、删除或重排 actionables、entities、relations、collections，Browser Pilot 的 scan/ABML actionability、hit-test、editable、visibility 与 AX/DOM fusion 仍是结构和执行权威。

可选 Readability content-plane provider 通过 `content:"readability"` 或 `readability:true` 在省略 `mode` 的 canonical observe 路径显式触发。实现位于 [`observe/readabilityRunner.ts`](src/commands/observe/readabilityRunner.ts)，按需从 `@mozilla/readability` 读取浏览器脚本并通过现有 page runtime 在 DOM clone 上运行，使用自己的 bounded deadline、`maxElemsToParse` 与 content 字符上限。Inline 只保留 provider report 和必要 digest/failure；完整 article/content 属于 saved v3 diagnostics/content frontier。Readability HTML 会移除 script/style/noscript/template 等不安全片段并经过 redaction；它不创建、删除或重排 actionables、entities、relations、collections，scan/ABML、AX/DOM fusion、hit-test、editable 与 visibility 仍是结构和执行权威。

关键入口：[`observeCommand.ts`](src/commands/observeCommand.ts)、[`observe/scanRunner.ts`](src/commands/observe/scanRunner.ts)；scan/text/tabs 内部阶段的所有者见 [5.5 Commands 模块表](#55-srccommands)。可选 provider 的独立 runner 位于 [`observe/readabilityRunner.ts`](src/commands/observe/readabilityRunner.ts) 与 [`observe/axeDiagnosticsRunner.ts`](src/commands/observe/axeDiagnosticsRunner.ts)。

#### `browser_execute`

用于在真实 tab 执行 JavaScript，或执行结构化 physical input program。CLI 的 `--script` 对 JavaScript 一视同仁：接受 inline source、`@file` 或 stdin（`-`）。临时 JavaScript 必须只在内存中传递：只有短且 shell-safe 的源码可以 inline，多行、复杂、生成式或引号敏感源码必须经 `--script -` 从 stdin 传入；不得为了执行 transient JavaScript 创建本地临时脚本文件再交给 `--script @file`。`@file` 仅用于原本就存在或用户明确要求保留的持久源码。结构化 program 使用 `--program @file` 读取 JSON array / newline frames。

规则：

- `script` 与 `program` 二选一；
- 不接受 `monitor` 或关闭事务的兼容开关；
- 只接受 JavaScript，不接受 native bridge command；
- 页面动作可以通过 JS 或 CDP physical input program 完成；
- 非幂等 mutation 应携带稳定 `intentId`；同一 daemon process 内，相同 intent + payload 的完成结果直接复用，不确定 intent 禁止再次 dispatch，不同 payload 明确冲突；
- physical program 会聚合成功与失败 frame 的 ACK，并在 expand 后重新验证真实序列。非 navigation/download 动作应以唯一且最终的 `{eval:"...",verify:true}` 后置条件结束；只接受 `true` 或 `{verified:true}` 作为 `completed/program-verified` 证明；
- observers 在动作 dispatch 前 arm；JavaScript 非 `undefined` resolve 产生 `completed/script-resolved`，无返回且无效果产生 `no_effect`；
- 同 target 的 active write 先串行；ACK 后未验证的任意 write 会阻止 execute/native 后续 mutation，直到结算后开始的 fresh、same-page canonical no-mode observe 建立只读边界；同一 `intentId` 仍保持去重；
- 所有终态经统一 operation result owner 做预算检查；大返回保留 `completion.source` 机械证明，完整 `completion.evidence.result` 保存到 artifact，inline 只保留 type/count/keys/preview 或最小 pointer；
- `continuation` 是下一次决策提示而不是业务成功证明；页面状态才重新观察，target 变化先重获，非页面状态做只读验证，只有存在 diagnostics 才检查 diagnostics，任何情况都不能盲重放 mutation；
- 没有独立的 click/type 工具。

关键文件：[`executeCommand.ts`](src/commands/executeCommand.ts)。

#### `browser_command`

底层 native bridge command escape hatch。它发送 `{ cmd, ... }` 对象到 extension，但仍经过 schema 校验和安全拒绝逻辑。CLI `--command` 只接受内联 JSON，不支持也不推荐 `--command @file`；大段结构化交互使用 `browser_execute --program @file`。临时 JavaScript 必须以内存方式传给 `browser-pilot execute --script -`，不得为此创建临时脚本文件；只有持久源码才使用 `browser-pilot execute --script @file`。

关键文件：[`nativeCommand.ts`](src/commands/nativeCommand.ts)。

#### `browser_network` / `browser_hook` / `browser_frame`

这几类工具共享 `defineNativeActionCommand()` 注册模式，将高层 `action` 映射到底层 native command。read action 立即返回；write action 经 `withBrowserOperation()` 返回统一终态。公开 `browser_wait`/CLI `wait` 已删除，selector/navigation/network-idle 实现只作为 internal supervisor primitive，不能通过 `browser_command` 访问。

Raw `browser_network action=captureReload` / canonical CLI `browser-pilot network capture-reload` 是 page-load network flow 的推荐入口：command 层会在同一 batch 中先执行 `network.start`，再 reload/navigation，随后沿内部 bounded condition/list/export 路径返回 transaction outcome 和 artifact evidence。不要把面向 agent 的文档写成手动 `network start` 后再 reload/sleep/list 的流程，因为该流程容易漏掉早期请求；低层 `start/list/stop/exportHar` 保留给需要持续 recorder 控制的场景，其中 start 只在 recorder armed 后完成，stop 只在停止并 flush 后完成。captureReload 结果和相关 bridge responses 可包含 bounded `diagnostics.latency` / temporal telemetry，字段限于 elapsed/deadline/ack/queue/runtime/serialize 等操作性 timing 与计数，不包含 command payload、headers、body、postData、cookies 或 URL query。读取 capture artifact 时先用 canonical CLI `browser-pilot artifact inspect` / `artifact paths` 检查实际 path，再通过 `artifact json` 读取存在的 JSON path。

```text
# browser-pilot-executable
browser-pilot network capture-reload --session-id <session-id> --target-ref <targetRef> --json
```

关键文件：[`nativeActionCommands.ts`](src/commands/nativeActionCommands.ts)。

#### Web Security tools

Web Security 工具位于 [`src/commands/webSecurity`](src/commands/webSecurity)，分为：

- `commands/`：工具注册；
- `browserNative/`：内建 crawl/fuzz/sqli/template/oast/cookie/replay 实现；
- `bridges/`：sqlmap、nuclei 外部工具桥；
- `shared/`：HTTP、HAR、request template、artifact、diagnostics；
- `wordlists/`：SQLi payloads。

---

## 8. Bridge、Daemon 与 Extension 协议链路

### 8.1 Daemon 是浏览器会话 owner

CLI 调用通常是短生命周期的。Daemon 长驻并持有 browser session，这样：

- CLI 退出不会断开浏览器连接；
- extension 连接状态可复用；
- 多项目共享用户本地 daemon；
- 每次 `/invoke` 携带 `cwd`，用于 artifacts/evidence 的请求级作用域。
- pairing `pairingId` 作为 operation owner 传播；没有 pairing 的本地 CLI 使用稳定 `local-cli` owner，late effects 只能被相同 owner + browser session 的下一次相关 operation 消费。
- `/invoke` 对 write command 保持到 terminal outcome，不在 transport ACK 后提前返回。

Daemon 的 `SessionOperationRegistry` 是 process-local operation ledger：普通 operation 最多 256 项，每项最多 200 条 compact/redacted sequenced events，普通 active/terminal TTL 为 5 分钟。`finish()` 把 active 标记为 terminal 而不删除；terminal 后 30 秒内的事件追加为 `late_effect`，不覆盖原终态，surfaced 后不重复消费。Mutation evidence 走更保守的保留规则：active mutation、intent tombstone、未观察 barrier 不参与普通 TTL/256 项淘汰；bridge stop 将 active mutation 转成需 observe 的 ambiguous terminal 并保留证据。Protected mutation evidence 最多 4096 项，满时新 intent write fail closed；新 daemon process 才是清空边界。

Daemon reuse 不是 display version 比较。0.4.0 使用 daemon protocol 5 与 command contract 3。[`contractIdentity.ts`](src/apps/daemon/contractIdentity.ts) 对 compact catalog/schema v3、全部 action-specific schemas、`browser-page-observation/v3`、`browser-page-scan/v1`、`browser-operation/v2` outcome mapping 与 native protocol 做 stable key-sorted canonical JSON + SHA-256，形成 `{packageVersion,daemonProtocolVersion,commandContractVersion:3,commandContractHash,toolCount}`。Lock metadata 与 live `/status` 都携带完整 identity；两者和 local identity 全字段一致才可复用。Mismatch 的 managed daemon 进入 drain/graceful shutdown 后才启动 replacement；grace 内无法证明替换成功时返回 `DAEMON_REPLACEMENT_FAILED`，旧 daemon 不接收 invoke。`status` / `doctor` 同时投影 local/daemon/lock identity 与 structured check；普通查询 exit 0，`--check` mismatch exit 1。

### 8.2 Bridge Server 组合关系

`BrowserBridgeServer` 聚合：

```text
BrowserBridgeClientRegistry
BrowserBridgeSessionState
BrowserCommandQueueRegistry
BrowserTabSessionRouter
BrowserBridgePendingRequests
BrowserBridgeCommandService
BrowserBridgeClientMessageService
BrowserBridgeClientHeartbeat
BrowserBridgeHttpServer
```

### 8.3 Extension 连接握手

Extension offscreen transport 会扫描本地端口范围 `18765-18784`。连接成功后 service worker 发送 `ext_ready`，携带：

- bridge info；
- extension instance id；
- `captureContractVersion:1`；
- consent capability；
- 当前 scriptable tabs。

Bridge Server 收到 `ext_ready` 或 `tabs_update` 后更新 client info 和 tabs router。
首个 ready client 初始化默认 browser selection；后续其他 client 的普通 `tabs_update` 不得抢占显式选择，只有同一 extension instance 的 reconnect 可以接替其旧 socket。Public `browserId` 由 `extensionInstanceId` 的 SHA-256 前缀生成，不再使用每个 WebSocket 的随机 id。Extension 为每个 Chrome tab 在 `chrome.storage.session` 保存随机 logical identity，所有 `ext_ready` / `tabs_update` / `tabs.list` payload 都携带 `tabIdentity`；`tabs.onReplaced` 把 identity 从 removed tab 迁到 added tab，真实 tab close 删除它。Daemon 用 stable browser id + `tabIdentity` 派生 `tabHandle`，因此同一 browser runtime 内 daemon replacement、MV3 worker restart、offscreen/socket reconnect 与 in-place tab replacement 都保持原 `targetRef`；browser runtime 重启或 tab close 是明确失效边界。带 `targetRef` 的内部 operation arm/finish 与实际命令始终使用该 tab session 的 owning client，不能回退到 default client。

Extension 同时维护 real page epoch。Top-level `webNavigation.onCommitted` mint 新 epoch；同 document 的 history/hash update 只更新 URL fact；BFCache 仅在当前 worker 能证明 `documentId` lineage 时复用 epoch；tab replacement、worker restart 或无法证明 lineage 时 mint 新 epoch。Bridge 将它与 `browserSessionId`、numeric `tabId` 和 target generation 组合为 [`PageIdentity`](src/kernels/session/pageIdentity.ts)。URL 与可选 `documentId` 不参与 equality。

Observation snapshot、auto/explicit baseline、session delta、perception ledger 和 render cache 全部按 `browserSessionId + tabId + targetGeneration + pageEpoch` 隔离。Identity mismatch 不返回错误 delta，而是丢弃 baseline、运行 full observation，并用 `document_changed`、`target_replaced`、`session_changed`、`identity_unproven` 或 `baseline_missing` 之一作为简短 `reanchorReason`。

OperationCoordinator 通过 offscreen transport 发送独立 `operation_event` message；每个 operation 在 `operation.begin` 成功后绑定到实际接收 begin 的 WebSocket，避免重连期间多个 offscreen socket 把 completion evidence 发给 stale daemon。`BrowserBridgeClientMessageService` 不把事件当 pending request result，而是按稳定 `operationId` 追加到账本。Registry 的 begin/update/event/finish/abort/clear 都推进单调 revision 并释放 one-shot waiters；settlement 只等待 revision change 或纯 liveness kernel 给出的下一 no-effect/stalled/deadline 边界，不允许 interval、固定 25ms timeout 或 registry polling fallback。Prerender2 若保留 numeric tab id，content script 在真实 `prerenderingchange`/`activationStart` 后上报 same-tab replacement，router 只递增一次 target generation；仍会发原生 `tabs.onReplaced` 的浏览器继续走 numeric replacement chain。未 ACK 的确定 target removal/detach 可终止为 `target_lost`/`failed`；physical/native dispatch 已 ACK 后若 result 或 observer 因非 durable reconnect/worker restart 丢失，则必须保留 ACK 并终止为 `ambiguous`，不得静默重放 mutating action。

Observe 在任何 page I/O 前检查 extension capture contract；版本不匹配返回 `EXTENSION_CONTRACT_MISMATCH` 与 reload recovery。页面 capture 只能返回 [`PageWorldScanBundleV1`](src/kernels/abml/pageWorldScan.ts) 的 `browser-page-scan/v1` camelCase wire shape（`page/content/structure/frames/signals/stats`）。Bridge boundary 对 schema、exact keys、nested scalar/array/object types 做严格 runtime validation，malformed/unknown/legacy bundle 返回 `SCAN_BUNDLE_INVALID`，不能通过 untyped record cast 继续执行。

### 8.4 Native protocol

Native command schema 源头是 [`src/bridge/protocol/native-command.schema.json`](src/bridge/protocol/native-command.schema.json)。同步脚本 [`scripts/sync-native-protocol.mjs`](scripts/sync-native-protocol.mjs) 会生成：

- [`src/bridge/extension/service_worker/protocol.ts`](src/bridge/extension/service_worker/protocol.ts)
- [`src/types/nativeProtocol.ts`](src/types/nativeProtocol.ts)
- [`src/commands/nativeActionMetadata.ts`](src/commands/nativeActionMetadata.ts)
- [`src/types/nativeErrorCodes.ts`](src/types/nativeErrorCodes.ts)

协议 schema 是源头，生成文件不应随意手改。

`operation.begin`、`operation.finish`、`operation.cancel` 以及既有 `wait.*` primitives 都标记为 `internal:true`，不注册 public tool，也不能通过 public `browser_command` 调用。`operation.begin` 只有在 listener/baseline/MutationObserver arm 完成后才返回；`operation.finish` 进入 30 秒 passive window；`operation.cancel` 立即清理 listeners/observer/timer。

---

## 9. Kernel、Runtime、Capture 与 Native 边界

### 9.1 Kernel 纯边界

`src/kernels/*`，尤其是 `src/kernels/abml/*`，必须保持纯逻辑。`src/kernels/session/*` 是唯一允许直接使用 `node:crypto` 的 kernel 子目录，仅限 `randomUUID`/`randomBytes` 生成 session/lease/operation/snapshot ID 或 salt，以及 `createHash` 生成不可逆诊断哈希；不得扩展到文件、进程、网络、browser、commands、bridge 或 runtime 依赖。

通用 kernel 边界：

- 不做 browser I/O;
- 不调用 CDP;
- 不读写文件;
- 不 spawn 进程;
- 不依赖 Node-only API，除上述 `src/kernels/session/*` 的 `node:crypto` 例外;
- 不依赖 commands、bridge、browser-runtime;
- 不写 per-site/per-framework 分支。

依赖方向只能是：

```text
browser-runtime ──imports──▶ kernels
```

### 9.2 ABML

ABML 是 Browser Pilot 的 agent-native 页面统一建模层，把面向人类的浏览器页面编译为可行动、可引用、可增量比较的结构化事实。`browser_observe` 省略 `mode` 时返回唯一的 `browser-page-observation/v3` root；ABML/scan 负责 entities、compact actionable refs、relations、collections 与 actionability 权威，content/diagnostics 通过同一 root 的 verified frontier 渐进展开。精确业务值或大段内容应通过 `browser_execute` 或 returned `saved.path` 上的 `browser_artifact` 定向读取。Provider truth 位于 root `providers`，统一表达 planned/executed/skipped/failed/degraded、reason、deadline reserve、actual time、bridge round trips 与 cost；它不复制大型 diagnostics，也不改变 structural authority。ABML 的 design reference oracle 以 Playwright、Testing Library、browser-use 与 Stagehand 的可借鉴点作为 repository-local guardrails，而不是 runtime dependency 或替代 API：query priority 以面向用户的 role/name/label/textAnchor 为稳定语义锚，过滤 selector-like、framework/generated class、long preview、SVG/path、HTML-like 噪声；locator/ref stability 保护 concise user-facing semantics，避免运行时 CSS、backendNodeId 或点位变化污染可复用 ref；auto-wait 只作为 action target 应接近执行时解析并防 stale ref 的设计参考，不给 observe 增加隐式等待；observe/action/extract 分层只强化边界，动作仍走 `browser_execute`/`browser_command`。AX fusion 保留 DOM scan 的执行 ref 与 actionability，full AX 做页面级语义/状态/层级和 AX-only 结构补强，partial AX 只在已有可靠 backendNodeId 的局部 refinement 中尝试；无法安全匹配或清洗的信息必须降级并进入 diagnostics。

ABML 负责：

- entity extraction；
- DOM ↔ AX merge；
- semantic refs；
- diff / treeDiff；
- relations；
- causal；
- collection completeness；
- actionability model；
- read/pierce/frame verb 决策。

重要文件：

- [`src/kernels/abml/entity.ts`](src/kernels/abml/entity.ts)
- [`src/kernels/abml/ax.ts`](src/kernels/abml/ax.ts)
- [`src/kernels/abml/diff.ts`](src/kernels/abml/diff.ts)
- [`src/kernels/abml/treeDiff.ts`](src/kernels/abml/treeDiff.ts)
- [`src/kernels/abml/relations.ts`](src/kernels/abml/relations.ts)
- [`src/kernels/abml/collections.ts`](src/kernels/abml/collections.ts)
- [`src/kernels/abml/causal.ts`](src/kernels/abml/causal.ts)
- [`src/kernels/abml/pageObservation.ts`](src/kernels/abml/pageObservation.ts)
- [`src/kernels/abml/pageWorldScan.ts`](src/kernels/abml/pageWorldScan.ts)
- [`src/kernels/abml/observeProviderPlan.ts`](src/kernels/abml/observeProviderPlan.ts)
- [`src/kernels/evidence/cost.ts`](src/kernels/evidence/cost.ts)
- [`src/kernels/abml/verbs/router.ts`](src/kernels/abml/verbs/router.ts)

### 9.3 Runtime

Runtime 层可以做浏览器 I/O，并将采集结果输入 kernel。典型职责：

- `sendCommand`；
- CDP `Accessibility.getFullAXTree` / `DOMSnapshot.captureSnapshot` for canonical page-wide AX fusion；
- CDP `Accessibility.getPartialAXTree` for scoped local read/pierce refinement when a reliable `backendNodeId` is already available；
- bounded `DOM.getBoxModel` geometry fallback；
- scan/content/vision script 执行；
- full AX/DOM fusion diagnostics、partial AX diagnostics、degraded/skipped 计数与 provider 状态汇总；
- screenshot；
- resource ref 注册；
- artifact 保存；
- 调用 kernel 纯函数。

### 9.4 Capture templates

`capture-src/entries/*.ts` 是页面世界脚本模板源。它们通过 `src/capture/inject.ts` 渲染成可执行脚本后注入浏览器页面。

模板不是 kernel，也不是 bridge。它只负责页面上下文中的数据采集。

Scan template 的 wire owner 是 [`pageWorldScan.ts`](src/kernels/abml/pageWorldScan.ts)。Template 直接产出 `browser-page-scan/v1`：page metadata、content text/tree/headings/interactive、structure actionables/rows/listHints/canvasRegions/mediaCandidates、frame notes、fingerprint/growth probe 与 stats 全部使用 typed camelCase fields。Capture summarizer、ABML prefetched scan、artifact projection 与 fingerprint owner 直接消费该类型，不维护旧 key 映射。

Scan 命名与 role mapping 链路由 `src/scan/buildScanScript.ts` 负责组装：构建阶段把 `dom-accessibility-api` 打包产物注入页面世界，`capture-src/entries/scanTemplate.ts` 中的 `computedAccessibleName()` 优先调用 `computeAccessibleName()`，再回退到 `aria-label`/`title`/`alt`/`placeholder`、HTML label、可见文本、pseudo text 和 hit-target 借名等本地启发式。`roleOf(el)` 的顺序是 safe explicit `role`、provider implicit role、Browser Pilot fallback；首个 provider 复用已注入的 `BrowserPilotDomAccessibilityApi.getRole(el)`，并过滤 `generic`、`presentation`、`none` 等低价值结果。role 只补强 `actionables`、reference targets、control relations 与 scan summary 的语义，不自动扩大 clickable/editable/actionability；是否可执行仍由 Browser Pilot 的 visibility、hit-test、handler、tag 与 control 逻辑决定。命名与 role 结果随后由 ABML entity/relations/collections 纯逻辑消费；kernel 层不得直接依赖 `dom-accessibility-api`、`aria-query` 或页面 DOM。

### 9.5 Native kernels

Native kernels 是优化，不是正确性唯一来源。

```text
src/native/browserPilotNativeKernels.ts
  │ spawnSync stdin/stdout JSON
  ▼
native/browser-pilot-kernels binary
```

可用环境变量：

| 环境变量 | 作用 |
|---|---|
| `BROWSER_PILOT_NATIVE_KERNELS=0` | 禁用 native kernels。 |
| `BROWSER_PILOT_NATIVE_KERNELS_DISABLE=1` | 禁用 native kernels。 |
| `BROWSER_PILOT_NATIVE_KERNELS_DEBUG=1` | 打印 native debug 日志。 |
| `BROWSER_PILOT_NATIVE_KERNELS_BIN` | 指定 native binary 路径。 |

---

## 10. 依赖关系与架构边界

### 10.1 允许的主依赖方向

```text
apps/cli ──▶ apps/daemon control client
apps/daemon ──▶ bridge/server + commands
commands ──▶ bridge runtime port + browser-runtime + kernels + artifacts/resources
browser-runtime ──▶ kernels + ports/resources/scan/content/capture
bridge/server ──▶ kernels/session + extension protocol types
bridge/extension ──▶ Chrome APIs + generated protocol
kernels ──▶ kernels 内部纯模块
```

### 10.2 禁止或高风险依赖

- `src/kernels/*` 不应导入 `src/commands/*`、`src/bridge/*`、`src/browser-runtime/*`。
- `dom-accessibility-api` 是 scan/capture 命名与 role provider 链路的运行时依赖，只能通过 `src/scan/domAccessibilityApiBundle.ts` 注入页面世界供 scan template 使用；不要把它引入 ABML kernels 或 extension/bridge 公共协议。
- `axe-core` 是 `browser_observe` accessibility diagnostics 的运行时依赖，只能作为显式 diagnostics-only add-on 经 `src/commands/observe/axeDiagnosticsRunner.ts` 按需读取并注入页面运行；不要把它引入 ABML kernels、extension service worker 常驻 bundle、command catalog 或 bridge/native 公共协议。默认 no-mode observe 不运行 axe，axe 输出只进入 provider diagnostics 与 artifact，不改变结构模型或 actionability。
- `@mozilla/readability` 是 `browser_observe` content plane 的运行时依赖，只能作为显式 Readability add-on 经 `src/commands/observe/readabilityRunner.ts` 按需读取并注入页面运行；不要把它引入 ABML kernels、extension service worker 常驻 bundle、command catalog 或 bridge/native 公共协议。默认 no-mode observe 不运行 Readability，Readability 输出只进入 provider diagnostics、content artifact hints 与 saved artifact 的 `readability` 节点，不改变结构模型或 actionability。
- `bridge/browser_pilot_bridge/` 和 `dist/` 是生成产物，不手改。
- `src/bridge/protocol/native-command.schema.json` 是 native protocol 源头。
- `commandCatalog.ts` 是 public tool surface 源头。
- 扩展源码 `src/bridge/extension/**` 不由主 `tsconfig.json` 校验，而由 `tsconfig.bridge-src.json` 单独校验。

### 10.3 高风险区域

修改以下目录需要额外谨慎：

- [`src/bridge/server`](src/bridge/server)
- [`src/apps/daemon`](src/apps/daemon)
- [`src/bridge/extension/service_worker`](src/bridge/extension/service_worker)

### 10.4 产品入口与公共面

以下入口不应作为清理对象随意删除或重命名：

- [`index.ts`](index.ts)
- [`src/apps/cli/bin.ts`](src/apps/cli/bin.ts)
- [`src/apps/cli/main.ts`](src/apps/cli/main.ts)
- [`src/apps/daemon/server.ts`](src/apps/daemon/server.ts)
- [`src/bridge/extension/service-worker.ts`](src/bridge/extension/service-worker.ts)
- [`src/commands/commandCatalog.ts`](src/commands/commandCatalog.ts)
- [`src/commands/webSecurity/browserNative/callbackOastWorker.mjs`](src/commands/webSecurity/browserNative/callbackOastWorker.mjs)

---

## 11. 构建、运行与验证

本节是开发地图中的验证入口摘要。Contributor workflow、gate 规则和完成标准的权威来源是 [`REPO_GOVERNANCE.md`](REPO_GOVERNANCE.md)；具体任务定义以 [`mise.toml`](mise.toml) 和 `scripts/` 实现为准。

### 11.1 推荐门禁

仓库使用 `mise` 作为 canonical gate：

```bash
mise run dev
mise run affected
mise run verify
mise run package-smoke
mise run smoke-browser
mise run dev-governance
```

含义：

| 命令 | 说明 |
|---|---|
| `mise run dev` | 常规本地开发门禁。 |
| `mise run affected` | 基于 changed files 的影响范围验证。 |
| `mise run verify` | 发布/完成前完整验证门禁。 |
| `mise run package-smoke` | 生成唯一 npm tarball，在隔离项目从 `.tgz` 安装并验证 package allowlist/ceilings、ESM/declarations、CLI contract/schema/validate/status、extension/native assets 与 JS fallback。 |
| `mise run smoke-browser` | 使用隔离 profile 启动本机 Chrome/Edge/Chromium 与 unpacked MV3 extension，验证真实握手、operation event settlement、observe/provider/frontier、network/hook、BFCache、Prerender2 replacement、target close/new target 和 reconnect。 |
| `mise run dev-governance` | 修改治理、脚本、workflow、README 等时使用。 |

`mise run verify` 包含：

- reachability audit；
- main TypeScript typecheck；
- tests TypeScript typecheck；
- extension TypeScript typecheck；
- required Rust native release build 与 native/TS parity；
- protocol drift check；
- all tests；
- executed-source coverage gate；
- exact complexity ratchet（复杂度 >20 的函数只能递减，>150 行函数保持为 0）；
- full ESLint；
- build；
- deterministic catalog/observation benchmark；
- `package-smoke` tarball install gate。

`mise run smoke-browser` 是 live-browser acceptance gate，不使用 mock Chrome API，也不允许 skip 生命周期断言。它先通过 [`scripts/build-bridge.mjs`](scripts/build-bridge.mjs) 重建 unpacked extension，再由 [`scripts/run-browser-smoke.mjs`](scripts/run-browser-smoke.mjs) 启动隔离浏览器 profile 和 in-process daemon/bridge。Fixture 以 event-driven HTTP gates 真实触发 completion event、BFCache back/forward 与 prerender activation；frontier read 必须通过 public `browser_artifact` 定点读取；末段会替换整个 in-process daemon，并用替换前的 `targetRef` 重新 observe 同一真实 tab。可通过 `BROWSER_PILOT_SMOKE_BROWSER` 指定非标准安装路径；bridge、daemon、extension 或真实浏览器 I/O 行为变化需要同时通过 `mise run verify` 与该 smoke gate。

[`scripts/package-smoke.mjs`](scripts/package-smoke.mjs) 的 hard ceilings 是 compressed 2,250,000 bytes、unpacked 10,500,000 bytes、1,600 files。它拒绝 tests/coverage/local state/env/credentials/absolute path leakage、扩展开发 sourcemap 和 allowlist 外文件；需要保留发布 artifact 时使用内部 `--artifact-dir` 参数，普通 `mise run package-smoke` 始终清理 temp/tarball/daemon/browser state。

### 11.2 低层维护脚本

以下 npm scripts 用于专项维护或底层构建，不是完成门禁。完成、交付或发布判断仍以 `mise` 门禁为准。

```bash
npm run sync:protocol
npm run sync:config
npm run build
npm run build:bridge
npm run build:native
npm run cli
npm run typecheck
npm run typecheck:tests
npm run audit:reachability
npm run audit:complexity
npm run lint
```

说明：

| 命令 | 说明 |
|---|---|
| `npm run build` | clean + `tsc -p tsconfig.build.json`。 |
| `npm run build:bridge` | 打包 MV3 extension 到 `bridge/browser_pilot_bridge/`。 |
| `npm run build:native` | 构建 Rust native kernels。 |
| `npm run cli` | 从源码运行 CLI：`tsx src/apps/cli/bin.ts`。 |
| `npm run typecheck` | 主 TypeScript 校验，不含 extension 源码。 |
| `npm run typecheck:tests` | tests TypeScript 校验，覆盖测试 fixture 与其导入契约。 |
| `npm run audit:complexity` | 核对复杂度与函数长度精确递减预算。 |
| `npm run lint` | reachability audit + complexity ratchet + ESLint。 |

### 11.3 从源码运行 CLI

```bash
npx tsx src/apps/cli/bin.ts --help
npx tsx src/apps/cli/bin.ts commands
npx tsx src/apps/cli/bin.ts connect
npx tsx src/apps/cli/bin.ts status
```

或使用 npm script：

```bash
npm run cli -- --help
npm run cli -- commands
```

### 11.4 Windows/global CLI package layout

npm package 的 `bin.browser-pilot` 固定指向 `./dist/src/apps/cli/bin.js`。Windows 全局安装会生成 `.cmd` / PowerShell shim 并执行这个 built entry，因此 package/global 布局必须同时包含 `dist/src/apps/cli/bin.js`、相邻的 `help.js` 与 `main.js`；top-level `browser-pilot --help` 会先动态导入 `help.js`，再按需导入 `main.js`。构建/打包逻辑需要保证删除 `dist/` 后不会被 stale incremental build info 误判为 up-to-date。若源码 checkout 未构建或 package 安装缺少 built files，CLI entry 会输出明确 recovery：源码 checkout 运行 `npm run build`，global/package install 重新安装，使 `dist/src/apps/cli/bin.js` 及相邻文件恢复。

### 11.5 扩展构建

扩展打包入口是 [`scripts/build-bridge.mjs`](scripts/build-bridge.mjs)，输出到 `bridge/browser_pilot_bridge/`。

打包入口包括：

- `src/bridge/extension/service-worker.ts`
- `src/bridge/extension/page_scripts/content.ts`
- `src/bridge/extension/offscreen/transport.ts`
- `src/bridge/extension/page_scripts/hook_dispatcher.ts`
- `src/bridge/extension/page_scripts/disable_dialogs.ts`

---

## 12. 配置、产物与状态目录

### 12.1 Bridge 端口

默认 bridge host/port：

- host：`127.0.0.1`
- port：`18765`
- port range end：`18784`
- WebSocket 单消息上限：`33554432` bytes（32 MiB）

配置位置：[`src/bridge/server/browserBridgeConfig.ts`](src/bridge/server/browserBridgeConfig.ts)、[`bridge/browser_bridge_config.json`](bridge/browser_bridge_config.json)。

WebSocket 单消息上限可通过 `BROWSER_PILOT_BRIDGE_MAX_PAYLOAD_BYTES` 覆盖；健康端点的 `maxPayloadBytes` 返回实际生效值。该上限约束单连接内存占用，超限消息以 WebSocket code `1009` 关闭。

### 12.2 Daemon 状态目录

Daemon 默认状态目录：

```text
~/.browser-pilot
```

可通过环境变量覆盖：

```text
BROWSER_PILOT_DAEMON_STATE_DIR
```

状态目录中存放 daemon lockfile、token、pairing/lease 相关状态。

### 12.3 Artifact 与 Resource

Artifact 与 resource 以每次 `/invoke` 携带的 `cwd` 作为请求级作用域。相关模块：

- [`src/artifacts`](src/artifacts)
- [`src/resources`](src/resources)

单 artifact 结构化读取上限由 [`artifactReaderShared.ts`](src/artifacts/artifactReaderShared.ts) 的 `MAX_ARTIFACT_READ_BYTES` 统一为 `41943040` bytes（40 MiB），高于默认 32 MiB WebSocket frame，为 operation envelope 留出余量。`browserOperationResult.ts` 在落盘前按最终 UTF-8 bytes 使用同一 ceiling 预检；超限走 fail-open，不写入或发布一个 `browser_artifact` 无法 inspect/paths/json 的假 continuation。

### 12.4 TypeScript 配置边界

| 文件 | 说明 |
|---|---|
| [`tsconfig.base.json`](tsconfig.base.json) | 公共 TypeScript 配置。 |
| [`tsconfig.json`](tsconfig.json) | 主项目 typecheck，排除 extension 源码。 |
| [`tsconfig.bridge-src.json`](tsconfig.bridge-src.json) | extension 源码 typecheck。 |
| [`tsconfig.tests.json`](tsconfig.tests.json) | tests typecheck，并解析测试导入的 Node/extension 契约。 |
| [`tsconfig.build.json`](tsconfig.build.json) | build 输出配置。 |

---

## 13. 测试体系

测试使用 Node built-in test runner + `tsx`，脚本位于 [`scripts/run-tests.mjs`](scripts/run-tests.mjs)。覆盖率验证使用 Node 22 test runner 内置 V8 coverage，脚本位于 [`scripts/run-coverage.mjs`](scripts/run-coverage.mjs)，会生成报告与 `coverage/` 下的 V8 JSON。门禁针对测试实际加载的可编辑源码，排除 schema 生成文件，要求至少 90% 的可编辑 `src/**/*.ts` 模块进入 V8 数据，并要求汇总行覆盖率不低于 70%、分支不低于 65%、函数不低于 60%。这不是未加载模块也计为 0 的全仓库静态覆盖率；模块加载比例单独防止通过缩小执行面获得虚高数字。`mise run coverage` 可专项执行，`mise run verify` 也会执行同一门禁。

测试分组：

| Scope | 目录 |
|---|---|
| `all` | `bootstrap`、`cli`、`artifacts`、`web-security`、`observe`、`governance` |
| `cli` | `bootstrap`、`cli` |
| `artifacts` | `bootstrap`、`artifacts` |
| `web-security` | `bootstrap`、`web-security` |
| `observe` | `bootstrap`、`observe` |
| `governance` | `bootstrap`、`governance` |

运行示例：

```bash
node scripts/run-tests.mjs all
node scripts/run-tests.mjs cli
node scripts/run-tests.mjs observe
node --import tsx --test tests/bootstrap/smoke.test.ts
mise run coverage
mise run smoke-browser
node scripts/run-coverage.mjs all
```

Observe regression benchmark 位于 [`tests/observe/observeRegressionBenchmark.test.ts`](tests/observe/observeRegressionBenchmark.test.ts)，随 `observe`/`all` scope 运行。Immutable baseline [`observe-v2-baseline-1573380.json`](tests/fixtures/observe-v2-baseline-1573380.json) 由 [`update-observe-benchmark-baseline.mjs`](scripts/update-observe-benchmark-baseline.mjs) 从 Git object `1573380` 的 archive 中执行旧 owner 得到，只有显式 `mise run update-observe-benchmark` 才能改写。Gate 同时要求 catalog ≤25 KiB；observation bytes 与 estimated tokens 的中位数各下降至少 25%；任一 fixture ≤旧值 105%；final cost 与 serialization 完全一致；required facts/actionable refs/relations/collection properties recall 100%；forbidden pollution/sensitive leakage/duplicate ownership/silent truncation 为 0；所有 folded/truncated block 有 verified read 或 unavailable reason。新增 case 继续使用离线 fixture 与纯逻辑路径；真实浏览器生命周期由独立 smoke gate 负责。

Operation progressive-disclosure 与 at-most-once regression 位于 [`tests/cli/commandExecution.test.ts`](tests/cli/commandExecution.test.ts) 及 bootstrap operation/program suites：它们保护小结果不多绕 artifact、大结果在严格字符预算内仍保留根终态和 completion source、完整 result 可由 returned path/jsonPath 读取、artifact 写失败不覆盖已完成终态、script business postcondition、ACK-error frame、expand 后 verifier ordering、动态 physical classification、active/cross-command barrier、same-page observe 时序、intent payload conflict、TTL/capacity/bridge reset retention、caller disconnect cancellation、queued write 不补发、program delay 中止，以及 worker restart instance isolation。Tab/session regression 另外保护 stable extension-derived `browserId`、extension-owned `tabIdentity` persistence/replacement transfer，以及新 daemon router 直接复用旧 `targetRef`。真实浏览器 smoke 使用只接受 trusted event 的 toggle，并验证异步 DOM business postcondition、transport timeout 后后续 program mutation frame 不执行、completed intent 复用、“物理效果已发生但 verifier 未证明”时同 intent 在 observe 前后都不能再次 dispatch，以及 daemon replacement 后旧 targetRef 仍能 observe。Governance test 枚举 `src/commands` 的 `withBrowserOperation()` 调用点，要求全部使用统一 `browserOperationCommandResult()` owner。

可信契约回归另外由以下 suites 持有：[`tests/cli/operationResultV2.test.ts`](tests/cli/operationResultV2.test.ts) 覆盖 8 个 terminal status 的 JSON/TTY/classification/code/exit/continuation matrix 以及 unknown/malformed schema；[`tests/cli/validationParity.test.ts`](tests/cli/validationParity.test.ts) 使用不少于 50 个 valid/invalid corpus 保护 shared normalized args 与 issue shape；daemon lifecycle/identity tests 保护 canonical hash determinism、全字段 mismatch 与 replacement failure；[`tests/bootstrap/pageIdentity.test.ts`](tests/bootstrap/pageIdentity.test.ts) 及 observe/router tests 保护 document commit、SPA、BFCache、replacement、reconnect 和错误 baseline 零复用。

常规 CI 位于 [`.github/workflows/verify.yml`](.github/workflows/verify.yml)：Ubuntu 与 Windows 运行相同 `verify` 门禁，另有 Windows real-browser job 使用系统 Edge/Chrome 执行 MV3 smoke。核心步骤是：

```bash
npm ci
mise run verify
mise run smoke-browser
```

Tag release 位于 [`.github/workflows/release.yml`](.github/workflows/release.yml)，只响应 `v*`。`tag-check` 首先要求 ref 精确等于 `v${package.json.version}`；Ubuntu/Windows 都执行 verify 与 tarball smoke，Windows 额外执行完整 browser smoke。Ubuntu package job 只通过 package smoke 保留一个 `.tgz` 与 SHA-256 JSON；publish job 下载并用 [`verify-release-artifact.mjs`](scripts/verify-release-artifact.mjs) 复核 tag/version/filename/singleton/hash/size，然后用 pinned npm 11 执行 `npm publish <verified.tgz> --access public --provenance`。Publish 不 checkout-import tarball、不重新 pack，只授予 `contents:read` 与 `id-token:write`，不配置长期 npm token。

---

## 14. 维护指南

### 14.1 新增公开工具

推荐流程：

1. 在 `src/commands` 新增或扩展工具定义模块。
2. 使用 `BrowserCommandDefinition` 标准结构。
3. 使用 TypeBox schema 和 `strictCommandParameters()`。
4. 接入 `jsonCommandResult()` 或 `textCommandResult()`。
5. 如需要摘要，注册 distiller。
6. 在 [`commandCatalog.ts`](src/commands/commandCatalog.ts) 添加 registrar。
7. 添加或更新测试。
8. 运行 `mise run affected`，完成前运行 `mise run verify`。

### 14.2 修改 native protocol

1. 修改 [`src/bridge/protocol/native-command.schema.json`](src/bridge/protocol/native-command.schema.json)。
2. 运行：

```bash
npm run sync:protocol
```

3. 检查生成文件变化。
4. 更新 extension/server/commands 对应实现。
5. 运行完整验证。

### 14.3 修改 ABML / Kernel

应保持纯逻辑边界：

- 新实体字段：优先看 `src/kernels/abml/entity.ts`。
- DOM/AX merge：`src/kernels/abml/ax.ts`。
- diff：`src/kernels/abml/diff.ts` / `treeDiff.ts`。
- read/pierce/frame 决策：`src/kernels/abml/verbs/*`。
- 浏览器 I/O 实现：放到 `src/browser-runtime/abml/*`。

### 14.4 修改 extension

1. 修改 `src/bridge/extension/**` 源码。
2. 不要直接编辑 `bridge/browser_pilot_bridge/`。
3. 需要时运行：

```bash
npm run build:bridge
```

4. 使用 `mise run affected` 或 `mise run verify` 验证。

### 14.5 修改构建、脚本、治理文档

修改以下内容时使用 governance 门禁：

- `REPO_GOVERNANCE.md`
- `AGENTS.md`
- `CODE_WIKI.md`
- `README.md`
- `tests/governance/`
- `mise.toml`
- `scripts/`
- `.github/workflows/`

运行：

```bash
mise run dev-governance
```

### 14.6 常见改动位置速查

| 需求 | 应修改位置 |
|---|---|
| 新增 CLI 子命令但不是 browser tool | `src/apps/cli/main.ts` 与相关 `cli*Command.ts`。 |
| 新增 browser tool | `src/commands/*` + `commandCatalog.ts`。 |
| 新增 native bridge command | `native-command.schema.json` + sync protocol + extension handler。 |
| 修改 JS 执行行为 | `src/commands/executeCommand.ts`、`src/bridge/extension/service_worker/exec.ts`。 |
| 修改 CDP 输入行为 | `src/bridge/extension/service_worker/input.ts`。 |
| 修改 tab/session 路由 | `src/bridge/server/BrowserTabSessionRouter.ts`、`src/kernels/session/*`。 |
| 修改 result envelope | `src/commands/resultMiddleware.ts`、`src/kernels/evidence/distill/*`。 |
| 修改 artifact 读取 | `src/artifacts/*`、`src/commands/artifactCommand.ts`。 |
| 修改 scan 页面脚本 | `capture-src/entries/scanTemplate.ts`、`src/scan/buildScanScript.ts`。 |
| 修改 content 提取 | `capture-src/entries/contentTemplate.ts`、`src/content/buildContentScript.ts`。 |
| 修改 Rust 加速 | `native/browser-pilot-kernels/src/main.rs`、`src/native/browserPilotNativeKernels.ts`。 |

---

## 15. 架构原则摘要

1. `commandCatalog.ts` 是 `browser_*` 工具公共面的权威来源。
2. CLI 不直接控制浏览器；daemon 是 live browser session owner。
3. Bridge Server 只和 extension 通信，不直接调用 Chrome API。
4. Extension service worker 执行 Chrome API/CDP，offscreen 维持 WebSocket。
5. `src/kernels/*` 保持纯逻辑边界。
6. `src/browser-runtime/*` 承担 browser I/O，依赖 kernels 而不是反向依赖。
7. `capture-src/*` 是页面世界脚本模板源。
8. Native kernels 是可选加速，失败必须回退 TypeScript 实现。
9. Native protocol schema 是源头，生成文件不随意手改。
10. `dist/` 和 `bridge/browser_pilot_bridge/` 是生成产物，不手改。
11. 完成或发布前以 `mise run verify` 为准。
12. Observe 默认提供 task entry points 而不猜动作；write operation 默认提供终态而不倾倒大 evidence。恢复/续行走 `nextActions`/`continuation`，可选细节走 `saved.path` + `artifact_hints` 渐进展开。
