# Driver Architecture

## 目标

给维护者一个稳定入口，理解 browser driver facade、service、registry 的职责边界，以及 tab 选择态 / 租约态 / 队列态之间的复合关系。

## 核心分层

| 模块 | 角色 | 直接职责 |
|---|---|---|
| `BrowserBridgeServer.ts` | facade | 暴露 public API，组合 driver services / registries，提供 snapshot / lifecycle diagnostics |
| `BrowserBridgeHttpServer.ts` | transport ingress | HTTP/WS server、端口绑定、upgrade 接入 |
| `BrowserBridgeClientRegistry.ts` | browser client registry | 已连接扩展 client、selected extension client、ping/pong/stale 观测 |
| `BrowserSessionRegistry.ts` | logical browser session | selected browser session、default session、browser session 生命周期 |
| `BrowserTabSessionRouter.ts` | tab routing | tab session、stable `tabHandle`/`targetRef`、replacement follow、activation-driven implicit target、browser-scoped duplicate tab 解析 |
| `BrowserLeaseRegistry.ts` | write ownership | tab lease、UI lock、TTL/disconnect cleanup |
| `BrowserCommandQueueRegistry.ts` | write serialization | `(browserSessionId, tabId)` 维度串行队列 |
| `BrowserBridgePendingRequests.ts` | in-flight request tracking | ACK/timeout/disconnect cleanup、bridge request lifecycle |
| `BrowserBridgeCommandService.ts` | command dispatch | command validation、target planning、payload transport、write invariant 断言 |
| `BrowserBridgeClientMessageService.ts` | client message route | WS register/unregister、`ext_ready`/`tabs_update`/`ack`/`result`/`error` 路由 |
| `BrowserBridgeClientHeartbeat.ts` | maintenance loop | stale client cleanup、lease/UI lock TTL sweep tick |
| `BrowserWaitSupervisor.ts` | durable waits | short-lease wait supervision、restart/disconnect diagnostics |

## Facade 依赖矩阵

| 消费者 | clients | browserSessions | tabs | leases | queues | pendingRequests | runtimeRecoveryArtifacts | operations | observationSnapshots |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `BrowserBridgeServer` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `BrowserBridgeCommandService` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | - |
| `BrowserBridgeClientMessageService` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | - |
| `BrowserBridgeClientHeartbeat` | ✓ | - | - | ✓ | - | - | - | - | - |

## 三套状态机

一个 tab 的关键状态拆成三处：

| 状态 | 持有者 | 说明 |
|---|---|---|
| 选择态 | `BrowserTabSessionRouter` | default/latest/selected browser 下的 implicit target；手动 activation 事件会更新 |
| 租约态 | `BrowserLeaseRegistry` | explicit lease、auto lease、UI lock、TTL/disconnect cleanup |
| 队列态 | `BrowserCommandQueueRegistry` | write 命令按 `(browserSessionId, tabId)` 串行化；tab replacement 时旧队列 alias 到新 physical tab |

### 合法组合

| 操作 | 选择态 | 租约态 | 队列态 |
|---|---|---|---|
| read + explicit tab | 只用于 target metadata | 可无 lease；若本 session 已持有 lease 会 touch | 不入队 |
| read + implicit target | 以 dispatch 时捕获的 target/source/selectionVersion 为准 | 可无 lease | 不入队 |
| write + explicit target | `targetRef`/`tabHandle` 或兼容 numeric `tabId` 必须经同一 resolver 解析到单一 live tab；numeric id 只在无歧义 replacement chain 内 auto-follow | 必须不存在 foreign-session lease；执行时使用 auto lease 或已有 explicit lease；replacement 后可迁移到新 tab session | 必须入队；replacement 中的旧队列 alias 到新 tab |
| write + implicit target | dispatch 时固定 implicit target；后续切 tab 不回写当前请求 | 与上同 | 必须入队 |
| `browser_tabs switch` / `pick` / `upload` 等 UI 改动 | 会变更选择态 | 受 UI lock 保护 | 视命令类型决定 |

### 复合不变量

`BrowserBridgeCommandService.sendPayload()` 是三者交汇点，write 分支在入队前和 queued closure 内都执行复合断言：

1. 目标 tab 已解析为当前 browser session 下的 live tab
2. `targetRef`/`tabHandle` 与 numeric `tabId` 兼容路径共用 resolver，replacement 诊断写入 `target.replacedFrom/replacedByTabId`
3. 若 tab 已有 lease，则 lease owner 必须等于当前 `browserSessionId`
4. target diagnostics 中的 `browserSessionId` 不能与 dispatch browser session 冲突
5. queued closure 真正 dispatch 前再次复核，避免“入队时正确、执行时状态已漂移”

断言失败优先返回既有 `TAB_LEASE_CONFLICT` 并附 `invariant` / `target` / `lease` 诊断。

## 租约与 UI lock 生命周期

### tab lease

- explicit lease：由 `browser_tabs leaseTab` 获取
- auto lease：write-path dispatch 时临时持有
- 同一 session 命中 lease 时会刷新 `lastSeenAt`
- heartbeat tick 会执行 TTL sweep
- client disconnect 会按断开的 `tabSessionIds` 释放相关 lease

### UI lock

- 保护 `switch` / `pick` / `upload` 等影响真实浏览器 UI 的操作
- 可重入；同 session 再入仅增加 `count`
- heartbeat tick 会执行 TTL sweep
- client disconnect 会按受影响 browser session 释放相关 UI lock

### 可观测性

- TTL 释放：`[pi-browser-bridge] Released expired lease/UI lock state`
- disconnect 释放：`[pi-browser-bridge] Released lease/UI lock state after client disconnect`

日志包含 reason、released leases、released UI locks、受影响 tab session / browser session。

## write dispatch 链路

1. tool register / driver public API 进入 `BrowserBridgeCommandService`
2. schema/target/accessMode 校验
3. `sendPayload()`：
   - resolve target
   - read：直接 `pendingRequests.send()`
   - write：`assertWriteInvariants()` → `queues.enqueue()` → queued closure 内再断言 → `leases.withAutoTabLease()` → `pendingRequests.send()`
4. result 返回后 `runtimeRecoveryArtifacts.recordCommandResult()` 记录 target + snapshot 证据

## wait supervisor 预算

`BrowserWaitSupervisor` 通过短租约重试来覆盖长等待：

- `computeBridgeGraceMs(remainingMs)`：按剩余 deadline 动态计算 per-attempt bridge grace
- `computeReconnectBudgetMs(remainingMs)`：按剩余 deadline 动态计算 reconnect budget
- 目标：避免固定 3000ms/250ms floor 让整体 wall-clock 明显超过用户声明 deadline

## 维护建议

- 改 target / queue / lease 行为时，先看本文件，再读：
  - `BrowserBridgeCommandService.ts`
  - `BrowserLeaseRegistry.ts`
  - `BrowserTabSessionRouter.ts`
  - `BrowserCommandQueueRegistry.ts`
- 改 heartbeat / stale cleanup / TTL sweep 时，再看：
  - `BrowserBridgeClientHeartbeat.ts`
  - `BrowserBridgeClientMessageService.ts`
- 改 wait budget / restart 行为时，再看：
  - `BrowserWaitSupervisor.ts`
  - `tests/unit/driver/BrowserWaitSupervisor.test.ts`
  - `tests/contracts/runtime/check-fake-ws.mjs`
  - `tests/contracts/runtime/check-lifecycle.mjs`
