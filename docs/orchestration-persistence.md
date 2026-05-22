# Orchestration Persistence Policy

本文冻结 TODO230 的 redacted orchestration state 持久化设计，并记录 TODO231 已实现的 save/load、adoption runtime、restart fixture 与 smoke gate。

## 1. 目标

- 提供 `browser_orchestrate` 重启诊断、人工排障与显式 adoption 的最小状态文件。
- 保存 redacted Desired、binding metadata 与 resource fingerprints，帮助判断旧 tab/window/profile 是否仍可能属于某个 orchestration。
- 默认不恢复 watch，不执行 cleanup，不关闭 tab/window，不重新安装 hook/network。

## 2. 默认路径与隐私分类

默认状态文件：`.pi/browser-artifacts/orchestration-state/state.v1.json`。

隐私分类：

```json
{
  "classification": "local_redacted_orchestration_state",
  "localOnly": true,
  "redaction": "required",
  "cleanup": "rm -rf .pi/browser-artifacts/orchestration-state"
}
```

该文件和普通 artifact 一样只保留在本地，不上传、不提交。需要清理时删除 `.pi/browser-artifacts/orchestration-state/`；删除后 driver 回到纯内存 store。

## 3. State schema

顶层文件：

```ts
type OrchestrationPersistedStateFile = {
  schemaVersion: "pi.browser.orchestration.state/v1";
  createdAt: number;
  updatedAt: number;
  driverRunId: string;
  piSessionId: string;
  mode: "diagnostic" | "adoption_pending" | "adopted_current";
  privacy: {
    classification: "local_redacted_orchestration_state";
    localOnly: true;
    redaction: "required";
    cleanup: string;
  };
  orchestrations: OrchestrationPersistedRecord[];
};
```

每个 orchestration record 保存：

- `orchestrationId/generation/desiredHash/createdAt/updatedAt/deletedAt`
- `redactedDesired`：使用现有 `redactDesired()` 输出；cookie 只保留 `valueHash/valueLength/valuePresent`。
- `bindings`：`sessionTag/tabRole/browserId/tabId/windowId/groupId/owned/createdByOrchestrator/desiredUrl`、network/hook/pre-navigation registration metadata。
- `cookies`：`key/name/origin/action/domain/path/storeId/partitionKeyHash/valueHash/valuePresent`。
- `fingerprints`：`browserId/tabId/windowId/profileId/origin/url/desiredUrl/workerBootId/networkConfigHash/hookFingerprint/preNavigationHookHashes/cookieKeys/owned/createdByOrchestrator`。
- `status/readOnly/adoptionRequired/adoptedAt`。

## 4. 禁止落盘字段

持久化文件、summary、status 与 adoption diagnostic 均禁止写入：

- raw cookie value、`Set-Cookie`、Authorization secret、password、token、secret。
- HTTP/WebSocket raw body、postData、payload。
- 任意可执行 JavaScript 文本：`script`、`code`、`source`。
- 页面 DOM/HTML/text 全量内容；这些仍只能作为显式 artifact，并由 `browser_artifact` 默认脱敏读取。

Pre-navigation hook 只能保存 `hookId/version/hash/identifier/sessionKey/cdpSessionName/effectVerifiedAt/workerBootId` metadata；真实 bytes 继续来自 driver 内置 registry 和 sha256 校验。

## 5. driverRunId 与 piSessionId

- `driverRunId`：`BrowserBridgeServer` 进程内生成的一次性运行 ID；同一进程内可认为是 current memory owner。
- `piSessionId`：Pi session 级 ID；无法取得时写入显式 `unknown` 并按跨 session stale 处理。
- 只要 `driverRunId` 或 `piSessionId` 与当前运行不一致，加载状态必须标记为 `stale/readOnly/adoptionRequired`。

## 6. Startup load 规则

当前实现加载时遵守：

1. 只解析和校验 schema，不执行副作用。
2. 默认写入内存 stale view，供 `status` 展示。
3. 不启动 watch timer。
4. 不执行 cleanup、closeTab、closeWindow、network.stop、hook.uninstall、frame.removeNewDocumentScript。
5. 不把 stale binding 作为普通 target resolver 结果，除非 adoption 已完成。
6. schema 不兼容或校验失败时忽略该文件并返回 diagnostic；不得 best-effort cleanup。

## 7. Stale / adoption 状态机

状态：

- `current`：同 driverRunId 且同 piSessionId 的内存态；沿用现有 cleanup policy。
- `stale`：来自旧 driverRunId 或旧 piSessionId；只读展示。
- `read_only`：状态文件可读但不可托管；`apply/watch/delete` 不使用其中资源。
- `adoption_required`：有可展示 fingerprints，但必须显式 adoption 后才能托管。
- `adopted`：TODO231 adoption 成功后，重新 observe live resources 并写入当前 driverRunId/piSessionId。

未 adoption 的 stale resources：status visible，no watch，no cleanup，no close；契约关键字：status visible, no watch, no cleanup, no close。

## 8. Adoption policy runtime

TODO231 的显式 adoption 输入必须至少包含：

```json
{
  "enabled": true,
  "orchestrationId": "case-1",
  "resourceTypes": ["tab", "window", "networkRecorder", "hookDispatcher", "preNavigationHook", "cookie"],
  "verifyOrigins": ["https://app.example.test"],
  "verifyUrls": ["https://app.example.test/dashboard"],
  "requireOwnedFingerprint": true
}
```

Adoption 前必须重新 observe live resources，并校验：

- browserId/tabId/windowId/profileId 与 fingerprint 匹配。
- 当前 URL/origin 在 `verifyUrls/verifyOrigins` 内。
- owned/createdByOrchestrator 指纹满足 `requireOwnedFingerprint`。
- network/hook/pre-navigation registration 仍可通过 runtime status/CDP probe 验证。

任一 required resource 校验失败时 adoption 失败；不得 fallback 到 selected/latest tab。

## 9. OrchestrationStore 与 PersistentOrchestrationStore 边界

- `OrchestrationStore.ts` 继续只持有当前进程内存态，不直接读写文件。
- TODO231 新增 `PersistentOrchestrationStore.ts`，只负责 schema validate、atomic write、load stale view、redaction enforcement。
- `BrowserBridgeServer.ts` 只能在 lifecycle 边界调用 persistence adapter；不得把文件 I/O、adoption 决策或 cleanup 逻辑塞回 facade。
- `BrowserTargetResolver` 不解析 stale bindings；adopted 后才进入普通 store/binding 查询。

## 10. Atomic write 与失败策略

当前实现使用本项目 artifact atomic write 约定：写 temp、fsync/rename、失败保留旧文件。写入失败只产生 diagnostic，不影响当前内存 orchestration apply/status/delete。

## 11. 验收

TODO230 验收：

```bash
npm run check:orchestration-persistence
npm run check:token
npm run check:artifact
```

TODO231 验收另含 `npm run check`、`npm run check:lifecycle`、`npm run check:orchestration` 与 Edge isolated restart/adoption smoke artifact。已实现 runtime artifact：`.pi/browser-artifacts/smoke-orchestration-persistence-result.json`。

## 12. TODO231 实施结果

- `PersistentOrchestrationStore.ts` 已实现 redacted save/load、schema validate、atomic write 与 read-only stale load。
- `BrowserBridgeServer.ts` 在 startup/load 与 stop/save lifecycle 接入 persistence adapter；facade 不承载 adoption 决策。
- `BrowserOrchestrationCoordinator.ts` 在 `apply/watch/stop/delete` 上执行 read-only gate；`status` 只展示 stale state。
- Explicit adoption 成功前不启动 watch、不 cleanup、不 close；失败不 fallback 到 selected/latest tab。
- Contract 覆盖 redacted state、restart read-only status、adoption 失败不误关旧 tab、adoption 后 cleanup。
