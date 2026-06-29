# Add Observe Regression Benchmark Spec

## Why
ABML / observe 会长期演进，单靠页面级 heuristic 容易出现“修一个页面、坏另一个页面”的回归。需要先建立轻量、可重复、可纳入项目门禁的 observe regression benchmark，用固定 fixture 和指标约束 PageObservation 质量。

## What Changes
- 增加 observe regression benchmark 的 fixture、指标和测试入口。
- 用离线 fixture/纯逻辑测试优先覆盖已有问题：SVG/HTML 污染、长 containerName、重复 collection name、sample 保留、canonical no-mode shape。
- 建立可扩展的 benchmark case 格式，后续可逐步加入 Krill、LINUX DO、GitHub、docs、dashboard、virtualized list、iframe/shadow DOM 等样本。
- 不依赖真实浏览器端到端测试作为基础门禁，避免 flakiness；真实 Edge observe 继续作为人工/专项实测补充。
- 不改变 `browser_observe` 的公开契约，只新增测试与 benchmark harness。

## Impact
- Affected specs: `browser_observe` PageObservation、ABML regression quality gates、observe maintenance workflow。
- Affected code: `tests/` benchmark fixtures/harness、`scripts/run-tests.mjs` scope、`mise.toml` gate wiring、必要时 `CODE_WIKI.md` 测试地图。

## ADDED Requirements

### Requirement: Offline observe regression benchmark
The system SHALL provide an offline observe regression benchmark that can run without a live browser or extension.

#### Scenario: benchmark runs in CI/local gate
- **WHEN** the benchmark command is executed
- **THEN** it SHALL evaluate fixed observe/ABML fixtures and return deterministic pass/fail results

#### Scenario: live browser is unavailable
- **WHEN** Chrome/Edge extension is not connected
- **THEN** the benchmark SHALL still run because it uses offline fixtures or pure logic builders

### Requirement: Benchmark quality metrics
The benchmark SHALL check stable observe quality metrics that protect recent ABML/observe improvements.

#### Scenario: markup pollution exists
- **WHEN** a fixture contains output names with `<path`, `<svg`, or raw HTML-like strings
- **THEN** the benchmark SHALL fail that case

#### Scenario: collection names regress
- **WHEN** a fixture has long item/card previews or duplicate collection names
- **THEN** the benchmark SHALL verify that final collection names are concise, safe, and distinguishable

#### Scenario: evidence samples are preserved
- **WHEN** item preview is rejected as a container name
- **THEN** the benchmark SHALL verify that safe sample/evidence remains available

### Requirement: Extensible benchmark cases
The benchmark SHALL use a simple case structure that can grow over time.

#### Scenario: adding a new page pattern
- **WHEN** a developer adds a new observe regression case
- **THEN** they SHALL be able to define fixture input, expected metrics, and assertions without a live browser dependency

### Requirement: Canonical observe path remains protected
The benchmark SHALL protect canonical no-mode `browser_observe` PageObservation shape and avoid reintroducing legacy projection reliance.

#### Scenario: no-mode observe behavior changes
- **WHEN** code changes affect observe scan shaping
- **THEN** benchmark or existing tests SHALL fail if canonical PageObservation shape is lost

## MODIFIED Requirements

### Requirement: Project validation gates
The project SHALL include observe regression benchmark coverage in the appropriate local validation path, preferably `mise run affected` through the existing test runner scope. Release readiness SHALL continue to be covered by `mise run verify`.

### Requirement: Observe maintenance workflow
Future ABML/observe heuristic changes SHOULD add or update benchmark cases that capture the intended behavior and prevent known regressions.

## REMOVED Requirements

### Requirement: Real-browser-only observe quality validation
**Reason**: Real browser tests are valuable but too environment-dependent for baseline regression gates.
**Migration**: Use offline benchmark cases as the default gate, and keep live Edge/Chrome observe runs as supplemental verification for selected pages.
