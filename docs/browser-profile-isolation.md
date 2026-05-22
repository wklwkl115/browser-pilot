# Browser Profile / Incognito Isolation

本文记录 profile-first 物理隔离的当前运行边界。当前状态：TODO232 设计已落档，TODO233 runtime 已实现；`browser_orchestrate` 已接受显式 `isolation.scope:"profile"`，由 `BrowserProfileManager.ts` 创建和清理 managed profile。Incognito 仍是 Incognito opt-in diagnostic，不进入默认 gate。

## 1. 当前能力

- 使用 managed browser profile 提供物理隔离：独立 `--user-data-dir`、临时 extension copy、独立 bridge port、driver-owned browser process。
- `BrowserProfileManager.ts` 负责 create/start/connect/observe/stop/delete；orchestrator 只调用 driver facade，不直接拼 Chrome 参数。
- 默认隔离仍是 logical；profile scope 必须显式声明为 `isolation.scope:"profile"`。
- 每个 managed profile 持有 `profileId/profileDir/extensionDir/bridgePort/debugPort/browserId/browserExtensionId/processId/owned/cleanup` metadata。
- 删除 orchestration 时只停止 driver-owned browser process 并清理 owned `profileDir/extensionDir`；不会关闭用户已有 Chrome/Edge。
- `PI_BROWSER_PROFILE_CHROME` 可指定 managed profile 使用的 Chrome/Edge；未设置时回退 `PI_BROWSER_SMOKE_CHROME` 与常见 Chrome/Edge 路径。

## 2. 非目标

- 不接管用户个人 profile，不接受 Desired 传入任意 `profileDir/extensionDir`，避免误删用户数据。
- 不用 incognito 替代 managed profile；incognito 授权依赖用户浏览器设置，不能作为稳定主干隔离边界。
- 不把 `target` / `profileId` 写入 native command schema；Node driver 解析后只向 bridge 发送最终 `tabId`。
- 不把 incognito 放入 `npm run check`、`quality:local`、`smoke:browser:isolated` 或 `release:local:smoke` 默认 gate。

## 3. Runtime lifecycle

1. `create`：校验 extension source，生成 safe `profileId`，分配 `profileDir`、`extensionDir`、`bridgePort`、`debugPort`。
2. `patch`：复制解包扩展，patch dist service worker bridge port，并注入 `PI_BROWSER_MANAGED_PROFILE_B64` metadata。
3. `start`：spawn Chrome/Edge，参数包含 `--user-data-dir=<profileDir>`、`--disable-extensions-except=<extensionDir>`、`--load-extension=<extensionDir>`、`--remote-debugging-port=<debugPort>`。
4. `connect`：等待 extension client 在独立 bridge port 连接，绑定 `profileId -> browserId/browserExtensionId/processId`。
5. `observe`：`ActualStateCollector` 只采集目标 profile 的 clients/tabs/cookies；`BrowserTargetResolver` 用 `profileId` 过滤 profile-bound orchestration target。
6. `stop/delete`：先清理 recorder/hook/tab/window，再执行 `stopProfile`；失败诊断包含 redacted profile/port/process metadata。

## 4. Desired schema

当前 runtime 支持：

```ts
type BrowserOrchestrationDesired = {
  isolation?: {
    scope?: "logical" | "browser" | "profile";
    ownedTabsOnly?: boolean;
    closeOwnedTabsOnDelete?: boolean;
    profile?: {
      profileId?: string;
      lifecycle?: "managed";
      reuse?: "none" | "owned";
      cleanup?: "delete" | "keepOnFailure";
    };
  };
};
```

规则：

- `scope:"profile"` 必须同时提供 `isolation.profile.profileId`。
- `profile.lifecycle` 只允许 `managed`。
- `profileId` 是逻辑 id，不是文件路径；实际本地目录由 driver 生成。
- `reuse:"owned"` 只复用当前 driver metadata 中仍存活且 owned 的 profile；`reuse:"none"` 会重建。
- `cleanup:"delete"` 默认删除临时目录；`keepOnFailure` 仅用于失败诊断。

## 5. Cookie/storage 隔离验证

TODO233 smoke 启动 managed profiles A/B，并在同一 fixture origin 上验证 cookie/localStorage/sessionStorage：

- A 设置 cookie/localStorage/sessionStorage 后，B 读取不到。
- A/B 可设置同名 cookie，值互不覆盖。
- 删除 A 后 B 仍可通过 profile-bound target 读取自己的 storage。
- 删除 B 后两个 owned process 均退出，临时 profile/extension 被清理。
- artifact 只保存 hash/presence 与 cleanup metadata，不保存 raw cookie/storage value。

Artifact：`.pi/browser-artifacts/profile-isolation/profile-isolation-result.json`，隐私分类 `local_redacted_profile_isolation`。

## 6. Smoke / release gate

- `npm run check:profile-isolation`：锁定 normalization、manager/server/resolver/router/reconcile/config/docs/skill 契约。
- `npm run smoke:browser:isolated`：full smoke 会运行 profile A/B cookie/localStorage/sessionStorage 隔离；minimal/rollback smoke 可跳过。
- `npm run release:local:smoke`：当前解包扩展执行 full isolated smoke，并在 diagnostics 中上浮 `profileIsolation`；上一包 rollback smoke 保持 minimal。
- Incognito 不进入默认 gate；默认 launch 参数禁止 `--incognito`。

## 7. Incognito opt-in diagnostic

Incognito 只作为显式 probe：

1. 检查扩展是否允许无痕运行（例如 `chrome.extension.isAllowedIncognitoAccess` 或等价 runtime diagnostic）。
2. 未授权时返回 `INCOGNITO_NOT_ALLOWED`，包含操作提示与 `retryable:false`，不创建 incognito window。
3. 已授权且用户显式请求时，创建 owned incognito window，执行最小 cookie/storage probe，然后关闭该 owned window。
4. probe artifact 不进入默认 gate。

禁止默认添加 `--incognito`，禁止把 incognito 失败标记为主干 runtime 失败。

## 8. 错误 taxonomy

- `PROFILE_MANAGER_UNAVAILABLE`：无法定位 Chrome/Edge 或 profile manager 未启用。
- `PROFILE_START_FAILED`：owned browser process 或临时扩展启动失败。
- `PROFILE_CONNECT_TIMEOUT`：extension 未在 profile bridge port 上连接。
- `PROFILE_STORAGE_LEAK`：cookie/storage 隔离验证失败。
- `PROFILE_CLEANUP_FAILED`：owned process 或临时目录清理失败。
- `INCOGNITO_NOT_ALLOWED`：扩展未获无痕运行授权。
- `INCOGNITO_PROBE_FAILED`：显式 incognito probe 运行失败。

## 9. 回滚边界

如 profile runtime 出现跨平台进程清理、端口、Chrome path 或 storage leak 问题，回滚方式是禁用 `isolation.scope:"profile"`，保留 logical/browser/window/tabGroups/persistence 能力；不得恢复为接管用户个人 profile 或默认 incognito。
