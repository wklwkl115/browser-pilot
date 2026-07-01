# Pilot axe-core Diagnostics Spec

## Why
当前 Browser Pilot 已通过 DOM scan、`dom-accessibility-api`、role provider 与 CDP AX fusion 改善页面语义建模，但缺少标准化 accessibility diagnostics artifact 来定位 unnamed controls、missing labels、bad ARIA 和 landmark 问题。完成 axe-core 线路优化可以把 accessibility issue 作为可选诊断证据补充到 observe/doctor 体系中，同时避免把 axe 结果变成主结构、actionability 或 refs 权威。

## What Changes
- 调研 `axe-core` 的 license、browser/MV3 兼容性、bundle size、运行成本与 API 形态。
- 选择最小可行接入形态：优先作为显式 diagnostics/debug 能力或 bounded optional provider，而不是每次 no-mode `browser_observe` 默认完整运行。
- 在浏览器页面世界或 bridge/runtime 中建立 fail-closed 的 axe diagnostics runner，输出 bounded accessibility diagnostics artifact。
- 将 axe 诊断结果与 `PageObservation.diagnostics` 或现有 artifact/evidence 机制关联，但不生成 actionables、refs、entities 或 collections。
- 对 provider skipped/failed/degraded/executed 状态提供诚实 diagnostics，不把未执行的 axe 标记为成功。
- 增加 focused tests、fixture 和至少一个 real observe/diagnostics 实测，保护输出边界、redaction、性能预算和 fallback。
- 同步 `CODE_WIKI.md` 与长期优化记录中 P4 axe-core 线路状态。

## Impact
- Affected specs: `browser_observe` diagnostics、PageObservation provider diagnostics、accessibility diagnostics artifact、doctor/debug diagnostics workflow。
- Affected code: `package.json`、lockfile、`src/scan/*` 或 browser-runtime diagnostics runner、observe/diagnostics envelope、artifact handling、CLI/schema/docs as needed、tests、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements
### Requirement: axe-core diagnostics strategy
The system SHALL choose a minimal axe diagnostics strategy after evaluating `axe-core` compatibility, bundle size, runtime latency, and whether diagnostics should be triggered by explicit command/debug option or bounded optional provider.

#### Scenario: Strategy selected
- **WHEN** implementation begins
- **THEN** the selected strategy SHALL document whether `axe-core` is added as a dependency, where it runs, how it is bounded, and why it does not become the main observe path.

### Requirement: Bounded axe diagnostics runner
The system SHALL provide a fail-closed axe diagnostics runner that can execute in a browser-compatible context and return a bounded diagnostics summary plus local artifact when requested.

#### Scenario: Successful diagnostics run
- **WHEN** axe diagnostics is explicitly requested or enabled by a bounded diagnostics path
- **THEN** the system SHALL return issue counts by impact/rule, selected safe issue summaries, and a saved local artifact for full diagnostics details.

#### Scenario: Runner unavailable or fails
- **WHEN** axe-core fails to load, cannot run on the target, times out, or exceeds budget
- **THEN** the system SHALL keep normal observe/doctor behavior available and mark axe diagnostics as skipped, failed, or degraded with a concise reason.

### Requirement: Diagnostics-only boundary
The system SHALL treat axe output as diagnostics evidence only, not as Browser Pilot structural or actionability authority.

#### Scenario: axe reports an issue on a control
- **WHEN** axe reports a missing label, bad ARIA, color contrast, landmark, or similar accessibility issue
- **THEN** Browser Pilot SHALL NOT create or remove actionables, refs, entities, relations, or collections solely from that axe result.

#### Scenario: canonical observe without axe
- **WHEN** no-mode `browser_observe` runs without explicit axe diagnostics enablement
- **THEN** it SHALL keep its current canonical PageObservation shape and SHALL NOT run a full axe scan by default.

### Requirement: Safe artifact and redaction
The system SHALL store axe diagnostics details in local artifacts with bounded summaries and existing redaction/privacy conventions.

#### Scenario: Large diagnostics result
- **WHEN** axe returns many violations or large node targets/html snippets
- **THEN** inline output SHALL be summarized and truncated, while full details stay in a local artifact with safe read commands.

#### Scenario: Sensitive values in DOM snippets
- **WHEN** axe output contains attributes, text, URLs, or snippets that may include secrets
- **THEN** summaries and diagnostics metadata SHALL not expose sensitive tokens, cookies, authorization values, or long raw DOM snippets.

### Requirement: Provider diagnostics truthfulness
The system SHALL report axe provider state according to actual execution state.

#### Scenario: axe not requested
- **WHEN** axe diagnostics is not requested
- **THEN** diagnostics SHALL mark axe as skipped or omit it according to the final chosen contract, but SHALL NOT imply axe executed successfully.

#### Scenario: axe requested and completed
- **WHEN** axe diagnostics completes within budget
- **THEN** diagnostics SHALL mark axe as executed and include counts/artifact references.

### Requirement: Regression and live validation
The system SHALL include deterministic tests and a bounded live validation path for axe diagnostics.

#### Scenario: Focused tests
- **WHEN** focused tests run
- **THEN** they SHALL cover runner success, unavailable/failure fallback, summary bounding, provider diagnostics state, artifact shape, and diagnostics-only boundary.

#### Scenario: Live validation
- **WHEN** extension and tab are available
- **THEN** a bounded diagnostics run SHALL complete on a simple test page or record a clear environment blocker.

## MODIFIED Requirements
### Requirement: Observe diagnostics plane
The observe diagnostics plane SHALL be able to reference optional accessibility diagnostics evidence when explicitly requested or enabled, while preserving existing canonical PageObservation semantics and provider status honesty.

### Requirement: Dependency and runtime boundaries
Accessibility diagnostics libraries such as `axe-core` SHALL run through a bounded browser-compatible diagnostics path. They SHALL NOT be imported by `src/kernels/*`, SHALL NOT modify public `browser_*` command catalog unless a deliberate explicit diagnostics command is selected, and SHALL NOT be treated as scan/ABML model authority.

## REMOVED Requirements
### Requirement: Accessibility diagnostics only from handcrafted scan/AX signals
**Reason**: Handcrafted scan/AX signals can identify structure and some semantic quality issues, but they do not provide standard WCAG-style diagnostics for missing labels, invalid ARIA, and landmark problems.
**Migration**: Keep scan/AX diagnostics as structure/provider health signals, and add axe-core as an optional diagnostics evidence source with bounded artifact output.
