# Browser Orchestration 后续增强路线

本文是 TODO 217-222 状态协调器首个生产闭环之后的独立技术路线。当前不会声明任何未实现能力为 callable capability；所有条目必须按 TODO 逐项完成设计、实现、契约与 smoke gate 后才能进入 README/skill 的当前能力描述。

## 1. 基线与边界

已完成基线：

- TODO 217：`cookies list|get|set|remove` native primitive 完成。
- TODO 218：Node driver `BrowserOrchestrationCoordinator`、Desired/Actual/Diff/Reconcile、owned cleanup、locks、redaction 完成。
- TODO 219：`browser_orchestrate` callable tool、summary、artifact、generated docs、README/skill/CHANGELOG 同步完成。
- TODO 220：explicit `watch` / self-heal、TTL、maxAttempts、pause diagnostics、Service Worker restart drift 恢复完成。
- TODO 221：runtime isolated smoke 与 release smoke 覆盖 orchestration happy path、自愈、cookie/network/hook/navigation 完成。
- TODO 222：首个生产闭环 gate 完成，`delete` 不关闭 non-owned tabs，敏感值不进入 summary/status/store/failure details。

固定边界：

- 高层协调继续只在 Node driver；Chrome extension 只提供底层 native primitives。
- `browser_orchestrate` 的定位是声明式浏览器会话状态协调/对账，不是通用站点工作流自动化 DSL。
- `browser_orchestrate` 是 Node 组合工具，不进入 `native_command_schema.json`。
- Existing `tabId` 参数和 omitted fallback 兼容保留；新增逻辑寻址不得 silently fallback 到默认 tab。
- Desired State 与 persistent state 禁止持久化 cookie raw value、authorization/body/postData/websocket payload、任意可执行脚本文本。
- 跨 Pi session / driverRunId 自动 cleanup 默认禁止；adoption 必须显式声明并重新 observe 验证。
- `tabGroups` 是视觉/诊断增强，不作为核心 reconcile 的 hard fail 条件。
- Incognito 仅作为 opt-in 能力，不阻塞 profile-first 主干和 release gate。
- 点击步骤、表单填写、账号口令、站点专用脚本与业务流程执行继续留在 `browser_execute` / `browser_scan` / `browser_wait` 等命令式工具层。

## 2. 架构决策

### 2.1 Target Resolver 参数形态

TODO 223 已将细化设计落档到 `docs/browser-target-resolver.md`。采用结构化 `target:{...}` 对象，作为 tab-scoped tools 的统一逻辑寻址命名空间。

示例：

```json
{
  "script": "return window.location.href",
  "target": {
    "orchestrationId": "case-1",
    "sessionTag": "vulnerable-app",
    "tabRole": "main"
  }
}
```

关键规则：

- `target` 是 tool schema，不是 native command schema。
- Node driver 解析 `target` 后向 native command 传入最终 `tabId`。
- `tabId`、`target.tabId`、command body 内 `tabId` 若冲突必须返回结构化错误。
- `sessionTag/tabRole` 推荐与 `orchestrationId` 一起使用；无 `orchestrationId` 时只能唯一匹配，否则 `TARGET_AMBIGUOUS`。
- 未来 `windowId/groupId/profileId/requireOwned` 继续放入 `target`，避免多个顶层参数漂移。

### 2.2 Window 与 tabGroups primitive

采用独立 `windows` 与 `tabGroups` native commands，使协议域与 Chrome Extension API 域保持同构。

关键规则：

- `windows` 用于 owned window lifecycle 与 window-level isolation。
- `tabGroups` 用于视觉分组和诊断，不作为导航、cookie、network、hook 的 hard dependency。
- 若 `chrome.tabGroups` 不可用，返回 `tabGroups:"degraded_not_supported"`，继续执行核心 reconcile。
- 权限变更必须通过 manifest、schema、generated docs、package、runtime smoke 同步验证。

### 2.3 Pre-navigation Hook Policy

基于 `frame.addNewDocumentScript` / document-start 注入策略，但 Desired 和 persisted state 只保存声明式 hook metadata。

允许持久化：

- `hookId`
- `enabled`
- `params`
- `scope`
- `version/hash`

禁止持久化：

- `script`
- `code`
- `source`
- 任意可执行脚本文本

真实脚本文本只能来自 driver 内置 registry，或仓库内只读安全目录并带 hash 校验；不得从外部 Desired JSON 反序列化后执行。

### 2.4 Persistent State 与 Adoption

持久化只提供诊断与显式接管线索，不赋予跨 session 自动 cleanup 权限。

关键规则：

- state 文件包含 `driverRunId`、`piSessionId`、`schemaVersion`、redacted desired、bindings metadata、resource fingerprints。
- 同 driverRunId / 同 Pi session 内可按现有 cleanup policy 清理 owned resources。
- 跨 session state 默认 `stale/readOnly/adoptionRequired`。
- adoption 必须在 Desired 中显式声明，并重新 observe URL/origin/browserId/windowId/profileId 等指纹后才可托管。
- 未 adoption 的 stale resources 只能在 status 中展示，不能 watch、cleanup 或 close。

### 2.5 Profile-first 与 Incognito Opt-in

隔离推进采用 profile-first：Node driver 管理独立 Chrome profile / `--user-data-dir` / extension copy / bridge port。

关键规则：

- Profile scope 才是主干隔离能力，cookie/storage 隔离由文件系统 profile 边界保证。
- Incognito 依赖用户授权扩展无痕运行，只做 opt-in probe 与 diagnostic；未授权不得让主干 smoke 失败。
- Managed profile cleanup 只停止 driver 创建的 owned browser process，不关闭用户已有 Chrome。

## 3. 阶段与依赖

| 阶段 | TODO | 优先级 | 依赖 | 输出 |
|---|---:|---|---|---|
| Target Resolver | 223-224 | P0 | 217-222 | 逻辑 target 设计与所有 tab-scoped tools runtime 支持 |
| Window/tabGroups | 225-227 | P1 | 224 | owned window lifecycle、tabGroups degraded visual grouping、runtime smoke |
| Pre-navigation Hook | 228-229 | P1 | 224 | 安全 hook registry、document-start 编排、runtime smoke |
| Persistent State | 230-231 | P2 | 224；建议 226 后 | redacted persistence、stale/adoption gate、restart fixture |
| Physical Isolation | 232-233 | P2/P3 | 224；建议 231 后 | profile-first 设计与 managed profile smoke 已完成；incognito opt-in diagnostic |

## 4. TODO 执行方案

### TODO223. Target Resolver 设计与 Tool Schema 审计

状态：已完成设计落档与 native schema 防泄漏 contract；runtime 实现已由 TODO224 完成。

目标：定义结构化 `target:{...}`，完成所有 tab-scoped tools 的 schema 与兼容边界审计。

范围：`src/tools/toolShared.ts`、`src/tools/toolAdapter.ts`、`src/driver/types.ts`、`BrowserBridgeServer.ts`、`BrowserTabSessionRouter.ts`、`src/driver/orchestration/*`、tool contracts、generated docs、README/skill 文案。

关键设计点：

- `target` 是 tool-level 参数，不进入 `native_command_schema.json`。
- 保留现有 `tabId`；新增冲突、ambiguous、stale target 错误语义。
- 列出覆盖工具清单：scan/content/html/execute/wait/network/hook/evidence/frame/screenshot/download/upload 及未来 tab-scoped tools。

实施步骤：

1. 落档 target resolver 细化设计到 `docs/browser-target-resolver.md`。
2. 定义 TypeBox schema 草案与冲突规则。
3. 定义 driver resolver API 与错误码。
4. 增加静态 contract，禁止 native schema 泄漏逻辑 target。

验收 Gate：`npm run check:tools`、`npm run check:tool-docs`、`npm run check:protocol`。

风险与回滚：风险是把逻辑寻址错误下沉到 MV3 native schema；回滚为保留现有 `tabId` 唯一路径。

### TODO224. Target Resolver 实现与 Runtime 验证

状态：已完成。所有 tab-scoped tools 可用 `target:{orchestrationId,sessionTag,tabRole}` 定位 orchestration tab。

范围：`toolAdapter.ts`、各 `register*.ts`、`BrowserBridgeServer.ts`、`BrowserTabSessionRouter.ts`、`OrchestrationStore.ts`、orchestration types、contracts、isolated smoke。

关键设计点：

- `toolAdapter` 统一暴露 `target` 参数。
- `BrowserBridgeServer.resolveToolTarget()` 委派 `BrowserTargetResolver`，最终生成 `BrowserBridgeTargetInfo` 与 `tabId`。
- command body 内 `tabId` 与外层 target 冲突必须 fail。
- 不允许 ambiguous/stale/conflict target 降级到 default/latest tab。

实施步骤：

1. 增加 shared target params。
2. 迁移所有 tab-scoped tool 注册层。
3. 接入 orchestration binding 查询。
4. 更新 generated docs 与 skill guideline。
5. smoke 中用逻辑 target 执行 execute/wait/network/hook。

验收 Gate：`npm run check`、`npm run check:orchestration`、`npm run check:lifecycle`、Edge isolated smoke；`check:lifecycle` 覆盖 browser-scoped duplicate switch 与 target conflict/browser conflict/stale/ambiguous。

风险与回滚：风险是破坏 legacy `tabId`；回滚为禁用 `target` 解析，保留原参数。

### TODO225. Window/tabGroups Native Primitive 设计

状态：已完成设计落档。详见 `docs/window-isolation-tabgroups.md`。本项冻结 `windows` / `tabGroups` primitive 草案、权限计划、错误 taxonomy 与 no-hard-fail 语义；runtime 接入由 TODO226 完成。

目标：为 owned window lifecycle 与 visual grouping 定义 native primitives、权限和降级语义。

范围：设计文档、protocol/schema 草案、manifest/package/smoke 同步计划、contracts。

关键设计点：

- 后续 TODO226 新增独立 `windows` / `tabGroups` command。
- `tabGroups` permission 变更需记录；unsupported 返回 `tabGroupsStatus:"degraded_not_supported"`，不 hard fail。
- 最小方法冻结：`windows list|get|create|update|focus|close`；`tabGroups status|query|group|update|ungroup`。
- 设计期不声明未实现 runtime capability。

验收 Gate：`npm run check:protocol`、`npm run check:bridge:files`、tool/native generated docs 无 drift。

风险与回滚：权限提示变化和 Chromium 兼容性；回滚为移除 `tabGroups` 权限/schema，保留 tabs 核心能力。

### TODO226. Window Isolation 与 tabGroups 实现

状态：已完成。Coordinator 已支持 owned window 创建/绑定/cleanup，并在可用时分组 owned tabs；真实浏览器 smoke gate 已由 TODO227 完成。

范围：bridge core commands、orchestration types/normalize/actual/diff/executor/store/locks/redaction、contracts。

关键设计点：

- Desired 增 `windowIsolation` / `ownedWindow` / `visualGrouping`。
- Binding 增 `windowId`、`windowOwned`、`windowCloseOnDelete`、`groupId`、`tabGroupsStatus`。
- Cleanup 只关闭 `windowOwned:true` 且 `windowCloseOnDelete!==false` 的 owned window；非 owned window 只可 reuse。
- `tabGroups` degraded 后继续核心 reconcile。

实施结果：

1. 实现 `windows` native command。
2. 实现 `tabGroups` feature probe 与 command，manifest 加入 `tabGroups` permission。
3. 扩展 Desired/Actual/Diff/Reconcile，新增 `window` / `visual-grouping` phase 与 `createWindow/groupTabs/closeWindow` operations。
4. 扩展 summary/status/store/artifact，上浮 `windowId/groupId/tabGroupsStatus`。
5. 增加 owned/non-owned cleanup、visual grouping success 与 degraded fixtures。

验收 Gate：`npm run check:protocol`、`npm run check:bridge:files`、`npm run check:pi-browser-bridge`、`npm run check:orchestration` 已通过；`npm run check` 为最终合并门禁。

风险与回滚：windowId 复用和误关窗口；回滚为禁用 `ownedWindow` operations。

### TODO227. Window/tabGroups Runtime Smoke Gate

状态：已完成。真实 Edge isolated smoke 与 `release:local:smoke` 已验证 owned window、owned tabs、tabGroups success diagnostics 与 cleanup。

范围：browser smoke、isolated smoke、release smoke、smoke diagnostics、README/CHANGELOG/TODO。

关键设计点：

- isolated smoke 创建 owned window 与两个 owned tabs。
- 支持 tabGroups 时验证 groupId；不支持时验证 degraded diagnostic。
- delete 后 owned resources 清理，非 owned resources 保留。

实施结果：

1. 增加 `browser_orchestrate.windowPlan/windowApply/windowStatus/windowDelete/windowArtifact` smoke case。
2. 上浮 `windowId/groupId/tabGroupsStatus` 与 `windowTabGroups` 到 artifact。
3. release smoke 成功/失败 diagnostics 记录 current smoke window/tabGroups 证据；rollback smoke 保持最小 tabs/wait/execute。
4. 文档记录 no-hard-fail 与 artifact 路径。

验收 Gate：`npm run check`、Edge isolated smoke、`release:local:smoke` 已通过。

风险与回滚：浏览器差异导致 flake；回滚为保留 window smoke、禁用 visual grouping smoke hard assertion。

### TODO228. Pre-navigation Hook Policy 设计

状态：已完成设计落档与静态契约；TODO229 已基于该 policy 完成 runtime 实现与 smoke gate。

目标：定义 document-start 级 hook policy，禁止持久化任意可执行脚本文本。

范围：orchestration docs、new hook policy doc、orchestration types、frame primitive docs、page script contracts。

关键设计点：

- Desired 只保存 `hookId/enabled/params/scope/version/hash`。
- 脚本文本来自 driver 内置 registry 或仓库只读安全目录 + hash。
- contract 禁止 `script/code/source` 进入 persisted Desired。
- TODO228 阶段 runtime 对 enabled `preNavigationHooks` 返回 `ORCHESTRATION_INVALID_DESIRED`，避免静默忽略；TODO229 已替换为 registry-backed runtime validation。

实施结果：

1. 新增 `docs/pre-navigation-hook-policy.md`，定义 hook registry、metadata schema、install-before-navigate lifecycle、MV3 restart/watch 恢复、cleanup/verification、错误与回滚边界。
2. `docs/browser-orchestration-coordinator.md` 增加 Pre-navigation Hook metadata 小节，明确 raw `frame.addNewDocumentScript source` 与 orchestration policy 的边界。
3. `src/driver/orchestration/types.ts` 增加 metadata/registry/registration 类型。
4. `normalizeDesired` 递归拒绝 `script/code/source`，TODO229 后接受 registry-backed `preNavigationHooks`。
5. 新增 `check:pre-nav-hook-policy` 契约并纳入 `npm run check`。

验收 Gate：`npm run check:tools`、`npm run check:token`、`npm run check:pre-nav-hook-policy`、`npm run check`。

风险与回滚：外部 JSON 注入可执行脚本文本；回滚为禁用 orchestration Desired `preNavigationHooks`，保留 `browser_frame.addNewDocumentScript` primitive。

### TODO229. Pre-navigation Hook 实现与 Smoke

状态：已完成 runtime 实现与 smoke gate。

目标：coordinator 支持 pre-navigation hook 安装、验证、清理与 watch 恢复。

范围：orchestration modules、frame command path、orchestrate tool schema/summary、contracts、runtime smoke。

关键设计点：

- hook phase 固定在 navigation 前。
- 有 pre-navigation hook 的新 tab/window 先创建 `about:blank`，完成 `frame.addNewDocumentScript` 后再导航。
- Binding 保存 hook id、version、hash、registration id、CDP session metadata、workerBootId，不保存脚本文本。
- delete/stop/失败补偿清理 registration；watch/status 检测丢失或 workerBoot 变化并重装。
- 已加载页面不承诺 retroactive 生效；必要时重新导航生成新 document。

实施结果：

1. 新增安全 hook registry 与内置 `pi.preNavigationMarker@1`，脚本 bytes 固定并以 sha256 校验。
2. 扩展 Desired normalization，接受 registry-backed `preNavigationHooks`，继续递归拒绝 `script/code/source`。
3. 扩展 DiffPlanner/ReconcileExecutor/ActualStateCollector/Store：新增 `hook-pre-nav` phase、`installPreNavigationHook` / `uninstallPreNavigationHook` operation、`persistent_cdp.listNewDocumentScripts` registration 观测与 marker effect 验证。
4. 增加 restart/lost registration fixtures，验证 workerBoot/registration drift 可恢复，delete/stop 可清理。
5. smoke 验证 document-start marker 早于页面 head script 生效，artifact 写入 `.pi/browser-artifacts/smoke-pre-navigation-hook-result.json`。

验收 Gate：`npm run check`、`npm run check:orchestration`、`npm run check:runtime-fixtures`、Edge isolated smoke。

风险与回滚：CDP/session 与 frame 生命周期复杂；回滚为禁用 Desired `preNavigationHooks`，保留 raw `browser_frame.addNewDocumentScript` primitive。

### TODO230. Persistent State 安全设计

状态：已完成设计落档与静态契约；runtime save/load 与 adoption gate 已由 TODO231 完成。

目标：设计 redacted orchestration state 持久化，提供重启诊断与显式 adoption 基础。

范围：`OrchestrationStore.ts`、`PersistentOrchestrationStore.ts`、`BrowserBridgeServer.ts`、driver types、orchestration docs、artifact privacy docs。

关键设计点：

- state schema 为 `pi.browser.orchestration.state/v1`，默认路径 `.pi/browser-artifacts/orchestration-state/state.v1.json`。
- state 包含 `schemaVersion/driverRunId/piSessionId/orchestrationId/redactedDesired/bindings/fingerprints`。
- 禁止 raw cookie、body/postData/payload、任意脚本文本落盘。
- startup load 默认 `stale/readOnly/adoptionRequired`，不启动 watch，不 cleanup，不 close。

实施结果：

1. 新增 `docs/orchestration-persistence.md`，定义 state path、schema、driverRunId/Pi session 边界、stale/adoption 状态机、redaction 与手动清理策略。
2. `types.ts` 增加 `OrchestrationPersistedStateFile`、persisted record/binding/fingerprint/cookie fingerprint 与 `OrchestrationAdoptionPolicy` 草案。
3. 新增 `check:orchestration-persistence` 契约，锁定 no raw cookie/body/postData/payload/script/code/source、`OrchestrationStore` 继续纯内存，runtime 文件 I/O 仅在 `PersistentOrchestrationStore.ts`。
4. README、AI_INSTALL、coordinator doc、TODO、CHANGELOG 已同步 persistence policy 与隐私分类 `local_redacted_orchestration_state`。

验收 Gate：`npm run check:orchestration-persistence`、`npm run check:token`、`npm run check:artifact`。

风险与回滚：tabId/windowId 复用导致误托管；回滚为忽略 state 文件，恢复内存 store。

### TODO231. Persistent State 实现与 Adoption Gate

状态：已完成 runtime 实现、contracts 与 restart/adoption smoke gate。

目标：实现持久化、重启后 read-only status、显式 adoption；禁止跨 session 自动误关。

范围：orchestration store/coordinator/server lifecycle、contracts、lifecycle fixture、isolated smoke。

关键设计点：

- Adoption 必须显式声明 `enabled:true`、`orchestrationId`、resource types、verify origins/URLs。
- Adoption 前重新 observe live resources。
- 未 adoption 的 stale resources：status visible，no watch，no cleanup，no close。

实施结果：

1. `PersistentOrchestrationStore.ts` 实现 redacted save/load 与 atomic write。
2. `BrowserBridgeServer.start()` 加载 stale/read-only state。
3. `status` 显示 `adoptionRequired`，不 collect、不 cleanup。
4. `apply/watch/stop/delete` 对未 adoption state 拒绝副作用；explicit adoption 重新 observe 并校验 live resources。
5. lifecycle fixture 验证 restart read-only state 不误关旧 tab。
6. smoke 验证 adoption 后才可 cleanup。

验收 Gate：`npm run check`、`npm run check:lifecycle`、`npm run check:orchestration`、Edge isolated smoke restart/adoption artifact `.pi/browser-artifacts/smoke-orchestration-persistence-result.json`。

风险与回滚：错误 adoption 误关用户资源；回滚为启动时不加载 persistent state。

### TODO232. Profile/Incognito 隔离设计

状态：已完成设计落档与静态契约。详见 `docs/browser-profile-isolation.md`。本项冻结 profile-first 物理隔离方案、Desired schema 草案、profile lifecycle、cookie/storage 验证、incognito opt-in diagnostic 与默认 gate 边界；runtime managed profile 已由 TODO233 实现。

目标：冻结 profile-first 物理隔离方案；Incognito 仅作为 opt-in diagnostic。

范围：isolated smoke、release smoke、new profile isolation doc、driver/profile manager design、orchestration Desired schema。

关键设计点：

- Profile-first：独立 `--user-data-dir`、extension copy、bridge port、owned process。
- Incognito：需要用户授权扩展无痕运行；未授权只返回 diagnostic。
- 默认 isolation 仍是 logical；profile scope 需显式声明。

实施结果：

1. `docs/browser-profile-isolation.md` 提炼 isolated smoke profile 启动经验。
2. 定义 managed profile lifecycle：create/start/connect/observe/stop/delete。
3. 定义 cookie/localStorage/sessionStorage 隔离验证与 artifact 边界。
4. 定义 incognito opt-in probe 与 `INCOGNITO_NOT_ALLOWED` diagnostic。
5. 定义 release smoke 条件，并锁定 incognito 不进入默认 gate。

验收 Gate：设计文档、`npm run check:profile-isolation`，contract 确认 incognito 不进入默认 gate。

风险与回滚：Chrome path、端口、子进程清理跨平台复杂；TODO233 runtime 回滚方式为禁用 profile scope。

### TODO233. Managed Profile-first 实现 Gate

状态：已完成 runtime 实现与 smoke gate。

目标：实现 owned browser profile lifecycle 与隔离 smoke；Incognito 保持 opt-in probe，不阻塞主干。

范围：`BrowserProfileManager.ts`、`BrowserBridgeServer.ts`、driver/orchestration modules、isolated smoke、release smoke、docs/skill/CHANGELOG。

关键设计点：

- profile 由 driver 创建并 owned。
- delete 只停止 owned profile process，不关闭用户 Chrome。
- 每个 profile 有 profileId/profileDir/bridgePort/extensionDir。
- cookie/localStorage 隔离是必测。
- Incognito 未授权返回 `INCOGNITO_NOT_ALLOWED` diagnostic。

实施结果：

1. 抽出 `BrowserProfileManager.ts` managed profile lifecycle。
2. 支持 Desired `isolation.scope:"profile"` 与 `ensureProfile/stopProfile` reconcile operations。
3. target resolver 支持 profile-bound browserId/profileId。
4. smoke 启动两个 profiles 并验证 cookie/localStorage/sessionStorage 隔离。
5. release smoke 用解包扩展验证 fresh profile 并上浮 `profileIsolation` diagnostics。

验收 Gate：`npm run check`、Edge isolated smoke、`release:local:smoke`，artifact 证明 profile A/B cookie/storage 不互通且 owned process 清理完成。

风险与回滚：最高风险项，不与 TODO224 同批；回滚为禁用 `isolation.scope:"profile"`。

### TODO234. `browser_orchestrate` 术语与边界冻结

状态：已完成。

目标：把对外口径统一到“声明式浏览器会话状态协调/对账”，并明确 `browser_orchestrate` 不承接 workflow DSL。

实施结果：

1. tool/README/skill/coordinator 文案统一收紧为 browser session reconciliation。
2. 明确点击步骤、表单填写、站点专用脚本与业务流程执行继续留在 `browser_execute` / `browser_scan` / `browser_wait`。
3. 契约锁定不回落到含糊的“state convergence”外部口径。

### TODO235. `sessionAssertions/readinessChecks` 设计冻结

状态：已完成。

目标：在不把 orchestration 变成流程 DSL 的前提下，引入只读、声明式的业务就绪断言层。

实施结果：

1. 新增 `docs/browser-orchestration-assertions.md`，冻结 canonical desired field `sessionAssertions`，`readinessChecks` 仅保留为描述性术语。
2. 锁定允许的可观测断言类型：`url/origin/loadState/cookie/storage/selector/text/attribute/hook/networkRecorder/profile`。
3. 锁定断言层只参与 `apply/status/watch/self-heal` 验收与 diagnostics，不引入点击、表单填写、账号口令、脚本源码或 workflow DSL。
4. 新增 `check:orchestration-assertions-design` 并纳入 `npm run check`。

### TODO236. `sessionAssertions/readinessChecks` runtime 实现 Gate

状态：已完成。

目标：让 `browser_orchestrate` 对“已登录/已准备好/监控 hook 已生效”这类状态给出声明式验收结果，同时保持 workflow DSL 边界不变。

实施结果：

1. `normalizeDesired.ts` 接入 `sessionAssertions`，拒绝 `readinessChecks` alias，并校验 assertion kinds/hash/selector/storage/loadState/profile 等输入。
2. `ActualStateCollector.ts` 新增只读 readiness probes：`url/origin/loadState/cookie/storage/selector/text/attribute/hook/networkRecorder/profile`。
3. `BrowserOrchestrationCoordinator.ts` 在 post-apply/status 路径上把 assertion failures 合并进 `ok/converged/failures`，区分 `ORCHESTRATION_ASSERTION_FAILED` 与 `ORCHESTRATION_ASSERTION_PROBE_FAILED`。
4. `summaries/orchestration.ts` 与 `OrchestrationStore.ts` 上浮 assertion count / passed / failed / probeFailed 摘要。
5. `check-orchestration-coordinator.mjs` 覆盖 satisfied/unsatisfied assertions 与 watch pause；`check-summaries.mjs` 锁定 orchestration assertion counters。

### TODO237. 断言层真实回归与证据面

状态：已完成。

目标：用真实浏览器回归证明断言层没有把 `browser_orchestrate` 变成脆弱的黑盒流程器。

实施结果：

1. `tests/smoke/smoke-browser.mjs` 新增真实浏览器 assertion smoke，覆盖登录态存在/不存在、pre-navigation effect、hook dispatcher 已安装，以及 logical target 继续可用。
2. 新增 artifact `.pi/browser-artifacts/smoke-orchestration-assertions-result.json`，记录断言 id、pass/fail、bindings、failure diagnostics、artifact privacy 与 redaction 分类，并验证不泄漏 raw cookie value。
3. `tests/smoke/smoke-browser-isolated.mjs` 与 `tests/release/release-local-acceptance.mjs` 上浮 `assertions` diagnostics，包含 satisfied/unsatisfied orchestrationId、logicalTargetSource 与 artifact path。
4. `check-smoke-diagnostics.mjs` 锁定 assertions smoke steps、isolated diagnostics 与 release diagnostics，确保 sessionAssertions 证据面进入 runtime gate。

### TODO238. `smoke:browser:isolated` 自举与 preflight 改进

状态：已完成。

实施结果：

1. 新增 `tests/smoke/isolatedSmokePreflight.mjs`，在 isolated smoke 启动前显式检查 `dist/build-manifest.json`、manifest 指向的 dist runtime 与 `dist/hook_dispatcher.js`。
2. 当前工作树 bridge 缺 dist 时，默认自动执行 `node scripts/build-bridge.mjs --quiet`；结果写入 `.pi/browser-artifacts/smoke-browser-isolated-results.json` 的 `preflight.reason`、`missingPaths` 与 `autoBuild`。
3. `PI_BROWSER_SMOKE_AUTO_BUILD=0` 可关闭自动 build，并稳定返回 `preflight.reason:"autobuild_disabled"` 与 `npm run build:bridge` 修复提示。
4. `tests/release/release-local-acceptance.mjs` 失败摘要同步上浮 `preflight` diagnostics，`check-smoke-diagnostics.mjs` 用临时 fixture 锁定 disabled/enabled 两条路径。

## 5. 推荐执行顺序

1. TODO223 → TODO238 已完成。
2. 完整 Incognito 实现继续后移，另开号段，不纳入当前主干 gate。
3. 发布/合并前继续复跑 `npm run quality:local`；需要 runtime 证据时复跑 `npm run release:local:smoke` 或 `npm run smoke:browser:isolated`。
