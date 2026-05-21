# Pre-navigation Hook Policy

本文冻结 TODO228 的 document-start hook policy，并记录 TODO229 runtime 落地边界。当前状态：已完成 runtime 实现与 smoke gate；`browser_orchestrate` 已支持 registry-backed `preNavigationHooks` metadata。当前可直接调用的底层原语仍是 `browser_frame` / `frame.addNewDocumentScript`；raw `source` 只属于底层 primitive，不进入 orchestration Desired/persisted state。

## 1. 目标与边界

目标：让 `browser_orchestrate` 在导航前安装受控 hook，使脚本在新 document 早期执行，同时禁止 Desired State、runtime store、status、summary、artifact 中持久化任意可执行脚本文本。

边界：

- 高层 policy 只在 Node driver 层实现。
- Chrome extension 继续只暴露 `frame.addNewDocumentScript` 与 `frame.removeNewDocumentScript` 底层 native primitive。
- `frame.addNewDocumentScript` 作为 raw primitive 仍需要 `source`；该 raw source 不得进入 orchestration Desired/persisted state。
- TODO228 只冻结 policy 与静态契约；TODO229 已实现 normalize → plan → install → navigate → verify → cleanup/watch 恢复。
- Desired/Store/Status/Summary/Artifact 只保存 metadata；不得保存 registry 脚本文本、raw `source`、inline `script/code` 或任意外部 payload。

## 2. 允许持久化的 metadata

Desired metadata 只允许声明式字段：

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

归一化后只保存：

```ts
type NormalizedPreNavigationHookMetadata = {
  hookId: string;
  enabled: boolean;
  params: Record<string, unknown>;
  scope: {
    tabRoles?: string[];
    origins?: string[];
    allFrames: boolean;
    matchAboutBlank: boolean;
  };
  version: string;
  hash: string;
  required: boolean;
  installPhase: "pre-navigation";
};
```

禁止字段：

- `script`
- `code`
- `source`
- 任何可执行 JavaScript 文本、函数字符串、inline module 文本；不得从外部 Desired JSON 反序列化后执行任何 payload。

禁止字段检查必须递归覆盖 top-level `preNavigationHooks`、session-level `preNavigationHooks`、`params`、`scope` 与未来扩展对象。

## 3. Hook Registry 规则

真实脚本文本只能来自受控 registry：

1. Driver 内置 registry：编译进仓库源码的固定 hook entry；当前内置 `pi.preNavigationMarker@1`。
2. 仓库只读安全目录：例如未来 `src/driver/orchestration/preNavigationHooks/assets/`，由 package 发布内容提供。
3. 每个 entry 必须声明 `hookId/version/hash`，`hash` 是脚本规范化字节的 SHA-256。
4. Desired 中的 `hash` 必须与 registry entry 完全一致；不一致返回 `ORCHESTRATION_INVALID_DESIRED`。
5. `hookId+version` 必须唯一；registry 冲突是启动/contract 级失败。
6. Registry entry 可以声明 `assetPath`、`paramsSchema`、默认 `scope`；不得把脚本文本复制进 persisted Desired。
7. 外部 HTTP、本地任意路径、用户输入字符串、artifact 内容、clipboard 内容不得作为 hook 脚本来源。

## 4. Lifecycle

TODO229 runtime 已按以下顺序实现：

1. Normalize：校验 `hookId/enabled/params/scope/version/hash`，递归拒绝 `script/code/source`。
2. Registry resolve：按 `hookId/version/hash` 从受控 registry 取脚本 bytes。
3. Ensure tab/window：先完成 `window`、`tab`、`visual-grouping` 等资源绑定；有 pre-navigation hook 的新 tab/window 先创建 `about:blank`。
4. Install before navigate：在目标 tab 发生 `wait.navigate` / `wait.navigateAndWait` 前调用 `frame.addNewDocumentScript`。
5. Verify registration：保存 Chrome 返回的 `identifier/sessionKey/cdpSessionName`，并记录 `hookId/version/hash`。
6. Navigate：执行 navigation/load-state/network-idle 收敛。
7. Verify effect：用非敏感 marker 或只读 evaluate 验证新 document 早期 hook 生效；已加载页面不承诺 retroactive 生效，必要时重新导航生成新 document。
8. Cleanup：`delete/stop` 与失败补偿通过 `frame.removeNewDocumentScript` 移除 registration。
9. Watch recovery：MV3 restart、CDP session 丢失或 identifier 丢失时，在下一次导航前重新 install；对已加载页面只报告 stale diagnostic。

phase 顺序：

```text
observe → window → tab → visual-grouping → recorder-pre-nav → hook-pre-nav → cookie → navigation → recorder → hook → verify → cleanup
```

`hook-pre-nav` 只负责 document-start registration；现有 `hook` phase 继续负责页面 dispatcher install/status/collect。

## 5. Runtime State 与 Artifact 边界

Binding / store 只可保存：

- `hookId`
- `version`
- `hash`
- `identifier`
- `sessionKey`
- `cdpSessionName`
- `sessionTag`
- `tabRole`
- `workerBootId`
- `installedAt`
- `effectVerifiedAt`
- degraded diagnostic code/message metadata

不得保存：

- registry 脚本文本
- raw `source`
- inline `script/code`
- 用户传入 executable payload
- cookie value、authorization、body/postData/websocket payload

Summary/status 只展示 metadata、counts、hash 前缀、registration id 与 diagnostic code；完整 raw registry bytes 不写 artifact。

## 6. 错误与降级

- Desired 出现 `script/code/source`：`ORCHESTRATION_INVALID_DESIRED`，不可重试。
- `hookId/version/hash` 未命中 registry：`ORCHESTRATION_INVALID_DESIRED`，不可重试。
- `frame.addNewDocumentScript` 失败：required hook 使 apply 失败；非 required hook 标记 degraded，核心 navigation 可继续，后续 plan 不无限重试同一 degraded hook。
- `frame.removeNewDocumentScript` 已知但 Chrome 已清理：按底层 primitive 的 `alreadyRemoved:true` 视为 cleanup 成功。
- MV3 restart 后无法证明 registration 存活：watch 报 stale 并在下一次导航前重装。

## 7. Contracts

TODO228/TODO229 契约锁定：

- 本文存在并声明 no-script-persistence policy。
- `src/driver/orchestration/types.ts` 包含 metadata/registry/registration/actual-state 类型，且 registry 用 `assetPath` 而不是 `sourcePath/script/code`。
- `normalizeDesired` 接受 registry-backed enabled `preNavigationHooks`，并递归拒绝 `script/code/source`。
- `bridge/native_command_schema.json` 仍保留 raw `frame.addNewDocumentScript` 的 `source` required 字段；该字段只属于 raw primitive，不属于 orchestration Desired。
- `docs/browser-orchestration-coordinator.md` 与 roadmap 指向本文，并明确 TODO229 runtime complete。
- `check:orchestration` 覆盖 about:blank 创建、install-before-navigate、effect verify、workerBoot/lost registration 恢复与 delete cleanup。
- `smoke:browser` / isolated smoke 覆盖 document-start marker 早于页面 head script 生效，并写出 `.pi/browser-artifacts/smoke-pre-navigation-hook-result.json`。

## 8. TODO229 实现清单

TODO229 已同步更新：

- normalization/runtime types
- DiffPlanner/ReconcileExecutor/ActualStateCollector/Store
- `browser_orchestrate` schema/summary
- orchestration fixture
- isolated smoke
- README/CHANGELOG/TODO/generated docs
- skill runtime capability 文案
