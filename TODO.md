# TODO

## 当前状态

- 当前主链路：`browser_tabs` -> `browser_scan` / `browser_content` / `browser_html` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎优先以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- 当前收敛的是实现路线与职责分层，不是工具能力收缩，也不是工具层安全边界收缩；扩展工具层能力第一，安全边界由 Pi 平台/安全层负责。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。

## 历史整理归档（1-162 已完成）

- 1-26：原生 Pi Browser Bridge、协议 schema、工具注册拆分、resultMiddleware/artifact/detailLevel、`browser_pick`/`browser_content` 基础能力完成。
- 27-73：历史动作拆分与 semantic DOM 工具已复审撤回；当前工具面收敛为 scan/content/execute/wait/network/hook/evidence/frame/html/screenshot/artifact 等组合能力，复杂交互走 `browser_scan` + `browser_execute`。
- 74-102：Web 执行面已落地并归档：recon/crawl/path-vhost-param fuzz/http replay/cookie/sqli/template/OAST/sqlmap/nuclei；单包分层、budget、summary、artifact、raw/HAR/captured request 链路与成熟引擎 bridge 契约完成。
- 103-126：Bug report C/H/M/L 批次已处理；覆盖 BrowserBridge session/tab、WS origin/retry、upload/download、transport/tab_sync、network/wait/hook/html/screenshot、JSON/router 等边界修复与契约。
- 127-129：默认 tab 竞态可观测化、MV3 长等待短租约 supervisor、Bridge JS `checkJs` 类型栅栏已完成。
- 130-156：桌面审计报告 Bug 1-26 已完成；覆盖 wait deadline、BrowserBridge/tab 路由、native 命令、内容/下载/截图、ReDoS/安全预算、契约与 README/CHANGELOG/skill 同步。
- 157-162：Bug 28+ 当前基线复核完成；已覆盖项与 callable 子集证据已归档，剩余未覆盖/部分覆盖项全部转入 TODO 163-174。
- 历史归档不再作为执行队列；Bug 审计队列已收口，当前从未完成 TODO 180 起推进，必要时回看 git diff、桌面报告与对应契约文件。


## 近期完成归档（163-179 已完成）

- 163-174：桌面缺陷审计剩余项已收口；覆盖 download mode、hook session/listener lifecycle、pick timeout、performance/evidence timeout、frame script lifecycle、wait.diagnose、html/artifact/content/scan 保真和真实 runtime callable 子集验证。关键证据：`.pi/browser-artifacts/todo174-runtime-callable-summary-reload.json`。
- 163A：`browser_network` 默认有界捕获 XHR/Fetch/Document JSON/text/html response body 与 request postData，`bodyAvailability/bodyUnavailableReason` 已落地，避免原始浏览器响应证据缺失不透明。
- 175-177：WebSecurity TS 注册层、summary 层和参数 shell 已按能力拆分并类型收口；`registerWebSecurityTools.ts` 14 行 facade，`src/tools/summaries/webSecurity.ts` 1 行 facade，契约锁定 12 个安全工具 schema/summary/artifact 行为不漂移。
- 178-179：Bridge Network recorder 已拆为 `network_model.js`（状态/配置/过滤/body 存储）与 `network.js`（CDP 事件/生命周期/命令分发），保留 `patterns.js -> wait.js -> network_model.js -> network.js` 加载顺序；`npm run check` 已通过，真实扩展 runtime 子集通过。关键证据：`.pi/browser-artifacts/runtime-bridge-validation-results.json`、`.pi/browser-artifacts/screenshot-1779252971729.png`。
- 历史归档不再作为执行队列；需要细节时回看 git：`cce5bd9`、`00141c6`、`6665217` 及对应契约文件。

## 当前架构债决策（支柱二/三/四）

- 支柱三（`wait.js` 解耦）已完成：wait 子系统拆为 `wait_cdp.js`、`wait_coordinator.js`、`wait_navigation.js`、`wait_network_idle.js`、`wait_selector.js` 与 299 行 `wait.js` facade；当前从 TODO 184 继续处理页面注入边界。
- 支柱二（ESM + TS bundler）是真实架构债，不因工作量大而搁置；但必须先完成 wait/hook 页面注入边界、smoke 诊断和 bridge 类型收口，再按构建产物切换路径迁移，避免一次性改动破坏 MV3 runtime。
- 支柱四（smoke 端口冲突）诊断成立但原“动态端口自动协商”方案不直接适配固定 `config.js` 的 MV3 扩展；先做显式失败分类和文档，再做无 puppeteer/playwright 强依赖的独占 Chrome profile smoke。
- `network.js` 已完成拆分，不再列为待拆债务；`hook_dispatcher.js` 是页面注入脚本，不能照搬 service worker `importScripts` 拆法，必须先冻结注入/打包边界。

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
- [x] Smoke 定位：`smoke:browser` 在启动 bridge 前写入 `build.runtime`，包含 `runtimeSwitched:true`、`manifestTarget:"dist/service-worker.js"`、entries 和 service worker sha256；本分支运行时被现有 Pi agent 占用 127.0.0.1:18765 阻断，artifact `.pi/browser-artifacts/smoke-browser-results.json` 已记录 `bridge.port.reason:"agent_occupies"`，未关闭用户进程。
- [x] 回滚：未保留双生产入口；若后续真实 reload 失败，必须在 TODO 193 gate 内修复或整项回滚，不能恢复旧 `background.js` 为备用生产路径。

## 192. 删除旧 `importScripts` 多文件入口与冗余 globals

- [x] 删除范围：已移除 `background.js`、旧 service worker/page 多文件 `.js`、`bridge-globals.d.ts` 与 `tsconfig.bridge.json`；生产目录只保留 manifest、popup、native schema、icons 和 generated dist marker。
- [x] 禁止债务：未保留“旧路径备用”“临时兼容入口”“双写 command handler”；测试改读 `bridge_src/service_worker/*.ts` / `bridge_src/page_scripts/*.ts` 源模块和 dist bundle，不再依赖生产目录旧 JS。
- [x] 契约：`check-bridge-files.mjs` 锁定生产入口只有 dist module service worker、manifest content scripts 指向 dist、legacy ambient globals 不存在；`check:bridge:types` 只检查 `tsconfig.bridge-src.json`。
- [x] 文档：README/AI_INSTALL/CHANGELOG/TODO 同步最终工程边界；能力描述未变化，未修改全局 skill。

## 193. 支柱二最终收口 gate

- [ ] 证明：ESM TS source、bundle build、manifest dist、页面独立 bundle、旧 importScripts 删除、ambient 类型收口全部由当前源码和契约证明。
- [ ] 全量验证：`npm run check`、真实扩展 runtime callable 子集、`npm run smoke:browser`（可独占端口时）全部通过；artifact 路径写入 TODO。
- [ ] 行为审计：对比迁移前后 tool names、schemas、error codes、summary/artifact 字段、network body/postData、wait supervisor metadata 无漂移。
- [ ] 文档收口：CHANGELOG 记录完整支柱二迁移；TODO 勾选所有支柱二任务；若全局 skill 文本涉及安装/reload/build 流程则运行 skill quick validate。

## 194. 独占 Chrome profile smoke（支柱四中期闭环）

- [ ] 性质判定：runtime 验证增强；目标是在不关闭用户常驻 agent/bridge 的情况下启动独占 Chrome profile 和临时扩展配置。
- [ ] 实现路线：优先用 `child_process` 启动本机 Chrome/Chromium + `--user-data-dir .pi/temp-profiles/smoke-*` + `--load-extension` 临时扩展副本；不默认引入 puppeteer/playwright 大依赖。
- [ ] 端口配置：临时复制扩展目录并生成对应端口的 `config.js`；测试结束清理临时 profile/extension 副本；不得修改用户正在使用的扩展目录。
- [ ] 契约与文档：新增 `smoke:browser:isolated`，失败时输出 Chrome path/profile/port/artifact；AI_INSTALL 记录普通 smoke 与 isolated smoke 的适用场景。
- [ ] Gate：本项排在 TODO 193 后执行；若本地 smoke 需要与常驻 agent 并行或提前进入 CI gate，则提前执行。TODO 保留明确方案，不替代 TODO 185 的即时诊断。

## 下一步建议顺序

1. 已完成 TODO 180：`wait.js` 只读依赖图和拆分契约准备。
2. 已完成 TODO 181：`wait_cdp.js` 拆出 CDP refs/subscription，契约与 `npm run check` 通过。
3. 已完成 TODO 182：`wait_coordinator.js` 拆出 WaitCoordinator、orphan GC 与 event subscription registry，契约与 `npm run check` 通过。
4. 已完成 TODO 183：`wait_navigation.js` / `wait_network_idle.js` / `wait_selector.js` 拆分与 wait facade 收口。
5. 已完成 TODO 184：冻结 `hook_dispatcher.js` 页面注入拆分/打包边界，真正拆分延后到 TODO 190 独立页面 bundle。
6. 已完成 TODO 185：补 smoke 端口冲突显式诊断。
7. 已完成 TODO 186：收紧 bridge ambient/global 类型。
8. 已完成 TODO 187：冻结 ESM + TS bundler 迁移设计。
9. 已完成 TODO 189：service worker bridge ESM TypeScript bundle 兼容源码、显式 boundary symbol imports 与 dist import 契约。
10. 已完成 TODO 190：页面/内容脚本独立 dist bundle 迁移与契约。
11. 已完成 TODO 191：manifest/package/check/smoke 定位切到 dist；真实 callable 通过证据仍归 TODO 193 gate。
12. 已完成 TODO 192：删除旧 importScripts 多文件入口与冗余 globals。
13. TODO 193：最终行为/真实 runtime gate。
14. TODO 194：在需要并行本地 smoke 或 CI runtime gate 时实现独占 Chrome profile smoke。
