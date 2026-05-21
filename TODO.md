# TODO

## 当前状态

- 当前主链路：`browser_tabs` -> `browser_scan` / `browser_content` / `browser_html` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎仅以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- TODO 200-215 工程治理期已完成；后续新增能力必须先补 TODO 决策、边界文档、契约与验证计划。
- 状态协调器首个生产闭环已完成：`browser_orchestrate` 为当前 callable Node 组合工具；后续增强路线见 `docs/browser-orchestration-next-roadmap.md`，未完成增强不得写入当前 capability。
- 后续仍保持能力完整性：不削弱已实现工具能力，不新增工具层安全闸；安全边界继续由 Pi 平台/安全层负责。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。

## 工程治理期执行原则（TODO 200-215，已完成）

- 能力冻结：除阻断性 bugfix 外，不新增 callable tool、不新增默认扫描/自动化决策流、不扩大默认网络/文件/外部进程行为；新增能力必须由后续 TODO 显式解除冻结并给出迁移/回滚边界。
- 稳定优先：所有改动必须保持工具名、参数 schema、错误码、summary/artifact envelope、runtime smoke 证据链兼容，除非 TODO 明确迁移并提供回滚。
- 本地优先：质量门禁、依赖审计、发布验收、runtime fixtures 均先做本地脚本；不引入 GitHub Actions、Dependabot、Sentry、SonarQube、自动 registry 发布作为当前主线。
- 风险导向：测试补强优先覆盖多浏览器、MV3 重启、pending cleanup、长等待、network/hook/transfer 证据保真；不追求固定覆盖率数字。
- 审计优先：错误、artifact、redaction、发布包、协议生成都要可复现、可追踪、可本地验证；禁止 silent fallback、模糊默认和只靠文档声明的完成状态。

## 历史整理归档（1-162 已完成）

- 1-26：原生 Pi Browser Bridge、协议 schema、工具注册拆分、resultMiddleware/artifact/detailLevel、`browser_pick`/`browser_content` 基础能力完成。
- 27-73：历史动作拆分与 semantic DOM 工具已复审撤回；当前工具面收敛为 scan/content/execute/wait/network/hook/evidence/frame/html/screenshot/artifact 等组合能力，复杂交互走 `browser_scan` + `browser_execute`。
- 74-102：Web 执行面已落地并归档：recon/crawl/path-vhost-param fuzz/http replay/cookie/sqli/template/OAST/sqlmap/nuclei；单包分层、budget、summary、artifact、raw/HAR/captured request 链路与成熟引擎 bridge 契约完成。
- 103-126：Bug report C/H/M/L 批次已处理；覆盖 BrowserBridge session/tab、WS origin/retry、upload/download、transport/tab_sync、network/wait/hook/html/screenshot、JSON/router 等边界修复与契约。
- 127-129：默认 tab 竞态可观测化、MV3 长等待短租约 supervisor、Bridge JS `checkJs` 类型栅栏已完成。
- 130-156：桌面审计报告 Bug 1-26 已完成；覆盖 wait deadline、BrowserBridge/tab 路由、native 命令、内容/下载/截图、ReDoS/安全预算、契约与 README/CHANGELOG/skill 同步。
- 157-162：Bug 28+ 当前基线复核完成；已覆盖项与 callable 子集证据已归档，剩余未覆盖/部分覆盖项全部转入 TODO 163-174。
- 历史归档不再作为执行队列；Bug 审计队列已收口，当前从未完成 TODO 195 起推进，必要时回看 git diff、桌面报告与对应契约文件。


## 近期完成归档（163-179 已完成）

- 163-174：桌面缺陷审计剩余项已收口；覆盖 download mode、hook session/listener lifecycle、pick timeout、performance/evidence timeout、frame script lifecycle、wait.diagnose、html/artifact/content/scan 保真和真实 runtime callable 子集验证。关键证据：`.pi/browser-artifacts/todo174-runtime-callable-summary-reload.json`。
- 163A：`browser_network` 默认有界捕获 XHR/Fetch/Document JSON/text/html response body 与 request postData，`bodyAvailability/bodyUnavailableReason` 已落地，避免原始浏览器响应证据缺失不透明。
- 175-177：WebSecurity TS 注册层、summary 层和参数 shell 已按能力拆分并类型收口；`registerWebSecurityTools.ts` 14 行 facade，`src/tools/summaries/webSecurity.ts` 1 行 facade，契约锁定 12 个安全工具 schema/summary/artifact 行为不漂移。
- 178-179：Bridge Network recorder 已拆为 `network_model.js`（状态/配置/过滤/body 存储）与 `network.js`（CDP 事件/生命周期/命令分发），保留 `patterns.js -> wait.js -> network_model.js -> network.js` 加载顺序；`npm run check` 已通过，真实扩展 runtime 子集通过。关键证据：`.pi/browser-artifacts/runtime-bridge-validation-results.json`、`.pi/browser-artifacts/screenshot-1779252971729.png`。
- 历史归档不再作为执行队列；需要细节时回看 git：`cce5bd9`、`00141c6`、`6665217` 及对应契约文件。

## 当前架构债决策（支柱二/三/四）

- 支柱三（`wait.js` 解耦）已完成：wait 子系统拆为 `wait_cdp.js`、`wait_coordinator.js`、`wait_navigation.js`、`wait_network_idle.js`、`wait_selector.js` 与 299 行 `wait.js` facade。
- 支柱二（ESM + TS bundler）终态已完成：service worker 当前由 `bridge_src/service-worker.ts` 真实 ESM entry 构建，`dist/build-manifest.json` 记录 `serviceWorkerBuildMode:"esm-import-graph"`、`orderedConcatenation:false`、`legacyServiceWorkerModules:[]`；TODO 200 已开启 strict/noImplicitAny 并清零 bridge/page `@ts-nocheck`，TODO 202 已通过 build/check/pack/isolated-smoke gate。
- 支柱四（smoke 端口冲突）已完成当前阶段：默认 smoke 显式诊断端口占用，isolated smoke 可用独占 Chrome profile 验证 runtime；不引入 puppeteer/playwright。
- `network.js` 已完成拆分，不再列为待拆债务；`hook_dispatcher` 已作为独立 page bundle 进入 dist，但源码仍是大文件，后续只在真实收益明确时继续拆，不阻塞支柱二终态。

## 180. Bridge `wait.js` 职责拆分：只读依赖图与边界冻结

- [x] 性质判定：prerequisite refactor debt；目标是拆解 1239 行 `wait.js`，保持 `browser_wait`、TS `BrowserWaitSupervisor.ts`、MV3 service worker 短租约语义完全不变。
- [x] 只读图谱：已在 `docs/bridge-wait-split.md` 列出 `wait.js` 顶层状态、函数、Chrome/CDP 事件依赖、外部全局消费者和直接 VM fixture 暴露符号。
- [x] 拆分方案：冻结现有 `importScripts` 拓扑下的文件顺序和职责：`wait_cdp.js`（CDP refs/subscription/domain cleanup）、`wait_coordinator.js`（WaitCoordinator/wait id/event subscription/orphan GC）、`wait_navigation.js`（navigation/loadState/frame lifecycle）、`wait_network_idle.js`（networkIdle filter/calculator）、可选 `wait_selector.js`、`wait.js`（facade/command dispatch/diagnose glue）。
- [x] 不变式：`docs/bridge-wait-split.md` 记录并锁定 `timeoutMs:0` immediate probe、长等待 lease/supervisor metadata、orphan cleanup、CDP domain release retry、event listener tab scope、`wait.any/all` 空条件拒绝、错误码和 summary/artifact 字段不变。
- [x] 契约准备：`check-pi-browser-bridge.mjs` 改为 `readBridgeBundle()` + `waitBridgeFiles` 组合加载；`check-bridge-files.mjs` 改为 `waitBridgeRuntimeFiles/serviceWorkerBridgeFiles/assertBackgroundOrder()`，为后续 wait 子文件按真实顺序进入 VM fixture 做准备。
- [x] 文档：README 指向 `docs/bridge-wait-split.md`；CHANGELOG/TODO 记录本项为设计/契约准备，无行为改动，未更新 skill 能力描述。

## 181. Bridge `wait.js` 拆分第一刀：CDP refs/subscription 子系统

- [x] 执行边界：新增 `bridge/pi_browser_bridge/wait_cdp.js`，迁出 `piBrowserCdpSubscriptions`、`piBrowserCdpTabRefs`、`piBrowserCdpDomainRefs`、cleanup history、domain acquire/release/diagnose/subscriber helper；`wait.js` 不再直接持有 CDP refcount 状态，当前约 1039 行。
- [x] 加载顺序：`background.js` 保持 `runtime.js -> wait_cdp.js -> ... -> wait.js -> network_model.js` 顺序；当前经 TODO 182 扩展为 `runtime.js -> wait_cdp.js -> wait_coordinator.js -> wait.js -> network_model.js`，`check-bridge-files.mjs` 与 `check-pi-browser-bridge.mjs` 锁定 wait bundle 顺序和 `wait.js` facade 位置。
- [x] 不变式：保留 `Network.disable/Page.disable` 失败时 ref 保留、retry release、tab removed 不留 stale ref、subscriber cleanup 和 `diagnosePiBrowserCdpDomainRefs/Subscriptions/CleanupHistory` 结构。
- [x] 契约：fake CDP 测试覆盖 acquire/release、disable failure、retry release、tab cleanup、subscriber cleanup；`check-bridge-files.mjs` 锁定 `wait_cdp.js` 不包含 selector/navigation/networkIdle 业务，且 `wait.js` 不回吸 CDP maps/helper。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-refactor-execution && npm run check"` 已通过；本项为内部 service worker 拆分；后续 TODO 183 已继续拆分 wait 子系统并记录 smoke 端口占用阻塞证据。

## 182. Bridge `wait.js` 拆分第二刀：WaitCoordinator / orphan GC / event subscription

- [x] 执行边界：新增 `wait_coordinator.js`，迁出 `WaitCoordinator`、`piBrowserWaits`、`waitKey/makeWaitId`、timeout/state helper、event subscription registry、orphan wait cleanup、通用 wait cleanup helper；`wait.js` 当前约 850 行。
- [x] 不变式：active wait key、tab-scoped listener key、`cleanupTabWaits`、`cancelWaitsForTab`、`cleanupWaitsForUninstall`、orphan age 语义和 diagnostics 字段不变；`wait.js` 继续只通过全局 facade 调用这些 helper。
- [x] 契约：既有两 tab 同 listenerId/uninstall cleanup 契约继续通过；新增 wait coordinator fixture 覆盖 orphan cleanup、`cleanupTabWaits`、`cancelWaitsForTab(tabId,'tab_cleanup')`；`check-bridge-files.mjs` 锁定 `wait.js` 不再重定义 WaitCoordinator，`wait_coordinator.js` 不包含 navigation/networkIdle/selector 业务。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-refactor-execution && npm run check"` 已通过；本项为内部 service worker 拆分；后续 TODO 183 已继续拆分 wait 子系统并记录 smoke 端口占用阻塞证据。

## 183. Bridge `wait.js` 拆分第三刀：navigation / networkIdle / selector 子系统与收口 gate

- [x] 执行边界：新增 `wait_navigation.js`、`wait_network_idle.js`、`wait_selector.js`；navigation/loadState/current-state probe/webNavigation handlers 进入 navigation；networkIdle include/ignore pattern、quiet window、inflight 计算进入 networkIdle；selector probe/polling 进入 selector。
- [x] Facade 收口：`wait.js` 只保留 composite wait、native wait command dispatch、cancel、hook/evidence helper、diagnose glue，当前约 299 行；所有 wait 子文件均 ≤450 行。
- [x] 不变式：`wait.navigation timeoutMs=0` 真实当前状态探测、`navigateAndWait` 总 deadline 扣减、迟到 lease 成功转 `WAIT_TIMEOUT/WAIT_STATE_LOST`、networkIdle safe pattern、selector timeout/error code 保持不变。
- [x] 契约：组合 VM fixture 继续覆盖 navigation immediate check、any/all 空条件、networkIdle ReDoS 防护、diagnose iframe、performance timeout；`check-bridge-files.mjs` 锁职责边界、加载顺序和所有 wait 子文件 ≤450 行。
- [x] Runtime：`npm run smoke:browser` 已尝试，当前被既有 `127.0.0.1:18765` bridge 占用阻断，未关闭用户进程；失败证据写入 `.pi/browser-artifacts/smoke-browser-results.json`。本项代码路径由 `npm run check` 的 VM/contract 覆盖，端口诊断与隔离 smoke 继续由 TODO 185/194 处理。

## 184. 页面注入边界：`hook_dispatcher.js` 拆分/打包设计冻结

- [x] 性质判定：页面注入脚本边界设计，不得直接套用 service worker 多文件拆分；目标是解决 862 行 `hook_dispatcher.js` 单体并为支柱二页面 bundle 做前置。
- [x] 只读图谱：`docs/hook-dispatcher-boundary.md` 已确认 `runtime.js` 的 `PI_BROWSER_HOOK_DISPATCHER_FILE`、`hook.js` 的 `chrome.scripting.executeScript({ files })`、CDP fallback fetch、`callPagePiBrowser` dispatch、uninstall cleanup、page global store、listener registry 和 session strict-match 边界。
- [x] 决策：当前采用“单文件自包含页面 bundle + 契约锁定”；禁止在无 bundler 阶段把 dispatcher 拆成多个需页面 import 的文件。真正拆分进入 TODO 190 独立页面 bundle 迁移。
- [x] 不变式：install/collect/status/uninstall/evaluate、wrong-session `INVALID_SESSION`、collect no self-noise、seq monotonic、listener cleanup、redact pattern budget 全部不变，继续由 VM fixture 覆盖。
- [x] 契约：`check-bridge-files.mjs`、`check-page-scripts.mjs`、`check-pi-browser-bridge.mjs` 覆盖注入文件名、service worker exclusion、dispatcher 自包含性、无页面 import/无 `chrome.*`、session/listener cleanup；README/CHANGELOG/边界文档已同步。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 已通过；首次全量 check 在 fake-ws 随机时序处失败，单跑 `check:fake-ws` 和随后全量重跑均通过。

## 185. Smoke 端口冲突显式诊断与文档收口

- [x] 性质判定：小成本验证体验修复；目标是让 `npm run smoke:browser` 在 `127.0.0.1:18765` 被占用时返回可执行诊断，而不是只暴露裸 `EADDRINUSE`。
- [x] 实现：新增 `tests/smoke/smokePortDiagnostics.mjs`；smoke 启动失败时区分 `agent_occupies`、`orphan_socket`、`unknown_owner`，尽量输出 PID、进程名、命令行、health 探测，并写入 `.pi/browser-artifacts/smoke-browser-results.json` 的 `bridge.port` 记录。
- [x] 文档：已更新 `AI_INSTALL.md` 和 README 维护入口，说明本地 smoke 与常驻 agent/bridge 互斥；脚本只诊断，不自动 kill 用户进程。
- [x] 契约：新增 `tests/contracts/check-smoke-diagnostics.mjs` 并接入 `npm run check`，锁定分类语义、artifact step 名和文档 reason。
- [x] 验证：`check-smoke-diagnostics` 模拟占用端口与空闲端口两种场景；`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 已通过；未引入 puppeteer/playwright。

## 186. Bridge ambient/global 类型收紧（支柱二前置）

- [x] 性质判定：内部类型强化；目标是减少 `bridge-globals.d.ts` 黑盒 `any`，为 ESM TS 迁移提供真实边界，不改变 runtime。
- [x] 类型范围：已定义 `PiBridgeCommand`、`PiBridgeResponse/PiBridgeData`、CDP send/subscription、wait record、network recorder、hook command、Chrome tab/download/runtime/debugger/scripting/alarms/webNavigation 最小接口；移除 ambient `Record<string, any>`、`[key:string]:any`、`declare const chrome:any`。
- [x] 迁移方式：用 JSDoc + `checkJs` 收紧现有 JS；`runtime.js` 改用 `PiBridgeGlobalThis`，`router.js` 改用 `PiBridgeWsEnvelope`，popup cookie 响应显式 array normalize，hook/wait 对 page response 做显式 response/data cast。
- [x] 契约：`check-bridge-files.mjs` 禁止关键 ambient broad `any` 回流并锁定 Chrome/CDP/wait/network/hook/WS 具体类型；TODO 186 阶段 `tsc -p tsconfig.bridge.json` 随 `npm run check` 执行，TODO 192 已删除旧 ambient globals 并改为只检查 `tsconfig.bridge-src.json`。
- [x] 文档：README/CHANGELOG/TODO 记录这是支柱二前置；不声称已完成 ESM/bundler。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 已通过。

## 187. 支柱二 ESM + TS Bundler 迁移设计冻结

- [x] 性质判定：重大架构迁移设计；`docs/bridge-esm-bundler-plan.md` 已写清完整终态和阶段 gate，不再把 ESM/bundler 作为模糊“以后做”。
- [x] 终态：Bridge service worker 源码进入 `bridge_src/` ESM TypeScript 源目录，显式 `import/export`；构建产物进入 `bridge/pi_browser_bridge/dist/`；`manifest.json` 在 TODO 191 指向构建产物；页面注入脚本独立 bundle；旧 `importScripts` 多文件入口在 TODO 192 删除。
- [x] 工具决策：优先 esbuild，Rollup 仅作为 MV3/page-script 行为无法保留时的 fallback；禁止把 tree-shaking/常驻内存作为主要收益，主收益限定为显式依赖、类型安全、构建产物可复现。
- [x] 边界：`content`、`hook-dispatcher`、`disable-dialogs`、background service worker 分别为独立入口；source map、构建产物、发布包边界、reload/smoke 流程写入设计文档。
- [x] Gate：TODO 180-186 已完成后才能开始代码迁移；README/CHANGELOG/TODO 与 `check-bridge-files.mjs` 文档契约已同步。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 已通过；本项未切 runtime。

## 188. Bridge build pipeline 骨架（不切 runtime）

- [x] 新增构建脚本：添加 `build:bridge`，通过 esbuild 生成实验产物，不修改当前 `manifest.json` runtime 指向；构建脚本无私有绝对路径。
- [x] 源目录：建立 `bridge_src/`，新增最小 `service-worker.ts` spike 和 `shared/buildInfo.ts` 类型，验证 ESM TS -> MV3 service worker bundle。
- [x] 产物边界：`bridge/pi_browser_bridge/dist/` 由脚本生成，`.gitignore` 只保留 marker；TODO 188 当时 build manifest 标记为未切 runtime，TODO 191 已切为 `runtimeSwitched:true/manifestTarget:"dist/service-worker.js"`。
- [x] 验证：`npm run check` 增加 `check:bridge:build` 静态验证；TODO 188 阶段未切 runtime，TODO 191 已更新 README/AI_INSTALL 为 dist runtime。
- [x] 验证命令：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 已通过。

## 189. Service worker bridge 迁移到 ESM TypeScript bundle

- [x] 迁移范围阶段 1：`bridge_src/service_worker/` 已按当前 service worker 侧 `importScripts` 顺序承载 config/protocol/patterns/CDP/runtime/wait/network/hook/evidence/frame/html/screenshot/transfer/bridge_info/core/exec/router/tab_sync/transport 兼容源码；`build:bridge` 生成完整 `dist/service-worker.js`，保持 callable command 名、错误码、artifact、summary 不变。
- [x] 类型要求阶段 1：`bridge_src/service-worker.ts` 已显式 import 每个 service worker source module 的 boundary symbol 并导出 `serviceWorkerModuleGraph`；各 source module 显式 export 自身 module marker，禁止新增 global registry 替代模块边界。细粒度 handler command/response 类型收口继续归入 TODO 192 删除旧 globals 阶段。
- [x] 兼容期：旧 JS runtime 仍是 manifest 生产入口；dist service worker 为实验产物，不产生双生产入口；同一命令没有两个 runtime 同时注册。
- [x] 契约：`check:bridge:types` 同时覆盖旧 JS check 与 `bridge_src` TS check；`check-bridge-build.mjs` 锁 source module boundary symbol、build manifest module list，并用 Chrome fixture 动态 import `dist/service-worker.js` 验证 runtime/debugger/alarms/tabs listener 注册。
- [x] Runtime 边界：本项不切 manifest，不声明真实扩展已使用 dist；真实 reload/callable 子集验证归入 TODO 191 manifest 切换 gate。
- [x] 验证附带修复：全量 `npm run check` 暴露 `browser_callback_oast` Windows state file replace 偶发 `EPERM/EBUSY` 导致 DNS callback 事件停留在 tmp 文件；已在主进程与 worker 状态保存中加入 bounded rename retry，保持锁语义与 artifact 路径不变。

## 190. 页面注入脚本独立 bundle 迁移

- [x] 迁移范围：`bridge_src/page_scripts/` 已承载 `hook_dispatcher`、`content`、`disable_dialogs` 独立 TypeScript entry；`build:bridge` 生成 `dist/hook_dispatcher.js`、`dist/content.js`、`dist/disable_dialogs.js`，不得与 service worker bundle 混合。
- [x] 注入契约：当前 manifest/runtime 仍使用旧 `hook_dispatcher.js`、`content.js`、`disable_dialogs.js`；dist 文件名为 TODO 191 切换目标，`chrome.scripting.executeScript({ files })` 与 CDP fallback 将在同一 gate 一步切到 `dist/hook_dispatcher.js`，不保留双生产入口。
- [x] 安全/证据边界：dist hook bundle 保留 `window.__PI_BROWSER_HOOKS__`、session strict-match、listener cleanup、collect no self-noise、seq monotonic、redact budget；dist content bundle 显式内联共享 `TID`；disable-dialogs prompt 返回语义不变。
- [x] 契约：`check-bridge-build.mjs` 与 `check-page-scripts.mjs` 锁 page script entries、dist 自包含、hook 无 background-only API、service worker 不内联 dispatcher；真实 hook/content/pick runtime artifact 归入 TODO 191 manifest 切换 gate。

## 191. Manifest/package/check/smoke 切到构建产物

- [x] 切换：`manifest.json` 已指向 `dist/service-worker.js` module service worker，content scripts 已指向 `dist/disable_dialogs.js` / `dist/content.js`，hook 注入常量已切到 `dist/hook_dispatcher.js`；旧手工 `importScripts` 入口不再作为生产入口，只保留到 TODO 192 删除。
- [x] 检查：`check:bridge` 顺序改为 typecheck -> build -> files/contracts；`npm run check` 覆盖 build、typecheck、manifest/dist/page script/tool doc drift，`check-bridge-build.mjs` 动态 import dist service worker 并验证 build metadata。
- [x] Smoke 定位：`smoke:browser` 在启动 bridge 前写入 `build.runtime`，包含 `runtimeSwitched:true`、`manifestTarget:"dist/service-worker.js"`、entries 和 service worker sha256；本地默认端口若被常驻 Pi agent 占用会记录 `bridge.port.reason:"agent_occupies"` 且不关闭用户进程，最终 runtime pass 证据由 TODO 193 的 isolated smoke 提供。
- [x] 回滚：未保留双生产入口；若后续真实 reload 失败，必须在 TODO 193 gate 内修复或整项回滚，不能恢复旧 `background.js` 为备用生产路径。

## 192. 删除旧 `importScripts` 多文件入口与冗余 globals

- [x] 删除范围：已移除 `background.js`、旧 service worker/page 多文件 `.js`、`bridge-globals.d.ts` 与 `tsconfig.bridge.json`；生产目录只保留 manifest、popup、native schema、icons 和 generated dist marker。
- [x] 禁止债务：未保留“旧路径备用”“临时兼容入口”“双写 command handler”；测试改读 `bridge_src/service_worker/*.ts` / `bridge_src/page_scripts/*.ts` 源模块和 dist bundle，不再依赖生产目录旧 JS。
- [x] 契约：`check-bridge-files.mjs` 锁定生产入口只有 dist module service worker、manifest content scripts 指向 dist、legacy ambient globals 不存在；`check:bridge:types` 只检查 `tsconfig.bridge-src.json`。
- [x] 文档：README/AI_INSTALL/CHANGELOG/TODO 同步最终工程边界；能力描述未变化，未修改全局 skill。

## 193. 支柱二一期收口 gate：dist runtime 切换可用

- [x] 证明：`bridge_src/service_worker/` 与 `bridge_src/page_scripts/` 已承载当前 runtime 源；`build:bridge` 生成 `dist/service-worker.js`、`dist/content.js`、`dist/hook_dispatcher.js`、`dist/disable_dialogs.js`；`manifest.json` 指向 dist；旧 `importScripts` 多文件入口、`bridge-globals.d.ts`、`tsconfig.bridge.json` 已删除；`check-bridge-build.mjs` / `check-bridge-files.mjs` / `check-page-scripts.mjs` 锁定这些一期边界。
- [x] 全量验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 已通过；`npm run smoke:browser:isolated` 已通过，artifact `.pi/browser-artifacts/smoke-browser-isolated-results.json`，覆盖 build.runtime、bridge、tabs.reuse、wait.loadState、scan/content/html/frame/hook、execute/CDP input、pick、network、screenshot、tabs.close。普通 `npm run smoke:browser` 保留端口占用诊断，不关闭用户进程。
- [x] 行为审计：契约继续覆盖 tool names、protocol/native schema、error codes、summary/artifact distillation、network body/postData、wait supervisor metadata、transfer/page script 行为；runtime isolated smoke 证明 dist service worker 实际执行并连接 `ws://127.0.0.1:18766`。
- [x] 口径修正：本项不是支柱二终态；当前仍存在 `@ts-nocheck`、非 strict tsconfig、service worker 构建按旧顺序拼接和 npm package 漏 dist runtime 风险。终态工作转入 TODO 195-202。

## 194. 独占 Chrome profile smoke（支柱四中期闭环）

- [x] 性质判定：runtime 验证增强；目标是在不关闭用户常驻 agent/bridge 的情况下启动独占 Chrome profile 和临时扩展配置。
- [x] 实现路线：新增 `smoke:browser:isolated`，用 `child_process` 启动本机 Chrome/Chromium + `--user-data-dir .pi/temp-profiles/smoke-*` + `--load-extension` 临时扩展副本；未引入 puppeteer/playwright 大依赖。
- [x] 端口配置：脚本从 18766-18800 选空闲 bridge port、8766-8800 选 fixture port，临时复制扩展目录并 patch `dist/service-worker.js` 中的 bridge 端口；测试结束清理临时 profile/extension 副本，不修改用户正在使用的扩展目录。
- [x] 契约与文档：`check-smoke-diagnostics.mjs` 锁 `smoke:browser:isolated`、临时 profile/load-extension/端口 patch/artifact；失败时输出 Chrome path/profile/port 到 `.pi/browser-artifacts/smoke-browser-isolated-results.json`。
- [x] Gate：本项提前执行以解除本地常驻 agent 端口互斥；TODO 193 仍负责最终真实 runtime callable 通过证据。

## 195. 支柱二阻断修复：发布/安装包必须包含可运行 dist runtime

- [x] 性质判定：package-portability blocker；manifest 已指向 `bridge/pi_browser_bridge/dist/**`，因此 npm package、干净 checkout 的安装路径必须有可运行 dist runtime，不能只依赖本地已有 build 产物。
- [x] 事实复核：`npm pack --dry-run --json` 修复前只包含 `bridge/pi_browser_bridge/dist/.gitignore`，缺少 `dist/service-worker.js`、`dist/content.js`、`dist/hook_dispatcher.js`、`dist/disable_dialogs.js`、source map 与 `build-manifest.json`；根因是 generated dist 目录内 `.gitignore` 被 npm 继承且无 package include/prepack 边界。
- [x] 实现决策：采用 package-portable 方案：`prepack` 运行 `node scripts/build-bridge.mjs --quiet`，`package.json.files` 明确包含 `bridge/`、`bridge_src/`、`scripts/`、`tests/`、`src/`、`docs/` 等发布边界，`build:bridge` 生成 dist `.npmignore` 覆盖 dist `.gitignore` 的 npm 打包语义；无私有绝对路径，不要求用户手动 build 才能加载扩展。
- [x] 契约：新增 `tests/contracts/check-package-files.mjs` 并接入 `check:package` / `npm run check`；契约解析 `npm pack --dry-run --json`，强制包内包含 manifest 指向的 service worker/content/disable-dialogs dist、hook dispatcher、source maps、build manifest、manifest、native schema、bridge source 和 build script，禁止只包含 `dist/.gitignore` 的坏状态。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run build:bridge"` 通过；`npm pack --dry-run --json` 修复后包内包含 207 个文件与完整 dist runtime；`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check:package"` 通过；`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 通过。

## 196. 支柱二终态设计修正：从“拼接兼容 bundle”转为真实 ESM 依赖图

- [x] 性质判定：architecture correction；当前 `build:bridge` 对 service worker 仍按旧 `importScripts` 顺序拼接源码，不能满足“跨文件依赖拓扑由 import/export 表达”的终态。
- [x] 设计修正：已更新 `docs/bridge-esm-bundler-plan.md`，把 TODO 188-193 明确标为一期 runtime 迁移，把 TODO 196-202 标为终态迁移；写清当前 `ordered-concat-compat` 只是兼容桥，目标 `esm-import-graph` 禁止长期保留 ordered concatenation 作为 service worker 构建主路径。
- [x] 分层边界：文档确定 `bridge_src/service_worker/` 的最终模块依赖方向：shared/types/config/protocol/patterns -> runtime/cdp/wait/network state -> command handlers -> router/transport/tab_sync/service-worker；禁止业务模块反向依赖 router/transport/popup UI/startup side effects。
- [x] 迁移策略：按 TODO 197-199 模块组逐步导出真实函数/类型并显式 import；每组迁移后 build 不再从拼接文本读取该组源码；不得恢复 global registry 或双生产入口。
- [x] 验收：TODO/README/CHANGELOG 已把一期状态与支柱二终态拆开；`build:bridge` 写入 `dist/build-manifest.json` 的 `serviceWorkerBuildMode:"ordered-concat-compat"` / `targetServiceWorkerBuildMode:"esm-import-graph"`，`check-bridge-build.mjs` 契约能区分当前是否仍依赖 `serviceWorkerModules` 拼接。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 通过。

## 197. Service worker 真实 ESM 迁移第一阶段：shared/runtime/CDP/wait 基础层

- [x] 执行约束：本项未提交半迁移状态；`config/protocol/patterns/runtime/cdp/wait_*` 同批完成，TODO 198/201 未提前推进。
- [x] 范围：`config`、`protocol`、`patterns`、`runtime`、`cdp`、`wait_cdp`、`wait_coordinator`、`wait_navigation`、`wait_network_idle`、`wait_selector`、`wait` 已迁移到真实 import/export；命令名、错误码、diagnostics、wait supervisor metadata 不变。
- [x] 图谱 gate 197A：`bridge_src/service-worker.ts` 与 generated service worker 均 import foundation modules；`scripts/build-bridge.mjs` 只拼接未迁移 legacy tail；`dist/build-manifest.json` 记录 `foundationImported:true`、`serviceWorkerFoundationModules`、`legacyServiceWorkerModules`。
- [x] 类型 gate 197B：`config/protocol/patterns/runtime/cdp` 移除 `// @ts-nocheck`；新增 `runtimeEnv.ts` 与 `types.ts` 承载 Chrome/runtime/CDP 基础边界；runtime 对未迁移 legacy command tail 只经 `legacyCommandSurface/requireLegacyCommand` 显式兼容面调用。
- [x] 类型 gate 197C：`wait_*` 与 `wait` 移除 `// @ts-nocheck`；wait registry/domain/subscriber/selector/networkIdle/navigation 通过局部 typed maps/defaults 收口；wait 子系统文件仍 ≤450 行。
- [x] 契约 gate 197D：`check-bridge-build.mjs`/`check-bridge-files.mjs` 锁定 foundation 无 `@ts-nocheck`、无基础层文本拼接回归、foundation ESM imports、runtime legacy 兼容面和 wait 职责边界；VM/fake CDP wait 契约继续通过。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools\pi-browser-tools-bridge-refactor-todos && npm run check"` 通过；`npm run smoke:browser:isolated` 通过，artifact `.pi/browser-artifacts/smoke-browser-isolated-results.json`，覆盖 build.runtime、bridge、wait.loadState、scan/content/html/frame/hook/execute/pick/network/screenshot/tabs.close。

## 198. Service worker 真实 ESM 迁移第二阶段：command 层真实 import/export 收口

- [x] 性质判定：支柱二终态的第二个代码迁移批次；目标是让 command handler 层脱离文本拼接和隐式全局，保持所有浏览器工具外部行为不变。
- [x] 执行入口：本轮先跑 `npm run check:bridge:types` 复核基线；未提交“仅删除 `// @ts-nocheck`”的半迁移状态，当前先完成 command import graph 与 runtime dispatch gate。
- [x] 迁移范围首段：`network_model`、`network`、`hook`、`evidence`、`frame`、`html`、`screenshot`、`transfer`、`bridge_info`、`core_commands`、`exec` 已进入真实 ESM build graph；native schema、tool response、错误码、artifact/body/postData、hook session/listener cleanup、download/upload 行为不漂移。
- [x] 依赖边界：command 模块内 runtime/wait/CDP/helper 已改为显式 ESM import；startup 兼容全局只限 TODO 199 的 router/transport/tab_sync 过渡，未新增 `globalThis`/`self` 业务读取。
- [x] 循环依赖处理：拆掉 `network_model -> network -> network_model` 环；`network_model` 只拥有 recorder/body store/state，并通过 `setNetworkWaitNotifier` 显式 notifier 唤醒 network wait，不反向 import `network.ts`。
- [x] batch/router 边界：`core_commands` 提供 `validatePiBridgeProtocolMessage` / `dispatchPiBridgeCommand` 无 listener 副作用 dispatch helper；`handleBatch` 与 router 均调用该 helper，router 只保留 Chrome/WS listener 绑定，启动层迁移归 TODO 199。
- [x] 构建：`scripts/build-bridge.mjs` 已将本组移出 `legacyServiceWorkerModules`，新增 `serviceWorkerCommandModules` / `commandImported:true`；本组通过 `bridge_src/service-worker.ts` ESM 图进入 dist，page script bundle 继续独立，未把 `hook_dispatcher` 内联进 service worker。
- [x] 类型：本组 `// @ts-nocheck` 已移除；复用 runtime/protocol/wait/CDP 类型边界并用显式 imports 收口 network recorder/body store、hook page response、frame/html/screenshot/transfer/native command 路径；未新增 `Record<string, any>` 或 broad ambient fallback。
- [x] 契约：已扩展 `check-bridge-build.mjs` / `check-bridge-files.mjs` / `check-pi-browser-bridge.mjs` / `check-transfer-runtime.mjs`，锁定 command graph、runtime 直连 command handler、network notifier、剩余 legacy tail 仅 `router/tab_sync/transport`；fake-ws、network body availability/postData、hook wrong-session、frame/html/screenshot/transfer 合约继续通过。
- [x] 验证：`npm run check:bridge:types`、`npm run check`、`npm run smoke:browser:isolated` 已通过；isolated smoke artifact `.pi/browser-artifacts/smoke-browser-isolated-results.json`，service worker sha256 `bd35b6fe1994b9bcfe777d2863c91649a952e770d2709a5acd1a700468d390cc`。

## 199. Service worker 真实 ESM 迁移第三阶段：router/transport/tab_sync 启动层与 ordered-concat 删除

- [x] 性质判定：支柱二 service worker 依赖图收口；目标是删除 ordered-concat 兼容桥，让 `bridge_src/service-worker.ts` 成为唯一启动入口。
- [x] 迁移范围：`router`、`tab_sync`、`transport` 已改为真实 ESM；listener 安装、WebSocket 生命周期、probe backoff、tabs update/remove sync、runtime/onMessage dispatch 由显式启动函数绑定，不再靠模块文本顺序和隐式全局副作用完成关键初始化。
- [x] owner 边界：transport socket/probe 状态归 `transport.ts`；router 只做协议验证与 dispatch；tab sync 只做 tab 事件到状态同步，transport 通过显式依赖注入提供 socket/probe。
- [x] 构建删除：`scripts/build-bridge.mjs` 不再生成 `bridge_src/.generated/service-worker.generated.ts`，不再 `readFile` 拼 service worker 源文本；`dist/build-manifest.json` 改为 `serviceWorkerBuildMode:"esm-import-graph"`、`orderedConcatenation:false`、`legacyServiceWorkerModules:[]`。
- [x] 契约：动态 import dist fixture 证明 runtime/onMessage、debugger、alarms、tabs、webNavigation listener 注册；静态契约禁止 `serviceWorkerModules` 拼接数组、`legacyServiceWorkerModules` 非空、源文本 `readFile` 组装 service worker。
- [x] 验证：`npm run build:bridge`、`npm run check`、`npm run smoke:browser:isolated` 已通过；isolated smoke artifact `.pi/browser-artifacts/smoke-browser-isolated-results.json`，service worker sha256 `afc06695edcba74470ae4865b0e0cfae5681f9480ce86fdc4ebdce9107f626e9`。

## 200. Bridge TypeScript strict 与 page script 类型收口

- [x] 性质判定：支柱二类型终态；`tsconfig.bridge-src.json` 已从迁移兼容态收紧为 `strict:true`、`noImplicitAny:true`，不能回退到宽松类型检查。
- [x] 执行决策：使用真实 TS 类型注解完成 strict，不用显式 broad `any` 规避；VM fixture 已通过 esbuild transform 执行带 TS 语法的源码，后续分片收紧 service worker/page script 类型。
- [x] 前置 fixture：`check-pi-browser-bridge.mjs`、`check-transfer-runtime.mjs`、`check-page-scripts.mjs`、`check-protocol-contract.mjs` 与 transfer/tool fixtures 已支持 raw 静态断言 + esbuild TS 转译执行，避免 TS 注解破坏 VM 契约。
- [x] 启动层 strict 分片：`router.ts`、`tab_sync.ts`、`transport.ts` 与 `types.ts` 已补真实 TS 类型；`--strict --noImplicitAny` 输出中过滤本组为 0。
- [x] Service worker strict：TODO 198-199 完成后已将 `tsconfig.bridge-src.json` 收紧到 `strict:true`、`noImplicitAny:true`；`bridge_src/service_worker/**/*.ts` `// @ts-nocheck` 计数为 0。
- [x] Page scripts strict：`content.ts`、`disable_dialogs.ts`、`hook_dispatcher.ts` 已移除 `// @ts-nocheck`；页面注入全局 store、listener registry、session strict-match、toast/prompt/content extraction 已类型化；仍保持独立 bundle，不引用 service worker-only API。
- [x] Loose 输入策略：外部 Chrome/CDP/page response/WS envelope 经 `JsonRecord`、具名 Chrome/CDP/page API 类型和局部 normalize helper 收口后进入业务逻辑；契约禁止 broad `Record<string, any>`、`as any`、旧 ambient globals 回流。
- [x] 契约：`check-bridge-files.mjs` 扩展 type hygiene contract：`@ts-nocheck` 为 0，`strict/noImplicitAny` 为 true，禁止旧 `bridge-globals.d.ts` 回归，禁止 service worker/page script API 越界引用和 broad `any` cast；VM contracts 改为 TS-aware。
- [x] 验证：`npm run check:bridge:types`、`npm run check:page-scripts`、`npm run check:pi-browser-bridge`、`npm run check:transfer`、`npm run check` 已在 strict 下通过；页面 bundle 行为继续由 page-script/dist contracts 覆盖。

## 201. 插件 UI/HUD 决策：保留 cookie 调试面板

- [x] 决策：保留现有 cookie 调试面板，不做“小Pi/Performance HUD”。
- [x] 当前仓库没有 `feature/pi-bridge-simple-ui` 分支，不迁移旧 UI patch。
- [x] 本项不作为支柱二 runtime/协议/类型终态阻塞项；后续只在 popup 实际改动时补对应契约与验证。

## 202. 支柱二终态收口 gate

- [x] 证明条件：发布包包含 manifest 指向的 dist runtime；`manifest.json` 指向 `dist/service-worker.js` module service worker；service worker 构建完全走真实 ESM import graph；`dist/build-manifest.json` 记录 `serviceWorkerBuildMode:"esm-import-graph"`、`orderedConcatenation:false`、`legacyServiceWorkerModules:[]`；`bridge_src` `@ts-nocheck` 清零；`tsconfig.bridge-src.json` 为 `strict:true` / `noImplicitAny:true`；旧 runtime/globals/importScripts 无回归。
- [x] 行为验证：`npm run build:bridge`、`npm run check`、`npm pack --dry-run --json`、`PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated` 已通过；artifact `.pi/browser-artifacts/smoke-browser-isolated-results.json` 记录 build.runtime、bridge、tabs.reuse/close、wait.loadState、scan/content/html selector、frame.list、hook.readOnlyNoInstall、execute.interaction/cdpInput、pick-lite、network、screenshot，service worker sha256 `b4bc10872b5b9b8e13ba239ff3eed398bc9f7b7d9118473a1807889228e937c7`。
- [x] 文档同步：README、AI_INSTALL、CHANGELOG、TODO、`docs/bridge-esm-bundler-plan.md` 已同步“支柱二终态完成”描述；本轮未修改全局 skill，因此未运行 skill quick validate。
- [x] 合并准备：当前分支为 `feature/pi-browser-tools-bridge-refactor-completion`；`git merge-base --is-ancestor master HEAD` 返回 0，`git merge-tree $(git merge-base master HEAD) master HEAD` 未报告冲突。当前工作树仍为开发 WIP dirty，未执行最终合并，也不声明工作树干净；合并前必须提交/清理后复跑门禁。

## 203. 支柱五：本地质量门禁脚本

- [x] 性质判定：本地开发质量门禁，不引入 GitHub Actions、Dependabot、自动发布 registry、强制 Husky hook 或远程 CI 依赖。
- [x] 决策：新增 `npm run quality:local`，串联 `npm run build:bridge`、`npm run check`、`npm pack --dry-run --json`，作为发布/合并前默认质量门禁。
- [x] Smoke 边界：`npm run smoke:browser:isolated` 保持手动/可选门禁；`quality:local` 只输出下一步提示，不默认启动真实 Chrome/Edge，契约已锁定脚本不在 gate 段调用 smoke。
- [x] 文档：README/AI_INSTALL/TODO 记录本地门禁命令、适用场景、失败 artifact 位置和端口占用处理方式。
- [x] 验证：本地门禁脚本在当前开发树运行；脚本只编排 build/check/pack，不修改工具能力、协议或 runtime 行为。干净 checkout 的最终运行留给提交后发布/合并前复核。

## 204. 支柱五：本地并发、生命周期与泄漏验证

- [x] 性质判定：风险导向测试增强，不追求固定覆盖率数字，不引入 Playwright/Puppeteer 作为默认依赖。
- [x] 覆盖范围：新增 `tests/contracts/check-lifecycle.mjs` fake WebSocket fixture，覆盖多浏览器同数值 `tabId`、`selectBrowser`、WS 断连/重连、MV3 service worker restart、pending request cleanup、tab command queue、wait/network/hook 长任务。
- [x] Artifact：失败时写入 `.pi/browser-artifacts/lifecycle-fixture-failure.json`，包含 bridge snapshot、pending、target selection、listener/CDP/network recorder 状态；cookie/token/authorization/body/postData 等字段按字段名脱敏，不泄漏正文。
- [x] 契约：本地 fixture 使用真实 `BrowserBridgeServer`、`BrowserWaitSupervisor` 与 fake WebSocket 行为断言复现生命周期问题；未用源码字符串检查替代行为断言。
- [x] 验证：新增 `check:lifecycle` 并纳入 `npm run check`/`quality:local`；isolated smoke 仍保持单独手动运行。

## 205. 支柱五：协议与工具文档本地生成

- [x] 性质判定：文档同步成本治理；目标是减少 native schema、tool schema、README、skill、contract 多处手写漂移。
- [x] 决策：新增 `scripts/generate-tool-docs.mjs` 与 `npm run docs:generate`，从 `bridge/native_command_schema.json`、实际 `pi.registerTool` 元数据和源码结构化错误码生成可审核的工具清单、参数表、native command 表、错误码/Artifact 行为片段。
- [x] 边界：不采用 TypeDoc 作为主要产物；生成文件 `docs/generated/browser-tool-contract.generated.md` 以 callable tool/native command/error/artifact 契约为中心，不暴露内部源码 API 作为用户接口。
- [x] 同步：生成产物进入仓库 docs；`check:tool-docs` 已追加 `node scripts/generate-tool-docs.mjs --check` 漂移检查；本轮未修改全局 skill，因此未运行 skill quick validate。
- [x] 验证：生成脚本幂等；`npm run check:tool-docs` 可发现生成产物与工具/schema/错误码不一致，且 `npm run check` 会覆盖该检查。

## 206. 支柱五：本地依赖与安全审计策略

- [x] 性质判定：本地依赖治理，不接入远程 Dependabot/SonarQube/Sentry；保持生产依赖少而可审计。
- [x] 决策：新增 `check:deps`，覆盖 `package.json`/`package-lock.json` 根依赖一致性、生产依赖 allowlist、`npm ls --json --all`、`npm audit --omit=dev --audit-level=high` 可用性和生产依赖清单漂移。
- [x] 升级流程：README/AI_INSTALL 记录依赖升级必须包含范围、兼容性风险、回滚方式，并通过 `npm run check`、`npm pack --dry-run --json`，必要时运行 isolated smoke。
- [x] 安全边界：不接入外部错误追踪服务；`check:deps` 只写本地 `.pi/browser-artifacts/dependency-audit-summary.json`，不发送 cookie/token/网络正文。
- [x] 验证：依赖检查命令失败信息可执行；registry/DNS/timeout 不可用时记录 `npmAudit.status:"unavailable"` 并通过，避免普通离线开发被短暂 registry 问题阻塞；高危/严重生产漏洞、lockfile 漂移或依赖树问题会失败。

## 207. 支柱五：`BrowserBridgeServer` 职责拆分

- [x] 性质判定：Node driver 内部架构重构，不改变公开工具名、参数、错误码、artifact 或 bridge 协议。
- [x] 拆分边界：已将 HTTP/WS server、client registry、tab/session router、pending request manager、target selection diagnostics 拆到 `BrowserBridgeHttpServer.ts`、`BrowserBridgeClientRegistry.ts`、`BrowserTabSessionRouter.ts`、`BrowserBridgePendingRequests.ts`、`BrowserBridgeDiagnostics.ts`；`BrowserBridgeServer.ts` 保持 thin facade。
- [x] 行为不变：多浏览器同数值 `tabId`、`selectBrowser`、default/latest fallback、`selectionVersion`、断连 session retention、pending timeout diagnostics 全部由 fake WS/lifecycle fixture 覆盖并保持兼容。
- [x] 契约：`check:fake-ws` / `check:lifecycle` 覆盖 ambiguous tab、stale tab、client disconnect、bridge stop、timeout ACK/no-ACK、MV3 restart 与长任务 pending；`check:tools` 更新为跨 driver 模块边界断言，减少对单文件私有实现字符串的依赖。
- [x] 验证：拆分后已运行 `check:fake-ws`、`check:lifecycle`、`check:tools`、`check:protocol`、`check:pi-browser-bridge`；随后全量 `npm run quality:local` 复核。isolated smoke 仍保持手动可选，TODO 202 已有 Edge artifact。

## 208. 支柱五：统一 Tool Adapter 与结果处理中间层

- [x] 性质判定：工具注册层去重，不新增工具能力，不修改外部 callable contract。
- [x] 收口范围：新增 `src/tools/toolAdapter.ts`，统一 `sharedTabScopedToolParams`、`timeoutMs/maxChars` 归一、`runTool` 错误包装、`jsonToolResult/textToolResult` 中间层、bridge nested error 映射与 artifact fallback 命名。
- [x] 迁移范围：`scan/content/html/execute/pick/evidence/transfer/nativeAction/screenshot/artifact/tabs` 注册层已改走 adapter；WebSecurity shared shell 改走 adapter，并补 `sharedWebSecurityParams`、`sharedWebSecurityBrowserSessionParams`、`sharedWebSecurityResultParams` 三类共享参数 helper。
- [x] 边界：各工具领域逻辑仍保留在原模块；`registerTools.ts` 继续只做组合入口；WebSecurity 12 个注册模块继续显式注册、具名 ToolParams 归一和 shared shell 执行，不把 cookie binding、summary 或成熟引擎逻辑搬进 adapter。
- [x] 契约：现有 `browser_*` 名称、promptSnippet/guidelines、TypeBox 参数、summary/saved envelope、错误码保持稳定；contracts 已兼容并锁定 `toolAdapter`、`jsonToolResult/textToolResult/runTool`、WebSecurity 唯一 shared shell 与生成文档 drift。
- [x] 文档生成：`scripts/generate-tool-docs.mjs` 已识别 adapter/shared helper、`sharedTransferParams()`、WebSecurity browser-session/result params 与 `includeTabId:false`，`browser_download/browser_upload` artifact 行保持 `outputPath/artifact`。
- [x] 验证：已运行 `npm run docs:generate`、`check:tool-docs`、`check:tools`、`check:pi-browser-bridge`、`check:web-security`、`check:transfer`、`check:artifact`；最终以本项收口后的 `npm run check` 与 `npm run quality:local` 复核。

## 209. 支柱五：协议单源化终态设计与实现

- [x] 性质判定：协议治理重构；目标是把 native command、tool 参数、错误码、文档片段和测试 fixture 尽量收敛到单一可生成源。
- [x] 设计：已新增 `docs/protocol-single-source-plan.md`，明确继续以 `bridge/native_command_schema.json` 为单源，不引入外部 IDL；记录生成产物、人工维护边界、兼容策略和回滚方式。
- [x] 生成范围：`scripts/sync-native-protocol.mjs` 支持 `--check` 并生成 `bridge/pi_browser_bridge/native_command_schema.json`、`bridge_src/service_worker/protocol.ts`、`src/protocol/nativeProtocol.ts`、`src/protocol/nativeActionMetadata.ts`、`src/protocol/nativeErrorCodes.ts`、`docs/generated/native-protocol.generated.md`。
- [x] 迁移边界：首批只迁移 `browser_wait`、`browser_network` 与 `browser_download`/`browser_upload`；wait/network action alias、actionDescription、transfer command/artifact metadata 已从生成产物消费，hook/frame/html/screenshot/evidence 后续按域迁移。
- [x] 错误码：`bridge/native_command_schema.json` 已维护 60 个结构化错误码，覆盖 driver/runtime/tool 当前公开错误码；`check-protocol-contract.mjs` 会扫描 `src` 与 `bridge_src` 中结构化 code，发现 schema 漏项即失败。
- [x] 契约：`check:protocol` 先跑 `sync-native-protocol.mjs --check` 再跑 protocol contract；契约锁定生成文件头、生成文档、wait/network/transfer metadata 消费、root/bridge schema 一致和手改生成产物 drift。
- [x] 验证：已运行 `npm run check:protocol`；本项最终门禁继续以 `npm run check` 与 `npm run quality:local` 复核，未修改全局 skill。

## 210. 支柱五：Web Security 子域边界加固

- [x] 性质判定：同包内边界强化，不拆出新的 Web 扩展，保持 `pi-browser-tools` 一个 Web 包；本项不新增 callable tool、不扩大默认扫描/外部进程行为。
- [x] 边界：`register/` 只保留 schema、具名 ToolParams 归一和 shared shell 调用；crawl/fuzz/sqlmap/nuclei/callback/cookieAnalyze/httpReplay 只能通过 cookie/HAR/raw-request/artifact/browser-native/shared adapter 访问基础 browser 能力。
- [x] 输入输出：`executeWebSecurityToolShell` 统一 timeout/maxBodyBytes/maxChars、cookie provider、artifact fallback、result distill；新增 `webSecurity/shared/diagnostics.ts` 统一 WebSecurity domain failure envelope、敏感字段脱敏与 stack suppress；sqlmap/nuclei bridge 继续通过 bounded `spawnSync`、request/stdout/stderr artifact 和 replay inputs。
- [x] 契约：`check-web-security-tools.mjs` 增加 domain boundary contract，锁定 register/browserNative/bridges/shared 分层、`webSecurityCore` 只做兼容 re-export、基础 `registerTools` 不直接导入实现层、WebSecurity 模块不反向依赖 driver/bridge runtime/chrome API。
- [x] 验证：`npm run check:web-security` 已通过；最终门禁继续以全量 `npm run check` 与 `npm run quality:local` 复核。不引入自动扫描默认路径。

## 211. 支柱五：Artifact 与证据隐私治理

- [x] 性质判定：本地证据治理；保护 cookie/token/authorization/postData/body/websocket payload 等敏感内容，同时保留可审计原始证据路径；不新增外部上传、远程存储或清理守护进程。
- [x] 策略：新增 `src/utils/redaction.ts` 与 `src/tools/artifactPrivacy.ts`，统一 artifact 分类 `local_raw_evidence`、默认根 `.pi/browser-artifacts/`、`localOnly:true`、手动清理提示、summary/details/error/browser_artifact 默认脱敏规则。
- [x] 边界：`outputPath`/自动落盘 artifact 继续保存完整原始 envelope/artifactValue；summary/full/details/error content 默认脱敏，敏感 full 结果返回 `saved_to_artifact`；`browser_artifact` 默认脱敏读取，只有显式 `redact:false` 才返回本地原始证据。
- [x] 契约：`check-token-contract.mjs` 覆盖 error/resultMiddleware 的 cookie/token/authorization/body/postData/websocket 脱敏与原始 artifact 保真；`check-artifact-reader.mjs` 覆盖 text/json/search/sample 默认脱敏、privacy metadata 与 `redact:false` 显式原始读取。
- [x] 验证：已运行 `docs:generate`、`check:token`、`check:artifact`、`check:summaries`、`check:errors`、`check:tools`、`check:tool-docs`，并通过全量 `npm run check` 与 `npm run quality:local` 复核。

## 212. 支柱五：可重放 runtime fixture 库

- [x] 性质判定：本地可复现测试资产建设，减少复杂行为只能靠真实浏览器 smoke 发现的问题；不新增 callable tool，不引入浏览器自动化重依赖。
- [x] 覆盖：新增 `tests/contracts/check-runtime-fixtures.mjs`，覆盖 network body/postData/HAR 与 WebSocket frames、hook session/listener cleanup、wait immediate selector 状态、transfer direct/click download 与 upload、frame evaluate、screenshot visible-tab fallback、callback worker state file 与 stale lock recovery；MV3 restart/lease 继续由 `check:lifecycle` 的 fake WebSocket supervisor fixture 覆盖。
- [x] 形式：使用本地 HTTP/WS fixture、fake Chrome/CDP API、可重放 bridge envelopes；未引入 Playwright/Puppeteer。
- [x] Artifact：成功摘要写 `.pi/browser-artifacts/fixtures/runtime-fixtures-summary.json`，失败诊断写 `.pi/browser-artifacts/fixtures/runtime-fixtures-failure.json`；临时输入写测试临时目录，callback session 结束后清理，诊断按字段名脱敏 cookie/token/authorization/body/postData/payloadData。
- [x] 验证：新增 `check:runtime-fixtures` 并纳入 `npm run check` / `quality:local`；已运行 `npm run check:runtime-fixtures`，最终门禁继续以全量 `npm run check` 与 `npm run quality:local` 复核。

## 213. 支柱五：错误码与诊断 taxonomy 收口

- [x] 性质判定：错误体系治理；本轮不新增 callable tool、不重命名公开错误码，只在 Node/tool 归一化输出中补充 `taxonomy` 与 `diagnostics`。
- [x] 分类：`src/utils/errors.ts` 已统一 driver/tool/native/page/CDP/network/transfer/security/artifact/protocol/unknown domain；优先消费 `src/protocol/nativeErrorCodes.ts` 的 schema category/retryable/summary，schema 外 artifact/CDP/page/tool timeout 使用显式 heuristic 分类。
- [x] 诊断：归一化错误保留原 `code/message/details/name`，新增 `taxonomy.domain/category/retryable/source/summary` 与紧凑 `diagnostics.scopes`，从 details 提取 target(tab/browser/source/selectionVersion)、session(request/wait/listener/session id)、pending(id/acked/timeout/pendingCount)；完整 details 仍按原路径保留并脱敏输出。
- [x] 兼容：保留现有公开错误码与 bridge/native response envelope；`INVALID_BROWSER_COMMAND` 额外标为 protocol domain，不改变 code；WebSecurity 继续使用 domain failure envelope，Node 侧归类为 security。
- [x] 契约：扩展 `check-errors`，覆盖 BrowserBridgeError、ArtifactReaderError、protocol/native response、nested bridge response、transfer validation、WebSecurity failure、CDP/tool 分类、stack strip、secret redaction 与 circular details。
- [x] 文档：`docs:generate` 生成 `Structured error taxonomy` 表；README/AI_INSTALL/CHANGELOG/TODO 记录 `check:errors` 与 taxonomy 边界。
- [x] 验证：已运行 `npm run check:errors`；最终门禁继续以全量 `npm run check` 与 `npm run quality:local` 复核。

## 214. 支柱五：本地发布包验收与回滚演练

- [x] 性质判定：本地发布可靠性验证；不配置远程 registry、自动发布或远程 CI，只新增本地脚本和可审计 artifact。
- [x] 验收：新增 `npm run release:local`，脚本位于 `tests/release/release-local-acceptance.mjs` 以符合 scripts 边界；在 `.pi/browser-artifacts/release-acceptance/work/pack-run` clean cwd 执行 `npm pack --dry-run --json` 与实际 pack，解包检查 manifest `dist/service-worker.js`、dist page bundles、native schema、source maps 和 `build-manifest.json` 的 `serviceWorkerBuildMode:"esm-import-graph"` / `orderedConcatenation:false`。
- [x] Runtime smoke：`npm run release:local:smoke` 支持对当前解包扩展运行 full isolated smoke；`tests/smoke/smoke-browser-isolated.mjs` 支持 `PI_BROWSER_SMOKE_EXTENSION_DIR` / `PI_BROWSER_SMOKE_RESULT_PATH` / 失败临时目录保留。
- [x] 回滚：脚本把上一成功包轮转到 `previous/`，保存当前包到 `last-successful/`；`release:local:smoke` 对上一包执行最小 tabs/wait/execute rollback smoke。
- [x] 文档：AI_INSTALL/README/CHANGELOG/TODO 记录本地打包验收、回滚步骤、必附 artifact 与失败排查字段。
- [x] 失败诊断：`release-acceptance-summary.json` 输出 pack 文件列表、build manifest、Chrome profile、bridge port、smoke artifact；失败时可用 `--keep-temp-on-failure` 或 `PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE=1` 保留临时 profile/extension。
- [x] 验证：已运行 `npm run release:local`；已用 Edge 运行 `PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run release:local:smoke`，当前包 full isolated smoke 和上一包最小 rollback smoke 均通过。关键 artifact：`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`current-smoke-browser-isolated-results.json`、`rollback-smoke-browser-isolated-results.json`。

## 215. 支柱五：仓库换行治理基线

- [x] 性质判定：本地开发一致性治理，不改变 runtime、tool schema、artifact、协议或构建产物语义。
- [x] 决策：新增 `.gitattributes`，固定 TS/JS/MJS/JSON/Markdown/YAML/HTML/CSS/SVG 为 LF，图片与压缩包为 binary；不做全仓换行重写，避免制造无意义大 diff。
- [x] 验证：运行 `git diff --check`，确认无 whitespace error；后续新增/修改文本文件由 Git attributes 统一规整，减少 Windows/Git Bash 下 CRLF 噪声。

## 216. 标准级状态协调器设计落档

- [x] 性质判定：重大架构/工具规划；目标是以 Node driver 层 Desired/Actual/Diff/Reconcile Loop 实现生产级浏览器状态协调，不做 MVP、Demo 或 prompt-only 方案。
- [x] 决策：采用“此前 session/tab role/ownership 方案 + 标准级状态协调器”合并方案；`browser_orchestrate` 作为未来 Node 组合工具，Chrome extension 只补底层 native command 原语，不承载高层协调状态机。
- [x] 边界：首个生产闭环覆盖 tabs/navigation/cookies/network recorder/hook dispatcher/owned cleanup/watch；不承诺 Chrome profile/incognito/cookie jar 强隔离，不做自动漏洞判断或扫描决策。
- [x] 文档：新增 `docs/browser-orchestration-coordinator.md`，记录目标、架构、职责边界、数据模型、状态流、错误/并发/恢复、安全、测试与分阶段验收。
- [x] 口径：本文档是实现前设计，不把 `browser_orchestrate` 或状态协调器写入当前工具清单/skill callable capability；后续实现时再同步 README、CHANGELOG、skill 与 generated contracts。

## 217. 状态协调器前置协议：cookies write primitive

- [x] 优先级：P0；依赖：TODO 216。
- [x] 性质判定：native command 原语补齐；目标是让 coordinator 可声明式收敛 cookie Desired State，同时保持 Chrome extension 只提供底层 cookies 操作。
- [x] 协议：已扩展 `bridge/native_command_schema.json` 的 `cookies` command，新增/明确 `list|get|set|remove` methods 与 `get/set/remove` required fields；已运行 `npm run sync:protocol`，更新 generated protocol/docs。
- [x] Runtime：已修改 `bridge_src/service_worker/core_commands.ts` 与 `types.ts`，接入 `chrome.cookies.get/set/remove`，保留 http(s) URL 校验、partitionKey/path/domain/secure/httpOnly/sameSite/expirationDate 支持。
- [x] 隐私：`cookies.set/remove` mutation result 与 failure details 不输出 cookie value；list/get 继续保留浏览器 cookie 读取能力供既有 browser-session cookie binding 使用，外层 summary/artifact 继续沿用 token/cookie 脱敏规则。
- [x] 测试：已扩展 `check-pi-browser-bridge.mjs`、`check-protocol-contract.mjs`、`check-token-contract.mjs` 覆盖 set/remove、非法 URL、unsupported scheme、permission/native error、脱敏与协议 required fields。
- [x] 验证：`npm run check:protocol`、`npm run check:bridge:types`、`npm run check:pi-browser-bridge`、`npm run check:token`、全量 `npm run check` 与 Edge isolated runtime smoke 已通过；smoke artifact：`.pi/browser-artifacts/smoke-browser-isolated-results.json`。

## 218. 状态协调器 Node driver 核心

- [x] 优先级：P0；依赖：TODO 217。
- [x] 性质判定：核心生产实现；已新增 `src/driver/orchestration/`，状态机未塞入 `BrowserBridgeServer.ts`、`registerTools.ts` 或 Chrome extension。
- [x] 模块：新增 `types.ts`、`normalizeDesired.ts`、`OrchestrationStore.ts`、`ActualStateCollector.ts`、`DiffPlanner.ts`、`ReconcileExecutor.ts`、`BrowserOrchestrationCoordinator.ts`、`ResourceLocks.ts`、`orchestrationErrors.ts`、`orchestrationRedaction.ts` 与 `index.ts` re-export。
- [x] 集成：`BrowserBridgeServer` 持有 coordinator thin facade；`orchestrator()` 暴露 Node driver API；`stop()` 停止 watch timers 并按 cleanup policy 释放 owned resources；`snapshot()` 暴露 compact orchestration summary。
- [x] 语义：已实现 Desired normalization、Actual aggregation、Diff plan、bounded apply、owned tab binding、resource locks、deadline budget、operation results、partial failure envelope、delete cleanup 与 required failure compensation。
- [x] 边界：保持内存态，不做跨 Pi session 持久化恢复；delete/compensation 只关闭 owned tabs；不跨 browser fallback；store/plan/result/status 不记录 raw cookie value。
- [x] 测试：新增 `tests/contracts/check-orchestration-coordinator.mjs` 与 `check:orchestration`，覆盖 plan/apply/status/delete、重复 apply 幂等、target conflict、partial failure、cleanup compensation 和 cookie value redaction。
- [x] 完成条件：`check:orchestration` 已纳入 `npm run check`；已通过 `npm run check:orchestration`、`npm run check:lifecycle`、`npm run check:fake-ws` 与全量 `npm run check`。

## 219. `browser_orchestrate` 工具注册、结果契约与文档生成

- [x] 优先级：P0；依赖：TODO 218。
- [x] 性质判定：新增 callable tool；已同步工具 schema、budget、summary、artifact、错误 taxonomy、generated docs、README、CHANGELOG、skill。
- [x] Tool：新增 `src/tools/registerOrchestrateTool.ts`，支持 `plan|apply|status|watch|stop|delete`、`dryRun`、`desiredState`、`orchestrationId`、`watch`、`cleanup`、`timeoutMs/detailLevel/outputPath/maxChars`；`cleanup:false` 明确拒绝，避免 orphan owned resources。
- [x] Summary：新增 `src/tools/summaries/orchestration.ts`，summary 上浮 `orchestrationId/generation/converged/operation counts/drift/failures/bindings/watch`，敏感 Desired 字段脱敏，完整 envelope 走 artifact。
- [x] Contract：更新 `registerTools.ts`、`budgets.ts`、`resultMiddleware.ts`、`check-tools-contract.mjs`；`scripts/generate-tool-docs.mjs` 无需额外适配即可识别新工具；generated docs 已刷新。
- [x] Skill/README：已声明 `browser_orchestrate` 为当前 callable 能力，并强调它不替代页面观察、选择器验证或证据判断。
- [x] 完成条件：`npm run docs:generate -- --check` 对应检查通过、全量 `npm run check` 通过，新增 tool contract 文档无 drift。

## 220. Watch/self-heal 协调环生产化

- [x] 优先级：P1；依赖：TODO 219。
- [x] 性质判定：自愈能力，不默认后台运行；`watch` 必须显式启用，已带 TTL、interval、maxAttempts、stop/delete 控制与 pause metadata。
- [x] Drift：已识别 tab missing/url drift/browser mismatch、Service Worker `workerBootId` 变化、network recorder lost/config drift、hook lost/session mismatch/fingerprint drift、cookie drift、navigation/load state drift。
- [x] 恢复：已按 Desired 策略 recreate owned tab、restart/reconfigure recorder、reinstall hook、idempotent cookie set、bounded navigation；连续失败后 pause 并返回 lastFailure/retry diagnostics。
- [x] 泄漏防护：watch reconcile 复用 orchestration/resource locks；TTL 与 maxAttempts 限制后台循环；cleanup 只处理 owned resources；server shutdown/delete/stop 清理 watch timer，无 zombie tab/recorder/hook。
- [x] 测试：扩展 `tests/contracts/check-orchestration-coordinator.mjs` 覆盖 workerBootId restart、tab removed、recorder lost/config、hook uninstalled/fingerprint、cookie drift、navigation timeout、watch stop/delete；`check:lifecycle` 与 `check-runtime-fixtures` 继续通过，保证生命周期与 runtime fixture 兼容。
- [x] 完成条件：故障注入 tests 通过；watch/status/delete operationResults 可审计且无 zombie tab/recorder/hook；已通过 `npm run check:orchestration`、`npm run check:lifecycle`、`npm run check:runtime-fixtures` 与全量 `npm run check`。

## 221. 状态协调器 runtime smoke 与发布验收

- [x] 优先级：P1；依赖：TODO 220。
- [x] Smoke：已扩展 `tests/smoke/smoke-browser.mjs` / `tests/smoke/smoke-browser-isolated.mjs`，覆盖 `browser_orchestrate plan/apply/status/delete` happy path、network recorder、hook dispatcher、cookie set/remove、导航等待与 watch 自愈路径；isolated artifact：`.pi/browser-artifacts/smoke-browser-isolated-results.json`，完整 orchestration envelope：`.pi/browser-artifacts/smoke-orchestration-result.json`。
- [x] Runtime fixtures：`tests/contracts/check-orchestration-coordinator.mjs` 写入可重放 fixture artifact `.pi/browser-artifacts/orchestration-fixture-results.json`，覆盖 partial failure、duplicate apply、cleanup compensation、redaction、artifact full envelope。
- [x] Release：`release:local:smoke` 覆盖当前包 full isolated smoke 与上一包 minimal rollback smoke；失败摘要已包含 orchestrationId、operationResults、bridge port、profile、artifact paths；release artifact：`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`current-smoke-browser-isolated-results.json`、`rollback-smoke-browser-isolated-results.json`。
- [x] 完成条件：`npm run check`、`PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated`、`PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run release:local:smoke` 已通过，并已在 CHANGELOG/TODO 记录 artifact 路径。

## 222. 状态协调器首个生产闭环收口 gate

- [x] 优先级：P0 gate；依赖：TODO 217-221 全部完成。
- [x] 证明条件：cookies primitive、Node coordinator、`browser_orchestrate` tool、watch/self-heal、contracts、generated docs、README、CHANGELOG、skill、isolated smoke 全部完成且一致。
- [x] 行为审计：重复 apply 幂等；部分失败不 silent；cookie value 不泄漏；watch 显式 TTL；Service Worker restart 后 recorder/hook 可恢复；delete 不关闭非 owned tabs。新增 `deleteNonOwned` fixture 断言 reused tab 不被关闭。
- [x] 兼容审计：既有 `browser_tabs`、tab-scoped tools、network/hook/wait 行为不漂移；omitted `tabId` fallback 兼容但不作为 orchestrate 内部目标解析主路径；`browser_orchestrate` 仍是 Node 组合工具，不进入 native schema。
- [x] 文档审计：`docs/browser-orchestration-coordinator.md` 与实际实现一致；skill 不夸大 profile/incognito 强隔离；generated tool/native docs 由 `npm run check:tool-docs` / `npm run check:protocol` 校验无 drift。
- [x] 完成条件：全量 `npm run quality:local`、`PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated` 和 `PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run release:local:smoke` 已通过。关键 artifact：`.pi/browser-artifacts/smoke-browser-isolated-results.json`、`.pi/browser-artifacts/smoke-browser-results.json`、`.pi/browser-artifacts/smoke-orchestration-result.json`、`.pi/browser-artifacts/orchestration-fixture-results.json`、`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`.pi/browser-artifacts/release-acceptance/current-smoke-browser-isolated-results.json`、`.pi/browser-artifacts/release-acceptance/rollback-smoke-browser-isolated-results.json`。

## 状态协调器后续增强执行队列（223-233）

后续路线已落档到 `docs/browser-orchestration-next-roadmap.md`。TODO 217-222 保持已完成状态；以下条目均为未实现的后续增强，完成前不得写入当前 callable capability。固定边界：Target resolver 是 tool-level `target:{...}`，不进入 native schema；Desired/Persistent State 禁止持久化任意可执行脚本文本；跨 Pi session 自动 cleanup 默认禁止；adoption 必须显式声明；`tabGroups` 只做 degraded diagnostic；Incognito 仅 opt-in，不阻塞主干。

## 223. Target Resolver 设计与 Tool Schema 审计

- [x] 优先级：P0；依赖：TODO 222。
- [x] 目标：定义结构化 `target:{...}` 参数，统一 tab-scoped tools 的逻辑寻址模型，减少后续手动 `tabId`。
- [x] 范围：`src/tools/toolShared.ts`、`src/tools/toolAdapter.ts`、`src/driver/types.ts`、`BrowserBridgeServer.ts`、`BrowserTabSessionRouter.ts`、`src/driver/orchestration/*`、tool contracts、generated docs、README/skill 文案。
- [x] 关键设计：`target` 是 tool schema，不进入 `bridge/native_command_schema.json`；支持 `tabId/browserId/orchestrationId/sessionTag/tabRole`，预留 `windowId/groupId/profileId/requireOwned`；`tabId` 与 `target.tabId` 或 command body `tabId` 冲突必须结构化失败；无 `orchestrationId` 的 `sessionTag/tabRole` 只能在唯一匹配时解析，否则 `TARGET_AMBIGUOUS`。
- [x] 预期产出：新增 `docs/browser-target-resolver.md`，覆盖目标/非目标、覆盖工具清单、TypeBox schema 草案、解析优先级、冲突规则、driver resolver API 草案、错误码/diagnostics 与 TODO 224 输入条件；`docs/browser-orchestration-next-roadmap.md` 与 README 已指向该设计。
- [x] Contract：`tests/contracts/check-protocol-contract.mjs` 断言 native command schema 不暴露 tool-level logical target fields：`target/sessionTag/tabRole/orchestrationId/profileId/groupId/requireOwned`。
- [x] 验收条件：`npm run check:protocol`、`npm run check:tools`、`npm run check:tool-docs` 已通过；本项不实现 runtime target resolver，不修改 callable tool schemas，不更新 skill 为当前能力。
- [x] 风险/回滚：风险是破坏现有 `tabId` 兼容或引入静默 fallback；回滚为继续只使用 legacy `tabId`。

## 224. Target Resolver 实现与 Runtime 验证

- [x] 优先级：P0；依赖：TODO 223。
- [x] 目标：所有 tab-scoped tools 支持 `target:{orchestrationId,sessionTag,tabRole}` 定位 orchestration tab。
- [x] 范围：`toolAdapter.ts`、各 tab-scoped `register*.ts`、`BrowserBridgeServer.ts`、`BrowserTabSessionRouter.ts`、`OrchestrationStore.ts`、orchestration types、contracts、isolated smoke。
- [x] 关键设计：`toolAdapter` 统一暴露 `target`；新增 `BrowserTargetResolver` 并由 `BrowserBridgeServer.resolveToolTarget()` 委派；Node driver 解析后只向 native command 传最终 `tabId`；ambiguous/stale/conflict 不降级到 default/latest tab；`BrowserBridgeTargetInfo` 保留 `source:"orchestration"`、`browserId`、`orchestrationId/sessionTag/tabRole` diagnostics。
- [x] 实施：新增 shared target params；迁移 scan/content/html/execute/wait/network/hook/evidence/frame/screenshot/download/upload/pick 与 WebSecurity cookie provider；接入 orchestration binding 查询；orchestration 内部 tab 操作使用 browser-scoped binding 并加固 createTab 后 tab-sync 等待；更新 generated docs、README 与 skill guideline；smoke 使用逻辑 target 执行 execute/network/hook/wait 与 self-heal 验证。
- [x] Contract：`check:tools` 锁定 shared target schema、resolver 模块、router browser-scoped physical target；`check:lifecycle` 覆盖 logical target 跨 selected browser dispatch、browser-scoped duplicate switch、target conflict/browser conflict/stale/ambiguous；`check:protocol` 继续断言 native schema 不暴露 logical target fields。
- [x] 验收条件：`npm run check`、`npm run check:orchestration`、`npm run check:lifecycle`、Edge isolated smoke 已通过；smoke artifact `.pi/browser-artifacts/smoke-browser-isolated-results.json` / `.pi/browser-artifacts/smoke-orchestration-result.json` 上浮 `targetSource:"orchestration"`。
- [x] 风险/回滚：风险是 target 解析改变现有 fallback 行为；回滚为禁用 shared `target` 参数与 `BrowserTargetResolver` 委派，保留 `tabId` 路径。

## 225. Window/tabGroups Native Primitive 设计

- [x] 优先级：P1；依赖：TODO 224。
- [x] 目标：为 owned window lifecycle 与 Chrome `tabGroups` 视觉分组定义独立 native primitives、权限、错误 taxonomy 与降级语义。
- [x] 范围：`bridge/native_command_schema.json`、protocol sync、`bridge_src/service_worker/core_commands.ts`、Chrome API types、manifest、generated docs、contracts；本项只冻结草案，不修改实际 native schema/runtime/manifest。
- [x] 关键设计：后续 TODO 226 新增独立 `windows` / `tabGroups` command；`tabGroups` 需要 manifest permission，但 unsupported 返回 `tabGroupsStatus:"degraded_not_supported"`，不得阻断 tabs/navigation/cookies/network/hook 核心 reconcile。
- [x] 预期产出：新增 `docs/window-isolation-tabgroups.md`，冻结 command schema 草案、错误码、Chrome API 类型计划、permission/package/smoke 同步计划、no-hard-fail contract；static contract 锁定 design-only 边界，避免 `windows` / `tabGroups` 早于 runtime 进入 schema 或 manifest。
- [x] 验收条件：`npm run check:protocol`、`npm run check:bridge:files`、generated native docs 无 drift；contract 证明 `tabGroups` 不作为必需成功条件。
- [x] 风险/回滚：权限提示变化与 Chromium 兼容性；回滚为移除 `tabGroups` permission/schema，保留 tabs 核心能力。

## 226. Window Isolation 与 tabGroups 实现

- [x] 优先级：P1；依赖：TODO 225。
- [x] 目标：coordinator 支持 owned window 创建/绑定/cleanup，并在可用时分组 owned tabs。
- [x] 范围：bridge core commands、orchestration types/normalize/actual/diff/executor/store/locks/redaction、contracts。
- [x] 关键设计：Desired 增 `windowIsolation/ownedWindow/visualGrouping`；Binding 增 `windowId/windowOwned/groupId/tabGroupsStatus`；cleanup 只关闭 owned window/tab；非 owned window 只可 reuse；`tabGroups` degraded 后继续核心 reconcile。
- [x] 实施：新增 `windows list|get|create|update|focus|close` 与 `tabGroups status|query|group|update|ungroup` native primitives；manifest 增加 `tabGroups` permission；bridge runtime/types/tab sync 返回 `windowId/groupId`；orchestration 新增 `window` 与 `visual-grouping` phase、`createWindow/groupTabs/closeWindow` operations、owned window cleanup、degraded operation status；summary/status/store/artifact 上浮 `windowId/groupId/tabGroupsStatus`。
- [x] Contract：`check:protocol` 锁定 runtime schema/error taxonomy 且 logical target fields 不进入 native schema；`check:bridge:files` 锁定 manifest permission、bridge runtime/types；`check:orchestration` fixture 覆盖 owned window lifecycle、visual grouping success、`tabGroupsStatus:"degraded_not_supported"` no-hard-fail、non-owned cleanup 与 partial-failure compensation。
- [x] 验收条件：`npm run check:protocol`、`npm run check:bridge:files`、`npm run check:pi-browser-bridge`、`npm run check:orchestration` 已通过；fixture artifact `.pi/browser-artifacts/orchestration-fixture-results.json` 包含 window/group lifecycle 证据。
- [x] 风险/回滚：windowId 可复用，误关窗口风险高；回滚为禁用 `ownedWindow` operations，保留 tabs/cookies/network/hook 主链路。

## 227. Window/tabGroups Runtime Smoke Gate

- [x] 优先级：P1 gate；依赖：TODO 226。
- [x] 目标：真实浏览器验证 owned window、owned tabs 与 tabGroups degraded/success diagnostics。
- [x] 范围：`tests/smoke/smoke-browser.mjs`、`tests/smoke/smoke-browser-isolated.mjs`、`tests/release/release-local-acceptance.mjs`、smoke diagnostics、README/CHANGELOG/TODO。
- [x] 实施：full browser smoke 新增 `browser_orchestrate.windowPlan/windowApply/windowStatus/windowDelete/windowArtifact`，创建 owned window 与两个 owned tabs，验证 `createWindow/groupTabs/closeWindow`、同一 `windowId`、`groupId`、`tabGroupsStatus` 与 cleanup；isolated smoke 上浮 `windowTabGroups` diagnostics；release smoke/current artifact 记录同一 diagnostics，rollback 保持最小 tabs/wait/execute。
- [x] 关键设计：支持 tabGroups 时验证 `groupId` 与 `tabGroupsStatus:"available"`；不支持时允许 degraded diagnostic；delete 后 owned window 通过 `closeWindow` 清理，non-owned resources 保留。
- [x] 验收条件：`npm run check`、Edge isolated smoke、`release:local:smoke` 已通过；artifact 上浮 `windowId/groupId/tabGroupsStatus`。
- [x] Artifact：`.pi/browser-artifacts/smoke-browser-isolated-results.json`、`.pi/browser-artifacts/smoke-browser-results.json`、`.pi/browser-artifacts/smoke-window-tabgroups-result.json`、`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`.pi/browser-artifacts/release-acceptance/current-smoke-browser-isolated-results.json`、`.pi/browser-artifacts/release-acceptance/current-smoke-browser-results.json`。
- [x] 风险/回滚：浏览器差异可能导致 flake；回滚为保留 owned window smoke，禁用 visual grouping hard assertion。

## 228. Pre-navigation Hook Policy 设计

- [x] 优先级：P1；依赖：TODO 224。
- [x] 目标：定义基于 `frame.addNewDocumentScript` 的 document-start hook policy，解决导航前早期注入，同时禁止持久化任意可执行脚本文本。
- [x] 范围：`docs/browser-orchestration-coordinator.md`、新增 hook policy doc、orchestration types、frame primitive docs、page script contracts。
- [x] 关键设计：Desired 只保存 `hookId/enabled/params/scope/version/hash`；真实脚本文本只来自 driver 内置 registry 或仓库只读安全目录 + hash；contract 禁止 `script/code/source` 进入 persisted Desired。
- [x] 实施：新增 `docs/pre-navigation-hook-policy.md`，冻结 hook registry、metadata schema、install-before-navigate lifecycle、MV3 restart/watch 恢复策略、cleanup/verification 与 no-script-persistence 边界；`normalizeDesired` 对 TODO229 前的 `preNavigationHooks` 显式拒绝，避免字段被静默忽略；orchestration types 增加设计期 metadata 类型但不规划 runtime operation。
- [x] Contract：新增 `check:pre-nav-hook-policy`，锁定 policy 文档、metadata 字段、forbidden `script/code/source` 递归拒绝、`browser_frame.addNewDocumentScript` raw primitive 与 orchestration policy 的边界；`npm run check` 纳入该静态契约。
- [x] 验收条件：`npm run check:tools`、`npm run check:token`、`npm run check:pre-nav-hook-policy`、`npm run check` 已通过。
- [x] 风险/回滚：外部 JSON 注入脚本文本风险；回滚为移除 future `preNavigationHooks` metadata 类型与 rejection contract，保留 `browser_frame.addNewDocumentScript` primitive。

## 229. Pre-navigation Hook 实现与 Smoke

- [ ] 优先级：P1；依赖：TODO 228。
- [ ] 目标：coordinator 支持 pre-navigation hook 安装、验证、清理与 watch 恢复。
- [ ] 范围：orchestration modules、frame command path、orchestrate tool schema/summary、contracts、runtime smoke。
- [ ] 关键设计：hook phase 必须在 navigation 前；Binding 保存 hook id、registration id、hash，不保存脚本文本；delete/stop 清理 registration；watch 检测 registration 丢失并重装；已加载页面不承诺 retroactive 生效。
- [ ] 实施步骤：实现安全 hook registry；扩展 Desired normalization；扩展 DiffPlanner/ReconcileExecutor/ActualStateCollector；增加 restart/lost registration fixtures；smoke 验证 document-start 标记早于页面脚本。
- [ ] 验收条件：`npm run check`、`npm run check:orchestration`、`npm run check:runtime-fixtures`、Edge isolated smoke 通过。
- [ ] 风险/回滚：CDP/session 与 frame lifecycle 复杂；回滚为禁用 Desired `preNavigationHooks`。

## 230. Persistent State 安全设计

- [ ] 优先级：P2；依赖：TODO 224；建议在 TODO 226 后执行。
- [ ] 目标：设计 redacted orchestration state 持久化，提供重启诊断与显式 adoption 基础。
- [ ] 范围：`OrchestrationStore.ts`、future `PersistentOrchestrationStore.ts`、`BrowserBridgeServer.ts`、driver types、orchestration docs、artifact privacy docs。
- [ ] 关键设计：state 包含 `schemaVersion/driverRunId/piSessionId/orchestrationId/redactedDesired/bindings/fingerprints`；禁止 raw cookie、body/postData/payload、任意脚本文本落盘；startup load 默认 read-only/stale，不启动 watch，不 cleanup。
- [ ] 预期产出：`docs/orchestration-persistence.md`、state schema、driverRunId/Pi session 边界、stale/adoption 状态机、redaction 与手动清理策略。
- [ ] 验收条件：`npm run check:token`、`npm run check:artifact`、static persistence contract 通过。
- [ ] 风险/回滚：tabId/windowId 复用导致误托管；回滚为忽略 state 文件，恢复纯内存 store。

## 231. Persistent State 实现与 Adoption Gate

- [ ] 优先级：P2；依赖：TODO 230。
- [ ] 目标：实现持久化、重启后 read-only status、显式 adoption；禁止跨 session 自动误关。
- [ ] 范围：orchestration store/coordinator/server lifecycle、contracts、lifecycle fixture、isolated smoke。
- [ ] 关键设计：adoption 必须显式声明 `enabled:true/orchestrationId/resourceTypes/verifyOrigins/verifyUrls`；adoption 前重新 observe live resources；未 adoption 的 stale resources 只可 status，不可 watch/cleanup/close。
- [ ] 实施步骤：实现 save/load；server startup 加载 stale state；status 显示 `adoptionRequired`；apply/watch 处理 explicit adoption；restart fixture 验证不误关旧 tab；smoke 验证 adoption 后才可 cleanup。
- [ ] 验收条件：`npm run check`、`npm run check:lifecycle`、`npm run check:orchestration`、Edge isolated smoke restart/adoption artifact 通过。
- [ ] 风险/回滚：错误 adoption 误关用户资源；回滚为启动时不加载 persistent state。

## 232. Profile/Incognito 隔离设计

- [ ] 优先级：P2/P3；依赖：TODO 224；建议在 TODO 231 后执行。
- [ ] 目标：冻结 profile-first 物理隔离方案；Incognito 仅作为 opt-in diagnostic。
- [ ] 范围：isolated smoke、release smoke、new profile isolation doc、driver/profile manager design、orchestration Desired schema。
- [ ] 关键设计：Profile-first 使用独立 `--user-data-dir`、extension copy、bridge port、owned process；Incognito 需要用户授权扩展无痕运行，未授权只返回 diagnostic；默认 isolation 仍为 logical，profile scope 必须显式声明。
- [ ] 预期产出：`docs/browser-profile-isolation.md`、profile lifecycle、cookie/storage 隔离验证、incognito probe、release smoke 条件。
- [ ] 验收条件：设计文档完成；static contract 确认 Incognito 不进入默认 gate。
- [ ] 风险/回滚：Chrome path、端口、子进程清理跨平台复杂；回滚为不启用 profile scope。

## 233. Managed Profile-first 实现 Gate

- [ ] 优先级：P3；依赖：TODO 232。
- [ ] 目标：实现 owned browser profile lifecycle 与隔离 smoke；Incognito 保持 opt-in probe，不阻塞主干。
- [ ] 范围：future `BrowserProfileManager.ts`、`BrowserBridgeServer.ts`、driver/orchestration modules、isolated smoke、release smoke、docs/skill/CHANGELOG。
- [ ] 关键设计：profile 由 driver 创建并 owned；delete 只停止 owned profile process，不关闭用户 Chrome；每个 profile 有 `profileId/profileDir/bridgePort/extensionDir`；cookie/localStorage 隔离必测；Incognito 未授权返回 `INCOGNITO_NOT_ALLOWED` diagnostic。
- [ ] 实施步骤：抽出 managed profile lifecycle；支持 Desired `isolation.scope:"profile"`；target resolver 支持 profile-bound browserId；smoke 启动两个 profiles 并验证 storage 隔离；release smoke 用解包扩展验证 fresh profile。
- [ ] 验收条件：`npm run check`、Edge isolated smoke、`release:local:smoke` 通过；artifact 证明 profile A/B cookie/storage 不互通且 owned process 清理完成。
- [ ] 风险/回滚：最高风险项，不与 TODO 224 同批；回滚为禁用 `isolation.scope:"profile"`。

## 下一步建议顺序

1. TODO 223-228 已完成；下一步执行 TODO 229，推进 pre-navigation hook runtime 与 smoke gate。
2. 执行 TODO 230 → 231，推进 redacted persistence 与 explicit adoption。
3. 执行 TODO 232 → 233，推进 profile-first；完整 Incognito 如需主干实现，另开 TODO 234。
4. 发布/合并前继续复跑 `npm run quality:local`；需要 runtime 证据时复跑 `npm run release:local:smoke` 或 `npm run smoke:browser:isolated`。
