# Bridge ESM / Runtime Detailed History

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
- [x] 契约：新增 `tests/contracts/runtime/check-smoke-diagnostics.mjs` 并接入 `npm run check`，锁定分类语义、artifact step 名和文档 reason。
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
- [x] 契约：新增 `tests/contracts/drift/check-package-files.mjs` 并接入 `check:package` / `npm run check`；契约解析 `npm pack --dry-run --json`，强制包内包含 manifest 指向的 service worker/content/disable-dialogs dist、hook dispatcher、source maps、build manifest、manifest、native schema、bridge source 和 build script，禁止只包含 `dist/.gitignore` 的坏状态。
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

