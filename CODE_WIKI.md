# Browser Pilot Code Wiki

生成日期：2026-06-24

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
- 本地 memory 与 evidence envelope 管理。

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
│  ├─ memory/                       memory 文件、profile、recall 存储层
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
  │ def.execute(...)
  ▼
src/commands/executeCommand.ts
  │ server.executeJavaScript(...)
  ▼
src/bridge/server/BrowserBridgeCommandService.ts
  │ sendPayload(script)
  ▼
WebSocket payload { id, code:string, tabId, timeoutMs }
  ▼
src/bridge/extension/offscreen/transport.ts
  │ 转发给 service worker
  ▼
src/bridge/extension/service_worker/router.ts
  │ code 是 string，进入 handleWsExec
  ▼
src/bridge/extension/service_worker/exec.ts
  │ chrome.scripting.executeScript 或 CDP Runtime.evaluate fallback
  ▼
result/error
  ▼
BrowserBridgePendingRequests resolve/reject
  ▼
daemon response
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
  │ server.sendCommand(...)
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
result/error → bridge server → daemon → CLI
```

### 4.3 ACK 与 timeout 语义

Bridge Server 为每个 request 分配 `id`。Extension 收到请求后先返回 `ack`，执行完成后返回 `result` 或 `error`。这让 server 可以区分：

- 请求未到达 extension：没有 ACK；
- 请求已到达但执行慢：有 ACK，pending request 仍在运行；
- 请求完成：收到 result/error。

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
- pairing token 与 tenant lease 管理；
- 维护 daemon lockfile 与状态发现。

关键文件：

| 文件 | 职责 |
|---|---|
| [`server.ts`](src/apps/daemon/server.ts) | daemon 主体，`startDaemon()` 与 HTTP routes。 |
| [`daemonControl.ts`](src/apps/daemon/daemonControl.ts) | lockfile、spawn、find、ensure、stop、control request。 |
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
| [`BrowserBridgePendingRequests.ts`](src/bridge/server/BrowserBridgePendingRequests.ts) | pending request 生命周期。 |
| [`BrowserBridgeClientMessageService.ts`](src/bridge/server/BrowserBridgeClientMessageService.ts) | extension 上行消息处理。 |
| [`BrowserBridgeClientRegistry.ts`](src/bridge/server/BrowserBridgeClientRegistry.ts) | WebSocket client registry。 |
| [`BrowserTabSessionRouter.ts`](src/bridge/server/BrowserTabSessionRouter.ts) | tab/session/targetRef 路由。 |
| [`BrowserBridgeSessionState.ts`](src/bridge/server/BrowserBridgeSessionState.ts) | session kernel state 聚合。 |
| [`BrowserCommandQueueRegistry.ts`](src/bridge/server/BrowserCommandQueueRegistry.ts) | per-tab command queue。 |
| [`BrowserBridgeClientHeartbeat.ts`](src/bridge/server/BrowserBridgeClientHeartbeat.ts) | WebSocket heartbeat。 |

### 5.4 `src/bridge/extension`

Extension 是 MV3 浏览器侧实现。它执行实际浏览器能力：Chrome APIs、CDP、content scripts、network recorder、hook、screenshot、transfer、wait 等。

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
| [`service_worker/exec.ts`](src/bridge/extension/service_worker/exec.ts) | JavaScript 执行与 CDP fallback。 |
| [`service_worker/cdp.ts`](src/bridge/extension/service_worker/cdp.ts) | CDP attach/send/detach/targets/frameTree。 |
| [`service_worker/input.ts`](src/bridge/extension/service_worker/input.ts) | CDP 输入、pointer/key/touch/ref。 |
| [`service_worker/network.ts`](src/bridge/extension/service_worker/network.ts) | network recorder、HAR/body/wait。 |
| [`service_worker/wait.ts`](src/bridge/extension/service_worker/wait.ts) | wait.any/all/cancel/diagnose。 |
| [`service_worker/hook.ts`](src/bridge/extension/service_worker/hook.ts) | DOM/event hook。 |
| [`service_worker/screenshot.ts`](src/bridge/extension/service_worker/screenshot.ts) | screenshot capture。 |

MV3 service worker 不能稳定持有长期 WebSocket，因此项目使用 offscreen document 作为 WebSocket transport，service worker 专注于命令调度和 Chrome API/CDP 调用。

### 5.5 `src/commands`

Commands 层是 `browser_*` 公共工具面。它向上服务 CLI/daemon，向下调用 bridge server、browser runtime、kernel 与 artifacts/memory/resource 层。

职责：

- 定义公开工具名称、描述、prompt、TypeBox 参数 schema；
- 注册所有工具；
- 统一 timeout、maxChars、targetRef/tabId、operation tracking；
- 统一结果 envelope、summary、artifact fallback、redaction、memory auto-surface、evidence；
- 实现 core browser tools 与 Web Security tools。

核心文件：

| 文件 | 职责 |
|---|---|
| [`commandCatalog.ts`](src/commands/commandCatalog.ts) | 公开工具注册器的权威清单。 |
| [`defineBrowserCommands.ts`](src/commands/defineBrowserCommands.ts) | 命令注册总入口。 |
| [`commandDefinition.ts`](src/commands/commandDefinition.ts) | `BrowserCommandDefinition` 等基础类型。 |
| [`commandManifestIndex.ts`](src/commands/commandManifestIndex.ts) | command definition 收集器。 |
| [`commandRuntime.ts`](src/commands/commandRuntime.ts) | timeout、target、operation、result helper。 |
| [`resultMiddleware.ts`](src/commands/resultMiddleware.ts) | distilled envelope、artifact、summary、memory。 |
| [`validationMiddleware.ts`](src/commands/validationMiddleware.ts) | schema validation helper。 |
| [`distillerRegistry.ts`](src/commands/distillerRegistry.ts) | summary distiller registry。 |

核心工具文件：

| 工具 | 文件 |
|---|---|
| `browser_tabs` | [`tabsCommand.ts`](src/commands/tabsCommand.ts) |
| `browser_execute` | [`executeCommand.ts`](src/commands/executeCommand.ts) |
| `browser_observe` | [`observeCommand.ts`](src/commands/observeCommand.ts)、[`observe/scanRunner.ts`](src/commands/observe/scanRunner.ts) |
| `browser_command` | [`nativeCommand.ts`](src/commands/nativeCommand.ts) |
| `browser_wait`、`browser_network`、`browser_hook`、`browser_frame` | [`nativeActionCommands.ts`](src/commands/nativeActionCommands.ts) |
| `browser_evidence` | [`evidenceCommand.ts`](src/commands/evidenceCommand.ts) |
| `browser_artifact` | [`artifactCommand.ts`](src/commands/artifactCommand.ts) |
| `browser_memory` | [`memoryCommand.ts`](src/commands/memoryCommand.ts) |
| `browser_download`、`browser_upload` | [`transferCommands.ts`](src/commands/transferCommands.ts) |
| `browser_screenshot` | [`screenshotCommand.ts`](src/commands/screenshotCommand.ts) |

### 5.6 `src/kernels`

Kernels 是纯逻辑层。这里的代码不做浏览器 I/O、不读写文件、不依赖 runtime/commands/bridge。除 `src/kernels/session/*` 可显式导入 `node:crypto` 用于随机 ID 与不可逆诊断哈希外，kernel 不依赖 Node-only API。

主要子目录：

| 目录 | 职责 |
|---|---|
| [`kernels/abml`](src/kernels/abml) | Agent Browser Markup Language，页面实体、AX/DOM 融合、diff、relations、collections、causal、verbs。 |
| [`kernels/refs`](src/kernels/refs) | `bp-ref://` ref mint/parse/id/policy/text extraction。 |
| [`kernels/evidence/distill`](src/kernels/evidence/distill) | fact、budget、projection、artifact plan、recovery、salience envelope。 |
| [`kernels/memory`](src/kernels/memory) | memory profile、terms、recall、routing、salience、staleness。 |
| [`kernels/session`](src/kernels/session) | session、lease、operation、snapshot、perception ledger、intent refs。 |
| [`kernels/security`](src/kernels/security) | SQLi oracle、replay diff 等安全工具纯逻辑。 |
| [`kernels/temporal`](src/kernels/temporal) | timeout、state loss、staleness、deadline pressure 判断。 |

### 5.7 `src/browser-runtime` 与 `src/browser-command-runtime`

`browser-runtime` 是 kernel 的浏览器 I/O 适配层，负责调用 bridge/CDP/scan/screenshot/resource，然后把采集结果交给 kernel 纯函数处理。

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
| [`browser-command-runtime/waitSupervisor.ts`](src/browser-command-runtime/waitSupervisor.ts) | wait runtime coordination。 |

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
- `jsAst.reduce`

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
| `jsonCommandResult()` | [`src/commands/commandRuntime.ts`](src/commands/commandRuntime.ts) | JSON 结果 envelope 入口。 |
| `distilledJsonResult()` | [`src/commands/resultMiddleware.ts`](src/commands/resultMiddleware.ts) | 摘要、artifact、redaction、memory、evidence envelope。 |
| `validateCommandArgs()` | [`src/validation/commandArgs.ts`](src/validation/commandArgs.ts) | TypeBox 参数转换与校验。 |

### 6.5 Kernels / Runtime / Native

| 名称 | 文件 | 说明 |
|---|---|---|
| `Entity` | [`src/kernels/abml/entity.ts`](src/kernels/abml/entity.ts) | ABML 实体模型。 |
| `diffEntities()` | [`src/kernels/abml/diff.ts`](src/kernels/abml/diff.ts) | entity diff 纯实现。 |
| `SessionKernel` | [`src/kernels/session/SessionKernel.ts`](src/kernels/session/SessionKernel.ts) | session/lease/operation/snapshot kernel 聚合。 |
| `mintRef()` / `parseRef()` | [`src/kernels/refs/core.ts`](src/kernels/refs/core.ts) | `bp-ref://` URI 创建与解析。 |
| `createBrowserAbmlRuntime()` | [`src/browser-runtime/abml/runtime.ts`](src/browser-runtime/abml/runtime.ts) | 创建 ABML runtime context。 |
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
- `browser_wait`
- `browser_network`
- `browser_hook`
- `browser_evidence`
- `browser_frame`
- `browser_screenshot`
- `browser_artifact`
- `browser_memory`

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

### 7.2 命令定义模型

每个工具都是一个 `BrowserCommandDefinition`，包含：

- `name`
- `label`
- `description`
- `promptSnippet`
- `promptGuidelines`
- `parameters`
- `prepareArguments`
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

大多数命令使用 `strictCommandParameters()` 构造 TypeBox schema，默认拒绝未知参数。

Daemon `/invoke` 流程会：

1. 调用 `def.prepareArguments(params)`；
2. 调用 `validateCommandArgs(def.parameters, prepared)`；
3. 通过后再执行 `def.execute(...)`。

### 7.4 结果 Envelope

命令结果统一经过 `jsonCommandResult()` 或 `textCommandResult()`，最终由 `resultMiddleware.ts` 生成 distilled envelope。

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
- `memory`
- `evidence`

大结果会保存 artifact，并在输出中给出读取方式。

### 7.5 关键工具说明

#### `browser_observe`

用于页面感知。支持：

- `scan`：结构化页面感知，ABML、actionables、entities、diff、causal；
- `content`：可读正文；
- `html`：精确 HTML/text slice；
- `text`：可见文本优先观察；
- `tabs`：tab inventory。

`scan` / `text` 会通过 observe memory augmentation 自动在结果 envelope 的 `memory` 字段暴露匹配的本地 fact memory。该自动暴露面只面向 `kind=fact` 的事实卡片：首次匹配可内联 bounded body，后续/折叠视图只给 handle 与元数据；SOP、workflow、playbook、checklist、步骤或 agent 指令不应被记录，也不会作为 observe 行为指南暴露。

关键文件：[`observeCommand.ts`](src/commands/observeCommand.ts)、[`observe/scanRunner.ts`](src/commands/observe/scanRunner.ts)、[`observe/memoryAugmentation.ts`](src/commands/observe/memoryAugmentation.ts)。

#### `browser_execute`

用于在真实 tab 执行 JavaScript，或执行结构化 physical input program。

规则：

- `script` 与 `program` 二选一；
- 只接受 JavaScript，不接受 native bridge command；
- 页面动作可以通过 JS 或 CDP physical input program 完成；
- 没有独立的 click/type 工具。

关键文件：[`executeCommand.ts`](src/commands/executeCommand.ts)。

#### `browser_command`

底层 native bridge command escape hatch。它发送 `{ cmd, ... }` 对象到 extension，但仍经过 schema 校验和安全拒绝逻辑。

关键文件：[`nativeCommand.ts`](src/commands/nativeCommand.ts)。

#### `browser_wait` / `browser_network` / `browser_hook` / `browser_frame`

这几类工具共享 `defineNativeActionCommand()` 注册模式，将高层 `action` 映射到底层 native command。

关键文件：[`nativeActionCommands.ts`](src/commands/nativeActionCommands.ts)。

#### Web Security tools

Web Security 工具位于 [`src/commands/webSecurity`](src/commands/webSecurity)，分为：

- `commands/`：工具注册；
- `browserNative/`：内建 crawl/fuzz/sqli/template/oast/cookie/replay 实现；
- `bridges/`：sqlmap、nuclei 外部工具桥；
- `shared/`：HTTP、HAR、request template、JS AST、artifact、diagnostics；
- `wordlists/`：SQLi payloads。

---

## 8. Bridge、Daemon 与 Extension 协议链路

### 8.1 Daemon 是浏览器会话 owner

CLI 调用通常是短生命周期的。Daemon 长驻并持有 browser session，这样：

- CLI 退出不会断开浏览器连接；
- extension 连接状态可复用；
- 多项目共享用户本地 daemon；
- 每次 `/invoke` 携带 `cwd`，用于 artifacts/memory/evidence 的请求级作用域。

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
- consent capability；
- 当前 scriptable tabs。

Bridge Server 收到 `ext_ready` 或 `tabs_update` 后更新 client info 和 tabs router。

### 8.4 Native protocol

Native command schema 源头是 [`src/bridge/protocol/native-command.schema.json`](src/bridge/protocol/native-command.schema.json)。同步脚本 [`scripts/sync-native-protocol.mjs`](scripts/sync-native-protocol.mjs) 会生成：

- [`src/bridge/extension/service_worker/protocol.ts`](src/bridge/extension/service_worker/protocol.ts)
- [`src/types/nativeProtocol.ts`](src/types/nativeProtocol.ts)
- [`src/commands/nativeActionMetadata.ts`](src/commands/nativeActionMetadata.ts)
- [`src/types/nativeErrorCodes.ts`](src/types/nativeErrorCodes.ts)

协议 schema 是源头，生成文件不应随意手改。

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

ABML 是 Browser Pilot 的页面感知核心，负责：

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
- [`src/kernels/abml/verbs/router.ts`](src/kernels/abml/verbs/router.ts)

### 9.3 Runtime

Runtime 层可以做浏览器 I/O，并将采集结果输入 kernel。典型职责：

- `sendCommand`；
- CDP `Accessibility.getFullAXTree` / `DOMSnapshot.captureSnapshot`；
- scan/content/vision script 执行；
- screenshot；
- resource ref 注册；
- artifact 保存；
- 调用 kernel 纯函数。

### 9.4 Capture templates

`capture-src/entries/*.ts` 是页面世界脚本模板源。它们通过 `src/capture/inject.ts` 渲染成可执行脚本后注入浏览器页面。

模板不是 kernel，也不是 bridge。它只负责页面上下文中的数据采集。

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
commands ──▶ bridge runtime port + browser-runtime + kernels + artifacts/resources/memory
browser-runtime ──▶ kernels + ports/resources/scan/content/capture
bridge/server ──▶ kernels/session + extension protocol types
bridge/extension ──▶ Chrome APIs + generated protocol
kernels ──▶ kernels 内部纯模块
```

### 10.2 禁止或高风险依赖

- `src/kernels/*` 不应导入 `src/commands/*`、`src/bridge/*`、`src/browser-runtime/*`。
- `src/commands/memory/*` 只能记录与召回 `kind=fact` 的本地事实记忆；不得把 SOP、workflow、playbook、checklist、步骤或 agent 指令语义写入 memory。record/validate 会拒绝非 fact kind 与 SOP-like 内容；`browser_observe` 只自动暴露匹配到的 fact memory，不把 memory 当作流程指南。需要 daemon/bridge 信息时优先依赖窄接口，例如 snapshot evidence 只依赖 `getObservationSnapshot()`。
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
mise run dev-governance
```

含义：

| 命令 | 说明 |
|---|---|
| `mise run dev` | 常规本地开发门禁。 |
| `mise run affected` | 基于 changed files 的影响范围验证。 |
| `mise run verify` | 发布/完成前完整验证门禁。 |
| `mise run dev-governance` | 修改治理、脚本、workflow、README 等时使用。 |

`mise run verify` 包含：

- reachability audit；
- main TypeScript typecheck；
- extension TypeScript typecheck；
- protocol drift check；
- all tests；
- full ESLint；
- build。

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
npm run audit:reachability
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
| `npm run lint` | reachability audit + ESLint。 |

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

### 11.4 扩展构建

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

配置位置：[`src/bridge/server/browserBridgeConfig.ts`](src/bridge/server/browserBridgeConfig.ts)、[`bridge/browser_bridge_config.json`](bridge/browser_bridge_config.json)。

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

### 12.3 Artifact 与 Memory

Artifact、resource、memory 以每次 `/invoke` 携带的 `cwd` 作为请求级作用域。相关模块：

- [`src/artifacts`](src/artifacts)
- [`src/resources`](src/resources)
- [`src/memory`](src/memory)
- [`src/commands/memory`](src/commands/memory)

`src/commands/memory/store.ts` 保持 record/validate/recall 的入口职责；payload fact-only validation 与 evidence/profile enrichment 位于 `validation.ts`/`evidence.ts`，磁盘写入、tombstone、bounded body read 位于 `repository.ts`，recall ranking 与 dedup/similar scoring 位于 `ranking.ts`。这些拆分不改变 `.browser-pilot/memory` 下的 frontmatter、index、URI 或 tombstone 兼容格式。

### 12.4 TypeScript 配置边界

| 文件 | 说明 |
|---|---|
| [`tsconfig.base.json`](tsconfig.base.json) | 公共 TypeScript 配置。 |
| [`tsconfig.json`](tsconfig.json) | 主项目 typecheck，排除 extension 源码。 |
| [`tsconfig.bridge-src.json`](tsconfig.bridge-src.json) | extension 源码 typecheck。 |
| [`tsconfig.build.json`](tsconfig.build.json) | build 输出配置。 |

---

## 13. 测试体系

测试使用 Node built-in test runner + `tsx`，脚本位于 [`scripts/run-tests.mjs`](scripts/run-tests.mjs)。覆盖率观测使用 Node 22 test runner 内置 V8 coverage，脚本位于 [`scripts/run-coverage.mjs`](scripts/run-coverage.mjs)，只生成报告与 `coverage/` 下的 V8 JSON，不设置全仓库硬阈值，也不改变默认测试或 `mise run affected` / `mise run verify` 行为。

测试分组：

| Scope | 目录 |
|---|---|
| `all` | `bootstrap`、`cli`、`artifacts`、`js-ast`、`governance` |
| `cli` | `bootstrap`、`cli` |
| `artifacts` | `bootstrap`、`artifacts` |
| `js-ast` | `bootstrap`、`js-ast` |
| `governance` | `bootstrap`、`governance` |

运行示例：

```bash
node scripts/run-tests.mjs all
node scripts/run-tests.mjs cli
node --import tsx --test tests/bootstrap/smoke.test.ts
mise run coverage
node scripts/run-coverage.mjs all
```

CI 位于 [`.github/workflows/verify.yml`](.github/workflows/verify.yml)，核心步骤是：

```bash
npm ci
mise run verify
```

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
| 修改 memory recall/record | `src/commands/memory/*`、`src/memory/*`、`src/kernels/memory/*`。 |
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
