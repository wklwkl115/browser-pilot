# Pi Browser Tools SOP：安装与环境配置

本 SOP 只覆盖项目安装、浏览器桥安装、环境配置、reload、验证和排障。正式使用方式由 skill 负责。skill 源在仓库内 `skills/pi-browser-tools/SKILL.md`（版本管理的单一来源），部署到全局 `D:/Pi/agent/skills/pi-browser-tools/SKILL.md` 供 Pi 加载。

发布入口说明：Pi runtime 继续通过 `pi.extensions: ["./index.ts"]` 加载源码入口；npm/package `main`/`types`/`exports` 与 `pi-browser` CLI bin 使用 `dist/` 编译产物。

## 适用路径

- 项目目录：`D:/Pi/agent/extensions/pi-browser-tools`
- 浏览器扩展目录：`D:/Pi/agent/extensions/pi-browser-tools/bridge/pi_browser_bridge`
- skill 源（仓库内，单一来源）：`skills/pi-browser-tools/SKILL.md`
- 全局 Pi skill 加载路径（部署目标）：`D:/Pi/agent/skills/pi-browser-tools/SKILL.md`

## 安装依赖

```bash
cd D:/Pi/agent/extensions/pi-browser-tools
npm install
```

## 配置 Bridge

默认配置通常无需修改：

- `PI_BROWSER_BRIDGE_HOST=127.0.0.1`
- `PI_BROWSER_BRIDGE_PORT=18765`
- `PI_BROWSER_BRIDGE_PORT_RANGE_END=18784`
- `PI_BROWSER_TOOL_PROFILE=security`（默认；设为 `core` 可隐藏 Web Security follow-up tools）
- `PI_BROWSER_USAGE_LOG`（开发期临时用法日志，默认关）：设为 `1` 写入 `.pi/usage/usage-YYYYMMDD.jsonl`，或设为某个 `.jsonl` 路径写到指定文件；每个工具调用一行 JSON（tool/args/result/ms/bytes，args 默认脱敏）。`PI_BROWSER_USAGE_LOG_RAW=1` 关闭脱敏（不建议）。仅挂在 `on_log` 中间件钩子上、best-effort 写入，不影响工具行为。

如需改端口：

1. 设置 Pi 进程环境变量 `PI_BROWSER_BRIDGE_PORT`，必要时设置 `PI_BROWSER_BRIDGE_PORT_RANGE_END`。
2. 同步 `bridge/browser_bridge_config.json` 后运行 `npm run build:bridge`，确认 dist runtime 内的 WebSocket 地址与端口范围一致。
3. 重新加载 Pi 会话和浏览器扩展。

## 安装浏览器扩展

方式一：在 Pi 中执行：

```text
/browser-install
```

然后按提示在 Chrome/Edge 打开扩展管理页，加载目录：

```text
D:/Pi/agent/extensions/pi-browser-tools/bridge/pi_browser_bridge
```

方式二：手动安装：

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `bridge/pi_browser_bridge`。
5. 确认扩展名称为 `Pi Native Browser Bridge`。
6. 确认扩展权限包含 downloads 和 webNavigation；更新后需重新加载扩展才能启用 `browser_download` 路径回传和 `wait.navigation` 事件完成监听。
7. 如需 `browser_upload` 读取本地文件路径，在扩展详情中启用「允许访问文件网址」。

## Reload 流程

- 修改 Pi extension TypeScript 后：在当前 Pi 会话执行 `/reload`，或新开会话。
- 修改浏览器扩展文件后：执行 `/browser-reload`，或在浏览器扩展页点击重新加载。
- 修改 skill 后：直接编辑仓库内 `skills/pi-browser-tools/SKILL.md`（全局加载路径是指向它的目录 junction，改动即时生效），然后执行 `/reload`，或新开 Pi 会话。

## 验证

项目静态与契约验证（脚本位于 `tests/contracts/`）：

```bash
npm run build
npm run check
npm run check:all:bridge
npm run check:all:package
npm run check:all:contracts
```

本地发布/合并前质量门禁（本地脚本，不依赖 GitHub Actions/远程 CI，不启动真实浏览器）：

```bash
npm run quality:local
```

该门禁串联 `npm run build:bridge`、`npm run check`、`npm pack --dry-run --json`；当前 `prepack` 会先执行 `npm run build` 生成 outer `dist/`，再 quiet build bridge dist。成功后只打印可选 isolated smoke 下一步。`npm run check` 现由 `scripts/run-check-groups.mjs` 聚合 bridge/unit、package/docs、contracts 三组，可按故障域单独运行 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`；`.github/workflows/check.yml` 也直接复用这三组入口。需要结构化回归摘要时可运行 `node scripts/run-check-groups.mjs --json ...`，结果写入 `.pi/browser-artifacts/check-groups-summary.json`。失败时先看当前命令输出；runtime/smoke 类 artifact 默认在 `.pi/browser-artifacts/`；端口占用按 `.pi/browser-artifacts/smoke-browser-results.json` 的 `bridge.port` PID/原因人工处理，不自动 kill 进程。




本地依赖与生产安全审计（已纳入 `npm run check`；不接入远程 Dependabot/Sonar/Sentry）：

```bash
npm run check:deps
```

该命令校验 lockfile 一致性、生产依赖 allowlist、`npm ls --json --all` 和 `npm audit --omit=dev --audit-level=high`；摘要写入 `.pi/browser-artifacts/dependency-audit-summary.json`。registry/DNS/timeout 不可用时记录 `npmAudit.status:"unavailable"` 并通过，普通离线开发不被阻塞；高危/严重生产漏洞、lockfile 漂移或依赖树问题会失败。当前生产依赖 allowlist 为 `js-yaml`、`typebox`、`typescript`、`ws`、`zod`（MCP 壳移除后 `@modelcontextprotocol/sdk` 已下线）：其中 `typebox`/`typescript`/`zod` 被源码运行路径直接消费，不应机械移动到 devDependencies。

依赖升级记录必须包含：升级范围、兼容性风险、回滚方式、`npm run check`、`npm pack --dry-run --json`，必要时附 `npm run smoke:browser:isolated` artifact。错误统计只落本地 artifact，不发送 cookie/token/网络正文到外部服务。

工具/协议契约文档生成（已纳入 `npm run check:tool-docs` 的漂移检查）：

```bash
npm run sync:protocol
npm run check:protocol
npm run docs:generate
npm run check:tool-docs
```

生成产物为 `docs/generated/browser-tool-contract.generated.md`，来源是实际工具注册元数据、`bridge/native_command_schema.json` 和源码结构化错误码；其中 `Structured error taxonomy` 表列出公开 code、domain、category、retryable 与来源；不要手工编辑生成文件。文档结构规范见 `docs/document-structure.md`；修改 archive/roadmap/todo 入口或历史归档索引后先运行 `npm run docs:sync-indexes && npm run check`。

Native 协议单源为 `bridge/native_command_schema.json`。修改该文件后先执行 `npm run sync:protocol`，再执行 `npm run check:protocol`；脚本会生成 `bridge/pi_browser_bridge/native_command_schema.json`、`bridge_src/service_worker/protocol.ts`、`src/protocol/nativeProtocol.ts`、`src/protocol/nativeActionMetadata.ts`、`src/protocol/nativeErrorCodes.ts` 与 `docs/generated/native-protocol.generated.md`。这些生成文件禁止手改，`check:protocol` 会捕获 drift、schema 副本不一致、wait/network/transfer metadata 漂移和错误码漏项。仓库已接入 `lefthook` pre-commit：当 schema 变更时会自动执行 `npm run sync:protocol` 并 stage 生成产物；首次安装依赖后会通过 `npm run prepare` 自动安装 hook。

错误 taxonomy 与诊断契约（已纳入 `npm run check`）：

```bash
npm run check:errors
```

该契约锁定 `normalizeError` / `compactError` 保留公开 `code/message/details/name`，追加 `taxonomy` 与紧凑 `diagnostics`；覆盖 driver/tool/native/page/CDP/network/transfer/security/artifact/protocol 分类、nested bridge/native response、ArtifactReader、transfer、WebSecurity、stack strip、secret redaction 和 circular details。

Tool Registry / Adapter 注册层边界分别由 `src/tools/toolRegistry.ts` 与 `src/tools/toolAdapter.ts` 承载：前者维护 core/security 声明式注册顺序与 capability profile 分组，并由 `tests/unit/tools/toolRegistry.test.ts` + contracts 锁定顺序/唯一性/gating；后者负责共享 tab-scoped 参数、timeout/maxChars 归一、`runTool`、`jsonToolResult/textToolResult`、nested bridge error 与 artifact fallback。修改工具注册样板后至少运行 `npm run check:tools`、`npm run check:tool-docs`；涉及 WebSecurity shared shell 时同步运行 `npm run check:web-security`。

WebSecurity 子域边界验证（已纳入 `npm run check`）：

```bash
npm run check:web-security
```

该契约锁定 `register/browserNative/bridges/shared` 分层、`executeWebSecurityToolShell` 唯一执行 shell、browser-session cookie provider 单点、`webSecurity/shared/diagnostics.ts` domain failure envelope 脱敏/去 stack、sqlmap/nuclei bounded process + request/stdout/stderr artifact，以及 WebSecurity 不反向依赖 driver、bridge runtime 或 `chrome.*`。


Artifact 与证据隐私治理（已纳入 `npm run check`）：

```bash
npm run check:token
npm run check:artifact
```

默认 artifact 根目录是 `.pi/browser-artifacts/`，保存的原始证据标记为 `local_raw_evidence`、`localOnly:true`、手动清理。工具 summary/details/error 与 `browser_artifact` 默认脱敏 cookie/token/authorization/body/postData/websocket payload；只有明确需要本地原始证据时才对具体路径使用 `browser_artifact` 的 `redact:false`。清理命令：`rm -rf .pi/browser-artifacts/*`。不要上传或提交该目录。

本地生命周期 fixture（已纳入 `npm run check`，不启动真实浏览器）：

```bash
npm run check:lifecycle
```

该 fixture 覆盖多浏览器同数值 `tabId`、`selectBrowser`、WS 断连/重连、MV3 service worker restart、pending cleanup、tab command queue、wait/network/hook 长任务。失败时写 `.pi/browser-artifacts/lifecycle-fixture-failure.json`，包含 bridge snapshot、pending、target selection、listener/CDP/network recorder 状态；cookie/token/authorization/body/postData 等字段按字段名脱敏。

可重放 runtime fixture（已纳入 `npm run check`，不启动真实浏览器）：

```bash
npm run check:runtime-fixtures
```

该 fixture 使用本地 HTTP/WS server、fake Chrome/CDP API 与 recorded bridge envelopes，覆盖 network body/postData/HAR、hook session/listener、wait immediate/MV3 状态、transfer download/upload、frame evaluate、screenshot fallback、callback worker 状态文件和 stale lock recovery。成功摘要写 `.pi/browser-artifacts/fixtures/runtime-fixtures-summary.json`；失败诊断写 `.pi/browser-artifacts/fixtures/runtime-fixtures-failure.json` 并按字段名脱敏。

Bridge ESM TypeScript 构建管线（生成当前 manifest 使用的 service worker 与 content/hook/disable-dialogs dist bundles；支柱二终态已完成：TODO 197 shared/runtime/CDP/wait、TODO 198 command 层、TODO 199 router/transport/tab_sync 启动层均已走真实 ESM import graph，TODO 200 已开启 strict/noImplicitAny 并完成 page script 类型收口，TODO 202 已通过 build/check/pack/isolated-smoke gate；`build-manifest.json` 记录 `serviceWorkerBuildMode:"esm-import-graph"`、`orderedConcatenation:false` 与 metadata-only 模块清单；修改 `bridge_src/**` 后先 build 再 reload 扩展）：

```bash
npm run build:bridge
```

发布/安装包边界验证（会触发 `prepack` quiet build，并确认 manifest 指向的 dist runtime 进入 npm 包）：

```bash
npm pack --dry-run --json
```

`npm run check` 已包含 `verify:bridge:dist` 和 `check:package`：前者只读验证当前 dist，后者用 dry-run 验证 `dist/service-worker.js`、`dist/content.js`、`dist/disable_dialogs.js`、`dist/hook_dispatcher.js`、source maps 与 `build-manifest.json` 均进入包内；干净安装不应依赖手工提前 build。

本地发布包验收与回滚演练：

```bash
npm run release:local
PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run release:local:smoke
```

`release:local` 在 clean cwd 中执行 `npm pack --dry-run --json` 与实际 pack，解包检查 manifest dist 路径、dist runtime、native schema 和 build manifest，并把当前 tarball、上一成功 tarball、摘要保存在 `.pi/browser-artifacts/release-acceptance/`。`release:local:smoke` 额外加载当前解包扩展跑 full isolated smoke，并加载上一包跑最小 tabs/wait/execute 回滚 smoke。最终报告附：`release-acceptance-summary.json`、`current/pi-browser-tools-0.3.0.tgz`、`last-successful/release-metadata.json`、当前/回滚 smoke artifact；失败时查看 summary 的 `failureDiagnostics.packFiles/buildManifest/chromeProfile/bridgePort/smokeArtifact`。CI 如需显式启用这些 runtime 门禁，使用 `PI_BROWSER_CI_BROWSER_SMOKE=1`、`PI_BROWSER_CI_RELEASE_SMOKE=1`、`PI_BROWSER_CI_ROLLBACK_SMOKE=1`。CI setup/build 共享步骤已抽到 `.github/actions/setup-node-build`。

skill 变更后按 skill-creator 要求验证（全局路径是指向仓库源的 junction，二者等价）：

```bash
PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools
```

> 全局加载路径 `D:/Pi/agent/skills/pi-browser-tools` 是指向仓库 `skills/pi-browser-tools` 的目录 junction。若仓库被移动/重新克隆，需重建：`cmd /c mklink /J "D:\Pi\agent\skills\pi-browser-tools" "D:\Pi\agent\extensions\pi-browser-tools\skills\pi-browser-tools"`。

真实浏览器 smoke（可选，需浏览器扩展已连接，且端口未被其它 bridge 占用）：

```bash
npm run smoke:browser
```

本地已有常驻 Pi agent/bridge 占用 18765 时，使用独占临时 Chrome/Edge profile：

```bash
npm run smoke:browser:isolated
```

验证 `browser_observe mode=scan` 的 high-entropy summary、`artifact_hints` 精确 `jsonPath` 后续动作和本地 scan fixture：

```bash
npm run smoke:browser:scan-summary
```

验证 `persistent_cdp` 驱动的 debugger evidence workflow、本地异常/stack/script source 证据和 cleanup：

```bash
npm run smoke:browser:debugger-evidence
```

验证 cross-tool correlation metadata 在 observe → execute → wait → artifact 链路里的 runtime 对账行为：

```bash
npm run smoke:browser:correlation-chain
```

验证 interception 自动 fulfill 规则路径的本地 runtime smoke：

```bash
npm run smoke:browser:intercept-response
```

验证 interception `replaceScript` 路径的本地 runtime smoke：

```bash
npm run smoke:browser:intercept-replace-script
```

验证 interception uninstall 后 fail-closed 行为的本地 runtime smoke：

```bash
npm run smoke:browser:intercept-uninstall-fail-closed
```

验证 interception `continueRequest` 请求改写（method/header/body）在 send 前生效的本地 runtime smoke：

```bash
npm run smoke:browser:intercept-request-mutate
```

验证 tab close 后 interception cleanup/fail-closed 诊断的本地 runtime smoke：

```bash
npm run smoke:browser:intercept-tab-close-cleanup
```

验证不同 browser session 在同一 tab 上进行 interception 写操作时的 lease-conflict 证明：

```bash
npm run smoke:browser:intercept-lease-conflict
```

验证 WebSocket session/replay 的本地 runtime smoke：

```bash
npm run smoke:browser:websocket-session
npm run smoke:browser:memory
```

WSL 调 Windows Edge 的已验证命令：

```bash
PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated
```

Chrome 在部分 Windows/WSL 组合下可能忽略 `--disable-extensions-except`，优先用上述 Edge 命令复现 isolated smoke。
如果需要在 WSL 下跑 correlation chain runtime smoke，可直接套同样的 `PI_BROWSER_SMOKE_CHROME=...` 环境变量。

如果 `127.0.0.1:18765-18784` 均被占用，smoke 会失败并在 `.pi/browser-artifacts/smoke-browser-results.json` 写入 `bridge.port` 诊断：

- `agent_occupies`：常驻 Pi agent/bridge 正在使用扩展固定端口；先停止该 agent 或空闲时再跑 smoke。
- `orphan_socket`：疑似遗留 node/smoke 进程占用端口；按输出 PID/命令行人工确认后关闭。
- `unknown_owner`：其它进程占用端口；按输出 PID/命令行排查。

smoke 只报告占用原因，不会自动 kill 用户进程。

上传/下载真实浏览器 smoke（显式执行，会创建临时上传文件并触发下载）：

```bash
npm run smoke:browser:transfer
```

输出 artifact 默认写入：

```text
.pi/browser-artifacts/
```

当前发布前全量手动 smoke 结果保留在：

```text
.pi/browser-artifacts/final-smoke/results.json
```

该结果覆盖 tabs/wait/observe(scan/content/html)/artifact/execute/pick/network/hook/evidence/frame/screenshot/download/upload（早期独立的 query/type/click/semantic DOM 动词已并入 `browser_execute`/`browser_observe`，不再是独立工具）；临时 tab/server/upload fixture/download 文件已清理。

## 排障

1. 在 Pi 中执行 `/browser-status`，确认 bridge、扩展、tabs、pending 状态。
2. 如果扩展未连接，检查端口、扩展是否启用、浏览器扩展是否重新加载。
3. 如果 tab 不可用，先用 `browser_tabs list` 确认目标 tab。
4. 如果命令超时，检查 `/browser-status` 的 pending 请求和目标页面是否阻塞。
5. 如果要做 internal-only JS AST 摘要，执行 `/browser-js-ast [path] [--slice offset:length] [--output file]`，或先把显式 JS 文本放进编辑器再执行 `/browser-js-ast`。大 bundle 会降级为 lexical inventory；需要 AST 时用 `--slice` 或 source map 归档源码。
6. 如果要做 internal-only Wasm 元数据/桥接摘要，执行 `/browser-wasm <path> [--wat] [--output file]`；`--wat` 依赖本地成熟桥接工具可用。
7. 如果要做 internal-only WebSocket session/transcript 原语，执行 `/browser-ws open <url> [--session id] ...`、`/browser-ws send --text ...`、`/browser-ws replay --step ... [--steps-json '[...]']`、`/browser-ws wait ...`、`/browser-ws collect [--output file]`、`/browser-ws close`。
8. 如果 `browser_observe mode=scan` 返回空结构，先用 `browser_tabs list` 切换到目标 tab，确认页面可见后重试。
9. 如果 artifact 读取失败，确认相对路径位于 `.pi/browser-artifacts/`；读取其它文件使用绝对路径；默认脱敏输出，确需原始本地证据时显式 `redact:false`。
10. 如果 `browser_download` 没有返回路径，重新加载浏览器扩展并确认 downloads 权限。
11. 如果 `browser_upload` 返回 file access 错误，在扩展详情启用文件网址访问后重试。

## 安全约束

- 不把 API key、cookie、密码、token 写入项目文件。
- 不把个人浏览器 profile、下载文件、截图 artifact 提交为项目代码。
- 真实浏览器 smoke 会创建临时页面和 artifact；完成后按需清理 `.pi/browser-artifacts/`，例如 `rm -rf .pi/browser-artifacts/*`。
