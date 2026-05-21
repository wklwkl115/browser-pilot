# Pre-navigation Hook Policy

本文冻结 TODO228 的 document-start hook policy。当前状态：设计与静态契约已完成；runtime 编排、smoke 与 release gate 留给 TODO229。本文不声明新的 callable capability；当前可直接调用的底层原语仍是 `browser_frame` / `frame.addNewDocumentScript`。

## 1. 目标与边界

目标：让后续 `browser_orchestrate` 能在导航前安装受控 hook，使脚本在新 document 早期执行，同时禁止 Desired State、runtime store、status、summary、artifact 中持久化任意可执行脚本文本。

边界：

- 高层 policy 只在 Node driver 层实现。
- Chrome extension 继续只暴露 `frame.addNewDocumentScript` 与 `frame.removeNewDocumentScript` 底层 native primitive。
- `frame.addNewDocumentScript` 作为 raw primitive 仍需要 `source`；该 raw source 不得进入 orchestration Desired/persisted state。
- TODO228 不安装 hook、不修改 navigation 行为、不创建新 smoke gate。
- TODO229 才实现 normalize → plan → install → navigate → verify → cleanup/watch 恢复。

## 2. 允许持久化的 metadata

Future Desired metadata 只允许声明式字段：

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

1. Driver 内置 registry：编译进仓库源码的固定 hook entry。
2. 仓库只读安全目录：例如未来 `src/driver/orchestration/preNavigationHooks/assets/`，由 package 发布内容提供。
3. 每个 entry 必须声明 `hookId/version/hash`，`hash` 是脚本规范化字节的 SHA-256。
4. Desired 中的 `hash` 必须与 registry entry 完全一致；不一致返回 `ORCHESTRATION_INVALID_DESIRED`。
5. `hookId+version` 必须唯一；registry 冲突是启动/contract 级失败。
6. Registry entry 可以声明 `assetPath`、`paramsSchema`、默认 `scope`；不得把脚本文本复制进 persisted Desired。
7. 外部 HTTP、本地任意路径、用户输入字符串、artifact 内容、clipboard 内容不得作为 hook 脚本来源。

## 4. Lifecycle

TODO229 runtime 必须按以下顺序实现：

1. Normalize：校验 `hookId/enabled/params/scope/version/hash`，递归拒绝 `script/code/source`。
2. Registry resolve：按 `hookId/version/hash` 从受控 registry 取脚本 bytes。
3. Ensure tab/window：先完成 `window`、`tab`、`visual-grouping` 等资源绑定。
4. Install before navigate：在目标 tab 发生 `wait.navigate` / `wait.navigateAndWait` 前调用 `frame.addNewDocumentScript`。
5. Verify registration：保存 Chrome 返回的 `identifier/sessionKey/cdpSessionName`，并记录 `hookId/version/hash`。
6. Navigate：执行 navigation/load-state/network-idle 收敛。
7. Verify effect：用非敏感 marker 或只读 evaluate 验证新 document 早期 hook 生效；已加载页面不承诺 retroactive 生效。
8. Cleanup：`delete/stop` 通过 `frame.removeNewDocumentScript` 移除 registration。
9. Watch recovery：MV3 restart、CDP session 丢失或 identifier 丢失时，在下一次导航前重新 install；对已加载页面只报告 stale diagnostic。

推荐 phase 顺序：

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
- `cdpSessionName`
- `sessionTag`
- `tabRole`
- `workerBootId`
- `installedAt`

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
- `frame.addNewDocumentScript` 失败：required hook 使 apply 失败；非 required hook 可标记 degraded，但 navigation 是否继续由 TODO229 的 operation required 规则决定。
- `frame.removeNewDocumentScript` 已知但 Chrome 已清理：按底层 primitive 的 `alreadyRemoved:true` 视为 cleanup 成功。
- MV3 restart 后无法证明 registration 存活：watch 报 stale 并在下一次导航前重装。

## 7. Contracts

TODO228 静态契约必须锁定：

- 本文存在并声明 no-script-persistence policy。
- `src/driver/orchestration/types.ts` 包含 metadata/registry/registration 类型，且 registry 用 `assetPath` 而不是 `sourcePath/script/code`。
- `normalizeDesired` 在 TODO229 前拒绝 enabled `preNavigationHooks`，并递归拒绝 `script/code/source`。
- `bridge/native_command_schema.json` 仍保留 raw `frame.addNewDocumentScript` 的 `source` required 字段；该字段只属于 raw primitive，不属于 orchestration Desired。
- `docs/browser-orchestration-coordinator.md` 与 roadmap 指向本文，并明确 TODO229 runtime pending。

## 8. TODO229 输入条件

TODO229 开工前不得新增 callable capability 文案。实现时必须同时更新：

- normalization/runtime types
- DiffPlanner/ReconcileExecutor/ActualStateCollector/Store
- `browser_orchestrate` schema/summary
- orchestration fixture
- runtime fixture 或 isolated smoke
- README/CHANGELOG/TODO/generated docs
- skill 仅在 runtime capability 真实可用后更新
