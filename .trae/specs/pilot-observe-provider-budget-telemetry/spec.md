# Pilot Observe Provider Budget Telemetry Spec

## Why
P1-P5 已引入 accessible name、AX/full+partial、role provider、axe diagnostics、Readability 等 observe provider。长期优化记录中剩余共同风险集中在 bundle size、latency、timeout/degraded 命中率、node/result budgets 与大页面表现；需要统一 provider budget telemetry，避免每条 provider 只在局部测试中有预算信息，难以持续发现性能和输出预算回归。

## What Changes
- 梳理现有 observe provider diagnostics/timings/bounded metadata：scan、dom-accessibility-api、full AX、partial AX、role provider、axe、Readability。
- 建立统一的 provider budget telemetry 摘要，覆盖 executed/skipped/failed/degraded、duration、count、budget、truncated、fallback reason 等字段。
- 将 telemetry 保持为 diagnostics/evidence，不改变 canonical PageObservation 结构、actionables、refs、entities、relations、collections。
- 增加 focused tests 和 regression fixture，保护大页面预算、provider 状态诚实性和默认 no-mode observe 输出稳定性。
- 不新增 runtime dependency，不扩大 public `browser_*` command surface，不把 telemetry 写入 `src/kernels/*`。
- 同步 `CODE_WIKI.md` 与 `.trae/notes/abml-observe-long-term-optimization.md`，将跨 provider budget/latency 关注项沉淀为统一 guardrail。

## Impact
- Affected specs: `browser_observe` diagnostics、PageObservation provider status、observe artifact/evidence、observe regression benchmark。
- Affected code: `src/commands/observe/*` diagnostics/projection、`src/browser-runtime/abml/*` diagnostics shaping、tests/fixtures、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements
### Requirement: Provider budget telemetry inventory
The system SHALL inventory existing observe provider diagnostics and budget metadata before changing output shape.

#### Scenario: Inventory completed
- **WHEN** implementation begins
- **THEN** the inventory SHALL identify current fields, gaps, owners, and which telemetry can be normalized without breaking existing output.

### Requirement: Unified provider budget summary
The system SHALL expose a bounded diagnostics summary for observe providers that records provider status and budget-related evidence.

#### Scenario: Provider executed
- **WHEN** a provider executes during observe
- **THEN** telemetry SHOULD include provider name, status, duration or timing when available, relevant counts, applied budgets, truncation/degraded markers, and artifact/evidence references when available.

#### Scenario: Provider skipped or failed
- **WHEN** a provider is skipped, unavailable, failed, or degraded
- **THEN** telemetry SHALL report a concise reason without implying successful execution.

### Requirement: Diagnostics-only boundary
The system SHALL treat provider budget telemetry as diagnostics evidence only.

#### Scenario: Telemetry recorded
- **WHEN** telemetry records provider counts, latency, truncation, or fallback
- **THEN** it SHALL NOT create, remove, reorder, or rename actionables, refs, entities, relations, collections, or content plane output.

### Requirement: Bounded output and artifact safety
The system SHALL keep inline telemetry bounded and avoid duplicating large provider outputs.

#### Scenario: Large page observe
- **WHEN** observe runs on a large page with many provider metrics
- **THEN** inline telemetry SHALL remain compact, and detailed provider artifacts SHALL stay in existing saved artifacts or provider-specific nodes.

### Requirement: Regression coverage
The system SHALL include focused tests and benchmark coverage for provider budget telemetry.

#### Scenario: Focused tests
- **WHEN** focused tests run
- **THEN** they SHALL cover executed/skipped/failed/degraded providers, budget truncation, fallback reasons, and no structural output drift.

#### Scenario: Regression benchmark
- **WHEN** observe regression benchmark runs
- **THEN** it SHALL protect telemetry shape and budget indicators without requiring live browser-only provider execution.

## MODIFIED Requirements
### Requirement: Observe diagnostics plane
The observe diagnostics plane SHALL include or derive a compact provider budget telemetry summary while preserving existing provider-specific diagnostics and artifact links.

### Requirement: Long-term optimization notes
The long-term observe optimization notes SHALL track cross-provider budget and latency guardrails as a maintained follow-up across P1-P5, not as isolated provider-specific TODOs only.

## REMOVED Requirements
### Requirement: Provider budget status only in scattered provider-specific fields
**Reason**: Scattered budget/timing fields make it difficult to detect cross-provider latency, truncation, and fallback regressions.
**Migration**: Preserve existing provider-specific fields and add a compact normalized summary for common budget telemetry.
