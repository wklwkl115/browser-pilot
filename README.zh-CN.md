<div align="center">

<img src="docs/assets/hero-banner.jpg" alt="Browser Pilot" width="100%">

# Browser Pilot

**真实浏览器标签页的智能体基础设施。**

观察、执行、验证、追溯 &mdash; 无需多模态模型。

<img src="docs/assets/logo.jpg" alt="Browser Pilot Logo" width="120">

[![CI](https://github.com/wklwkl115/browser-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/wklwkl115/browser-pilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/browser-pilot-mcp?logo=npm&color=CB3837)](https://www.npmjs.com/package/browser-pilot-mcp)
[![License](https://img.shields.io/github/license/wklwkl115/browser-pilot?color=2563EB)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-22D3EE)
![Chrome and Edge](https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-F59E0B?logo=googlechrome&logoColor=white)

[English](README.md) &middot; [简体中文](README.zh-CN.md)

[特性](#特性) &middot; [对比](#差异化对比) &middot; [演示](#真实工作流) &middot; [快速开始](#快速开始) &middot; [工具](#工具) &middot; [架构](#架构) &middot; [安全](#安全模型)

</div>

---

## 特性

<table>
<tr>
<td width="33%" valign="top">
<h3 align="center">全看见</h3>
<p align="center">结构化页面模型返回可操作控件、语义区域、框架和可继续展开的资源入口 &mdash; 无需截图猜测。</p>
</td>
<td width="33%" valign="top">
<h3 align="center">真办事</h3>
<p align="center">通过浏览器原生能力执行页面 JavaScript、可信输入、Chrome API、CDP 命令、标签页操作、上传和下载。</p>
</td>
<td width="33%" valign="top">
<h3 align="center">能兜底</h3>
<p align="center">写操作返回有界的页面变化。显式预期返回目标级验证结果和差异。每个操作都留下结构化证据。</p>
</td>
</tr>
</table>

Browser Pilot 直接使用 Chrome 或 Edge 中**已打开**的标签页和登录会话。无需无头浏览器，无需独立配置文件，无需多模态模型 &mdash; 只需对真实标签页的结构化控制。

## 差异化对比

| | Browser Pilot | 截图式 AI | Puppeteer / Playwright | Selenium |
|---|---|---|---|---|
| **真实浏览器标签页** | 是 &mdash; 使用你已登录的会话 | 无头或独立配置文件 | 无头或启动新实例 | 无头或启动新实例 |
| **页面理解方式** | 结构化 DOM 模型 | 像素级图像推理 | 手动选择器 | 手动选择器 |
| **操作精度** | 引用定向，确定性 | 坐标点击，易出错 | CSS / XPath 选择器 | CSS / XPath 选择器 |
| **结果验证** | 内置，目标级差异 | 重新截图 + LLM 猜测 | 手动断言 | 手动断言 |
| **证据链** | 每次操作的结构化产物 | 仅截图 | 截图 / 轨迹 | 截图 / 日志 |
| **需要多模态** | 否 | 是 | 否 | 否 |
| **AI 智能体原生** | MCP 工具，可组合 | 因实现而异 | 库 API | 库 API |

## 真实工作流

每个 GIF 展示一项完整的浏览器任务：目标、可见操作和验证结果。在隔离的 Edge 会话中录制，所有操作均通过 Browser Pilot 公开工具完成。

### 创建并验证支持工单

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/demo-form-verification.gif" alt="Browser Pilot 观察支持表单，填写字段，通过可信输入提交并验证结果" width="100%">

### 查找并打开逾期发票

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/demo-structured-research.gif" alt="Browser Pilot 通过观察得到的引用筛选发票表格，并打开匹配记录" width="100%">

### 同步库存并验证结果

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/demo-network-evidence.gif" alt="Browser Pilot 同步西区仓库库存并验证更新后的总量" width="100%">

## 快速开始

### 第 1 步 &mdash; 安装扩展

```bash
npx --yes browser-pilot-mcp@latest install
```

安装器会把扩展复制到 `~/.browser-pilot/extension`，并自动打开对应的 Chrome 或 Edge 扩展管理页。首次安装时，启用**开发者模式**，点击**加载已解压的扩展程序**，选择命令输出的目录。

> 此确认无法被脚本绕过 &mdash; 这是浏览器安全策略的强制要求。

同时安装了两个浏览器时，可通过 `--browser edge` 或 `--browser chrome` 指定。npm 包升级后再次运行安装命令，然后在自动打开的页面点击**重新加载**。

### 第 2 步 &mdash; 配置 MCP 客户端

```toml
[mcp_servers.browser-pilot]
command = "npx"
args = ["--yes", "--package", "browser-pilot-mcp@latest", "browser-pilot-mcp"]
```

首次调用工具时，MCP 进程会自动启动或复用本地守护进程。产物资源默认写入 MCP 客户端提供的第一个文件系统根目录；不支持 Roots 的客户端会依次回退到 `BROWSER_PILOT_PROJECT_ROOT` 和进程工作目录。

<details>
<summary><strong>从源码构建</strong></summary>

```bash
git clone https://github.com/wklwkl115/browser-pilot.git
cd browser-pilot
npm ci
npm run build
npm run build:bridge
npm run mcp -- install
```

然后将 MCP 客户端的 `command` 设为 `node`，并指向 `dist/src/apps/mcp/bin.js`。

</details>

## 工具

Browser Pilot 提供 5 个可组合的 MCP 工具：

| 工具 | 用途 |
|---|---|
| `browser_observe` | 返回精简的页面内容、可执行操作、页面变化和可展开的语义资源。 |
| `browser_execute` | 在当前标签页或引用所属标签页中执行页面 JavaScript。 |
| `browser_command` | 执行可信输入以及经过校验的浏览器原生命令或 CDP 操作。 |
| `browser_tabs` | 列出、切换、创建或关闭已连接的浏览器标签页。 |
| `browser_screenshot` | 以 MCP 图片资源返回当前视口或完整页面截图。 |

MCP 的 `tools/list` 响应是公开语法的准确信息源。[`src/commands/commandCatalog.ts`](src/commands/commandCatalog.ts) 维护公开工具列表，各个 `*Command.ts` 模块维护对应的参数结构和处理逻辑。原生命令结构可通过 `browser-pilot://native-command/<cmd>` 资源读取。

`browser_observe` 支持 `mode: "auto" | "full" | "diff"` 和 `visual: "auto" | "always" | "never"`。内联结果只保留当前决策需要的数据，无法继续压缩的内容通过带类型的观察资源提供。`browser_tabs` 始终返回 `{ "tabs": [...] }`；`browser_screenshot` 返回截图元数据和图片资源。

## 智能体工作流程

```text
观察  ->  选择 bp-ref  ->  执行脚本或命令  ->  验证  ->  收集证据
```

1. **从活动标签页开始。** 省略 `targetRef` 时使用当前选中的标签页。只在需要区分时列出标签页；任务确实需要时再创建、切换或关闭。
2. **按需观察。** 只有需要理解页面时才调用 `browser_observe`。观察结果中的 `bp-ref` 会让后续操作自动路由到引用所属标签页。
3. **选对工具。** 页面 JavaScript 使用 `browser_execute`，原生浏览器操作使用 `browser_command`。同一页面内能够确定执行的 JavaScript 应合并到一次调用中。
4. **验证写操作。** 写操作需要验证时添加 `expect`。只有下一步决策依赖新页面状态时才重新观察。

<details>
<summary><strong>执行与验证约定</strong></summary>

`browser_execute` 提供 `browserPilot.refs`、`resolve(ref)`、`box(ref)` 和 `setValue(target, value)`。写操作按目标串行执行，并自动使用扩展/CDP 回退路径。

成功的 `browser_execute` 和 `browser_command` 调用返回 `{ "result": ..., "effect"?: ..., "verification"?: ... }`；写操作可能附带 `effect` 和 `verification`。`expect` 可以是返回真值的 JavaScript 表达式，也可以是结构化的引用/状态后置条件，例如 `{ "ref": "bp-ref://control/...", "state": { "pressed": true } }`。结构化验证会在命令执行前后读取同一引用，融合 DOM 与目标可访问性状态，并返回目标级差异。

原始 CDP 命令使用 `command: { cmd: "cdp", method: "Domain.method", params: {...} }`。目标仍通过工具级 `targetRef` 指定；运行时会话、物理目标、超时、附加和清理状态不属于公开参数。

</details>

## 架构

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/browser-pilot-flow.svg" alt="Browser Pilot 将 MCP 请求经由本地守护进程和 Manifest V3 扩展发送到真实浏览器标签页" width="100%">

```text
AI 智能体
   |  MCP stdio
   v
MCP 进程  --本地 IPC-->  Node 守护进程
                          |  WebSocket 桥接
                          v
                   offscreen 传输层
                          |
                          v
                 MV3 Service Worker
                          |  Chrome API / CDP
                          v
                  Chrome 或 Edge 标签页
```

| 状态 | 所有者 |
|---|---|
| MCP 协议和项目根目录 | 每个智能体独立的 MCP 进程 |
| 守护进程生命周期 | 用户本地守护进程 |
| 连接、待处理请求和目标写入队列 | `BrowserBridgeServer` |
| 当前浏览器和标签页会话 | 会话注册表 |
| Chrome API 和 CDP 会话 | MV3 Service Worker |
| 已捕获证据 | 请求级项目产物根目录 |

源码按职责组织：`src/apps` 包含 MCP 服务器和守护进程；`src/bridge` 负责传输与扩展；`src/commands` 维护公开工具结构和编排；`src/browser-command-runtime` 准备命令执行；`src/browser-page-runtime` 执行页面脚本；`src/browser-runtime` 适配浏览器 I/O；`src/kernels` 保持纯逻辑。页面扫描位于 `src/scan` 和 `capture-src`，观察结果组装位于 `src/commands/observe`。

<details>
<summary><strong>项目结构</strong></summary>

```text
browser-pilot/
├── src/
│   ├── apps/                  # MCP 服务器 + 守护进程入口
│   │   ├── daemon/            # 本地 Node 守护进程
│   │   └── mcp/               # MCP stdio 服务器
│   ├── bridge/                # 传输 + 扩展
│   │   ├── extension/         # MV3 Service Worker、内容脚本
│   │   ├── server/            # 桥接 HTTP + WebSocket 服务器
│   │   └── protocol/          # 原生命令 schema
│   ├── commands/              # 公开工具 schema + 编排
│   │   └── observe/           # 页面观察组装
│   ├── kernels/               # 纯逻辑（无 I/O）
│   │   ├── abml/              # 可访问性模型层
│   │   ├── evidence/          # 证据提炼
│   │   ├── refs/              # 引用解析
│   │   └── session/           # 会话生命周期
│   ├── scan/                  # 页面扫描 + 噪声规则
│   └── utils/                 # 共享工具
├── bridge/                    # 生成的扩展包
├── docs/assets/               # 图表 + 演示 GIF
├── scripts/                   # 构建 + 开发脚本
└── tests/                     # 测试套件
```

</details>

## 安全模型

- WebSocket 桥**只**接受来自已配置 Browser Pilot 扩展来源的升级请求；扩展报告的构建版本过期时，命令分发会拒绝执行。
- 页面内容**始终**是不可信输入。
- Browser Pilot **不会**移除页面安全响应头，也**不会**屏蔽页面对话框。
- 安全漏洞请通过 GitHub 私密漏洞报告提交。如果该功能不可用，只在公开 issue 中请求私密联系方式 &mdash; 不要附带密钥、令牌或未脱敏证据。

## 开发

**环境要求：** Node.js 22+、Chrome 或 Edge，以及用于执行仓库任务的 [`mise`](https://mise.jdx.dev/)。

```bash
mise run verify          # 统一检查：类型检查 + lint + 测试 + 构建
mise run smoke-browser   # 浏览器集成冒烟测试
```

运行时代码位于 `src/` 和 `capture-src/`；`dist/` 与 `bridge/browser_pilot_bridge/` 是生成目录。桥接主机和端口范围由 `bridge/browser_bridge_config.json` 管理 &mdash; 修改后运行 `npm run sync:config`。

## 贡献

欢迎贡献。请先开 issue 讨论你想改变的内容。

1. Fork 本仓库
2. 创建功能分支（`git checkout -b feat/amazing-feature`）
3. 提交更改（`git commit -m 'feat: add amazing feature'`）
4. 推送到分支（`git push origin feat/amazing-feature`）
5. 发起 Pull Request

提交前请确保 `mise run verify` 通过。

## 许可证

本项目使用 [Apache-2.0](LICENSE) 许可证。嵌入依赖的许可证请参见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。

---

<div align="center">

为需要真正办事的 AI 智能体而造。

[报告 Bug](https://github.com/wklwkl115/browser-pilot/issues) &middot; [请求功能](https://github.com/wklwkl115/browser-pilot/issues) &middot; [GitHub](https://github.com/wklwkl115/browser-pilot)

</div>
