# 架构与工程化设计改进执行合同

> Status: COMPLETE — archived. 7 个工作流已交付（distiller 注册化 `src/tools/summaries/registerBuiltinDistillers.ts`、lease/heartbeat 硬化、`src/driver/BrowserWaitSupervisor.ts`、`lefthook.yml`、`tsconfig.base.json`、`docs/driver-architecture.md` 等，见 CHANGELOG）；工程化收口已归档（见 `ARCHIVE.md`）。
> 本文中的 capability profile 边界是执行当时的历史约束；后续 agent-native architecture B1 已移除 profile，当前 22 个工具 always-on。
> 本文取代 `.plan/architecture-design-improvements.md` 作为唯一执行合同；`.plan/...` 仅保留为讨论输入，不再直接作为执行源。

## 目标

在不扩公开 `browser_*` 工具面、不恢复 orchestration / target resolver 的前提下，完成以下 7 个工作流：

1. distiller 注册化与 fallback 摘要分发收口
2. tab 选择态 / 租约态 / 队列态复合不变量前置断言
3. 租约 TTL、断连清理与 UI lock 生命周期硬化
4. wait supervisor 超时预算硬化
5. protocol sync pre-commit hook 机制化
6. contracts 分目录与关键状态机单测扩面
7. `tsconfig.base.json` 与 driver 架构依赖矩阵文档

以上 7 项全部为必做项；允许拆阶段执行，不允许因为工作量大删项、降级为“只做高优先级”或长期挂起尾项。

## 行为边界

默认保持以下外部面稳定：

- 公开 `browser_*` 工具名、参数名、detail envelope 主形状
- 三层分层与当时的 capability profile 语义（历史约束；当前 profile 已移除）
- `browser_execute` / `browser_command` / `browser_observe` 的既有职责边界

允许的可观察变化仅限：

1. stale explicit lease / UI lock 会被 TTL 或 disconnect 清理
2. write-path 复合状态不一致会更早显式失败，而不是延迟到更深层冲突
3. wait 的总超时预算收紧，减少超过 deadline 的漂移
4. 若最终证明必须新增错误码，必须同批完成 protocol/schema/generated docs/contracts 同步

除上述范围外，不主动引入新的行为漂移。

## 非目标

- 不重构三层总架构，不把本批工作扩成新一轮结构性拆仓
- 不新增公开 `browser_*` 工具
- 不恢复自动选 tab / 自动选 observe mode / 自动串联 workflow
- 不削弱当时的 Web Security capability profile 或引入任务/风险分类器（历史约束；当前 profile 已移除，Web Security always-on）
- 不对 generated files 做无边界清理
- 不把 helper / test / docs 收口扩成全仓风格统一运动
- 不把原计划中“可选增强”扩成新的阻塞大项；本合同仅覆盖 7 个主工作流

## 执行顺序与依赖

### W0. 执行入口收口（先做）

范围：

- `docs/architecture-design-improvements-plan.md` 作为正式执行合同
- `CURRENT.md` / `TODO.md` 记录当前激活计划入口

要求：

- 后续实现、评审、归档一律引用本文
- `.plan/architecture-design-improvements.md` 不再被当作 source of truth

### W1. distiller 注册化与 fallback 摘要分发收口

核查结论：

- `src/tools/resultMiddleware.ts` 仍用中心化 `if` 链按 `toolName` / `command` 字符串分发摘要器
- 仓库内已存在大量调用点级 `distill`（如 `src/tools/registerEvidenceTool.ts`、`src/tools/toolAdapter.ts`、`src/tools/webSecurity/register/*.ts`）
- `tests/contracts/check-summaries.mjs` 会直接 import `src/tools/resultMiddleware.ts`；因此 distiller 初始化不能只依赖 `registerBrowserTools()` 的副作用

实施项：

1. 在 `src/tools/resultMiddleware.ts` 增加注册表 API：
   - `registerDistiller(toolName, distiller)`
   - `registerCommandDistiller(match, distiller)`
   - `distillValue(toolName, command, value)` 保持现有签名
2. 抽出 `unwrapData(value)` 一类公共 helper，消除 `isRecord(value) && value.data !== undefined ? value.data : value` 重复
3. 新增内建 distiller 注册模块，例如：
   - `src/tools/summaries/registerBuiltinDistillers.ts`
4. 用注册表重写当前 fallback 分发，仅覆盖现在确实走中心分发的 4 组规则：
   - `browser_evidence` / `evidence.collect`
   - `browser_network` / `network.*`
   - `browser_hook` + DOM-flow 相关命令
   - `ws.*`
5. 增加显式初始化保障，避免 load-order 脆弱性：
   - `registerBrowserTools()` 显式调用 `registerBuiltinDistillers()`
   - `resultMiddleware.ts` 内部增加一次性 `ensureBuiltinDistillersRegistered()`，保证 direct-import contracts 也能拿到完整注册
6. 兼容 `RunBrowserToolSpec.distill`：调用点显式 `distill` 优先；central fallback 只负责没有调用点定制摘要的路径
7. 新增 contract：`tests/contracts/drift/check-distiller-coverage.mjs`
   - 只校验“当前依赖 central fallback 的工具/命令”全部被注册表覆盖
   - 显式调用点级 `distill` 路径不强制进入 fallback 白名单
8. 删除 `resultMiddleware.ts` 中现有硬编码 `if` 链

影响文件：

- `src/tools/resultMiddleware.ts`
- `src/tools/summaries/index.ts`
- `src/tools/summaries/registerBuiltinDistillers.ts`（新增）
- `src/tools/registerTools.ts`
- `tests/contracts/drift/check-distiller-coverage.mjs`（新增）
- `package.json`（如需纳入现有检查脚本）

验证：

- `npm run check:summaries`
- `npm run check:tools`
- `npm run test:unit`
- `npm run check`

完成标准：

- fallback 摘要分发不再依赖中心化 `if` 链
- direct-import contract 与正常 runtime 都能稳定拿到内建 distiller
- 新增 fallback 路径时，忘记注册会在 contract 阶段失败，而不是静默退回 generic

### W2. tab 三套状态机复合不变量前置断言

核查结论：

- 一个 tab 的关键状态分散在：
  - `BrowserTabSessionRouter`：选择态
  - `BrowserLeaseRegistry`：租约态
  - `BrowserCommandQueueRegistry`：write 串行队列态
- 三者在 `src/driver/BrowserBridgeCommandService.ts#sendPayload()` 的 write 分支交汇，但缺少统一复合前置断言

实施项：

1. `BrowserLeaseRegistry` 增加只读查询能力：
   - `peekTabLease(tab)` 或等价 API
2. `BrowserBridgeCommandService` 新增 `assertWriteInvariants()`，在 write 分支入队前执行，至少覆盖：
   - foreign-session lease conflict 纵深防御
   - 目标 `browserSessionId` / `tab` 一致性
   - 选择态版本信息与 target diagnostics 的可见性
3. 为避免“入队前已检查、真正 dispatch 前状态又变化”的窗口，queued closure 内也要做最小一致性复核或 lease touch
4. 将合法组合写入文档：
   - read：不入队、不要求租约，可走 fallback target
   - write：必须入队；显式租约或 auto lease 的 owner 必须与 browser session 一致
   - pending switch 期间隐式 target 仍以 dispatch 时捕获的选择态为准
5. 正常路径复用现有错误码；断言失败优先复用 `TAB_LEASE_CONFLICT` / 既有 coded error，并附更多 diagnostics，而不是引入新的临时错误口径

影响文件：

- `src/driver/BrowserBridgeCommandService.ts`
- `src/driver/BrowserLeaseRegistry.ts`
- `docs/driver-architecture.md`（W7 同批补文档）
- 对应单测 / contract

验证：

- `npm run test:unit`
- `npm run check:fake-ws`
- `npm run check:lifecycle`
- `npm run check:bridge`

完成标准：

- write-path 复合不一致在单一 dispatch 入口被显式发现
- 正常路径不改变现有 smoke / lifecycle 行为
- 断言失败具备足够 target/lease/selection diagnostics

### W3. 租约 TTL、断连清理与 UI lock 生命周期硬化

核查结论：

- `BrowserLeaseRegistry` 当前无 TTL / sweep / disconnect cleanup
- `BrowserTabLeaseInfo` / `BrowserUiLockInfo` 已有 `createdAt` / `lastSeenAt`，但未用于生命周期治理
- disconnect 事件拿到的是 `ws` / disconnected tab sessions，不是“browser session 持有者崩溃”的直接句柄；因此清理设计必须按断开的 tab session / 受影响 browser session 落地，不能只写 `releaseAllForSession(browserSessionId)`

实施项：

1. 在 `BrowserLeaseRegistry` 增加生命周期 API：
   - `peekTabLease(...)`
   - `touchTabLease(...)`
   - `sweepExpired(now)`
   - `releaseLeasesForTabSessions(tabSessionIds: string[])`
   - `releaseUiLocksForBrowserSessions(browserSessionIds: string[])` 或等价最小 API
2. 引入 TTL 常量：
   - tab lease 默认 30min
   - UI lock 默认 5min
3. 活跃租约刷新规则：
   - reentrant `leaseTab()` 继续刷新 `lastSeenAt`
   - 同 session 对已 leased tab 的 read/write 命中时刷新 `lastSeenAt`
4. disconnect cleanup：
   - 在 `BrowserBridgeClientMessageService.unregisterClient()` 或 `BrowserBridgeServer.unregisterClient()` 串起清理
   - 先收集断开的 `tabSessionIds` 与受影响 `browserSessionIds`
   - 再释放相关 lease / UI lock
5. 周期 sweep：
   - 复用 heartbeat 周期或并列 maintenance tick
   - `sweepExpired(now)` 内保持可测；`now` 从调用方传入
6. 清理必须有结构化可观测性：
   - 至少 `console.warn` + reason=`ttl|disconnect`
   - 如后续接入统一 diagnostics，也必须保留相同事实字段
7. 默认不新增新的公开错误码；只有当实现证明复用现有码无法表达语义时，才允许新增，并必须同批完成 schema / generated docs / contracts / checks 同步

影响文件：

- `src/driver/BrowserLeaseRegistry.ts`
- `src/driver/BrowserBridgeClientMessageService.ts`
- `src/driver/BrowserBridgeServer.ts`
- `src/driver/BrowserBridgeClientHeartbeat.ts`（若复用 heartbeat tick）
- `tests/unit/driver/BrowserLeaseRegistry.test.ts`
- 相关 lifecycle/fake-ws contracts

验证：

- `npm run test:unit`
- `npm run check:fake-ws`
- `npm run check:lifecycle`
- `npm run check:bridge`
- `npm run check`

完成标准：

- explicit lease / UI lock 不会在 disconnect/crash 后永久残留
- 活跃 lease 不被 TTL 误清
- 清理路径有明确 reason 和受影响对象诊断

### W4. wait supervisor 超时预算硬化

核查结论：

- `src/driver/BrowserWaitSupervisor.ts` 里的固定 3000ms 不是 reconnect grace，而是 per-attempt bridge grace：`WAIT_LEASE_BRIDGE_GRACE_MS`
- `waitForReconnect()` 已按剩余时间裁剪上限，但仍有 `Math.max(250, ...)` 下限，会在剩余预算极小时产生超 deadline 等待
- 因此要修的是：
  - per-attempt bridge grace 动态化
  - reconnect budget 不得超过剩余 deadline

实施项：

1. 在 `BrowserWaitSupervisor.ts` 增加预算 helper：
   - `computeBridgeGraceMs(remainingMs)`
   - `computeReconnectBudgetMs(remainingMs)`
2. 将以下固定 3000ms 路径改为按剩余 deadline 计算的动态 budget：
   - leased wait `server.sendCommand(... timeoutMs: leaseMs + grace)`
   - zero-timeout immediate probe 的 bridge grace
   - `wait.navigateAndWait` 的导航阶段 bridge grace
3. 调整 `waitForReconnect()`：
   - 不得因为固定下限导致等待超过剩余 deadline
   - 允许保留极小的 transport floor，但该 floor 也必须受剩余预算约束
4. 单测覆盖：
   - `remainingMs = 2_000` 时 bridge grace / reconnect budget 明显小于旧固定值
   - `remainingMs = 30_000` 时仍可给满上限
   - disconnect → reconnect / late_success / worker restart 等现有 supervisor 行为保持可验证
5. 若需要保留常量，只保留“上限 cap”，不再把固定值直接当作所有 attempt 的实际预算

影响文件：

- `src/driver/BrowserWaitSupervisor.ts`
- `tests/unit/driver/BrowserWaitSupervisor.test.ts`（新增）
- 相关 fake-ws / lifecycle contracts

验证：

- `npm run test:unit`
- `npm run check:fake-ws`
- `npm run check:lifecycle`
- `npm run check:bridge`

完成标准：

- wait 总 wall-clock 不再因固定 3000ms / 250ms floor 明显超出 deadline
- supervisor 的 restart/disconnect/retry 行为保持既有契约

### W5. protocol sync pre-commit hook 机制化

核查结论：

- `bridge/native_command_schema.json` 是协议单源
- 当前同步依赖人工执行 `npm run sync:protocol`
- CI 已有 `check:protocol` 兜底，但只能事后发现 drift

实施项：

1. 引入 `lefthook` 作为 devDependency
2. 在 `package.json` 增加 `prepare` 安装 hook
3. 新增 `lefthook.yml`，当 `bridge/native_command_schema.json` 改动时自动执行：
   - `npm run sync:protocol`
   - `git add` 生成产物：
     - `bridge/pi_browser_bridge/native_command_schema.json`
     - `bridge_src/service_worker/protocol.ts`
     - `src/protocol/nativeProtocol.ts`
     - `src/protocol/nativeActionMetadata.ts`
     - `src/protocol/nativeErrorCodes.ts`
     - `docs/generated/native-protocol.generated.md`
4. 保留 CI 侧 `check:protocol` 不变，hook 只做本地提前纠偏，不替代 CI
5. 原计划中“同样可加 docs:generate”保持为可选增强，不单列为本合同的独立阻塞项；若同批实现，不得削弱 protocol hook 主路径

影响文件：

- `package.json`
- `lefthook.yml`（新增）
- 如有必要的安装说明文档

验证：

- 本地修改 schema 后执行普通 commit，生成产物会被自动 stage
- `git commit --no-verify` 绕过 hook 后，`npm run check:protocol` 仍能拦截 drift
- `npm run check:protocol`

完成标准：

- schema drift 不再依赖开发者手动记忆
- Windows/CI 环境都不引入新的提交流程断点

### W6. contracts 分目录与关键状态机单测扩面

核查结论：

- `tests/contracts/` 目前平铺，维护入口弱
- 关键状态机更多依赖 contract/integration 测试，focused unit coverage 不足
- 本工作流必须覆盖“目录治理 + 单测补齐”两部分，不能只做其中一半

实施项：

1. 重组 `tests/contracts/` 目录：
   - `tests/contracts/protocol/`
   - `tests/contracts/tools/`
   - `tests/contracts/runtime/`
   - `tests/contracts/drift/`
2. 迁移现有 `.mjs` 文件到对应目录，保持脚本名稳定，不改 contract 语义
3. 同步更新硬编码路径：
   - `package.json`
   - `scripts/run-check-groups.mjs`
   - 其他直接引用 contract 路径的测试/脚本/文档
4. 新增/扩充单测：
   - `BrowserWaitSupervisor.test.ts`
   - `BrowserLeaseRegistry.test.ts`
   - `BrowserTabSessionRouter.test.ts`
   - 如 W2/W3 落地需要，再补 `BrowserBridgeCommandService` focused unit test
5. 将 W1 新增的 `check-distiller-coverage.mjs` 放入新目录结构中
6. 先完成 W1-W4 代码，再做目录搬迁，避免在功能变更期间反复 churn 路径

建议分组：

- `protocol/`：schema / metadata / error code / generated drift
- `tools/`：tool contract / summaries / execute / docs / registry drift
- `runtime/`：fake-ws / lifecycle / page-scripts / content-pick / browser-command flows
- `drift/`：boundaries / doc-structure / distiller coverage / maintainer drift 类检查

影响文件：

- `tests/contracts/**`
- `tests/unit/driver/**`
- `package.json`
- `scripts/run-check-groups.mjs`

验证：

- `npm run test:unit`
- `npm run check:all:contracts`
- `npm run check:bridge`
- `npm run check`

完成标准：

- contract 目录结构可按领域导航
- 关键状态机具备 focused unit coverage
- 现有 check 命令名保持稳定

### W7. `tsconfig.base.json` 与 driver 架构依赖矩阵文档

核查结论：

- `tsconfig.json` / `tsconfig.build.json` / `tsconfig.bridge-src.json` 有重复 compilerOptions
- `BrowserBridgeServer` facade 的 service / registry 依赖关系只能从实现反推

实施项：

1. 新增 `tsconfig.base.json`，收口公共 `compilerOptions`
2. 更新以下 3 个配置使用 `extends`：
   - `tsconfig.json`
   - `tsconfig.build.json`
   - `tsconfig.bridge-src.json`
3. 仅保留各自差异项：
   - `module` / `moduleResolution`
   - `lib`
   - `include` / `exclude`
   - `noEmit` / `outDir` / `declaration*` 等
4. 新增 `docs/driver-architecture.md`，至少包含：
   - `BrowserBridgeServer` facade → service / registry 依赖矩阵
   - `BrowserBridgeCommandService` / `BrowserBridgeClientMessageService` / `BrowserLeaseRegistry` / `BrowserTabSessionRouter` 的职责边界
   - tab 选择态 / 租约态 / 队列态合法组合表
   - heartbeat / lease sweep / disconnect cleanup 维护回路
5. 若文档入口结构受影响，再运行 `npm run docs:sync-indexes`

影响文件：

- `tsconfig.base.json`（新增）
- `tsconfig.json`
- `tsconfig.build.json`
- `tsconfig.bridge-src.json`
- `docs/driver-architecture.md`（新增）

验证：

- `npm run build`
- `npm run check:src:types`
- `npm run check:bridge:types`
- `npm run check`

完成标准：

- 3 个 tsconfig 的公共配置只保留一份
- driver 依赖关系与状态机边界有稳定维护文档

## 并行规则

允许并行：

- W1 与 W5 可独立推进
- W2 / W3 / W4 可由不同人并行，但合并前必须统一在同一轮 runtime 回归里验证
- W7 可与 W6 的后半段并行

禁止并行的组合：

- 在 W1 尚未稳定前直接搬迁 distiller 相关 contract 路径
- 在 W2/W3 仍频繁改 driver 文件时先做 W6 的大规模测试路径搬迁

## 验证策略

### 窄门回归（按工作流执行）

- W1：`npm run check:summaries && npm run check:tools`
- W2/W3/W4：`npm run test:unit && npm run check:fake-ws && npm run check:lifecycle && npm run check:bridge`
- W5：`npm run check:protocol`
- W6：`npm run test:unit && npm run check:all:contracts`
- W7：`npm run build && npm run check:src:types && npm run check:bridge:types`

### 最终全量门禁

- `npm run check`
- `npm run quality:local`

### 有浏览器 runtime 时的补充 smoke

若本地已连接真实浏览器，最终收口前补跑最小 smoke：

- `npm run smoke:browser:intercept-lease-conflict`
- `npm run smoke:browser:correlation-chain`

若环境不可用，可不阻塞本合同合并，但必须在总结中明确说明未执行原因。

## 文档与索引同步要求

实现阶段至少同步：

- `CURRENT.md`
- `TODO.md`
- `CHANGELOG.md`

按变更范围补同步：

- `docs/generated/native-protocol.generated.md`（W5 或任何新增错误码/协议变更）
- `docs/driver-architecture.md`（W2/W3/W7）
- `docs/maintainer-map.md`（若 hook / tsconfig / driver 维护入口发生明显变化）
- `README.md`（若需要记录 contributor workflow 变更）

若文档结构索引块受影响，再执行：

- `npm run docs:sync-indexes`

## 最终验收标准

只有同时满足以下条件，才算本合同完成：

1. 7 个主工作流全部落地，无长期 deferred 尾项
2. `resultMiddleware` 的 fallback 摘要分发已注册化，并有 coverage contract
3. write-path 复合不变量已在统一 dispatch 入口显式断言
4. lease / UI lock 已具备 TTL + disconnect cleanup + 可观测性
5. wait supervisor 不再因固定 bridge/reconnect grace 明显超 deadline
6. protocol sync 已由 pre-commit hook 机制化，CI 兜底保留
7. contracts 完成分目录，关键状态机单测补齐
8. tsconfig 公共配置已抽到 base，driver 架构矩阵文档已落地
9. `npm run quality:local` 通过

## 收尾与归档

完成后：

1. 将 `CURRENT.md` 中该执行项改为已完成摘要
2. 结果迁入 `ARCHIVE.md` / `docs/archive/*`（按项目现有结构）
3. 在 `ROADMAP.md` 中仅保留后续未完成延伸项，不保留本合同执行日志
