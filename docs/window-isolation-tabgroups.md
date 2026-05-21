# Window Isolation 与 tabGroups Native Primitive / Runtime

本文记录 TODO 225 设计落档、TODO 226 runtime 实现状态与 TODO 227 真实浏览器 smoke gate：`windows` native primitive、`tabGroups` feature probe/visual grouping、Node coordinator owned window lifecycle 与 Edge isolated/release smoke 均已落地。

## 1. 已保持的不变式

- 高层 ownership、Desired/Actual/Diff/Reconcile 只在 Node driver 层。
- Chrome extension 只提供底层 native primitives。
- `browser_orchestrate` 不进入 `native_command_schema.json`。
- `target.windowId/groupId` 仍是 resolver 预留字段；TODO 226 不实现通过 window/group 自动解析 tab。
- `tabGroups` 只做视觉与诊断增强，不作为 tabs/navigation/cookies/network/hook 核心 reconcile 的 hard fail。
- Cookie/body/postData/websocket payload 不进入 summary/status/store/failure details。

## 2. TODO 225 设计边界

TODO 225 已完成：冻结 window/tabGroups primitive 草案、manifest permission 计划、Chrome API 类型计划、错误 taxonomy 与 no-hard-fail contract。

TODO 225 当时不修改 runtime；TODO 226 已移除 design-only 负向契约，并把 schema/runtime/manifest/coordinator 接入生产路径。

## 3. Native commands（TODO 226 已落地）

### 3.1 `windows`

`bridge/native_command_schema.json` 已包含：

```json
{
  "windows": {
    "domain": "core",
    "tabScoped": false,
    "methods": ["list", "get", "create", "update", "focus", "close"],
    "defaultMethod": "list",
    "methodSpecs": {
      "get": { "required": ["windowId"] },
      "update": { "required": ["windowId"] },
      "focus": { "required": ["windowId"] },
      "close": { "required": ["windowId"] }
    }
  }
}
```

Runtime：`bridge_src/service_worker/core_commands.ts#handleWindowsCommand` 调用 `chrome.windows`：

| method | 行为 | 返回摘要 | 约束 |
|---|---|---|---|
| `list` | `chrome.windows.getAll({populate})` | `windowId/focused/incognito/type/state/tabs[]` | 不含页面内容或 cookie。 |
| `get` | `chrome.windows.get(windowId,{populate})` | 单个 window summary | `windowId` 正整数。 |
| `create` | `chrome.windows.create()` | `windowId` 与首个 `tabs[]` | URL 校验复用 `tabs.create`，禁止 `javascript:`；incognito 主线禁用。 |
| `update` | `chrome.windows.update()` | updated window summary | ownership 由 Node coordinator 校验。 |
| `focus` | `chrome.windows.update(windowId,{focused:true})` | updated window summary | `focus` 是 shortcut。 |
| `close` | `chrome.windows.remove(windowId)` | `{windowId, closed:true}` | coordinator 只对 owned window 使用。 |

### 3.2 `tabGroups`

`bridge/native_command_schema.json` 已包含：

```json
{
  "tabGroups": {
    "domain": "core",
    "tabScoped": false,
    "methods": ["status", "query", "group", "update", "ungroup"],
    "defaultMethod": "status",
    "methodSpecs": {
      "group": { "required": ["tabIds"] },
      "update": { "required": ["tabGroupId"] },
      "ungroup": { "required": ["tabIds"] }
    }
  }
}
```

Runtime：`bridge_src/service_worker/core_commands.ts#handleTabGroupsCommand` feature-probe `chrome.tabGroups` 与 `chrome.tabs.group/ungroup`。

| method | 行为 | 返回摘要 | 降级 |
|---|---|---|---|
| `status` | feature probe | `{tabGroupsStatus:"available"|"degraded_not_supported", supported, reason?}` | API/permission 不可用返回 `ok:true` + degraded。 |
| `query` | `chrome.tabGroups.query()` | `{tabGroupsStatus, groups[]}` | unsupported 返回 degraded。 |
| `group` | `chrome.tabs.group()` | `{tabGroupsStatus, groupId, tabIds}` | unsupported/operation failed 不 hard fail。 |
| `update` | `chrome.tabGroups.update(tabGroupId, ...)` | updated group summary | protocol 字段为 `tabGroupId`，runtime 兼容 `groupId` alias。 |
| `ungroup` | `chrome.tabs.ungroup()` | ungrouped tab ids | unsupported/operation failed 不 hard fail。 |

`tabGroupsStatus`：

- `available`：API 与权限可用，操作已执行。
- `degraded_not_supported`：`chrome.tabGroups` 不存在、权限不可用或当前浏览器不支持；核心 reconcile 必须继续。
- `degraded_operation_failed`：API 存在但视觉分组操作失败；operation 记录 degraded，核心 tab/window/navigation/cookie/network/hook 继续执行。

## 4. Manifest / package runtime 状态

TODO 226 已修改 `bridge/pi_browser_bridge/manifest.json`，加入 `tabGroups` permission。同步要求：

- `npm run sync:protocol` 生成 native protocol/type/metadata/docs。
- `npm run build:bridge` 生成 manifest 当前使用的 dist runtime。
- `check:bridge:files` 验证 manifest permission、bridge runtime/types 与文档一致。
- TODO 227 已执行真实 Edge isolated smoke / release smoke，并在 artifact 上浮 `windowTabGroups` diagnostics。

`windows` API 当前由 MV3 extension 基础能力与 tabs 相关权限满足；后续如浏览器要求额外权限，以 runtime contract 为准。

## 5. Chrome API 类型

`bridge_src/service_worker/types.ts` 已包含：

- `PiChromeTab.groupId`。
- `PiChromeWindow` / `PiChromeWindows`。
- `PiChromeTabGroup` / optional `PiChromeApi.tabGroups?: PiChromeTabGroups`。
- `PiChromeTabs.group?()` / `PiChromeTabs.ungroup?()`。

`tabGroups` 在类型上保持 optional，feature probe 不假设存在。

## 6. Error taxonomy

已写入 `bridge/native_command_schema.json#errorCodes`：

| code | category | retryable | 使用场景 |
|---|---|---:|---|
| `WINDOW_ID_REQUIRED` | `runtime.window` | no | `get/update/focus/close` 缺少有效 `windowId`。 |
| `WINDOW_NOT_FOUND` | `runtime.window` | yes | Chrome 返回 window 不存在或已关闭。 |
| `WINDOW_OPERATION_FAILED` | `runtime.window` | true | Chrome windows API 操作失败。 |
| `ORCHESTRATION_WINDOW_OWNERSHIP_REQUIRED` | `driver.orchestration` | no | Node coordinator 尝试 close/update 非 owned window。 |
| `TAB_GROUPS_NOT_SUPPORTED` | `runtime.tabGroups` | no | 仅作为 diagnostic reason；默认返回 degraded data，不作为 hard error。 |
| `TAB_GROUP_ID_REQUIRED` | `runtime.tabGroups` | no | `update` 缺少有效 `tabGroupId`。 |
| `TAB_GROUP_TAB_IDS_REQUIRED` | `runtime.tabGroups` | no | `group/ungroup` 缺少非空 `tabIds`。 |
| `TAB_GROUPS_OPERATION_FAILED` | `runtime.tabGroups` | false | API 存在但 group/update/ungroup 失败；coordinator 记录 degraded。 |

## 7. Coordinator 接入（TODO 226 已落地）

- Desired：top-level `windowIsolation` / `visualGrouping` defaults；session-level `ownedWindow` / `visualGrouping` overrides。
- Binding：`windowId`、`windowOwned`、`windowCloseOnDelete`、`groupId`、`tabGroupsStatus`。
- Actual：采集 `windows.list` 与 `tabGroups.status`，tab state 保留 window/group diagnostics。
- Diff：新增 `window` 与 `visual-grouping` phase；规划 `createWindow`、`createTab`、`groupTabs`、`verifyStatus`。
- Reconcile：`createWindow` 先于 tabs/navigation；owned-window 后续 tabs 通过 `windowId` 创建；`groupTabs` 调用 degraded 不失败；`closeWindow` 只关闭 `windowOwned:true` 且 `windowCloseOnDelete!==false` 的窗口。
- Store/Summary/Artifact：上浮 `windowId/groupId/tabGroupsStatus`。

禁止：

- 通过 `target.windowId/groupId` 自动解析 tab。
- 因 `tabGroups` degraded 跳过 tabs/navigation/cookies/network/hook 核心操作。
- 关闭非 owned window；非 owned window 下只允许清理 owned tabs 或 recorder/hook。

## 8. No-hard-fail contract

```ts
if (tabGroupsStatus !== "available") {
  operation.status = "degraded";
  operation.required = false;
  operation.reason = "tabGroups visual grouping unavailable";
  // continue: tabs/navigation/cookies/network/hook/verify
}
```

已由 `tests/contracts/check-orchestration-coordinator.mjs` 覆盖：

- `tabGroups.status` unsupported 返回 `ok:true` + `tabGroupsStatus:"degraded_not_supported"`。
- `groupTabs` operation 标记 `status:"degraded"`，不增加 failure。
- status 可收敛，owned window/tabs 仍创建并可 delete cleanup。
- `.pi/browser-artifacts/orchestration-fixture-results.json` 包含 `createWindow`、`groupTabs`、`closeWindow`、`windowId`、`groupId`、`tabGroupsStatus` 证据。

## 9. TODO 226 / TODO 227 验收

TODO 226 已通过：

- `npm run check:protocol`
- `npm run check:bridge:files`
- `npm run check:pi-browser-bridge`
- `npm run check:orchestration`
- `npm run check:bridge:types`

TODO 227 已通过：

- `npm run check`
- `PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated`
- `PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run release:local:smoke`

关键 artifacts：

- `.pi/browser-artifacts/smoke-browser-isolated-results.json`
- `.pi/browser-artifacts/smoke-browser-results.json`
- `.pi/browser-artifacts/smoke-window-tabgroups-result.json`
- `.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`
- `.pi/browser-artifacts/release-acceptance/current-smoke-browser-isolated-results.json`
- `.pi/browser-artifacts/release-acceptance/current-smoke-browser-results.json`

## 10. 回滚

如 runtime/权限导致兼容问题：

1. 禁用 orchestration `ownedWindow` / `visualGrouping` planning。
2. 保留 tabs/cookies/network/hook 核心 reconcile。
3. 如必须回滚权限提示，移除 `tabGroups` manifest permission 与 `tabGroups` native command，保留 `windows` 或回退 tab-level logical isolation。
