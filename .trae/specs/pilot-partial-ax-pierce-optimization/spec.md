# Pilot Partial AX Pierce Optimization Spec

## Why
P2 AX fusion 已通过 `Accessibility.getFullAXTree` 改善 canonical observe 的 role/name/state 可靠性，但长期关注项仍包括大页面 AX latency、AX-only 输出预算与 `getPartialAXTree` 是否可用于局部 observe/pierce 优化。引入 bounded partial AX 试点可以在用户聚焦某个 ref、局部 pierce 或 action 后局部观察时减少全树成本，同时不改变 full observe 的 canonical 结构权威。

## What Changes
- 调研 CDP `Accessibility.getPartialAXTree` 的参数、返回形态、浏览器兼容性、pierce/iframe/shadow DOM 限制与成本。
- 在 ABML browser runtime 中新增 bounded partial AX helper，用于已知 backendNodeId 或 resolved node 的局部 AX enrichment。
- 将 partial AX 仅用于局部 pierce/read refinement 或 action-adjacent enrichment，不替代 canonical no-mode observe 的 full AX fusion 路径。
- 为 provider 状态提供 honest diagnostics：executed、skipped、failed、degraded，并记录 fallback 到 full AX 或 scan-only 的原因。
- 保持 `src/kernels/*` 纯逻辑，不引入 CDP/browser runtime 依赖；kernel 只消费纯数据结构。
- 增加 focused tests，覆盖 partial AX 成功、不可用、返回不足、ambiguous/fallback、预算限制和 structural boundary。
- 同步 `CODE_WIKI.md` 与 `.trae/notes/abml-observe-long-term-optimization.md` 中 P2 后续关注项状态。

## Impact
- Affected specs: ABML browser runtime AX provider、pierce/read local enrichment、PageObservation diagnostics、AX fusion fallback、observe regression benchmark。
- Affected code: `src/browser-runtime/abml/axRuntime.ts`、`src/browser-runtime/abml/runtime.ts`、pierce runtime helpers、ABML/AX tests、diagnostics/projection tests、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements
### Requirement: Partial AX strategy
The system SHALL evaluate and document a minimal `Accessibility.getPartialAXTree` strategy for local AX enrichment without replacing full canonical observe.

#### Scenario: Strategy selected
- **WHEN** implementation begins
- **THEN** the strategy SHALL identify supported target inputs, budget limits, diagnostics states, and fallback behavior.

### Requirement: Bounded partial AX runner
The system SHALL provide a bounded browser-runtime helper that can request partial AX data for a known local target when available.

#### Scenario: Backend node target available
- **WHEN** a pierce/read refinement has a reliable backendNodeId or resolved target node
- **THEN** the helper MAY request `Accessibility.getPartialAXTree` with bounded ancestors/fetchRelatives policy and return normalized AX nodes.

#### Scenario: Partial AX unavailable
- **WHEN** partial AX is unsupported, errors, times out, or returns insufficient data
- **THEN** the system SHALL fail closed and keep existing scan/full AX/pierce behavior available.

### Requirement: Local enrichment boundary
The system SHALL use partial AX only as local enrichment evidence, not as a replacement for canonical full observe or scan execution targets.

#### Scenario: Canonical no-mode observe
- **WHEN** normal no-mode `browser_observe` runs without a local partial AX trigger
- **THEN** it SHALL preserve the existing full AX fusion and scan-backed canonical PageObservation behavior.

#### Scenario: Local pierce/read refinement
- **WHEN** partial AX enriches a local ref or pierced region
- **THEN** it SHALL not create unrelated page-wide AX-only entities outside the requested local scope.

### Requirement: Diagnostics honesty and budgets
The system SHALL expose partial AX provider diagnostics when partial AX is attempted.

#### Scenario: Partial AX attempted
- **WHEN** a partial AX request is made
- **THEN** diagnostics SHALL record executed/skipped/failed/degraded state, node counts, target identity, and fallback reason when applicable.

#### Scenario: Budget exceeded
- **WHEN** partial AX node count, timeout, or relative expansion exceeds budget
- **THEN** the result SHALL be degraded or truncated without failing the main observe/pierce operation.

### Requirement: Kernel/runtime boundary
The system SHALL keep CDP calls and browser-specific partial AX logic outside `src/kernels/*`.

#### Scenario: Kernel consumption
- **WHEN** kernel code consumes partial AX data
- **THEN** it SHALL receive plain AX-like data structures and SHALL NOT import browser runtime, CDP, commands, or npm runtime dependencies.

### Requirement: Regression coverage
The system SHALL include deterministic tests for partial AX behavior and fallback.

#### Scenario: Focused tests
- **WHEN** focused tests run
- **THEN** they SHALL cover successful partial AX enrichment, unavailable/failure fallback, budget truncation/degraded diagnostics, and no page-wide structural pollution.

## MODIFIED Requirements
### Requirement: AX provider architecture
The AX provider architecture SHALL support both existing full-tree fusion for canonical observe and optional bounded partial-tree enrichment for local pierce/read scenarios, with clear diagnostics and fallback separation.

### Requirement: Long-term optimization notes
The long-term observe optimization notes SHALL update the P2 `getPartialAXTree` follow-up from open question to evaluated/implemented pilot status after completion.

## REMOVED Requirements
### Requirement: Full AX tree as the only AX enrichment source
**Reason**: Full AX tree is appropriate for canonical observe but can be too expensive for local pierce/read refinement on large pages.
**Migration**: Keep full AX tree as canonical observe default and add bounded partial AX as an optional local enrichment path.
