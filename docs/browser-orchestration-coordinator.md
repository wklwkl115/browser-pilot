# Browser Orchestration Coordinator 生产级设计

本文冻结 `browser_orchestrate` / 浏览器状态协调器的工程设计与落地边界。当前实现状态：TODO 216-222 首个生产闭环、TODO 223 Target Resolver 设计、TODO 224 Target Resolver runtime、TODO 225 Window/tabGroups primitive 设计、TODO 226 Window Isolation 与 tabGroups runtime、TODO 227 Window/tabGroups Runtime Smoke Gate、TODO 228 Pre-navigation Hook Policy 设计、TODO 229 Pre-navigation Hook runtime 与 smoke gate、TODO 230 Persistent State 安全设计、TODO 231 Persistent State 实现与 Adoption Gate、TODO 232 Profile/Incognito 隔离设计、TODO 233 Managed Profile-first 实现 Gate 均已完成。

## 1. 目标与适用范围

### 1.1 目标

- 引入 Node driver 层的声明式状态协调器：智能体提交 Desired State，驱动层采集 Actual State，计算 Diff，并执行 bounded reconcile，使真实浏览器资源收敛到目标状态。
- 降低多 tab、多 window、多 recorder、多 hook、多 cookie 场景中手动 `browser_tabs list/create/switch` 与显式 `tabId/windowId` 维护成本。
- 保持现有工具链的观察、执行、等待、证据、artifact 能力，不把高层决策下沉到 Chrome extension 或页面脚本。
- 为长期并发任务、自愈、状态诊断、资源清理和后续 `sessionId/tabRole` 目标解析提供稳定基础。

### 1.2 适用范围

当前生产版本覆盖：

- 逻辑 orchestration session 与 tab role 绑定。
- tabs create/reuse/close ownership 管理。
- owned window 创建/绑定/cleanup 与保守 ownership 校验。
- 可降级 Chrome `tabGroups` 视觉分组 diagnostics。
- pre-navigation document-start hook 安装、验证、清理与 watch 恢复；新 tab/window 先 `about:blank` 绑定，再安装 `frame.addNewDocumentScript` 后导航。
- managed profile-first 物理隔离：显式 `isolation.scope:"profile"` 创建独立 `--user-data-dir`、extension copy、bridge port 与 driver-owned browser process。
- navigation/load state 收敛。
- browser cookie set/remove/list 作为底层原语。
- network recorder start/status/stop/reconfigure。
- hook dispatcher install/status/uninstall/reinstall。
- one-shot `plan/apply/status/delete` 与显式 bounded `watch/stop`。
- fake WebSocket、runtime fixture、orchestration fixture、isolated smoke 下的故障注入验证。

当前版本仍不承诺：

- Incognito、用户个人 Chrome profile 或任意外部 cookie jar 接管。
- 自动漏洞判断、扫描决策、目标选择或策略推理。
- 在 MV3 service worker 中保存高层 Desired State。
- 任意外部脚本文本作为 Desired State；pre-navigation hook 只接受 registry-backed `hookId/version/hash` metadata。

## 2. 架构原则

- 高层协调只在 Node driver：Desired/Actual/Diff/Reconcile、并发锁、watch loop、artifact、summary、错误 taxonomy 全部在 Node 侧实现。
- Chrome extension 只提供明确底层原语：tabs、windows、tabGroups、cookies、wait、network、hook、frame、html、screenshot、transfer 等 native command。
- 不新增静默 fallback：`tabId`、`orchestrationId/sessionTag/tabRole` 冲突必须返回结构化错误。
- 不跨 browser 自动回退：除非 Desired State 显式允许，orchestration 绑定的 `browserId` 是硬边界。
- 不关闭非 owned tabs/windows：cleanup 只处理 coordinator 创建或明确绑定为 owned 的资源；owned window cleanup 只允许 `windowOwned:true`。
- 所有敏感输出默认脱敏：cookie value、authorization、postData、body、websocket payload 不进入 summary/details。
- 所有副作用可审计：每个 reconcile operation 有 id、phase、resourceRef、reason、status、error 与 redacted params。

## 3. 与现有项目结构的集成

### 3.1 Node driver 层

新增目录：

```text
src/driver/orchestration/
  types.ts
  normalizeDesired.ts
  OrchestrationStore.ts
  PersistentOrchestrationStore.ts
  ActualStateCollector.ts
  DiffPlanner.ts
  ReconcileExecutor.ts
  preNavigationHooks.ts
  BrowserOrchestrationCoordinator.ts
  ResourceLocks.ts
  orchestrationErrors.ts
  orchestrationRedaction.ts
```

职责：

- `normalizeDesired.ts`：归一化 loose tool input，校验 URL、tag、role、cookie、recorder、hook dispatcher 与 pre-navigation hook metadata。
- `OrchestrationStore.ts`：维护内存态 desired hash、generation、bindings、owned resources、pre-navigation hook registrations、watch metadata；仍不直接做文件 I/O。
- `PersistentOrchestrationStore.ts`：负责 redacted state schema validate、atomic write、startup stale/read-only load 与 redaction enforcement。
- `ActualStateCollector.ts`：从 `BrowserBridgeServer.snapshot()`、`refreshTabs()`、`windows.list`、`tabGroups.status`、`persistent_cdp.listNewDocumentScripts`、`network.status`、`hook.status`、`cookies`、`wait.navigation/loadState` 聚合 Actual State。
- `DiffPlanner.ts`：计算 Desired 与 Actual 的差异，生成有依赖顺序的 operation plan；pre-navigation hook operation 固定排在 navigation 前。
- `ReconcileExecutor.ts`：按 phase、依赖和 deadline 执行 windows/tabs/tabGroups/pre-navigation hooks/cookies/navigation/network/hook/verify/cleanup 操作。
- `BrowserOrchestrationCoordinator.ts`：对外提供 `plan/apply/status/watch/stop/delete`，管理 watch loop 与 lifecycle。
- `ResourceLocks.ts`：按 `orchestrationId`、`browserId:tabId`、`networkSessionId`、`hookSessionId` 加锁。
- `orchestrationErrors.ts`：定义 `ORCHESTRATION_*` 错误与 retryable 分类。
- `orchestrationRedaction.ts`：对 desired、actual、operation params、failures 做敏感字段脱敏。

修改：

- `src/driver/BrowserBridgeServer.ts`
  - 持有 coordinator 实例。
  - 暴露 `orchestrator()` 或 thin facade 方法。
  - `start()` 时加载 persistent state 为 read-only/adoptionRequired status；`stop()` 时停止 watch loops，跳过未 adoption stale state，并保存 redacted state。
- `src/driver/types.ts`
  - 扩展 target metadata：`source:"orchestration"`、`orchestrationId`、`sessionTag`、`tabRole`。
  - 增加 orchestration 内部类型 re-export，仅限 driver/tool 共享必要部分。

### 3.2 Tool 注册层

新增：

```text
src/tools/registerOrchestrateTool.ts
src/tools/summaries/orchestration.ts
```

修改：

- `src/tools/registerTools.ts` 注册 `browser_orchestrate`。
- `src/tools/budgets.ts` 增加 `browser_orchestrate` 预算。
- `src/tools/resultMiddleware.ts` 接入 orchestration summary。
- `scripts/generate-tool-docs.mjs` 若无法自动识别新增 helper，补生成器支持。

`browser_orchestrate` 是组合工具，不替代现有工具：

- `browser_tabs` 保持底层 tab 控制。
- `browser_wait` 保持等待/导航原语。
- `browser_network` 保持 recorder 原语。
- `browser_hook` 保持 hook 原语。
- `browser_execute` 仍是页面动作主工具。

### 3.3 Native command schema 与 Chrome extension

`browser_orchestrate` 不进入 `native_command_schema.json`；它是 Node tool。

已扩展底层 `cookies` command：

```json
{
  "cookies": {
    "domain": "core",
    "tabScoped": false,
    "methods": ["list", "get", "set", "remove"],
    "defaultMethod": "list",
    "methodSpecs": {
      "set": { "required": ["url", "name", "value"] },
      "remove": { "required": ["url", "name"] }
    }
  }
}
```

受影响文件由 `npm run sync:protocol` 生成或校验：

```text
bridge/native_command_schema.json
bridge/pi_browser_bridge/native_command_schema.json
bridge_src/service_worker/protocol.ts
src/protocol/nativeProtocol.ts
src/protocol/nativeActionMetadata.ts
src/protocol/nativeErrorCodes.ts
docs/generated/native-protocol.generated.md
```

扩展实现只改底层原语：

- `bridge_src/service_worker/core_commands.ts`：`handleCookies()` 支持 `list/get/set/remove`；`handleWindowsCommand()` 支持 `list/get/create/update/focus/close`；`handleTabGroupsCommand()` 支持 `status/query/group/update/ungroup`。
- `bridge_src/service_worker/types.ts`：`PiChromeApi.cookies` 增加 `set/remove` 类型，`PiChromeApi.windows` 与 optional `PiChromeApi.tabGroups` 建模 Chrome runtime API。
- `bridge/pi_browser_bridge/manifest.json`：TODO226 已加入 `tabGroups` permission。
- 不在 `transport.ts`、`router.ts`、`tab_sync.ts` 中放 cookie/window/group ownership 业务逻辑。

## 4. 数据模型

### 4.1 Desired State

Tool 参数使用 JSON object；YAML 只作为文档展示，不作为首版解析入口。

```ts
type BrowserOrchestrationDesired = {
  apiVersion: "pi.browser/v1";
  orchestrationId?: string;
  generation?: string;
  browser?: {
    browserId?: string | "selected" | "auto";
    requireSelected?: boolean;
    crossBrowserFallback?: false;
  };
  defaults?: {
    timeoutMs?: number;
    navigationTimeoutMs?: number;
    tabRole?: string;
    cleanupOnFailure?: boolean;
  };
  isolation?: {
    scope: "logical" | "browser";
    ownedTabsOnly: boolean;
    closeOwnedTabsOnDelete: boolean;
  };
  windowIsolation?: boolean | BrowserDesiredOwnedWindow;
  visualGrouping?: boolean | BrowserDesiredVisualGrouping;
  allowedOrigins?: string[];
  ttlMs?: number;
  sessions: BrowserDesiredSession[];
};

type BrowserDesiredSession = {
  tag: string;
  required?: boolean;
  url?: string; // shorthand for tabs:[{role:"main", url}]
  tabs?: BrowserDesiredTab[];
  ownedWindow?: boolean | BrowserDesiredOwnedWindow;
  visualGrouping?: boolean | BrowserDesiredVisualGrouping;
  cookies?: BrowserDesiredCookie[];
  networkRecorder?: boolean | BrowserDesiredNetworkRecorder;
  hookDispatcher?: boolean | BrowserDesiredHook;
};

type BrowserDesiredTab = {
  role: string;
  url: string;
  reuse?: "none" | "matchingUrl" | "owned";
  active?: boolean;
  waitUntil?: "none" | "domcontentloaded" | "complete" | "networkIdle";
  recreateOnMissing?: boolean;
};

type BrowserDesiredOwnedWindow = {
  enabled?: boolean;
  focused?: boolean;
  state?: "normal" | "minimized" | "maximized" | "fullscreen";
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  closeOnDelete?: boolean;
};

type BrowserDesiredVisualGrouping = {
  enabled?: boolean;
  title?: string;
  color?: string;
  collapsed?: boolean;
};
```

### 4.1.1 Pre-navigation Hook metadata（TODO 228 设计完成，TODO 229 runtime 已完成）

TODO 228 冻结了 `preNavigationHooks` 的声明式 metadata，详见 `docs/pre-navigation-hook-policy.md`。TODO 229 已实现 document-start hook runtime：Desired 只接收 registry-backed `hookId/version/hash/params/scope/required`，driver 从受控 registry 解析脚本 bytes，在 navigation 前调用 `frame.addNewDocumentScript`，并在 stop/delete 时调用 `frame.removeNewDocumentScript` 清理。raw `source` 仍只属于底层 `browser_frame` primitive，不进入 orchestration Desired/persisted state。

允许的 Desired metadata 仅包含：

```ts
type BrowserDesiredPreNavigationHook = {
  hookId: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
  scope?: {
    tabRoles?: string[];
    origins?: string[];
    allFrames?: boolean;
    matchAboutBlank?: boolean;
  };
  version: string;
  hash: string;
  required?: boolean;
};
```

禁止 Desired、runtime store、status、summary 与 artifact 持久化 `script`、`code`、`source` 或任意可执行 JavaScript 文本。真实脚本文本只能来自 driver 内置 registry 或仓库只读安全目录，并以 `hookId/version/hash` 校验。当前内置 registry 提供 `pi.preNavigationMarker@1`，用于验证 document-start marker 早于页面 head script 生效。

### 4.2 Actual State

Actual State 是探测结果，不是 store 的复制。

```ts
type BrowserOrchestrationActual = {
  observedAt: number;
  bridge: {
    running: boolean;
    extensionConnected: boolean;
    selectedBrowserId?: string;
    workerBootId?: string;
  };
  tabs: BrowserTabInfo[];
  windows?: Array<Record<string, unknown>>;
  tabGroups?: { tabGroupsStatus?: "available" | "degraded_not_supported" | "degraded_operation_failed"; supported?: boolean; reason?: string };
  sessions: Array<{
    tag: string;
    tabs: Array<{
      role: string;
      desiredUrl: string;
      tabId?: number;
      browserId?: string;
      windowId?: number;
      windowOwned?: boolean;
      windowCloseOnDelete?: boolean;
      groupId?: number;
      tabGroupsStatus?: string;
      exists: boolean;
      url?: string;
      active?: boolean;
      owned: boolean;
      navigation?: { matchesDesired: boolean; loadState?: string };
      networkRecorder?: { desired: boolean; active: boolean; sessionId?: string };
      hookDispatcher?: { desired: boolean; installed: boolean; state?: string; sessionId?: string };
      cookies?: Array<{ name: string; present?: boolean; valueHash?: string; drift?: boolean }>;
    }>;
  }>;
};
```

Cookie value 不进入 Actual State；需要比较时使用 hash 或直接执行幂等 set。

### 4.3 Diff / Plan

```ts
type ReconcileOperation = {
  id: string;
  phase:
    | "observe"
    | "window"
    | "tab"
    | "visual-grouping"
    | "recorder-pre-nav"
    | "cookie"
    | "navigation"
    | "recorder"
    | "hook"
    | "verify"
    | "cleanup";
  action:
    | "createWindow"
    | "createTab"
    | "reuseTab"
    | "groupTabs"
    | "startNetwork"
    | "setCookie"
    | "navigate"
    | "installHook"
    | "verifyStatus"
    | "closeTab"
    | "closeWindow"
    | "stopNetwork"
    | "uninstallHook";
  resourceRef: {
    orchestrationId: string;
    sessionTag: string;
    tabRole: string;
    tabId?: number;
    browserId?: string;
    windowId?: number;
    groupId?: number;
  };
  reason: string;
  dependsOn?: string[];
  idempotencyKey: string;
  required: boolean;
  redactedParams: Record<string, unknown>;
};
```

### 4.4 Runtime State

```ts
type OrchestrationRuntimeState = {
  orchestrationId: string;
  generation: string;
  desiredHash: string;
  createdAt: number;
  updatedAt: number;
  watch?: {
    active: boolean;
    intervalMs: number;
    expiresAt: number;
    lastRunAt?: number;
    nextRunAt?: number;
    failures: number;
  };
  bindings: Array<{
    sessionTag: string;
    tabRole: string;
    browserId: string;
    tabId: number;
    windowId?: number;
    windowOwned?: boolean;
    windowCloseOnDelete?: boolean;
    groupId?: number;
    tabGroupsStatus?: "available" | "degraded_not_supported" | "degraded_operation_failed" | "disabled";
    owned: boolean;
    desiredUrl: string;
    createdByOrchestrator: boolean;
    networkSessionId?: string;
    hookSessionId?: string;
    hookFingerprint?: string;
  }>;
};
```

Runtime State 默认内存态，仅 Pi session 内有效；可将 redacted audit 写 artifact，但不能把 cookie value 写入 state。

## 5. 关键数据流与生命周期

### 5.1 `plan`

1. 归一化 Desired State。
2. 读取 store 中现有 binding。
3. 采集 Actual State。
4. 计算 Diff 与 operation plan。
5. 返回计划，不执行副作用。

### 5.2 `apply`

1. 获取 `orchestrationId` lock。
2. 归一化 Desired State，写入 generation/digest。
3. 采集 Actual State。
4. 生成 plan。
5. 按 phase 执行：
   - ensure tab；
   - `network.start` if `startBeforeNavigate`；
   - `cookies.set`；
   - `wait.navigate` / `wait.navigateAndWait`；
   - `network.start` reconfigure if after navigation；
   - `hook.install`；
   - verify status。
6. 更新 store bindings。
7. 返回 converged、bindings、operationResults、failures。

### 5.3 `watch`

1. 先执行一次 bounded `apply`。
2. 写入 watch state：interval、ttl、maxAttempts。
3. 后台 reconcile loop 定期：observe → diff → apply drift plan。
4. 连续失败超限后自动 pause，并保留状态诊断。

`watch` 必须显式启用；默认 `apply` 不启动后台循环。

### 5.4 `delete`

1. 停止 watch。
2. 刷新 Actual State。
3. 按 cleanup policy：stop recorder → uninstall hook → close owned windows 或 close owned tabs。
4. 删除 store state 或标记 deleted。
5. 返回 cleanup operationResults。

## 6. 错误处理、并发控制、降级与恢复

### 6.1 错误处理

硬错误直接返回 tool error：

- `ORCHESTRATION_INVALID_DESIRED`
- `ORCHESTRATION_TARGET_CONFLICT`
- `ORCHESTRATION_SESSION_NOT_FOUND`
- `ORCHESTRATION_BROWSER_NOT_FOUND`
- `ORCHESTRATION_TIMEOUT`
- `ORCHESTRATION_LOCKED`

部分失败不吞错，返回 `ok:false`、`converged:false`、`failures[]` 与 per-operation status。

### 6.2 并发控制

- 每个 `orchestrationId` 一个 apply/watch/delete lock。
- 每个 `browserId:tabId` 一个 resource lock。
- 不同 orchestration 可并行；同一 tab 不并行变更。
- 同一 orchestration 内不同 session 可并行，同一 tab 内按 phase 串行。
- 默认限制：`maxConcurrentSessions=3`、`maxConcurrentOperations=6`。

### 6.3 降级策略

- `plan/status` 永远不执行副作用；即使部分 probe 失败，也返回可用的 partial actual 与 diagnostics。
- `apply` 遇到非 required resource 失败时继续执行其它独立 resource，并标记 `converged:false`。
- `watch` 连续失败达到阈值后 pause，不继续制造副作用。
- Extension 断连时不猜测状态；返回 retryable failure，等待下一轮 reconnect 后重探。

### 6.4 恢复机制

Drift 类型与恢复：

- Tab missing：若 `recreateOnMissing:true` 且 resource owned，则重建；否则失败。
- Service Worker restart：通过 `workerBootId` 变化与 `network.status/hook.status` 识别，重新 start/install。
- Recorder lost：同 `networkSessionId` 执行 `network.start` reconfigure。
- Hook lost：先 `hook.status`，必要时按 fixed `hookSessionId` 与 fingerprint reinstall。
- Cookie drift：执行 `cookies.set` 幂等覆盖。
- Navigation drift：执行 bounded navigation；失败后返回 `NAVIGATION_NOT_CONVERGED`。

### 6.5 补偿

不做全事务 rollback。支持有限补偿：

- 本轮新建且 owned tab 可关闭。
- 本轮启动 recorder 可 stop。
- 本轮安装 hook 可 uninstall。
- Cookie 默认不恢复；只在后续明确设计 cookie snapshot/restore 时增强。

## 7. 安全与边界控制

- Desired State 必须支持 `allowedOrigins`；cookie、navigation、hook、network 的 URL 均需匹配。
- Cookie set/remove 只允许 http(s) URL；错误与 summary 不输出 value。
- Hook/network 默认不自动开启；必须在 Desired State 显式声明。
- Recorder/hook sessionId 由 coordinator 生成稳定前缀：`orch:{orchestrationId}:{sessionTag}:{tabRole}:network|hook`。
- Pre-navigation hook policy 只持久化 `hookId/enabled/params/scope/version/hash` metadata；禁止 `script/code/source` 进入 Desired/persisted state。底层 `frame.addNewDocumentScript` raw primitive 可以接收 `source`，但 orchestration policy 不从 Desired 读取或保存该字段。
- Artifact 使用现有 `local_raw_evidence` 分类与脱敏机制。Persistent state policy 见 `docs/orchestration-persistence.md`；该状态文件使用 `local_redacted_orchestration_state` 分类，只保存 `redactedDesired/bindings/fingerprints`，跨 Pi session 自动 cleanup 禁止；显式 adoption 成功前 `apply/watch/stop/delete` 均拒绝副作用。
- 不修改 Chrome 扩展安全沙箱；只复用现有权限与 native command 原语。高层策略留在 Node driver，避免 MV3 重启丢失状态或绕过 Pi 平台边界。

## 8. 可维护性与可测试性

- Coordinator 子模块必须按职责拆分，禁止把状态机塞入 `BrowserBridgeServer.ts` 或 `registerOrchestrateTool.ts`。
- 外部输入在 `normalizeDesired.ts` 收口，内部类型强约束，避免 `unknown` 扩散。
- DiffPlanner 必须是可单测的纯逻辑层。
- ReconcileExecutor 必须通过 fake `BrowserBridgeServer`/fake WS fixture 覆盖副作用顺序。
- All operation results 必须可 artifact 化，summary 只保留 compact evidence。
- 生成文档与 schema drift 必须纳入 `npm run check`。

## 9. 分阶段实施计划与验收标准

本设计不采用 demo/MVP 口径；阶段只是提交顺序，最终首个可发布版本必须完成 216-222 的核心闭环和验证。

### 阶段 A：设计与协议准备

- 完成 TODO 216：设计文档、TODO 分解、README 入口。
- 完成 TODO 217：cookies set/remove native primitive 与协议生成。

验收：

- `npm run sync:protocol` / `npm run check:protocol` 通过。
- cookie primitive contract 覆盖 list/get/set/remove、无效 URL、脱敏。

### 阶段 B：Coordinator 核心

- 完成 TODO 218：Node driver coordinator/store/actual/diff/executor/locks。
- 完成 TODO 219：`browser_orchestrate` tool、summary、artifact、errors。

验收：

- `plan/apply/status/delete` 幂等。
- 重复 apply 不重复创建 tabs、recorder、hook。
- 部分失败有结构化 operationResults。

### 阶段 C：自愈与 watch

- 完成 TODO 220：explicit watch/stop、drift probe、backoff、TTL、pause。

验收：

- Service Worker restart 后 recorder/hook 可恢复。
- Tab missing 按策略 fail/recreate。
- Watch 不无限创建资源，不跨 browser fallback。

### 阶段 D：测试、文档、发布验收

- 完成 TODO 221：fake WS、runtime fixture、isolated smoke、fault injection 与 release smoke diagnostics。
- 完成 TODO 222：README/skill/generated docs/CHANGELOG/TODO 同步，release gate。

验收：

- `npm run check` 通过。
- `npm run smoke:browser:isolated` 覆盖 `browser_orchestrate` happy path、cookie set/remove、network/hook 编排、导航等待、watch 自愈，以及 owned window / tabGroups runtime diagnostics。
- `browser_orchestrate` 出现在 generated tool contract 与 skill，且文案不把 future capability 写成当前能力。
- `quality:local`、isolated smoke、release smoke 已作为首个生产闭环 gate 通过；关键 artifacts 记录在 TODO 222。

## 10. 长期演进

后续增强已独立落档到 `docs/browser-orchestration-next-roadmap.md`，并拆分为 TODO 223-233。该路线不改变 TODO 217-222 的首个生产闭环边界；任何新增能力在完成对应 TODO 的设计、实现、契约、runtime smoke 与发布 gate 前，不得写入当前 callable capability 描述。

固定演进边界：

- Target resolver 采用 tool-level `target:{...}`，不进入 `native_command_schema.json`。
- window-level isolation 与 Chrome `tabGroups` 视觉分组分阶段推进；`tabGroups` 不作为 hard fail 依赖。
- pre-navigation hook policy 只持久化声明式 hook metadata，禁止持久化任意可执行脚本文本。
- TODO 230/231 已冻结并实现 `docs/orchestration-persistence.md`：受控持久化 orchestration state 默认 read-only/stale，跨 Pi session 自动 cleanup 禁止；adoption 必须显式声明并校验 live resource 指纹。
- 物理隔离运行规则见 `docs/browser-profile-isolation.md`；TODO 232 已冻结 profile-first 方案，TODO 233 已实现 `isolation.scope:"profile"` managed profile runtime 与 smoke gate；Incognito 仅作为 opt-in diagnostic，不阻塞主干 smoke/release gate。
