# Browser Target Resolver 设计

本文冻结 target resolver 设计与运行边界。当前状态：TODO 223 已完成设计、schema 草案、覆盖清单、错误/diagnostics 规则与 native schema 防泄漏 contract；TODO 224 已完成 Node driver/runtime 解析、tab-scoped tools 参数接入、contracts、generated docs 与 isolated smoke gate。

## 1. 背景与目标

TODO 217-222 已完成状态协调器首个生产闭环：`browser_orchestrate` 能创建/复用 owned tabs，绑定 `orchestrationId/sessionTag/tabRole`，并协调 navigation、cookies、network recorder、hook dispatcher、watch/self-heal 与 cleanup。

TODO 223 的目标是在不改变现有工具行为的前提下，定义后续所有 tab-scoped tools 可复用的结构化 target 参数，使工具调用可从“手动维护 `tabId`”逐步迁移到“逻辑会话寻址”。

TODO 224 在此设计基础上新增 callable runtime 能力：tab-scoped tools 可通过 `target:{orchestrationId,sessionTag,tabRole}` 定位已由 `browser_orchestrate` 绑定的 tab。

## 2. 固定决策

- Target resolver 是 Node tool/driver 层能力，不进入 `bridge/native_command_schema.json`。
- Chrome extension 继续只接收底层 native command 与最终 `tabId`。
- `browser_orchestrate` 继续是 Node 组合工具，不进入 native schema。
- Existing top-level `tabId` 保持兼容；omitted `tabId` fallback 继续存在，但不能作为逻辑 target 解析失败后的 fallback。
- `target` 冲突、歧义、stale binding 必须结构化失败，禁止 silent fallback。
- `target` 不持有 cookie value、body、postData、websocket payload 或任意可执行脚本文本。

## 3. Tool-level Target Schema

当前 tab-scoped tools 已增加可选 `target` 对象：

```ts
type BrowserToolTargetRef = {
  // 物理寻址，兼容 top-level tabId
  tabId?: number | string;
  browserId?: string;

  // 逻辑 orchestration 寻址
  orchestrationId?: string;
  sessionTag?: string;
  tabRole?: string;

  // Window/group/profile 由后续 TODO 接入；当前 profileId 用于 profile-bound orchestration target disambiguation
  windowId?: number | string;
  groupId?: number | string;
  profileId?: string;
  requireOwned?: boolean;
};
```

TypeBox schema：

```ts
export const BrowserToolTargetRefSchema = Type.Object({
  tabId: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  browserId: Type.Optional(Type.String()),
  orchestrationId: Type.Optional(Type.String()),
  sessionTag: Type.Optional(Type.String()),
  tabRole: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  groupId: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  profileId: Type.Optional(Type.String()),
  requireOwned: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
```

TODO 224 已通过 `sharedTabScopedToolParams()` 暴露 `target`，并保持该 schema 不写入 native command schema；TODO 233 已使 `profileId` 用于 managed profile-bound orchestration target 过滤。

## 4. 覆盖工具清单

TODO 224 已覆盖所有现有 tab-scoped tools：

| 工具 | target 适用性 | 注意事项 |
|---|---|---|
| `browser_scan` | 是 | `tabsOnly:true` 不需要 tab target；指定 target 时只扫描目标 tab。 |
| `browser_content` | 是 | `url` 导航路径也应先解析 target，再执行 wait supervisor。 |
| `browser_html` | 是 | selector/html snapshot 只作用目标 tab。 |
| `browser_execute` | 是 | JS 与 command 两种模式都需检查 outer target 与 command body `tabId` 冲突。 |
| `browser_wait` | 是 | `cancel/diagnose` 等动作若无需 tab，应允许 no target；tab-scoped command 仍需解析。 |
| `browser_network` | 是 | recorder session 仍由 `sessionId` 控制；target 只解析 tab scope。 |
| `browser_hook` | 是 | hook session strict-match 保持不变；target 只解析 tab scope。 |
| `browser_evidence` | 是 | 聚合 hook/network/performance 时按目标 tab scope 过滤。 |
| `browser_frame` | 是 | frame evaluate/new document script 均按目标 tab。 |
| `browser_screenshot` | 是 | fallback 仍保留现有语义；显式 target stale 时不得 fallback。 |
| `browser_download` | 是 | selector/media click 模式按目标 tab；url mode 不需要 tab target。 |
| `browser_upload` | 是 | selector/file chooser 按目标 tab。 |
| WebSecurity tools with `tabId` | 是 | `bindBrowserSession` cookie collection 通过 cookie provider 支持 target 解析；主动 HTTP replay/fuzz 不因 target 变成 browser automation。 |

`browser_tabs` 不使用 logical `target`；它仍是底层 tab/browser lifecycle tool。

`browser_orchestrate` 不使用 tab-scoped `target`；它通过 `desiredState` 管理 sessions/tabs/bindings。

## 5. 解析优先级与冲突规则

### 5.1 输入来源

可能出现的 tab 指定来源：

1. top-level `tabId`
2. top-level `target.tabId`
3. native command body `tabId`
4. native command body legacy aliases（例如 `targetTabId` 仅限 tabs close 等底层命令）
5. logical `target:{orchestrationId,sessionTag,tabRole}`

### 5.2 规则

- `tabId` 与 `target.tabId` 同时存在且值不同：`TARGET_CONFLICT`。
- outer target 解析出的 tab 与 command body `tabId` 不同：`TARGET_CONFLICT`。
- explicit `browserId` 与 resolved orchestration binding 的 `browserId` 不同：`TARGET_BROWSER_CONFLICT`。
- `sessionTag/tabRole` 未唯一匹配：`TARGET_AMBIGUOUS`。
- 指定 orchestration 不存在：`ORCHESTRATION_SESSION_NOT_FOUND`。
- binding 存在但 tab disconnected 或 worker/browser mismatch：`ORCHESTRATION_TARGET_STALE`。
- logical target 解析失败时不得回退到 default/latest tab。
- 未提供 target/tabId 时，保留当前 omitted `tabId` fallback 兼容路径，并继续通过 `target.source` / `selectionVersion` 暴露 diagnostics。

## 6. Resolver API

TODO 224 已在 Node driver 层引入统一解析入口：

```ts
type ResolveBrowserToolTargetInput = {
  toolName: string;
  commandName?: string;
  topLevelTabId?: unknown;
  target?: unknown;
  commandBody?: Record<string, unknown>;
  allowEmptyTarget?: boolean;
};

// BrowserTargetResolver.resolve() 返回 BrowserBridgeTargetInfo | undefined；
// sendCommand/executeJavaScript 再把最终 tabId 写入 native command payload。
```

实际入口位置：

- `src/tools/toolShared.ts` / `sharedTabScopedToolParams()`：统一声明 tool-level `target` 参数。
- 各 tab-scoped `register*.ts`：把 `params.target` 传入 driver options。
- `src/driver/BrowserBridgeServer.ts`：暴露 `resolveToolTarget()` facade，保持 sendCommand/executeJavaScript 只向 native command 发送最终 tab target。
- `src/driver/BrowserTargetResolver.ts`：规范化 `target`，处理冲突/歧义/stale，并查询 orchestration binding。
- `src/driver/BrowserTabSessionRouter.ts`：继续负责 physical tab/browser session 解析，不直接读取 orchestration desired。
- `src/driver/orchestration/OrchestrationStore.ts` 或 coordinator facade：提供 binding lookup API。
- `src/driver/orchestration/ReconcileExecutor.ts` / `ActualStateCollector.ts`：内部 tab 命令使用 binding 的 `{tabId,browserId}`，避免跨浏览器重复 tabId 误路由；createTab 后轮询 tab-sync 再绑定。

`BrowserBridgeTargetInfo` 保留：

```ts
{
  source: "explicit" | "default" | "latest" | "none" | "orchestration";
  implicit: boolean;
  tabId?: number;
  browserId?: string;
  selectionVersionAtDispatch: number;
  selectionVersionAtResolve?: number;
  orchestrationId?: string;
  sessionTag?: string;
  tabRole?: string;
}
```

## 7. Error 与 Diagnostics

新增/复用错误码：

| code | 场景 | retryable |
|---|---|---:|
| `TARGET_CONFLICT` | 多个 target/tabId 来源不一致 | no |
| `TARGET_AMBIGUOUS` | logical target 匹配多个 binding/tab | no |
| `ORCHESTRATION_SESSION_NOT_FOUND` | 指定 orchestration state 不存在 | no |
| `TARGET_NOT_FOUND` | target 没有匹配 live tab/binding | yes |
| `TARGET_BROWSER_CONFLICT` | browserId 与 binding/browser scope 冲突 | no |
| `ORCHESTRATION_TARGET_STALE` | binding 存在但 live tab/browser 已失效 | yes |

Diagnostics 必须包含：

- `toolName`
- `commandName`
- `targetSource`
- `tabId` / `browserId`（如存在）
- `orchestrationId/sessionTag/tabRole`（如存在）
- `selectionVersionAtDispatch/Resolve`
- candidate bindings/tabs 的 redacted summary

不得包含：cookie value、request body、postData、websocket payload、脚本文本。

## 8. Contract 与 Gate

TODO 223/224 已增加以下 contract 与 runtime gate：

- `check:protocol`：native command schema 不得出现 logical target fields：`target/sessionTag/tabRole/orchestrationId/profileId/groupId/requireOwned`。
- `check:tools`：保持 `TAB_SCOPED_TOOL_GUIDELINE` 与 shared param helper 单点维护，并覆盖 resolver routing contract。
- `check:tool-docs`：generated tool docs 出现 `target` 参数且无 drift。
- `check:lifecycle`：fake WebSocket fixture 覆盖 logical target 跨 selected browser dispatch、browser-scoped duplicate switch、target conflict、browser conflict、stale 与 ambiguity。
- isolated smoke：使用 logical target 执行 `execute/network/hook/wait` 路径并在 artifact 上浮 `targetSource:"orchestration"`。

TODO 224 验收命令已通过：

```bash
npm run check
npm run check:orchestration
npm run check:lifecycle
PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated
```

## 9. 非目标

当前 target resolver 仍不做：

- 不给 `browser_tabs` 增加 logical target；它仍是底层 tab/browser lifecycle tool。
- 不把 `target` 写入 `native_command_schema.json` 或 Chrome extension native protocol。
- `windowId/groupId/profileId` 只在 Node target resolver/orchestration 层使用，不进入 native schema；`profileId` 已用于 profile-bound orchestration target disambiguation。
- 不改变 omitted `tabId` fallback 兼容路径；只在显式 `target`/`tabId` 冲突、歧义、stale 时失败。
- 不提供 Incognito 默认隔离；managed profile 隔离由 `browser_orchestrate` 的显式 `isolation.scope:"profile"` 管理。

## 10. 后续输入条件

后续维护必须保持：

- 本文档与 generated docs/README/skill 对当前 target 能力描述一致。
- `check:protocol` 持续验证 native schema 未被逻辑 target 污染。
- TODO 224/233 smoke artifact 能证明 logical/profile-bound target 真实路由到 orchestration binding。
