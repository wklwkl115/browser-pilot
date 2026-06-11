# ABML P1 基础语言规格 / P1 Language Foundation Spec

*ABML doc set — index & map: [`docs/abml-kernel-manifest.md`](abml-kernel-manifest.md#abml-documentation-map).*

> 状态: REVIEWED，P1 Gate 已通过；作为 ABML P2+ 的基础语义 source of truth。  
> 上游计划: `docs/unified-browser-modeling-language-plan.md`。  
> 范围: 只定义文档契约、纯函数契约、测试矩阵；**不要求、不允许直接改运行时**。

---

## 0. P1 冻结目标

P1 冻结 ABML 后续实现不能再随意改变的基础语言层：

1. `RefDescriptor` / `Locator` / `RefPolicy` / `ResolveResult`。
2. ref 重解析、消歧、缓存一致性、session/tab/frame 归属。
3. actionability 自动等待契约。
4. 后置校验三态契约。
5. 统一失败 envelope 与错误 taxonomy。
6. redaction / etag / TTL / session scope 不变量。
7. `eval` 逃生舱边界。
8. 流平面捕获窗口的时序语义。

P1 通过后才允许进入 P2 runtime registry 工作。

---

## 1. 统一 Ref 数据结构

### 1.1 Locator

```ts
type Locator =
  | { by: "backendNodeId"; value: number }
  | { by: "axNodeId"; value: string }
  | { by: "attrSignature"; value: Record<string, string> }
  | { by: "css"; value: string }
  | { by: "xpath"; value: string }
  | { by: "textAnchor"; value: string; role?: string; exact?: boolean }
  | { by: "point"; x: number; y: number };
```

Locator 没有一个跨所有 concern 的固定优先级；当前实现使用两类真实顺序：

```text
identity minting: semanticAnchor > css > backendNodeId > axNodeId > textAnchor > first locator
runtime resolution: descriptor.locators array order
```

原因：
- identity minting 优先页面稳定锚点。`backendNodeId` / `axNodeId` 是会话或 AX 重建作用域，直接作为首选 identity 会增加 ref churn；因此 `refId.ts` 在无 semantic anchor 时先取 `css`。
- runtime resolution 优先命中准确性。DOM builder 按 `css -> textAnchor -> point` 产出 locators；AX builder 按 `backendNodeId -> axNodeId -> textAnchor` 产出 locators；执行侧按数组顺序尝试。
- `attrSignature` / `xpath` 是保留的 resolution 兼容入口；当前不是默认 producer。

`point` 只作为几何兜底；不能单独把 point 命中当作高置信唯一结构实体，除非目标 `kind:"region"` 或调用视觉地板。

### 1.2 RefDescriptor

```ts
type RefKind =
  | "element"
  | "control"
  | "text"
  | "media"
  | "ax"
  | "region"
  | "frame"
  | "network-entry"
  | "event"
  | "signal"
  | "data-slice";

type RefOwner = {
  browserSessionId?: string;
  tabId?: number;
  frameRef?: string;
  topLevelOrigin?: string;
};

type RefPolicy = {
  redaction: "default" | "disabled";
  shareableAcrossSessions: boolean;
  liveActionsAllowed: boolean;
};

type SnapshotBinding = {
  observationId: string;
  resourceUri?: string;      // browser-result://... 或后续 pi-ref data-slice
  jsonPath?: string;
  etag?: string;
  immutable: boolean;
};

type DocumentEpoch = {
  frameId?: string;
  loaderId?: string;
  navigationId?: string;
  url?: string;
  mutationEpoch?: number;
  capturedAt: number;
};

type RefDescriptor = {
  refId: string;             // pi-ref://...
  kind: RefKind;
  locators: Locator[];
  owner: RefOwner;
  policy: RefPolicy;
  snapshot?: SnapshotBinding;
  semantic?: {
    role?: string;
    name?: string;
    value?: string;
    state?: Record<string, boolean>;
  };
  geometry?: {
    box?: { x: number; y: number; w: number; h: number };
    point?: { x: number; y: number };
  };
  observationId: string;
  documentEpoch?: DocumentEpoch;
  createdAt: number;
  ttlMs: number;
  stabilityScore?: number;
};
```

### 1.3 RefPolicy 默认值

| ref kind | redaction | shareableAcrossSessions | liveActionsAllowed |
|---|---:|---:|---:|
| element/control/frame/region | default | false | true |
| text/media/ax | default | false | false |
| network-entry/event/signal | default | false | false |
| data-slice, redacted artifact | default | true iff no owner/session binding | false |
| data-slice, raw/sensitive artifact | disabled | false | false |

规则：
- `redaction:"disabled"` 只表示来源资源是 raw/sensitive；普通 `read/inspect` 仍默认输出 redacted 内容。
- `liveActionsAllowed:false` 的 ref 不能被 `click/type/select/drag` 消费。
- 跨 session 共享默认禁止；只有 redacted、immutable、无 session 私有绑定的 data-slice 可共享读取。
- live/actionable ref 必须至少有一条 `locators`；`data-slice` / 不可变流实体允许 `locators: []`，但必须有 `snapshot.resourceUri` 或流实体证据标识。

---

## 2. Ref 重解析与消歧

### 2.1 ResolveResult

```ts
type ResolveStatus =
  | "unique"
  | "ambiguous"
  | "stale"
  | "scopeViolation"
  | "privacyBlocked"
  | "backendUnavailable";

type ResolveResult =
  | { status: "unique"; ref: RefDescriptor; candidate: CandidateSummary; refreshed?: RefDescriptor }
  | { status: "ambiguous"; ref: RefDescriptor; candidates: CandidateSummary[]; reason: string }
  | { status: "stale"; ref: RefDescriptor; reason: string }
  | { status: "scopeViolation"; ref: RefDescriptor; reason: string; expected: RefOwner; actual: RefOwner }
  | { status: "privacyBlocked"; ref: RefDescriptor; reason: string }
  | { status: "backendUnavailable"; ref: RefDescriptor; backend: string; reason: string };
```

`CandidateSummary` 及候选评分表是保留类型，当前 runtime 不构造该结果；见附录 A。

### 2.2 候选评分（保留，未实现）

当前实现没有通用 candidate scoring engine。执行侧按 `descriptor.locators` 数组顺序解析，
并由 actionability / scope / policy 层继续约束。未来若恢复通用重解析评分，必须按附录 A
把 `CandidateSummary` 与权重表作为 explicit migration 落地，不能把 reserved 表述当作当前能力。

### 2.3 唯一性规则

```text
RESOLVE_MIN_SCORE = 60
RESOLVE_UNIQUE_GAP = 10
```

- 无候选或最高分 `< RESOLVE_MIN_SCORE` → `stale`。
- 最高候选与第二候选分差 `< RESOLVE_UNIQUE_GAP` → `ambiguous`。
- 最高候选存在语义冲突(role/name 与 ref.semantic 明显不一致) → `ambiguous`。
- `kind:"region"` 且只有 point 命中时可返回 `unique`，但 `source` 必须标为 `vision` 或 `region`，后续写动词仍需 actionability。
- 禁止静默取第一个候选。

### 2.4 Scope 与 epoch

Scope 检查先于定位：

| 条件 | 结果 |
|---|---|
| `owner.browserSessionId` 存在且与当前 session 不同 | `scopeViolation` |
| `owner.tabId` 存在且与当前 tab 不同 | `scopeViolation` |
| `owner.frameRef` 存在但 frame 不可达 | `stale` 或 `backendUnavailable` |
| topLevelOrigin 不同且 ref 非 shareable data-slice | `scopeViolation` |

`DocumentEpoch` 用于缓存可信度，不用于跳过重解析：

- 写动词必须重解析 live target。
- `geometry/semantic` 只有在 `frameId + loaderId/navigationId + url` 未变时可作为排序 hint。
- `mutationEpoch` 变化后，cached geometry 只能作弱 hint；actionability 必须重新测量 box/hit-test。
- backendNodeId 跨 loader/navigation 不可信；若无其它 locator 命中则 `stale`。

---

## 3. Redaction / TTL / ETag / Session 决策表

### 3.1 Resolve 输入

```ts
type ResolveContext = {
  browserSessionId?: string;
  tabId?: number;
  frameId?: string;
  topLevelOrigin?: string;
  now: number;
  requestedRedaction: "default" | "disabled";
  explicitSensitiveAccess: boolean; // 仅由显式 redact:false / 本地 raw evidence 请求置 true
};
```

普通 ABML 动词的默认值：

```text
requestedRedaction = "default"
explicitSensitiveAccess = false
```

### 3.2 决策表

| 条件 | 决策 | 错误/输出 |
|---|---|---|
| `now > createdAt + ttlMs` | 拒绝 | `REF_STALE` |
| snapshot resource expired/not found | 拒绝 | `HANDLE_NOT_FOUND` / `HANDLE_EXPIRED` |
| snapshot etag mismatch | 拒绝 | `HANDLE_ETAG_MISMATCH` |
| live ref session/tab mismatch | 拒绝 | `REF_SCOPE_VIOLATION` |
| data-slice session mismatch 且 `shareableAcrossSessions:false` | 拒绝 | `REF_SCOPE_VIOLATION` |
| `policy.redaction:"default"` + requested default | 允许 | 输出 redacted/default 内容 |
| `policy.redaction:"default"` + requested disabled | 默认拒绝；仅当资源元数据明确 `sensitive:false` 且同 session 显式请求 raw 时允许 | `PRIVACY_BLOCKED` |
| `policy.redaction:"disabled"` + requested default | 允许 | 重新执行 redaction 后输出 |
| `policy.redaction:"disabled"` + requested disabled + `explicitSensitiveAccess:false` | 拒绝 | `PRIVACY_BLOCKED` |
| `policy.redaction:"disabled"` + requested disabled + cross-session | 拒绝 | `PRIVACY_BLOCKED` 或 `REF_SCOPE_VIOLATION` |
| `policy.redaction:"disabled"` + requested disabled + same-session + explicit sensitive access | 允许 | 输出 raw，但 envelope 必须标 `privacy.redaction:"disabled"` |

不变量：
- 解析 `pi-ref://` 时必须重新经过 `resourceStore` freshness/redaction 流程。
- `snapshot.resourceUri` 不得让 agent 看到本地绝对路径。
- `payloadHandle` 只能指向句柄，不能内联大 body/token/cookie。
- `redaction:"disabled"` 的输出必须只在显式请求、同 session、本地权限满足时出现。
- `explicitSensitiveAccess:true` 不能由 ref 自身携带，只能由当前工具调用参数和用户明确需求派生。

---

## 4. Actionability 自动等待

### 4.1 通用 schema

```ts
type ActionabilityPredicate =
  | "unique"
  | "attached"
  | "visible"
  | "stable"
  | "enabled"
  | "editable"
  | "inViewport"
  | "scrollable"
  | "receivesEvents"
  | "notOccluded";

type ActionabilityBlockerCode =
  | "not_unique"
  | "detached"
  | "not_visible"
  | "not_stable"
  | "disabled"
  | "not_editable"
  | "outside_viewport"
  | "not_scrollable"
  | "not_receiving_events"
  | "occluded";

type ActionabilitySpec = {
  timeoutMs: number;
  pollMs: number;
  stableWindowMs: number;
  stableEpsilonPx: number;
  required: ActionabilityPredicate[];
};

type ActionabilityReport = {
  ok: boolean;
  spec: ActionabilitySpec;
  elapsedMs: number;
  attempts: number;
  checks: Partial<Record<ActionabilityPredicate, boolean>>;
  blockers: Array<{ code: ActionabilityBlockerCode; message: string; evidence?: Record<string, unknown> }>;
  target?: CandidateSummary;
  targets?: Record<string, CandidateSummary>; // drag/from-to 等多目标动作
  geometry?: { before?: unknown; after?: unknown; final?: unknown };
  hitTest?: { x: number; y: number; topNode?: string; matchedTarget: boolean };
};
```

默认常量：

```text
ACTION_TIMEOUT_MS = 5000
ACTION_POLL_MS = 100
STABLE_WINDOW_MS = 150
STABLE_EPSILON_PX = 1
```

### 4.2 Predicate 语义

| predicate | 判定 |
|---|---|
| unique | `ResolveResult.status === "unique"` |
| attached | 目标仍在 live DOM/AX/frame 或可操作 region 中 |
| visible | 非 hidden、非 `display:none`、box 非空、AX 未 hidden |
| stable | `stableWindowMs` 内 box 位移不超过 `stableEpsilonPx` |
| enabled | 无 disabled/aria-disabled/inert 阻断 |
| editable | input/textarea/contenteditable 或可识别编辑器处于可输入状态 |
| inViewport | 可操作 point 位于 viewport 内；允许先滚动再重测 |
| scrollable | 自身或 ancestor 具备可滚动 overflow/scroll range |
| receivesEvents | point hit-test 的顶层目标为自身或可接受子节点 |
| notOccluded | hit-test 未命中遮挡层，且 pointer-events/覆盖层不阻断 |

### 4.3 动词矩阵

| 动词 | required predicates | 成功前动作 |
|---|---|---|
| `click` | unique, attached, visible, stable, enabled, inViewport, receivesEvents, notOccluded | 必要时滚入视口并重新 hit-test |
| `type` | unique, attached, visible, stable, enabled, editable, inViewport | focus 后再次确认 editable/focused |
| `select` | unique, attached, visible, stable, enabled, inViewport | 原生 select 直接设值；非原生控件按 click 流程展开 |
| `hover` | unique, attached, visible, stable, inViewport, receivesEvents | 鼠标移动到可接收事件点 |
| `drag` | from/to unique, attached, visible, stable, inViewport, receivesEvents | 计算真实轨迹前再次测量 from/to point |
| `scroll` | attached, scrollable；若滚动到特定元素则额外要求 unique | 如果目标不可见但 ancestor 可滚动，允许以 ancestor 为 action target |
| `upload` | unique, attached, enabled | 需用户确认文件路径；用 `DOM.setFileInputFiles` 后校验 files/value |

规则：
- `wait` 动词不替代 actionability；写动词内部必须执行本表。
- P1 不提供普通 `force` 绕过。未来若要加，必须另开安全/可靠性 RFC。
- actionability 失败返回 `ACTIONABILITY_TIMEOUT`，并携带 `ActionabilityReport`。
- 若失败原因单一且明确，可使用更具体错误：`TARGET_OCCLUDED`、`REF_AMBIGUOUS`、`TARGET_DISABLED`。

---

## 5. 后置校验

### 5.1 VerificationResult

```ts
type VerificationStatus = "verified" | "failed" | "inconclusive";

type VerificationResult = {
  status: VerificationStatus;
  verb: string;
  expected?: Record<string, unknown>;
  observed: Record<string, unknown>;
  evidence: Array<{ kind: string; summary: string; ref?: string; data?: Record<string, unknown> }>;
  elapsedMs: number;
};
```

### 5.2 默认校验语义

| 动词 | verified 条件 | failed 条件 | inconclusive 条件 |
|---|---|---|---|
| `click` | 明确导航、焦点/状态变化、目标事件效果、DOM/network 可归因变化之一 | 目标消失前未 dispatch、动作被取消、页面报告错误 | 输入已 dispatch 但无可归因变化 |
| `type` | value/textContent/selection/input event 变化符合 text | value 未变或被校验为错误值 | custom editor 无可读值但有 input 迹象 |
| `select` | selected value/label 符合期望 | value 不匹配 | custom select 无可读状态 |
| `scroll` | scrollTop/viewport/item count 变化或已到边界 | scrollable target 不存在 | 虚拟列表变化无法归因 |
| `drag` | from/to 位置、DOM/state 或 drop event 效果可见 | drop target 拒绝或位置不变且有错误 | 事件发送完成但效果不可观测 |
| `upload` | file input files/value 或上传请求出现 | file list 为空或 CDP set files 失败 | app 隐藏 input 且无可读上传状态 |

`inconclusive` 不是成功；envelope 必须暴露 `verification.status:"inconclusive"` 和下一步建议。

---

## 6. 统一错误 Envelope

### 6.1 AbmlError

```ts
type AbmlErrorCategory =
  | "ref"
  | "actionability"
  | "backend"
  | "verification"
  | "privacy"
  | "session"
  | "input"
  | "internal";

type AbmlErrorCode =
  | "REF_NOT_FOUND"
  | "REF_STALE"
  | "REF_AMBIGUOUS"
  | "REF_SCOPE_VIOLATION"
  | "HANDLE_NOT_FOUND"
  | "HANDLE_EXPIRED"
  | "HANDLE_KIND_MISMATCH"
  | "HANDLE_ETAG_MISMATCH"
  | "PRIVACY_BLOCKED"
  | "ACTIONABILITY_TIMEOUT"
  | "TARGET_OCCLUDED"
  | "TARGET_DISABLED"
  | "TARGET_NOT_EDITABLE"
  | "BACKEND_UNAVAILABLE"
  | "CROSS_ORIGIN_BLOCKED"
  | "VERIFY_FAILED"
  | "VERIFY_INCONCLUSIVE"
  | "TAB_LEASE_CONFLICT"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR";

type AbmlRecovery = {
  retryable: boolean;
  kind:
    | "read-refresh"
    | "narrow-ref"
    | "wait-and-retry"
    | "scroll-or-dismiss-overlay"
    | "switch-session-or-tab"
    | "recapture-evidence"
    | "use-visual-floor"
    | "manual-review"
    | "none";
  nextActions?: string[];
};

type AbmlError = {
  code: AbmlErrorCode;
  category: AbmlErrorCategory;
  message: string;
  recovery: AbmlRecovery;
  evidence?: Record<string, unknown>;
  candidates?: CandidateSummary[];
  actionability?: ActionabilityReport;
  verification?: VerificationResult;
  cause?: { source: string; code?: string; message?: string; details?: Record<string, unknown> };
};
```

### 6.2 与现有错误映射

| 现有错误/场景 | ABML code |
|---|---|
| `HANDLE_NOT_FOUND` | `HANDLE_NOT_FOUND` 或 `HANDLE_EXPIRED` |
| `HANDLE_KIND_MISMATCH` | `HANDLE_KIND_MISMATCH` |
| `HANDLE_ETAG_MISMATCH` | `HANDLE_ETAG_MISMATCH` |
| `NO_SESSION` / `SESSION_NOT_FOUND` | `REF_SCOPE_VIOLATION` |
| `TAB_LEASE_CONFLICT` | `TAB_LEASE_CONFLICT` |
| `SELECTOR_NOT_FOUND` | `REF_STALE` |
| `INVALID_SELECTOR` | `INVALID_INPUT` |
| `CROSS_ORIGIN_IFRAME` | `CROSS_ORIGIN_BLOCKED` |
| CDP helper missing/session limit | `BACKEND_UNAVAILABLE` |
| actionability timeout | `ACTIONABILITY_TIMEOUT` |
| post verification failed | `VERIFY_FAILED` |
| post verification inconclusive | `VERIFY_INCONCLUSIVE` |
| redaction/session policy denial | `PRIVACY_BLOCKED` 或 `REF_SCOPE_VIOLATION` |

所有失败 envelope 必须包含：

```ts
{
  ok: false,
  error: AbmlError,
  summary: { failed: true, code: AbmlErrorCode, recovery: AbmlRecovery }
}
```

---

## 7. `eval` 边界

`eval` 是 escape hatch，不是可靠动作路径。

规则：
- `eval` 输出必须过同一 envelope、redaction、token budget。
- `eval` 不得直接 mint `pi-ref://` live ref。
- `eval` 返回的 selector/point/DOM 摘要必须经过 `read` / noun modeler 才能成为 actionable ref。
- `eval` 的页面副作用不享受 actionability/verification；需要可靠交互时必须用动词或 MCP `transaction`。
- skill/docs 中应提示：优先 `read + verb`，只在探索/调试/一次性计算时用 `eval`。

---

## 8. 流平面时序语义

### 8.1 CaptureRef

```ts
type CaptureState = "active" | "stopped" | "expired" | "lost";

type CaptureRef = RefDescriptor & {
  kind: "signal";
  streamState: {
    state: CaptureState;
    startedAt: number;
    stoppedAt?: number;
    expiresAt: number;
    lastSeq?: number;
  };
};
```

### 8.2 规则

- `read({ plane:"network" | "event" })` 默认读取已捕获窗口的快照，不创建订阅。
- start/stop/wait 类动词创建或推进 `CaptureRef` 状态。
- `network-entry` / `event` ref 是不可变证据点。
- `replay(network-entry)` 产出新的 exchange Entity/ref，不改写原始 evidence ref。
- `active` capture 可继续 `read` 增量；`stopped` capture 只读；`expired/lost` 返回 `REF_STALE` 或 `HANDLE_EXPIRED`。

---

## 9. P1 纯函数与契约测试矩阵

| 测试族 | Fixture | 期望 |
|---|---|---|
| 重解析稳定性 | 同一 button 重渲染、backendNodeId 失效、data-testid 保留 | `unique` |
| 随机 class SPA | class 随机、文本/role 保留 | textAnchor/role 命中 |
| 多同名元素 | 10 个 `Add to cart`，无额外 locator | `REF_AMBIGUOUS` + candidates |
| 几何漂移 | cached point 偏移、semantic 不变 | 弱 hint，不跳过 actionability |
| navigation epoch | loaderId/url 改变、只有 backendNodeId | `REF_STALE` |
| session scope | session B 用 session A live ref | `REF_SCOPE_VIOLATION` |
| redacted snapshot | default redaction resolve | 输出 redacted |
| raw snapshot | `redaction:"disabled"` + 无 explicit access | `PRIVACY_BLOCKED` |
| etag mismatch | artifact 被改写 | `HANDLE_ETAG_MISMATCH` |
| TTL expired | now 超过 expiresAt | `REF_STALE` / `HANDLE_EXPIRED` |
| actionability hidden | target display:none | `ACTIONABILITY_TIMEOUT` + blocker `not_visible` |
| actionability overlay | hit-test 命中 overlay | `TARGET_OCCLUDED` 或 blocker `occluded` |
| actionability animation | box 持续移动 | blocker `not_stable` |
| type non-editable | div 非 editable | `TARGET_NOT_EDITABLE` |
| verification inconclusive | click dispatch 成功但无可归因变化 | `VERIFY_INCONCLUSIVE` |
| eval ref mint | eval 返回 selector/point | 不生成 actionable ref |
| capture lifecycle | active→stopped→expired | 状态与错误符合 §8 |

---

## 10. P1 Gate 判定

P1 可冻结条件：

1. 本文 schema 被评审接受。
2. `docs/unified-browser-modeling-language-plan.md` 引用本文作为 P1 source of truth。
3. 本文测试矩阵覆盖 ref/actionability/verification/error/privacy/eval/capture 基础语义。
4. 无 runtime 改动进入 P1。

P2 entry conditions：

1. P1 Gate Review 结论为 `Approve`。
2. 执行计划列出本文每个测试族对应的纯函数或契约测试。
3. P2 任务只允许实现本文已冻结字段/错误/决策表，不得新增隐式语义。

P1 若未冻结，P2/P3/P4 均不得开工。

---

## 附录 A. Reserved / Unimplemented Candidate Scoring

本附录记录保留类型和未实现评分表。它们存在于类型面用于 forward compatibility，
但当前 runtime 不构造 `CandidateSummary`，也没有通用候选评分引擎。

```ts
type CandidateSummary = {
  candidateId: string;
  locatorHits: Array<{ by: Locator["by"]; weight: number }>;
  score: number;
  role?: string;
  name?: string;
  source?: "dom" | "ax" | "vision" | "network" | "hook" | "evidence";
  geometry?: { box?: { x: number; y: number; w: number; h: number }; point?: { x: number; y: number } };
  documentOrder?: number;
};
```

Reserved locator weights:

| locator | weight |
|---|---:|
| backendNodeId | 100 |
| axNodeId | 95 |
| attrSignature | 90 |
| css | 80 |
| xpath | 70 |
| textAnchor | 60 |
| point | 40 |

Reserved score formula:

```text
score = sum(unique locator hit weights)
      + semanticBonus
      + geometryBonus
      + ownerFrameBonus
```

Reserved bonuses:

| bonus | 条件 | 分值 |
|---|---|---:|
| semanticBonus | role 精确匹配 | +10 |
| semanticBonus | name/text 精确匹配 | +10 |
| semanticBonus | textAnchor exact=false 模糊匹配 | +4 |
| geometryBonus | 与 cached point 距离 <= 8px | +8 |
| geometryBonus | 与 cached box IoU >= 0.8 | +8 |
| ownerFrameBonus | frameRef/frameId 匹配 | +15 |
