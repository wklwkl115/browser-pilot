# Browser Pilot

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-22%20browser__*-blueviolet.svg)](#工具列表)
[![Tests](https://img.shields.io/badge/tests-860%2B%20contracts-green.svg)](#开发)

[English](README.md)

**面向 AI agent 的真实浏览器自动化** —— 不是模拟器，不是代理，不是截图解析。
Browser Pilot 让你的 agent 直接控制真实的 Chrome/Edge 标签页：DOM 结构、JavaScript
执行、CDP 命令、网络流量、Cookie、文件传输。人类在 DevTools 里能做的一切，你的 agent 都能通过
22 个可组合的 `browser_*` 工具完成。

```
$ browser-pilot observe --mode scan --json | jq '.summary.gist'
"论坛帖子列表，14 行可见数据，导航侧栏，用户菜单。
 3 个表单（搜索、登录、发帖），47 个可操作元素。"

$ browser-pilot execute --script "document.querySelector('.topic-list .main-link a').href" --json
{ "data": "https://linux.do/t/welcome/1" }

$ browser-pilot network start --json && browser-pilot execute --script "fetch('/api/status')" --json
$ browser-pilot network list --session-id net-1 --json | jq '.data.requests[0].url'
"https://linux.do/api/status"
```

## 为什么选择 Browser Pilot

大多数浏览器自动化工具给 agent 的是**一张截图和一个点击坐标**。
Browser Pilot 给 agent 它们真正需要的东西：

- **结构化感知** —— DOM 扫描融合了实体提取、可访问性树、结构 diff 和模板压缩。你的 agent 看到的是语义模型，不是像素。
- **直接执行** —— 在页面中运行任意 JavaScript，不只是 click/type 宏。agent 像开发者在 DevTools 里一样编写 DOM 代码。
- **物理输入逃逸** —— 当受信任事件门控的控件忽略合成 click 时，CDP 物理输入（`input.pointer` / `input.keys`）能打通。不再有"按钮没反应"的死胡同。
- **完整网络可见性** —— 录制/重放/变异 HTTP 流量、导出 HAR、捕获请求体。精确看到页面收发了什么。
- **内置安全测试** —— 7 个 Web 安全工具（爬取、模糊测试、SQLi、模板检查、Cookie/session 分析、HTTP 重放、OAST）共享浏览器会话，无需额外代理。
- **Token 高效输出** —— 基于显著性的渲染、session delta 压缩和任务条件相关性保持输出紧凑。同一页面的重复扫描只发送变化部分。
- **860+ 契约测试** —— 协议、工具、边界、运行时 fixture、生命周期和治理门禁。工具接口被 CI 锁定。

## 工作原理

```
┌─ Chrome 扩展 (Manifest V3) ───────────────────────────────────────┐
│  Service worker + offscreen transport + content/hook 脚本          │
└────────────────────────┬──────────────────────────────────────────┘
                         │ WebSocket (127.0.0.1:18765-18784)
┌────────────────────────▼──────────────────────────────────────────┐
│  Node.js Bridge Server                                            │
│  HTTP/WS 外观 → 客户端注册 → tab/session 路由 → pending 管理      │
└────────────────────────┬──────────────────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────────────────┐
│  工具层 (22 个 browser_* 工具)                                     │
│  核心: tabs, observe, execute, command, wait, pick, screenshot,   │
│        network, hook, evidence, frame, artifact, memory,          │
│        download, upload                                           │
│  安全: crawl, fuzz, sqli, template, cookie-analyze,               │
│        http-replay, callback-oast                                 │
└───────────────────────────────────────────────────────────────────┘
```

Chrome 扩展运行在浏览器中，通过本地 WebSocket 桥接到 Node.js 服务器。
顶层的工具层暴露 22 个可组合的工具。两个前端接入同一个工具核心：

| 前端 | 适用场景 | 指南 |
|---|---|---|
| **CLI**（`browser-pilot` 命令） | Shell agent、CI、cron、人类 | [CLI 使用指南](docs/guide-cli.md) |
| **Pi 原生**（进程内 `browser_*` 调用） | Pi runtime agent（零开销） | [Pi 原生使用指南](docs/guide-pi-native.md) |

## 快速开始

### 前置条件

- Node.js 22+
- Chrome 或 Edge

### 安装

```bash
git clone <repository-url> browser-pilot
cd browser-pilot
npm install
npm run build
npm run build:bridge
```

### 加载浏览器扩展

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启**开发者模式**。
3. 点击**加载已解压的扩展程序** → 选择 `bridge/pi_browser_bridge`。
4. 确认扩展名称为 **Pi Native Browser Bridge**。

### 通过 CLI 使用

`browser-pilot` CLI 将全部 22 个工具暴露为 shell 子命令。用户级单例 daemon 管理 bridge server，
首次调用时自动启动。

```bash
# 就绪门控（多步操作推荐）
npx browser-pilot connect --wait --json

# 观察页面
npx browser-pilot observe --mode scan --json

# 执行 JavaScript
npx browser-pilot execute --script "document.title" --json

# 等待选择器
npx browser-pilot wait selector --selector "#result" --json

# 捕获网络流量
npx browser-pilot network start --json
npx browser-pilot network list --session-id net-1 --json

# 截图
npx browser-pilot screenshot --json

# 查看所有命令和参数
npx browser-pilot --help
npx browser-pilot schema observe --json
```

详见 **[CLI 使用指南](docs/guide-cli.md)** 了解完整工作流、文件输入、安全测试和 daemon 管理。

### 通过 Pi 原生使用

作为 Pi 扩展加载时，工具注册为 `browser_*` 工具调用，无需连接步骤。直接调用即可：

```
browser_tabs    { action: "list" }
browser_observe { mode: "scan" }
browser_execute { script: "document.title" }
browser_wait    { action: "selector", params: { selector: "#result" } }
```

详见 **[Pi 原生使用指南](docs/guide-pi-native.md)** 了解 observe-execute-wait 循环、记忆系统和恢复模式。

> Pi runtime 包（`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`）
> 是可选的 peer 依赖。CLI 可独立使用，不需要这些包。

## 工具列表

15 个核心工具（tabs, observe, execute, command, wait, pick, screenshot, network, hook,
evidence, frame, artifact, memory, download, upload）和 7 个安全工具（crawl, fuzz,
sqli, template, cookie-analyze, http-replay, callback-oast）。详见
[工具契约参考](docs/generated/browser-tool-contract.generated.md)。

## 典型工作流

```
1. tabs list           → 找到目标 tab
2. observe --mode scan → 理解页面结构
3. execute             → 点击、输入、滚动（JavaScript）
4. wait                → 等待导航 / 选择器 / 网络空闲
5. observe / network / evidence → 验证结果
6. artifact            → 读取详细证据
```

没有 `click` 或 `type` 命令 —— 页面操作通过 `browser_execute`（JavaScript）完成。
对于受信任事件门控的控件，使用 `browser_command` 发送 `input.pointer` 或 `input.keys`
（CDP 物理输入）。

## 核心特性

### 结构化 DOM 感知

`browser_observe` 返回页面的语义模型 —— 不是原始 HTML，不是截图。它融合了可访问性树与 DOM
结构，提取实体和关系，压缩重复模式（列表、表格），并跟踪跨扫描的变化。

### Session Delta

对同一标签页重复 `browser_observe mode=scan` 会产生紧凑的 delta 帧（`delta:"session"`），
只包含变化部分。多步工作流保持 token 高效，不牺牲完整性。

### 浏览器记忆

本地存储（`.pi/browser-memory/`）让 agent 记录和召回每站点的操作程序（SOP）和知识。
一旦记录，`browser_observe` 会自动展现与当前 URL 匹配的记忆 —— agent 不再需要为同一个操作
序列重新推理。

### Living Tab Sessions

稳定的 `tabHandle`/`targetRef` 标识符在 tab 替换、MV3 service worker 重启和扩展重连后
依然有效。你的 agent 不会丢失对标签页的追踪。

### 四个纯逻辑内核

核心感知管道运行在四个 CI 边界锁定的内核中，零浏览器/Node 依赖：

| 内核 | 用途 |
|---|---|
| **Capture**（感知） | 注入浏览器的页面级 JS 模板 |
| **ABML**（理解） | 实体提取、差异比较、模板化、关系、因果 |
| **Distill**（表达） | Token 经济、显著性渲染、事实分配 |
| **Memory**（保留） | 档案蒸馏、召回评分、过期验证 |

## 安全测试

安全工具遵循先观察后探测的流程。

```bash
# 指纹识别目标
npx browser-pilot crawl --action fingerprint --url https://example.com --json

# 爬取端点
npx browser-pilot crawl --url https://example.com --json

# 路径模糊测试
npx browser-pilot fuzz --mode path --url https://example.com/FUZZ --json

# 重放捕获的请求并变异
npx browser-pilot http-replay --raw-request @request.txt --json

# 检测 SQL 注入
npx browser-pilot sqli --url "https://example.com/search?q=test" --json
```

详见 [docs/playbooks/](docs/playbooks/) 中的安全测试操作手册。

## 开发

```bash
npm run build:bridge      # 构建 Chrome 扩展
npm run build             # 编译 Node.js 源码到 dist/
npm run lint              # ESLint
npm run check             # 运行全部契约/单元/边界测试
npm run quality:local     # 完整本地门禁：build + lint + check + npm pack --dry-run --ignore-scripts --json
npm run release:portable  # 干净公开文件树 + npm tarball 空项目安装 smoke
```

按域缩小范围快速迭代：

```bash
npm run check:all:src         # 源码类型检查 + registry drift
npm run check:all:bridge      # Bridge + 单元测试
npm run check:all:package     # Package + docs 检查
npm run check:all:contracts   # 契约测试
```

浏览器 smoke 测试（需扩展已连接）：

```bash
npm run smoke:browser:isolated    # 隔离 Chrome profile
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解完整的贡献流程。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/guide-cli.md](docs/guide-cli.md) | CLI 使用指南 —— 工作流、模式、示例 |
| [docs/guide-pi-native.md](docs/guide-pi-native.md) | Pi 原生使用指南 —— 工具调用、循环、记忆 |
| [docs/cli.md](docs/cli.md) | CLI 参考 —— 完整的命令/参数/输出规范 |
| [docs/playbooks/](docs/playbooks/) | 安全测试操作手册 |
| [docs/tool-boundaries.md](docs/tool-boundaries.md) | 工具选择边界 |
| [docs/browser-memory.md](docs/browser-memory.md) | 本地浏览器记忆系统 |
| [AI_INSTALL.md](AI_INSTALL.md) | 安装、扩展加载、故障排除 |
| [docs/generated/browser-tool-contract.generated.md](docs/generated/browser-tool-contract.generated.md) | 生成的工具契约参考 |
| [docs/generated/native-protocol.generated.md](docs/generated/native-protocol.generated.md) | 生成的 native 协议参考 |

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PI_BROWSER_BRIDGE_HOST` | `127.0.0.1` | Bridge 监听地址 |
| `PI_BROWSER_BRIDGE_PORT` | `18765` | Bridge 端口范围起始 |
| `PI_BROWSER_BRIDGE_PORT_RANGE_END` | `18784` | Bridge 端口范围结束 |
| `PI_BROWSER_RENDERER` | `salience` | 观察渲染器（`salience` 或 `ladder`） |
| `PI_BROWSER_SESSION_DELTA` | `1` | 重复 scan 的 session-delta（`0` 禁用） |
| `PI_BROWSER_RELEVANCE` | `1` | 任务条件相关性（`0` 禁用） |
| `PI_BROWSER_MEMORY` | `1` | 自动召回浏览器记忆（`0` 禁用） |

## 许可证

[Apache-2.0](LICENSE)
