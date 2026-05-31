# 架构与工程化设计改进方案

> 范围：driver 状态层、tools 工具层、运行时健壮性、工程化机制的精修。
> 性质：本项目无结构性缺陷（三层分层清晰、零循环依赖、协议单一来源、契约测试驱动）。
> 以下改进全部是"加防护、提对称、转机制"性质，**不改变外部行为**。
> 与 [`tool-layer-unification.md`](./tool-layer-unification.md) 互补：该方案统一工具执行壳，本方案处理其未覆盖的状态机、摘要分发、租约生命周期与工程纪律。

---

## 优先级总览

| 优先级 | 改进点 | 性质 | 影响文件 | 依赖 |
|--------|--------|------|---------|------|
| 🔴 P0 | distiller 注册化，消除硬编码字符串分发 | 扩展性/正确性 | `resultMiddleware.ts`, `summaries/` | 可独立做；与 unification 的 `spec.distill` 衔接 |
| 🔴 P0 | tab 三套状态机加复合不变量前置断言 | 正确性 | `BrowserBridgeCommandService.ts`, `BrowserLeaseRegistry.ts` | 独立 |
| 🟡 P1 | 租约 TTL + 心跳清理 | 健壮性/资源 | `BrowserLeaseRegistry.ts`, heartbeat | 独立 |
| 🟡 P1 | 协议同步 pre-commit hook | 工程纪律→机制 | `.husky/` 或 `lefthook.yml`, `package.json` | 独立 |
| 🟡 P1 | wait 重连宽限期动态化 | 健壮性 | `BrowserWaitSupervisor.ts` | 独立 |
| 🟢 P2 | 契约测试分目录 + 关键状态机补单测 | 可维护性 | `tests/contracts/`, `tests/unit/` | 独立 |
| 🟢 P2 | tsconfig 抽 base + Facade 依赖矩阵文档 | 整洁度 | `tsconfig*.json`, `docs/` | 独立 |

每项完成后运行 `npm run quality:local` 验证。各项之间无强耦合，可并行推进。

---

## P0-1. distiller 注册化

### 问题诊断

`src/tools/resultMiddleware.ts:11-17` 用工具名/命令名字符串做 `if` 链分发摘要器：

```ts
export function distillValue(toolName, command, value) {
  if (toolName === "browser_evidence" || command === "evidence.collect") return summarizeEvidenceData(...);
  if (toolName === "browser_network" || String(command||"").startsWith("network.")) return summarizeNetworkData(...);
  if (toolName === "browser_hook" && ["hook.getNodeListeners",...].includes(...)) return summarizeDomFlowData(...);
  if (String(command||"").startsWith("ws.")) return summarizeWsSessionData(...);
  return summarizeGenericValue(value);
}
```

**核心矛盾**：工具注册是优雅的声明式 registrar 数组（`toolRegistry.ts` → `resolveBrowserToolRegistrars`），摘要分发却是**中心化的命令式字符串匹配**——抽象不对称。

**后果：**
1. 新增工具要在两个不相关的地方改代码（注册 + 这里）。
2. 字符串拼写错误不报错，静默落到 `summarizeGenericValue`，输出降级且无告警。
3. `distillValue` 随工具增长持续膨胀，成为隐性"上帝函数"。

**已就绪的基础设施**：`resultMiddleware.ts:271` 已支持 per-call 覆盖：
```ts
const summary = options.distill ? options.distill(value) : distillValue(options.toolName, options.command, value);
```
即每个工具本就可以传 `distill`。缺的是：把这个"可选覆盖"升级为"注册时声明"，并让中心兜底变成**注册表查找**而非硬编码 `if` 链。

### 目标设计

```ts
// resultMiddleware.ts —— 注册表 + 兜底
type Distiller = (value: unknown, command?: string) => Record<string, unknown>;

const distillerRegistry = new Map<string, Distiller>();        // 按 toolName
const commandDistillerRules: Array<{ match: (cmd: string) => boolean; distiller: Distiller }> = [];

export function registerDistiller(toolName: string, distiller: Distiller): void {
  distillerRegistry.set(toolName, distiller);
}
export function registerCommandDistiller(match: (cmd: string) => boolean, distiller: Distiller): void {
  commandDistillerRules.push({ match, distiller });
}

export function distillValue(toolName: string, command: string | undefined, value: unknown) {
  const byTool = distillerRegistry.get(toolName);
  if (byTool) return byTool(value, command);
  const cmd = String(command || "");
  for (const rule of commandDistillerRules) if (rule.match(cmd)) return rule.distiller(value, cmd);
  return summarizeGenericValue(value);
}
```

> `network.` / `ws.` 这类按命令前缀的分发用 `registerCommandDistiller`，`browser_evidence` 这类按工具名的用 `registerDistiller`。两者覆盖现有全部 4 条分支。

### 实施步骤

1. **新增注册表 API**（上述），保留 `distillValue` 签名不变（向后兼容）。
2. **集中注册**：在 `summaries/index.ts` 或新建 `summaries/register.ts` 中，把现有 4 条分支翻译成注册调用：
   ```ts
   registerDistiller("browser_evidence", (v) => summarizeEvidenceData(unwrapData(v)));
   registerCommandDistiller((c) => c === "evidence.collect", ...);
   registerDistiller("browser_network", (v) => summarizeNetworkData(unwrapData(v)));
   registerCommandDistiller((c) => c.startsWith("network."), ...);
   registerDistiller("browser_hook", (v, c) => DOM_FLOW_CMDS.includes(c!) ? summarizeDomFlowData(c!, v) : summarizeGenericValue(v));
   registerCommandDistiller((c) => c.startsWith("ws."), (v, c) => summarizeWsSessionData(c || "ws", unwrapData(v)));
   ```
   抽出 `unwrapData(v) = isRecord(v) && v.data !== undefined ? v.data : v`，消除现有重复。
3. **确保注册执行**：在 `registerBrowserTools`（`registerTools.ts:6`）入口处 import 该注册模块，保证副作用执行（或显式调用 `registerBuiltinDistillers()`）。
4. **契约校验**（新增 `tests/contracts/check-distiller-coverage.mjs`）：遍历所有已注册工具名，断言每个工具要么有 distiller，要么显式在白名单里声明用 generic。把"忘了写摘要器"从运行时静默降级变成构建期失败。
5. **与 unification 衔接**：`tool-layer-unification.md` 的 `RunBrowserToolSpec.distill` 字段，迁移工具时直接 `registerDistiller(spec.toolName, spec.distill)`，无需再碰中心函数。

### 验证
- 所有工具的 summary 输出逐一对比迁移前后一致（smoke + contracts）。
- 新契约测试通过。

### 风险
| 风险 | 缓解 |
|------|------|
| 注册模块未被 import，副作用未执行 → 全部降级 generic | 契约测试覆盖率检查会立即捕获；在 registerTools 入口显式调用 |
| 命令前缀规则顺序敏感 | 现有 4 条分支无重叠，保持登记顺序即可；契约测试可加冲突检测 |

---

## P0-2. tab 三套状态机复合不变量

### 问题诊断

一个 tab 的状态分散在三处，各自职责单一、独立看都很干净：

| 状态 | 持有者 | 说明 |
|------|--------|------|
| 选择态 | `BrowserTabSessionRouter` (262 行) | 会 mutate session 的 default/latest |
| 租约态 | `BrowserLeaseRegistry` | `tabLeases: Map`，write 操作占用 |
| 队列态 | `BrowserCommandQueueRegistry` | per-(session,tab) write 串行化 |

**核心矛盾**：三者交汇于唯一一点——`BrowserBridgeCommandService.sendPayload`（write 分支：`queues.enqueue → leases.withAutoTabLease → pendingRequests.send`），**但该交汇点没有任何前置断言校验复合一致性**。正确性目前完全靠调用约定保证，而非类型或运行时断言。

一个 tab 可能处于这些组合中的任意一种，且无单点校验：未租约 + 隐式选择 / 显式租约 / 入队中 / 选择态与租约 session 不一致。

### 目标设计

在交汇点 `BrowserBridgeCommandService` 增加**显式前置条件**与**状态图文档**，不改变状态分布，只增加防护。

```ts
// BrowserBridgeCommandService.sendPayload 中，write 分支入队前
private assertWriteInvariants(browserSessionId: string, tab: BrowserTabSession): void {
  const lease = this.leases.peekTabLease(tab);              // 新增只读查询，不创建
  if (lease && lease.browserSessionId !== browserSessionId) {
    // 本应已被 leaseTab 拦截；此处做纵深防御，命中即说明上游路由有 bug
    throw new BrowserBridgeError("TAB_LEASE_CONFLICT", "write target leased by another session (invariant)", { browserSessionId, lease });
  }
  // 可扩展：选择态与目标 tab 的一致性断言
}
```

### 实施步骤

1. **`BrowserLeaseRegistry` 增加只读查询**：`peekTabLease(tab): BrowserTabLeaseInfo | undefined`（不创建租约，仅查询），供断言使用。
2. **`sendPayload` write 分支**入队前调用 `assertWriteInvariants`，作为纵深防御（正常路径不应命中，命中即暴露上游路由 bug）。
3. **文档化合法状态组合**：在 `BrowserBridgeCommandService.ts` 顶部加一段注释或新建 `docs/tab-state-machine.md`，用一张表/状态图写清：
   - read 操作：不入队、不要求租约、可走 fallback 选择。
   - write 操作：必须入队 + 持有匹配租约（auto 或 explicit）。
   - 选择态 mutate 的时机与队列/租约的关系。
4. **单测**（见 P2）：构造跨 session 并发 write 同一 tab、选择态切换中途 write 等边界，断言 `TAB_LEASE_CONFLICT` / 串行化行为。

### 验证
- 现有 smoke 中的 `intercept-lease-conflict`、`correlation-chain` 等用例行为不变。
- 新增的不变量断言在正常路径零命中（不影响性能）。

### 风险
| 风险 | 缓解 |
|------|------|
| 断言误报阻断正常请求 | 断言只在 write 分支、且条件与 `leaseTab` 一致，逻辑等价；先以日志告警模式灰度，再升级为 throw |

---

## P1-1. 租约 TTL + 心跳清理

### 问题诊断

已核实 `BrowserLeaseRegistry`（`src/driver/BrowserLeaseRegistry.ts`）**无任何 TTL/expiry/定时清理**：
- `withAutoTabLease` 的 `finally` 能清理正常路径的 auto 租约。
- **显式租约（`explicit: true`）若持有方崩溃/断连，只能靠手动 `releaseTab` 或 server 重启 `clear()`**。
- UI 锁同理（`uiLock` 带 reentrant `count`，持有方崩溃则永久锁死）。

伏笔已埋好：`BrowserTabLeaseInfo` 和 `BrowserUiLockInfo` 都已有 `createdAt` 与 `lastSeenAt` 字段，但无人消费 `lastSeenAt` 做过期判定。

### 目标设计

基于现有心跳机制（`BrowserBridgeClientHeartbeat`）做 TTL 清理：

```ts
// BrowserLeaseRegistry 新增
private readonly leaseTtlMs: number;          // 默认 30 * 60_000
private readonly uiLockTtlMs: number;         // 默认 5 * 60_000（UI 锁应更短）

sweepExpired(now: number): { releasedLeases: BrowserTabLeaseInfo[]; releasedUiLock?: BrowserUiLockInfo } {
  const releasedLeases: BrowserTabLeaseInfo[] = [];
  for (const [key, lease] of this.tabLeases) {
    if (now - lease.lastSeenAt > this.leaseTtlMs) { this.tabLeases.delete(key); releasedLeases.push(lease); }
  }
  let releasedUiLock: BrowserUiLockInfo | undefined;
  if (this.uiLock && now - this.uiLock.lastSeenAt > this.uiLockTtlMs) { releasedUiLock = this.uiLock; this.uiLock = undefined; }
  return { releasedLeases, releasedUiLock };
}

// 客户端断连时主动释放该 session 的所有租约
releaseAllForSession(browserSessionId: string): BrowserTabLeaseInfo[] { ... }
```

### 实施步骤

1. **`lastSeenAt` 刷新**：确认 `leaseTab` 重入时已刷新（现状已做：`lastSeenAt: now`）。read/write 命中租约时也应刷新，使活跃租约不被误清。
2. **TTL 清理**：新增 `sweepExpired(now)`，由现有心跳/诊断定时器周期调用（与 `BrowserBridgeDiagnostics` 的快照节奏对齐）。`now` 由调用方传入（保持类可测、无 `Date.now()` 内部副作用以便单测）。
3. **断连即释放**：在 `BrowserBridgeClientRegistry` 检测到客户端断开时，调用 `releaseAllForSession`，比纯 TTL 更及时。
4. **可观测性**：清理时通过 `BrowserBridgeDiagnostics` 记一条结构化日志（释放了哪些租约/锁、原因 = ttl|disconnect），避免静默。
5. **错误码**：被清理后再访问该租约应返回明确语义（复用现有 `TAB_LEASE_CONFLICT` 或新增 `runtime.recovery` 类下的 `LEASE_EXPIRED`，需同步 `native_command_schema.json` 后跑 `npm run sync:protocol`）。

### 验证
- 新增单测：模拟时间推进，断言过期租约/锁被清理，活跃的不被清理。
- smoke：客户端断连后，另一 session 能正常获得该 tab 的租约。

### 风险
| 风险 | 缓解 |
|------|------|
| TTL 过短误清活跃长操作的租约 | read/write 命中即刷新 `lastSeenAt`；TTL 取 30min 远大于单次操作；wait 类长操作走 lease 刷新 |
| 新错误码需改协议 | 优先复用现有码；若新增，严格走 `sync:protocol` 流程 |

---

## P1-2. 协议同步 pre-commit hook

### 问题诊断

协议单一来源是项目最强工程资产：`native_command_schema.json` → 生成 5 个产物，`check-protocol-contract.mjs` 用 VM 实际执行验证。**但同步全靠人工记忆**：改完 schema 必须手动 `npm run sync:protocol`，CI 仅在 `check:protocol` 的 `--check` 阶段**事后报错**，开发者本地容易漏跑、到 CI 才发现，打断节奏。

### 目标设计

把"纪律"转成"机制"：pre-commit 检测到 schema 改动则自动 sync 并 stage 产物。

```yaml
# lefthook.yml（或 .husky/pre-commit）
pre-commit:
  commands:
    sync-protocol:
      glob: "bridge/native_command_schema.json"
      run: npm run sync:protocol && git add bridge/pi_browser_bridge/native_command_schema.json bridge_src/service_worker/protocol.ts src/protocol/nativeProtocol.ts src/protocol/nativeActionMetadata.ts src/protocol/nativeErrorCodes.ts docs/generated/native-protocol.generated.md
```

### 实施步骤

1. 选型：项目未见现有 git hook 管理器，推荐 `lefthook`（单二进制、跨平台、Windows 友好——项目 CI 含 windows-latest）。
2. 加 `lefthook.yml` + `package.json` 的 `prepare` 脚本安装 hook。
3. hook 仅在 `native_command_schema.json` 改动时触发，避免拖慢无关提交。
4. 同样可加 `docs:generate`（工具 JSDoc 改动 → 重生成 `browser-tool-contract.generated.md`）。
5. **CI 兜底不变**：`check:protocol` 的 `--check` 仍保留，hook 是本地加速，不替代 CI 校验。

### 验证
- 改 schema 后 commit，确认产物被自动 stage。
- 绕过 hook（`--no-verify`）提交陈旧产物时，CI 仍能拦截。

### 风险
| 风险 | 缓解 |
|------|------|
| 团队成员未装 hook | `prepare` 脚本随 `npm ci` 自动装；CI `--check` 作为最终防线 |
| Windows 兼容 | lefthook 原生支持 Windows |

---

## P1-3. wait 重连宽限期动态化

### 问题诊断

`src/driver/BrowserWaitSupervisor.ts` 把长 wait（默认 35s）拆成短租约（≤25s）执行，支持 worker 重启/重连恢复（`historyLost` 标志 + 租约历史）——设计精良。但**重连宽限期是固定 3000ms**（`waitForReconnect` 的 grace）。当剩余 deadline < 3s 时，等待重连会**超出总超时承诺**。

### 目标设计

宽限期与剩余 deadline 相关：

```ts
const RECONNECT_GRACE_MS = 3_000;
const reconnectGrace = Math.min(RECONNECT_GRACE_MS, Math.max(50, remainingMs * 0.2));
await waitForReconnect(server, clientId, reconnectGrace);
```

### 实施步骤
1. 定位 `BrowserWaitSupervisor` 中 `waitForReconnect` 调用处与 3000ms 常量。
2. 改为 `min(3s, remainingMs * 0.2)`，下限 50ms。
3. 更新相关常量注释，说明动态计算依据。

### 验证
- 新增单测：`remainingMs = 2s` 时宽限 ≤ 400ms，`remainingMs = 30s` 时宽限 = 3s。
- 断言 wait 总耗时不超出 deadline + 既有 grace 容差。

### 风险
| 风险 | 缓解 |
|------|------|
| 宽限过短导致本可恢复的重连失败 | 仅在剩余时间本就不足时收紧；剩余充足时仍给满 3s |

---

## P2-1. 契约测试分目录 + 关键状态机补单测

### 问题诊断
- `tests/contracts/` 下 31 个 `.mjs` 平铺，"不读目录不知道有啥"。
- 单测约 10 个 vs 契约 31 个，重度依赖契约/集成测试。`BrowserWaitSupervisor`（283 行复杂重试/重连状态机）、`BrowserLeaseRegistry`、`BrowserTabSessionRouter` 这类纯逻辑、易出边界 bug 的类缺针对性单测。

### 实施步骤
1. **分目录**（仅移动 + 改引用，不改逻辑）：
   ```
   tests/contracts/protocol/    (check-protocol-*, check-*-schema)
   tests/contracts/tools/       (check-tools-*, check-execute-tool, check-web-security-*)
   tests/contracts/runtime/     (check-page-scripts, check-scan-script, check-content-pick, ...)
   tests/contracts/drift/       (check-registry-drift, check-tool-doc-drift, check-doc-structure)
   ```
   同步更新 `package.json` 中 `check:*` 的 glob/路径。
2. **补关键单测**（配合 P0-2 / P1-1 / P1-3）：
   - `BrowserWaitSupervisor`：late_success、worker 重启计数、disconnect→重连、动态宽限期。
   - `BrowserLeaseRegistry`：跨 session 冲突、auto 租约 finally 清理、TTL 清理、断连释放。
   - `BrowserTabSessionRouter`：default/latest fallback、选择态版本号、并发选择。

### 风险：移动文件改引用遗漏 → 全局搜索路径引用，分批移动，每批跑 `npm run check`。

---

## P2-2. tsconfig 抽 base + Facade 依赖矩阵文档

### 问题诊断
- `tsconfig.json` / `tsconfig.build.json` / `tsconfig.bridge-src.json` 重复 `target/strict/noImplicitAny/skipLibCheck` 等。
- `BrowserBridgeServer` 注入约 18 个 registry/service，"谁和谁交互"只能读 `commandService`/`clientMessageService` 实现反推。

### 实施步骤
1. **抽 `tsconfig.base.json`**：放公共 compilerOptions，三个配置 `extends` 它，只保留各自差异（`lib`、`module`、`include`、`noEmit`）。验证三条 `check:*:types` 与 `build` 全绿。
2. **依赖矩阵文档**（`docs/driver-architecture.md`）：一张表列出每个 service 实际消费哪几个 registry（如 `commandService` → tabs/queues/leases/pendingRequests/recovery），降低后来者理解成本。不改代码结构。

---

## 总体实施建议

1. **可并行**：7 项之间无强耦合，按团队带宽分配。
2. **建议起手顺序**：P0-1（distiller 注册化，价值最高、与 unification 衔接）→ P0-2（不变量，正确性最依赖约定处）→ P1 三项 → P2 收尾。
3. **每项独立验证**：完成后 `npm run quality:local`（build + 全 check + pack dry-run）。
4. **不做的事**：
   - 不重构三层分层结构（无结构性问题）。
   - 不改任何工具的外部行为/参数。
   - 不把 `src/pick`、`src/scan` 里注入页面的 best-effort 空 catch 当隐患整改——那是页面 DOM 清理脚本，静默失败合理，仅补一行说明注释即可（非本方案范围）。
   - 不引入新的运行时依赖（lefthook 为 devDependency）。
