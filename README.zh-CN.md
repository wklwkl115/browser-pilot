# Pi Browser Tools

[![CI](https://github.com/anthropics/browser-pilot/actions/workflows/check.yml/badge.svg)](https://github.com/anthropics/browser-pilot/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

[English](README.md)

面向 AI agent 的真实浏览器自动化工具 —— tab 控制、DOM 扫描、JavaScript/CDP 执行、
网络捕获、截图与证据采集、文件传输，以及 Web 安全测试层。

由 Chrome 扩展 + Node.js bridge 构成。支持任何能调用工具的 agent（Pi 原生）
或能执行 shell 命令的 agent（`browser-pilot` CLI）。

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

## 快速开始

### 前置条件

- Node.js 22+
- Chrome 或 Edge

### 安装

```bash
git clone https://github.com/anthropics/browser-pilot.git
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
# ... 在页面上操作 ...
npx browser-pilot network list --session-id net-1 --json

# 截图
npx browser-pilot screenshot --json

# 查看所有命令和参数
npx browser-pilot --help
npx browser-pilot schema observe --json
```

每个 `browser_*` 工具对应一个子命令：去掉 `browser_` 前缀，`_` 换成 `-`。
参数名用 kebab-case。`browser-pilot commands --json` 是可用命令和路由的唯一事实来源。

较长的脚本和请求体建议用文件代替 shell 引号：

```bash
npx browser-pilot execute --script-file ./my-script.js --json
npx browser-pilot command --command @native-command.json --json
npx browser-pilot http-replay --raw-request @request.txt --json
```

### 通过 Pi 原生使用

作为 Pi 扩展加载时，工具注册为 `browser_*` 工具调用，无需连接步骤。
参见 [skills/browser-pilot/SKILL.md](skills/browser-pilot/SKILL.md)。

> Pi runtime 包（`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`）
> 是可选的 peer 依赖。CLI 可独立使用，不需要这些包。

## 工具列表

| 工具 | 说明 |
|---|---|
| `browser_tabs` | 列出、切换、创建、关闭 tab；管理 session 和 lease |
| `browser_observe` | 扫描 DOM 结构，提取 content/HTML/text，diff 基线 |
| `browser_execute` | 在页面中执行 JavaScript（可选 effect 监控） |
| `browser_command` | 发送 native bridge 命令（CDP、input 等） |
| `browser_wait` | 等待导航、选择器、加载状态、网络空闲 |
| `browser_pick` | 交互式元素选择器 |
| `browser_screenshot` | 捕获可见 tab 截图 |
| `browser_network` | 录制/列出/导出 HTTP 流量和 HAR |
| `browser_hook` | 安装页面事件 hook（console、error、storage 等） |
| `browser_evidence` | 聚合 hook + network + performance 证据 |
| `browser_frame` | 列出 frame，在子 frame 中执行，注入脚本 |
| `browser_artifact` | 按行、JSON path、搜索或抽样读取保存的证据 |
| `browser_memory` | 本地浏览器记忆 —— 记录和召回每站点 SOP |
| `browser_download` | 通过 click、media selector 或 URL 下载文件 |
| `browser_upload` | 通过 file input 上传本地文件 |
| `browser_crawl` | 爬取 links/forms/API/source maps；指纹识别 URL |
| `browser_fuzz` | 路径、虚拟主机、参数模糊测试 |
| `browser_sqli` | SQL 注入检测（内置 oracle + sqlmap 桥接） |
| `browser_template` | HTTP 模板检查（内置 + nuclei 桥接） |
| `browser_cookie_analyze` | Cookie/JWT/JWE/PASETO/session 分析 |
| `browser_http_replay` | 重放和变异 HTTP 请求，带 diff 聚类 |
| `browser_callback_oast` | 本地 HTTP/HTTPS/DNS 回调监听器（OAST） |

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
npm run quality:local     # 完整本地门禁：build + lint + check + pack
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
| [docs/cli.md](docs/cli.md) | CLI 参考和使用模式 |
| [docs/playbooks/](docs/playbooks/) | 安全测试操作手册 |
| [docs/tool-boundaries.md](docs/tool-boundaries.md) | 工具选择边界 |
| [docs/browser-memory.md](docs/browser-memory.md) | 本地浏览器记忆系统 |
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
