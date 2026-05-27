# Orchestration Detailed History

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

后续路线已落档到 `docs/browser-orchestration-next-roadmap.md`。TODO 217-233 均已完成；以下条目记录已落地的增强与验收证据。固定边界：Target resolver 是 tool-level `target:{...}`，不进入 native schema；Desired/Persistent State 禁止持久化任意可执行脚本文本；跨 Pi session 自动 cleanup 默认禁止；adoption 必须显式声明；`tabGroups` 只做 degraded diagnostic；Incognito 仅 opt-in，不阻塞主干。

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
- [x] 实施：新增 `docs/pre-navigation-hook-policy.md`，冻结 hook registry、metadata schema、install-before-navigate lifecycle、MV3 restart/watch 恢复策略、cleanup/verification 与 no-script-persistence 边界；TODO228 阶段 `normalizeDesired` 对 enabled `preNavigationHooks` 显式拒绝，避免字段被静默忽略；orchestration types 增加设计期 metadata 类型但不规划 runtime operation。TODO229 已替换为 runtime normalization。
- [x] Contract：新增 `check:pre-nav-hook-policy`，锁定 policy 文档、metadata 字段、forbidden `script/code/source` 递归拒绝、`browser_frame.addNewDocumentScript` raw primitive 与 orchestration policy 的边界；`npm run check` 纳入该静态契约。
- [x] 验收条件：`npm run check:tools`、`npm run check:token`、`npm run check:pre-nav-hook-policy`、`npm run check` 已通过。
- [x] 风险/回滚：外部 JSON 注入脚本文本风险；回滚为移除 future `preNavigationHooks` metadata 类型与 rejection contract，保留 `browser_frame.addNewDocumentScript` primitive。

## 229. Pre-navigation Hook 实现与 Smoke

- [x] 优先级：P1；依赖：TODO 228。
- [x] 目标：coordinator 支持 pre-navigation hook 安装、验证、清理与 watch 恢复。
- [x] 范围：orchestration modules、frame command path、orchestrate tool schema/summary、contracts、runtime smoke。
- [x] 关键设计：hook phase 固定在 navigation 前；有 pre-navigation hook 的新 tab/window 先创建 `about:blank`，完成 `frame.addNewDocumentScript` 后再 navigate；Binding 只保存 hook id、version、hash、identifier、sessionKey、cdpSessionName、workerBootId，不保存脚本文本；delete/stop 清理 registration；watch/status 检测 registration 丢失或 workerBoot 变化并重装；已加载页面不承诺 retroactive 生效，必要时重新导航生成新 document。
- [x] 实施：新增受控内置 registry `pi.preNavigationMarker@1` 与 sha256 hash 校验；`normalizeDesired` 接受 registry-backed `preNavigationHooks` 并递归拒绝 `script/code/source`；`DiffPlanner` 增加 `hook-pre-nav` phase 与 `installPreNavigationHook` operation；`ReconcileExecutor` 通过 `frame.addNewDocumentScript` 安装、`persistent_cdp Runtime.evaluate` 验证 marker、`frame.removeNewDocumentScript` 清理；`ActualStateCollector` 通过 `persistent_cdp.listNewDocumentScripts` 与 marker evaluate 检测 registration/effect；Store/summary/status 上浮 registration metadata。
- [x] Contract：`check:pre-nav-hook-policy` 更新为 runtime 契约；`check:orchestration` fixture 覆盖 about:blank 创建、安装后导航、effect 验证、workerBoot/lost registration 恢复、delete cleanup 与 no raw script bytes；`check:smoke-diagnostics` 锁定真实 smoke 的 preNav steps/artifact。
- [x] Smoke：`smoke:browser` 新增 `browser_orchestrate.preNavPlan/preNavApply/preNavEffect/preNavStop/preNavDelete/preNavArtifact`，页面 head 脚本验证 document-start marker 早于页面脚本生效，artifact 写入 `.pi/browser-artifacts/smoke-pre-navigation-hook-result.json`；Edge isolated smoke gate 需通过后记录 artifact。
- [x] 验收条件：`npm run check`、`npm run check:orchestration`、`npm run check:runtime-fixtures`、Edge isolated smoke 通过。
- [x] 风险/回滚：CDP/session 与 frame lifecycle 复杂；回滚为禁用 Desired `preNavigationHooks`，保留 raw `browser_frame.addNewDocumentScript` primitive。

## 230. Persistent State 安全设计

- [x] 优先级：P2；依赖：TODO 224；建议在 TODO 226 后执行。
- [x] 目标：设计 redacted orchestration state 持久化，提供重启诊断与显式 adoption 基础。
- [x] 范围：已新增 `docs/orchestration-persistence.md`，覆盖 `OrchestrationStore.ts`、future `PersistentOrchestrationStore.ts`、`BrowserBridgeServer.ts` lifecycle 边界、driver persistence types、orchestration docs 与 artifact privacy docs；本项不实现 runtime save/load。
- [x] 关键设计：state schema 固定为 `pi.browser.orchestration.state/v1`，包含 `schemaVersion/driverRunId/piSessionId/orchestrationId/redactedDesired/bindings/fingerprints`；禁止 raw cookie、body/postData/payload、任意脚本文本落盘；startup load 默认 `stale/readOnly/adoptionRequired`，不启动 watch，不 cleanup，不 close。
- [x] 类型/边界：`types.ts` 增加 `OrchestrationPersistedStateFile`、`OrchestrationPersistedRecord`、`OrchestrationPersistedResourceFingerprint`、`OrchestrationPersistedCookieFingerprint` 与 `OrchestrationAdoptionPolicy` 草案；`OrchestrationStore.ts` 保持纯内存，无文件 I/O；`PersistentOrchestrationStore.ts` 已由 TODO 231 承担文件 I/O。
- [x] 契约/文档：新增 `check:orchestration-persistence` 并纳入 `npm run check`；README/AI_INSTALL/roadmap/coordinator doc/CHANGELOG/TODO 同步 persistence path、隐私分类 `local_redacted_orchestration_state`、manual cleanup 与 adoption 状态机。
- [x] 验收条件：已通过 `npm run check:orchestration-persistence`、`npm run check:token`、`npm run check:artifact`；TODO 231 已完成 save/load、restart fixture、adoption runtime 与 smoke gate。
- [x] 风险/回滚：tabId/windowId 复用导致误托管；回滚为忽略 state 文件，恢复纯内存 store。

## 231. Persistent State 实现与 Adoption Gate

- [x] 优先级：P2；依赖：TODO 230。
- [x] 目标：实现持久化、重启后 read-only status、显式 adoption；禁止跨 session 自动误关。
- [x] 范围：orchestration store/coordinator/server lifecycle、contracts、lifecycle fixture、isolated smoke。
- [x] 实现：新增 `PersistentOrchestrationStore.ts`，默认 `.pi/browser-artifacts/orchestration-state/state.v1.json`，schema `pi.browser.orchestration.state/v1`；save 使用 redacted record + temp/fsync/rename，load 写入 read-only/adoptionRequired stale view。
- [x] Lifecycle：`BrowserBridgeServer.start()` 加载 stale state，`stop()/shutdown/apply/stop/delete` 保存 redacted state；`OrchestrationStore.ts` 继续纯内存，文件 I/O 只在 persistence adapter。
- [x] Adoption gate：未 adoption 的 stale resources 只可 status；`apply/watch/stop/delete` 返回 `ORCHESTRATION_TARGET_STALE` 且不 watch/cleanup/close；explicit `adoption` 校验 `resourceTypes/verifyOrigins/verifyUrls`、browserId/windowId/profileId 与 owned fingerprint 后才转 `adopted`。
- [x] 契约：`check-orchestration-coordinator.mjs` 覆盖 redacted state、stale read-only gate、bad adoption 不误关旧 tab、adoption 后 cleanup；`check-lifecycle.mjs` 覆盖 restart load；`check-orchestration-persistence.mjs` 锁 runtime wiring。
- [x] 验收条件：已通过 `npm run check:orchestration-persistence`、`npm run check:orchestration`、`npm run check:lifecycle`；Edge isolated smoke restart/adoption artifact 路径 `.pi/browser-artifacts/smoke-orchestration-persistence-result.json`。
- [x] 风险/回滚：错误 adoption 误关用户资源；回滚为启动时不加载 persistent state。

## 232. Profile/Incognito 隔离设计

- [x] 优先级：P2/P3；依赖：TODO 224；建议在 TODO 231 后执行。
- [x] 目标：冻结 profile-first 物理隔离方案；Incognito 仅作为 opt-in diagnostic。
- [x] 范围：isolated smoke、release smoke、new profile isolation doc、driver/profile manager design、orchestration Desired schema。
- [x] 关键设计：Profile-first 使用独立 `--user-data-dir`、extension copy、bridge port、owned process；Incognito 需要用户授权扩展无痕运行，未授权只返回 diagnostic；默认 isolation 仍为 logical，profile scope 必须显式声明。
- [x] 预期产出：`docs/browser-profile-isolation.md`，冻结 profile lifecycle、Desired `isolation.scope:"profile"` 草案、cookie/localStorage/sessionStorage 隔离验证、incognito opt-in probe 与 release smoke 条件；TODO 233 已接续实现 runtime profile scope。
- [x] 契约：新增 `check:profile-isolation` 并纳入 `npm run check`，锁定 manifest 默认不启用 incognito、isolated/release smoke 不把 incognito 放入默认 gate；TODO 233 已替换 design-only runtime 边界。
- [x] 验收条件：设计文档完成；static contract 确认 Incognito 不进入默认 gate。
- [x] 风险/回滚：Chrome path、端口、子进程清理跨平台复杂；回滚为不启用 profile scope。

## 233. Managed Profile-first 实现 Gate

- [x] 优先级：P3；依赖：TODO 232。
- [x] 目标：实现 owned browser profile lifecycle 与隔离 smoke；Incognito 保持 opt-in probe，不阻塞主干。
- [x] 范围：`BrowserProfileManager.ts`、`BrowserBridgeServer.ts`、driver/orchestration modules、isolated smoke、release smoke、docs/skill/CHANGELOG。
- [x] 关键设计：profile 由 driver 创建并 owned；delete 只停止 owned profile process，不关闭用户 Chrome；每个 profile 有 `profileId/profileDir/bridgePort/extensionDir`；cookie/localStorage 隔离必测；Incognito 未授权返回 `INCOGNITO_NOT_ALLOWED` diagnostic。
- [x] 实施步骤：抽出 managed profile lifecycle；支持 Desired `isolation.scope:"profile"`；target resolver 支持 profile-bound browserId；smoke 启动两个 profiles 并验证 storage 隔离；release smoke 用解包扩展验证 fresh profile。
- [x] 验收条件：`npm run check`、Edge isolated smoke、`release:local:smoke` 通过；artifact 证明 profile A/B cookie/storage 不互通且 owned process 清理完成。
- [x] 风险/回滚：最高风险项，不与 TODO 224 同批；回滚为禁用 `isolation.scope:"profile"`。

## 234. `browser_orchestrate` 术语与边界冻结

- [x] 优先级：P1；依赖：TODO 223-233。
- [x] 目标：已把对外口径从含糊的“目标状态收敛”收紧为“声明式浏览器会话状态协调/对账”，并锁定 `browser_orchestrate` 与其他工具的职责边界。
- [x] 范围：已同步 `README.md`、`docs/browser-orchestration-coordinator.md`、`docs/browser-orchestration-next-roadmap.md`、generated tool docs、skill 文案、tool 注册描述。
- [x] 决策：`browser_orchestrate` 只负责浏览器资源/会话状态对账（session/tab/window/group/profile/url/loadState/cookie/network recorder/hook/pre-navigation hook/persistence/adoption/watch/self-heal/logical target），不接收点击步骤、表单填写、站点专用脚本、流程 DSL。
- [x] 契约：已更新 `check-tools-contract.mjs` 与 `check-tool-doc-drift.mjs`，锁定 session reconciliation wording、workflow DSL 禁止边界，以及 README/skill 文案一致性；schema/description 继续禁止 `script/code/source`。
- [x] 验收条件：`npm run check` 与 skill quick validate 通过；README/generated docs/skill 与 runtime capability 口径一致。

## 235. `sessionAssertions/readinessChecks` 设计冻结

- [x] 优先级：P1；依赖：TODO 234。
- [x] 目标：已在不把 `browser_orchestrate` 变成流程 DSL 的前提下，冻结“声明式业务就绪断言”设计。
- [x] 范围：已新增 `docs/browser-orchestration-assertions.md` 与 desired schema 草案；覆盖 coordinator、summary、artifact、redaction、watch/self-heal 的断言参与边界。
- [x] 决策：断言层只接受可观测事实，不接受动作；允许 `url/origin/loadState`、cookie/storage 存在性或 hash、selector/text/attribute、hook/recorder/profile 状态；禁止脚本源码、点击序列、账号口令、站点特化执行步骤进入 desired/store/artifact。
- [x] 命名冻结：canonical desired field 为 `sessionAssertions`；`readinessChecks` 只保留为描述性术语，不引入第二个 schema alias。
- [x] 语义：断言用于 apply/status/watch 的验收、降级、诊断与 self-heal 判断；apply 仍只做浏览器资源协调，不因断言层膨胀成业务流程执行器；DOM/text/attribute/storage 断言默认只产生 diagnostics，不驱动业务动作。
- [x] 契约：已新增 `check:orchestration-assertions-design` 并纳入 `npm run check`，锁定断言字段、redaction、failure envelope、“无 silent fallback”以及 design-only capability 边界。
- [x] 验收条件：设计文档与静态契约已完成；README/roadmap/coordinator/TODO/CHANGELOG 已同步；TODO236 完成前不得把该能力写入当前 capability。

## 236. `sessionAssertions/readinessChecks` runtime 实现 Gate

- [x] 优先级：P2；依赖：TODO 235。
- [x] 目标：已实现断言层，并让 `browser_orchestrate` 对“已登录/已准备好/监控 hook 已生效”这类状态给出声明式验收结果。
- [x] 范围：已覆盖 `normalizeDesired`、types、collector、coordinator、tool summary/artifact、orchestration fixture；planner 继续保持资源协调职责，不引入 assertion action。
- [x] 实施边界：断言只参与 apply 后验收、status、watch 与 self-heal 判断；资源创建、导航、cookie/hook/profile 仍由现有 orchestration phase 执行；未新增任意脚本执行入口或站点流程动作入口。
- [x] 失败语义：断言不满足时返回结构化 diagnostics/failure codes，区分 `ORCHESTRATION_ASSERTION_FAILED` 与 `ORCHESTRATION_ASSERTION_PROBE_FAILED`，并继续区分“资源已协调但断言未满足”和“资源协调失败”。
- [x] 契约：已扩展 `check:orchestration`、`check:summaries`、`check:orchestration-assertions-design`；持久化/状态文件继续禁止保存 raw secret/script/body。当前未改 bridge runtime，`check:runtime-fixtures` 无新增 browser primitive 需求。
- [x] 验收条件：`npm run check` 通过；本地 fixture 已证明 apply/status/watch 能报告断言满足/不满足两类结果。

## 237. 断言层真实回归与证据面

- [x] 优先级：P2；依赖：TODO 236。
- [x] 目标：已用真实浏览器回归证明断言层没有把 `browser_orchestrate` 变成脆弱的黑盒流程器。
- [x] 范围：已覆盖 isolated smoke、release/local runtime regression artifact 诊断上浮，以及必要文档/契约同步。
- [x] 场景：已覆盖“登录态已存在/不存在”的可观测断言、“监控页 pre-navigation hook 与 hook dispatcher 已生效”的断言，以及 logical target 继续可用。
- [x] 证据：新增 `.pi/browser-artifacts/smoke-orchestration-assertions-result.json`，记录断言名、满足/不满足、对应 bindings、diagnostics 和 redaction 分类；isolated/release smoke 已上浮 `assertions` diagnostics。
- [x] 验收条件：`npm run smoke:browser:isolated`、`npm run release:local:smoke`、必要 callable-tool runtime 回归通过；最终响应汇总 artifact 路径。

## 238. `smoke:browser:isolated` 自举与 preflight 改进

- [x] 优先级：P3；依赖：无；本项不替代 TODO 234-237 的 orchestration/runtime 证据，只补强 isolated smoke 自举体验。
- [x] 目标：消除缺少 `bridge/pi_browser_bridge/dist/build-manifest.json` 时的脆弱前置条件，让 isolated smoke 更接近一键 gate。
- [x] 范围：`tests/smoke/isolatedSmokePreflight.mjs`、`tests/smoke/smoke-browser-isolated.mjs`、`tests/contracts/check-smoke-diagnostics.mjs`、release diagnostics 与维护文档。
- [x] 决策：启动前显式检查 `dist/build-manifest.json`、manifest 指向的 dist runtime 与 `dist/hook_dispatcher.js`；当前工作树 bridge 缺 dist 时默认自动执行 `node scripts/build-bridge.mjs --quiet`，`PI_BROWSER_SMOKE_AUTO_BUILD=0` 可关闭自动 build 并稳定返回 `preflight.reason:"autobuild_disabled"`、`missingPaths` 与 `npm run build:bridge` 修复提示；不得静默跳过 build/runtime 校验。
- [x] 契约：`check-smoke-diagnostics.mjs` 现在用临时 fixture 真实验证缺 dist + auto-build disabled / enabled 两条路径，并锁定 isolated/release artifact 的 `preflight` diagnostics。
- [x] 验收条件：缺少 dist 时 smoke 给出确定性可复现结果；`npm run check` 通过；针对缺少 `build-manifest.json` 的最小 isolated smoke 回归通过。

## 239. `browser_orchestrate` adoption-first 可用性修复

- [x] 性质判定：既有 callable tool 可用性/路由修复，不新增点击 DSL，不削弱底层 `browser_tabs` 诊断能力。
- [x] 问题：实战中 agent 仍默认维护物理 `tabId`，没有把 `browser_orchestrate` 当作逻辑会话入口，违背声明式会话编排目标。
- [x] 决策：取消“简单/复杂任务”分流，让浏览器任务默认先获得 logical session target；`browser_tabs list` 降为物理诊断、stale/ambiguous 修复和用户明确要求列 tab 时使用。
- [x] 实现边界：为 `browser_orchestrate` 增加轻量 `ensure` / shorthand `apply`，工具内部展开标准 Desired State；后续 tab-scoped 工具使用返回的 `target:{orchestrationId,sessionTag,tabRole}`。
- [x] 结果契约：`browser_orchestrate` summary/envelope 上浮 `target`、`nextTargets`、`suggestedNextCalls`，直接教 agent 下一步调用 `browser_scan/browser_execute/browser_wait/browser_network/browser_hook`。
- [x] 文档同步：README、skill、generated docs、CHANGELOG、契约同步 orchestrate-first 口径；保留 no workflow DSL、no script/code/source、readinessChecks 非 alias 边界。
- [x] 验证：`npm run check`、`npm run smoke:browser:isolated`、`npm run release:local:smoke`、skill quick validate 均已通过。关键 artifact：`.pi/browser-artifacts/smoke-browser-isolated-results.json`、`.pi/browser-artifacts/smoke-orchestration-ensure-result.json`、`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`.pi/browser-artifacts/release-acceptance/current-smoke-browser-isolated-results.json`。

## 240. 硬回退 `browser_orchestrate` 工具面

- [x] 性质判定：用户验证后的能力撤回；目标是恢复到 `0a7245d` 前的浏览器工具面，而不是继续修补 adoption-first 路由。
- [x] 范围：删除 callable `browser_orchestrate`、orchestration coordinator、target resolver、profile isolation、pre-navigation hook orchestration、sessionAssertions/readinessChecks、window/tabGroups orchestration 相关代码、文档、contract、smoke 断言和 generated docs 暴露。
- [x] 保留：TODO 拆分文档、bridge ESM/runtime、WebSecurity、artifact、wait/network/hook/frame/html/screenshot/download/upload 等非 orchestration 能力；不恢复历史 split action 工具。
- [x] 默认路由：README、generated tool docs、global skill、contracts 全部恢复 `browser_tabs list/switch/create` first，tab-scoped tools 使用显式 `tabId`；省略 `tabId` 仅作为 selected/latest fallback。
- [x] 验证：`npm run check`、`npm run smoke:browser:isolated`、`npm run release:local:smoke`、skill quick validate 均已通过；runtime artifacts：`.pi/browser-artifacts/smoke-browser-isolated-results.json`、`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`.pi/browser-artifacts/release-acceptance/current-smoke-browser-isolated-results.json`、`.pi/browser-artifacts/release-acceptance/rollback-smoke-browser-isolated-results.json`。
