# ARCHIVE

> 历史已完成工作归档。当前执行入口见 `CURRENT.md`；未来路线见 `ROADMAP.md`。

## 最新完成归档（241-261 已完成）

- 241：完成 jshookmcp 能力原生吸收闭环。边界冻结为“只吸收功能思想和证据模型，不新增被拒绝的五个公开工具面”；交付 5 个 synthetic eval、fixtures、closure ledger、`browser_hook listTargets/installTargets`、contracts、全量 `npm run check`。
- 242：完成 `browser_scan` high-entropy summary v2。默认 summary 升级为 Scan Manifest，新增 `focus.primary_actions/forms/lists/text_signals` 与 `artifact_hints` 精确 jsonPath 导航，保留 artifact-first 和 legacy `actionables/list_hints` 紧凑字段；新增 `16-scan-high-entropy-summary` eval、fixture、contracts、`smoke:browser:scan-summary` runtime smoke。
- 243：完成 Debugger evidence workflow 的 RFC/eval 收口。`browser_execute` + `persistent_cdp` 已能稳定提供 debugger evidence；剩余缺口收缩为 page-authored provenance 与 pause/breakpoint/step 生命周期，继续保持 RFC-only，不新增公开调试工具。
- 244-249：完成工具面治理收口：`browser_observe` 成为观察层 canonical surface；`browser_execute`/`browser_command` 拆分；recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata、Web Security capability profiles 全部落地，并通过本地 contracts 与文档同步门禁。
- 250-256：完成 build/test/doc 工程治理首版收口：`verify:bridge:dist` 取代 `check` 隐式重建；新增 `test:unit`（Node `node:test`）并接入 `npm run check`；service worker entry 试开 tree-shaking；browser cookie binding 文案统一改为“HTTP request header injection”；build-manifest 模块清单改为 metadata-only 命名；补充 `docs/hook-dispatcher-multi-file-evaluation.md`；新增 `.github/workflows/check.yml` 作为外部 CI merge gate；package 边界继续以 `npm pack --dry-run --json` 验证。
- 257-261：完成维护入口图、protocol 单源剩余消费收口、纯逻辑 unit test 扩面、mature bridge 结构化预检诊断和顶层文档去重：新增 `docs/maintainer-map.md`；`bridge/native_command_schema.json` 与 generated protocol/runtime/docs 增加 mature bridge 错误码与 metadata helper；`src/tools/webSecurity/shared/matureBridge.ts` 收口 sqlmap/nuclei launcher probe/process timeout/failure record；`browser_sqlmap_bridge` / `browser_nuclei_bridge` 前移 target/template/launcher 失败；README/contracts/unit tests 全部同步，并通过 `npm run sync:protocol`、`npm run docs:generate`、`npm run test:unit`、`npm run check:web-security`、`npm run check`。
- 后续收口：完成 cross-tool evidence correlation metadata。distilled envelope、artifact summary、workflow eval、sample result 与 runtime smoke 全部补齐：`browser_observe` / `browser_execute` / `browser_command` / native action / `browser_evidence` / Web Security follow-up 工具统一暴露 `operationId`、`snapshotId`、`requestId`、`waitId`、`listenerId`、`sessionId`、`selectionVersion*`、`sourceMode`；`browser_artifact` 输出 `correlationPaths`；新增 `21-cross-tool-correlation-chain` eval 与 `smoke:browser:correlation-chain`，并通过 `npm run check` 与真实 runtime smoke 验证。
- 下阶段 workstream phase 1：完成请求/响应拦截与热补丁原语。以 internal/native primitive 形式接入 `intercept.install` / `uninstall` / `status` / `listRules` / `addRule` / `removeRule` / `collect` / `pause` / `continue` / `fail` / `fulfill`，并完成手工 fulfill、自动 fulfill、`replaceScript` 与 uninstall fail-closed 的真实浏览器 smoke 验证；继续保持不新增广义公开拦截工具的边界。关键证据：`.pi/browser-artifacts/smoke-browser-intercept-response-results.json`、`.pi/browser-artifacts/smoke-browser-intercept-replace-script-results.json`、`.pi/browser-artifacts/smoke-browser-intercept-uninstall-fail-closed-results.json`。
- 下阶段 workstream phase 2：完成请求/响应拦截与热补丁原语收尾。`intercept.continue` / auto-`continue` 已支持有界 request mutation（method/url/headers/body）与 `mutationSummary`；`intercept.install` 已支持 `stages` 选择；driver 已把 interception 写命令纳入 lease/queue 语义；真实浏览器 smoke 已验证 request-mutate、tab-close-cleanup、lease-conflict 三条路径。关键证据：`.pi/browser-artifacts/smoke-browser-intercept-request-mutate-results.json`、`.pi/browser-artifacts/smoke-browser-intercept-tab-close-cleanup-results.json`、`.pi/browser-artifacts/smoke-browser-intercept-lease-conflict-results.json`。
- 下阶段 workstream：完成 JS AST / 反混淆分析原语 phase 1。已落 internal-only parse/summary/reduction helpers（`src/tools/webSecurity/shared/jsAst.ts`、`jsAstArtifact.ts`、`jsAstShell.ts`）、compact summary adapter（`src/tools/summaries/webSecurity/jsAst.ts`）、internal slash-command path（`/browser-js-ast`），并通过 local fixtures 覆盖 imports/exports/function inventory、可疑模式摘要、string-array/decoder/constant folding、alias propagation、object-dispatch readability reduction、artifact output convention 与 eval/sample-result 同步。关键证据：`evals/browser-workflows/22-js-ast-artifact-summary.md`、`evals/browser-workflows/results/22-js-ast-artifact-summary.result.json`、`tests/unit/webSecurity/shared/jsAst.test.ts`、`tests/unit/webSecurity/shared/jsAstShell.test.ts`、`tests/unit/tools/jsAstSummary.test.ts`。
- 下阶段 workstream：完成 DOM 事件链 / sink-flow 分析辅助 phase 1。已在既有 `browser_hook` canonical surface 下落 internal/native actions：`getNodeListeners`、`getListenerChain`、`getSinkHints`；已补 selector-scoped listener/source/sink evidence 提取、compact summary adapter、本地 fixture、eval spec 与 sample result，同步保持 evidence-assist 边界，不新增公开 DOM-flow 工具，也不承诺 full taint engine。关键证据：`evals/browser-workflows/fixtures/dom-flow-listeners.html`、`evals/browser-workflows/23-dom-flow-listener-chain.md`、`evals/browser-workflows/results/23-dom-flow-listener-chain.result.json`、`evals/browser-workflows/24-dom-flow-sink-hints.md`、`evals/browser-workflows/results/24-dom-flow-sink-hints.result.json`、`tests/unit/tools/domFlowSummary.test.ts`。
- 下阶段 workstream：完成 Wasm 逆向桥接 phase 1。已落 Wasm metadata helpers（`src/tools/webSecurity/shared/wasmArtifact.ts`）、mature-bridge-first `.wat` helper（`wasmBridge.ts`）、compact summary adapters（`src/tools/summaries/webSecurity/wasm.ts`、`wasmBridge.ts`）、internal slash-command path（`/browser-wasm`），并通过本地 fixtures 覆盖 Wasm header/version/hash/section/import/export counts、launcher-unavailable diagnostics、`.wat` bridge artifact path、eval/sample-result 同步。关键证据：`evals/browser-workflows/25-wasm-artifact-metadata.md`、`evals/browser-workflows/results/25-wasm-artifact-metadata.result.json`、`evals/browser-workflows/26-wasm-wat-bridge.md`、`evals/browser-workflows/results/26-wasm-wat-bridge.result.json`、`tests/unit/webSecurity/shared/wasmArtifact.test.ts`、`tests/unit/webSecurity/shared/wasmBridge.test.ts`、`tests/unit/tools/wasmSummary.test.ts`、`tests/unit/tools/wasmBridgeSummary.test.ts`。
- 下阶段 workstream：完成 Stateful WebSocket replay/fuzz primitives phase 1。已落 tab-scoped session/transcript model（`bridge_src/service_worker/ws_model.ts`）、internal/native `ws.open/status/send/replay/wait/collect/close`、Node-side explicit helper/shell（`src/tools/webSecurity/shared/wsSession.ts`、`wsShell.ts`）、compact summary adapter（`src/tools/summaries/webSecurity/ws.ts`）、internal slash-command path（`/browser-ws`），并补 bounded replay、replay failure diagnostics（`stepIndex` / `lastSeq` / `partialSteps` / `partialTranscript`）、partial transcript artifact、`27-websocket-session-transcript` eval/sample-result 以及真实浏览器 + 本地 `WebSocketServer` opt-in runtime smoke。关键证据：`evals/browser-workflows/27-websocket-session-transcript.md`、`evals/browser-workflows/results/27-websocket-session-transcript.result.json`、`tests/unit/webSecurity/shared/wsSession.test.ts`、`tests/unit/webSecurity/shared/wsShell.test.ts`、`tests/unit/tools/wsSummary.test.ts`、`tests/smoke/smoke-websocket-session.mjs`、`.pi/browser-artifacts/smoke-browser-websocket-session-results.json`。
- 工程债修复批次：完成此前架构缺陷核验后要求的逐项修复。Driver 端新增 WS JSON/handler 错误日志、heartbeat/stale client 清理、pending stop 全拒绝、queue depth 上限与 `QUEUE_FULL`、snapshot TTL prune；Bridge 端 CSP bypass 从全局 DNR 改为 tab-scoped TTL、WS listener 全路径 cleanup；工具层收口共享 `normalizeTabId/isRecord`、`browser_tabs` 统一 `BrowserBridgeError`、枚举参数改 TypeBox literal union、`browser_callback_oast` trigger 等待参数改为 `triggerTimeoutMs` 并兼容旧 `timeoutMs`；补关键 driver 单测、Node coverage 入口、AST 化工具注册 contract 和文档/skill 同步。验证：`npm run build:bridge`、`npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`、`npm run test:coverage`、global skill quick_validate。
- 第二轮深度缺陷修复批次：完成 callback OAST `sessionId` 安全 slug、动态 HTTPS 证书生成、stale-lock token 校验、`maxRuntimeMs` 生命周期上限；WebSecurity `wordlistPath` 收口到 cwd/.pi 有界本地文件、private/link-local/metadata 目标默认阻断并通过 `allowPrivateTargets` 显式放开、sqlmap/nuclei 显式 launcher override 改为 `allowLauncherOverride:true`；MV3 restart 后为 network/intercept/ws 增加轻量 runtime-state 诊断；移除 content page-script 旧 DOM 命令通道；阻断 `javascript:`/`data:` 导航；为 template/fuzz/sqli 增加总请求或有界 case/candidate 累积；为 summary 增加最终 hard-cap；CI 新增 `check:lint`、去掉重复 full-check job，npm 包排除 `bridge/tmwd_cdp_bridge/` legacy 目录。验证：`npm run check`、`npm run test:coverage`、`npm run smoke:browser:isolated`、`quick_validate.py D:/Pi/agent/skills/pi-browser-tools`。

## 历史整理归档（1-162 已完成）

- 1-26：原生 Pi Browser Bridge、协议 schema、工具注册拆分、resultMiddleware/artifact/detailLevel、`browser_pick`/`browser_content` 基础能力完成。
- 27-73：历史动作拆分与 semantic DOM 工具已复审撤回；当前工具面收敛为 scan/content/execute/wait/network/hook/evidence/frame/html/screenshot/artifact 等组合能力，复杂交互走 `browser_scan` + `browser_execute`。
- 74-102：Web 执行面已落地并归档：recon/crawl/path-vhost-param fuzz/http replay/cookie/sqli/template/OAST/sqlmap/nuclei；单包分层、budget、summary、artifact、raw/HAR/captured request 链路与成熟引擎 bridge 契约完成。
- 103-126：Bug report C/H/M/L 批次已处理；覆盖 BrowserBridge session/tab、WS origin/retry、upload/download、transport/tab_sync、network/wait/hook/html/screenshot、JSON/router 等边界修复与契约。
- 127-129：默认 tab 竞态可观测化、MV3 长等待短租约 supervisor、Bridge JS `checkJs` 类型栅栏已完成。
- 130-156：桌面审计报告 Bug 1-26 已完成；覆盖 wait deadline、BrowserBridge/tab 路由、native 命令、内容/下载/截图、ReDoS/安全预算、契约与 README/CHANGELOG/skill 同步。
- 157-162：Bug 28+ 当前基线复核完成；已覆盖项与 callable 子集证据已归档，剩余未覆盖/部分覆盖项全部转入 TODO 163-174。
- 历史归档不再作为执行队列；Bug 审计队列与当前 TODO 195-233 执行队列均已收口，新增能力必须先补 TODO 决策、边界文档、契约与验证计划。


## 近期完成归档（163-179 已完成）

- 163-174：桌面缺陷审计剩余项已收口；覆盖 download mode、hook session/listener lifecycle、pick timeout、performance/evidence timeout、frame script lifecycle、wait.diagnose、html/artifact/content/scan 保真和真实 runtime callable 子集验证。关键证据：`.pi/browser-artifacts/todo174-runtime-callable-summary-reload.json`。
- 163A：`browser_network` 默认有界捕获 XHR/Fetch/Document JSON/text/html response body 与 request postData，`bodyAvailability/bodyUnavailableReason` 已落地，避免原始浏览器响应证据缺失不透明。
- 175-177：WebSecurity TS 注册层、summary 层和参数 shell 已按能力拆分并类型收口；`registerWebSecurityTools.ts` 14 行 facade，`src/tools/summaries/webSecurity.ts` 1 行 facade，契约锁定 12 个安全工具 schema/summary/artifact 行为不漂移。
- 178-179：Bridge Network recorder 已拆为 `network_model.js`（状态/配置/过滤/body 存储）与 `network.js`（CDP 事件/生命周期/命令分发），保留 `patterns.js -> wait.js -> network_model.js -> network.js` 加载顺序；`npm run check` 已通过，真实扩展 runtime 子集通过。关键证据：`.pi/browser-artifacts/runtime-bridge-validation-results.json`、`.pi/browser-artifacts/screenshot-1779252971729.png`。
- 历史归档不再作为执行队列；需要细节时回看 git：`cce5bd9`、`00141c6`、`6665217` 及对应契约文件。

## 历史阶段摘要

- Bridge ESM / dist runtime历史摘要见 `docs/archive/bridge-esm-history.md`
- 本地工程治理期历史摘要见 `docs/archive/governance-history.md`
- 已撤回 orchestration / target resolver / profile isolation历史摘要见 `docs/archive/orchestration-history.md`
- 更细历史拆分建议与仍保持 future-facing 的非激活项见 `docs/archive-history-compression-plan.md`。

## 详细历史记录已迁出

逐条历史明细已迁到以下文件：

- `docs/archive/bridge-esm-history.full.md`
- `docs/archive/governance-history.full.md`
- `docs/archive/orchestration-history.full.md`

主 `ARCHIVE.md` 只保留阶段摘要与入口索引，避免继续膨胀。

- 仓库收敛：历史上曾存在 `.pi/public-export/pi-browser-tools` 独立副本仓库；其缺失实现与 tests/evals 已回灌到正式源码树，之后外层仓库作为唯一真源，导出目录不再承担开发职责。
