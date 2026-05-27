# ARCHIVE

> 历史已完成工作归档。当前执行入口见 `CURRENT.md`；未来路线见 `ROADMAP.md`。

## 最新完成归档（241-261 已完成）

- 241：完成 jshookmcp 能力原生吸收闭环。边界冻结为“只吸收功能思想和证据模型，不新增被拒绝的五个公开工具面”；交付 5 个 synthetic eval、fixtures、closure ledger、`browser_hook listTargets/installTargets`、contracts、全量 `npm run check`。
- 242：完成 `browser_scan` high-entropy summary v2。默认 summary 升级为 Scan Manifest，新增 `focus.primary_actions/forms/lists/text_signals` 与 `artifact_hints` 精确 jsonPath 导航，保留 artifact-first 和 legacy `actionables/list_hints` 紧凑字段；新增 `16-scan-high-entropy-summary` eval、fixture、contracts、`smoke:browser:scan-summary` runtime smoke。
- 243：完成 Debugger evidence workflow 的 RFC/eval 收口。`browser_execute` + `persistent_cdp` 已能稳定提供 debugger evidence；剩余缺口收缩为 page-authored provenance 与 pause/breakpoint/step 生命周期，继续保持 RFC-only，不新增公开调试工具。
- 244-249：完成工具面治理收口：`browser_observe` 成为观察层 canonical surface；`browser_execute`/`browser_command` 拆分；recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata、Web Security capability profiles 全部落地，并通过本地 contracts 与文档同步门禁。
- 250-256：完成 build/test/doc 工程治理首版收口：`verify:bridge:dist` 取代 `check` 隐式重建；新增 `test:unit`（Node `node:test`）并接入 `npm run check`；service worker entry 试开 tree-shaking；browser cookie binding 文案统一改为“HTTP request header injection”；build-manifest 模块清单改为 metadata-only 命名；补充 `docs/hook-dispatcher-multi-file-evaluation.md`；新增 `.github/workflows/check.yml` 作为外部 CI merge gate；package 边界继续以 `npm pack --dry-run --json` 验证。
- 257-261：完成维护入口图、protocol 单源剩余消费收口、纯逻辑 unit test 扩面、mature bridge 结构化预检诊断和顶层文档去重：新增 `docs/maintainer-map.md`；`bridge/native_command_schema.json` 与 generated protocol/runtime/docs 增加 mature bridge 错误码与 metadata helper；`src/tools/webSecurity/shared/matureBridge.ts` 收口 sqlmap/nuclei launcher probe/process timeout/failure record；`browser_sqlmap_bridge` / `browser_nuclei_bridge` 前移 target/template/launcher 失败；README/contracts/unit tests 全部同步，并通过 `npm run sync:protocol`、`npm run docs:generate`、`npm run test:unit`、`npm run check:web-security`、`npm run check`。

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
