# Pilot Observe Design Reference Oracle Spec

## Why
P0-P5 已完成 observe benchmark、accessible naming、AX fusion、role mapping、accessibility diagnostics 与 content plane provider 试点；长期优化记录中剩余 P6 是持续借鉴 Playwright、Testing Library、browser-use 与 Stagehand。该路线应沉淀为 Browser Pilot 自己的设计参考与测试 oracle，而不是引入替代 runtime 或站点特定逻辑。

## What Changes
- 调研 Playwright locator/getByRole/ARIA snapshot/auto-wait、Testing Library query priority、browser-use DOM extraction、Stagehand observe/action/extract 分层，并映射到 Browser Pilot 现有 observe/action/content 边界。
- 建立一组 repository-local 的设计参考 oracle：用于检查 refs/actionables/query priority/observe-action-extract 分层是否符合用户中心原则。
- 增加 focused tests 或 benchmark fixtures，覆盖 user-centric actionable ordering、role/name 查询优先级、locator/ref stability、observe/action/extract boundary。
- 不直接引入 Playwright、Testing Library、browser-use 或 Stagehand 作为 runtime dependency。
- 不修改 `browser_*` public command surface，除非后续单独 spec 明确要求。
- 同步 `CODE_WIKI.md` 与 `.trae/notes/abml-observe-long-term-optimization.md`，将 P6 从开放参考更新为已沉淀的 oracle/guardrail。

## Task 1 Reference Mapping

| Reference | Adopt as local guardrail | Do not adopt in P6 | Future-spec only |
|---|---|---|---|
| Playwright locator / `getByRole` | Prefer user-facing role/name, label, placeholder, text, alt/title-style semantics over selector-like or DOM-path strings when observe builds actionables and refs. Locator stability becomes a test oracle for concise semantics that survive framework re-rendering. | Do not import Playwright, expose Playwright locator syntax, or replace Browser Pilot refs with Playwright locators. Do not make `browser_observe` perform actions just because Playwright locators auto-resolve at action time. | Temporal/action readiness can later borrow auto-wait-style language for `browser_execute` or `browser_command`, but not as a Task 1 behavior change. |
| Playwright ARIA snapshot / accessibility snapshot | Treat accessibility-tree-compatible role/name/state as high-signal evidence for actionables, diagnostics, and regression fixtures. | Do not make ARIA snapshots the canonical PageObservation output, and do not make accessibility audits block observe. | A future AX fusion spec may add richer snapshot comparison or browser-specific AX deltas. |
| Playwright auto-wait | Use the design idea that action targets should be resolved near action time and guarded against stale refs. | Do not add implicit waits to `browser_observe`; observe remains structural sensing, not action execution. | Future action-runtime work may define actionability waits under existing command boundaries. |
| Testing Library DOM query priority | Convert the priority ladder into Browser Pilot query-priority oracle: role/name first, then label, placeholder/value/text, alt/title, explicit test contract only when semantic queries are unavailable, and CSS/XPath/framework/generated details as last-resort evidence rather than primary names. | Do not add Testing Library runtime, jsdom assumptions, or Testing Library API names to the public `browser_*` surface. | Additional fixtures may later model `within`-style scoping for containers and collections. |
| browser-use DOM extraction | Borrow LLM-friendly compact state ideas: bounded clickable/actionable lists, stable element indexes/refs, visibility/actionability filtering, and concise text around controls. | Do not adopt browser-use as a dependency, Python/Rust runtime, cloud agent, command set, or index-only action API. Browser Pilot keeps refs/evidence/artifacts and existing `browser_execute`/`browser_command` routes. | More sophisticated viewport/paint-order filtering can be specified separately if current ABML/scan evidence proves insufficient. |
| Stagehand observe/action/extract layering | Use the separation as an oracle: `browser_observe` reports task entry points, refs, relations, content/artifact hints, diagnostics, and evidence; actions stay in `browser_execute`/`browser_command`; precise business extraction stays in execute or artifact reads. | Do not add Stagehand, natural-language act/extract APIs, or site-specific extractors to `browser_observe`. Do not expand the public command catalog for P6. | A future extraction spec may define first-class extraction workflows if it preserves command boundaries and artifact provenance. |

Browser Pilot guardrails derived from this mapping:

- Query priority: fixtures should fail if selector-like, framework/generated class, SVG/path, HTML-like, or long preview strings outrank concise role/name/label-style semantics.
- Locator/ref stability: refs should remain Browser Pilot-owned identifiers backed by concise user-facing evidence and should not become external-framework locators or index-only handles.
- Observe/action/extract boundary: observe is a structural perception layer; exact business values and mutating actions remain outside default observe.
- Runtime dependency boundary: P6 oracle work must not add Playwright, Testing Library, browser-use, or Stagehand dependencies, must not touch generated outputs, and must preserve `src/kernels/*` as pure logic.

## Impact
- Affected specs: `browser_observe` actionables ordering、refs/locators、PageObservation semantics、observe/action/extract boundary、observe regression benchmark。
- Affected code: tests/fixtures around observe summary/projection/ABML refs、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements
### Requirement: External design reference mapping
The system SHALL document how selected ideas from Playwright, Testing Library, browser-use, and Stagehand map to Browser Pilot concepts without replacing Browser Pilot runtime.

#### Scenario: Reference mapping completed
- **WHEN** P6 implementation begins
- **THEN** the mapping SHALL identify which ideas become tests/guardrails, which are explicitly out of scope, and which require future specs.

### Requirement: User-centric query priority oracle
The system SHALL include tests or fixtures that protect user-centric observe ordering and semantic priority for actionables and refs.

#### Scenario: Accessible control candidate
- **WHEN** a candidate has a stable role and accessible name
- **THEN** observe output SHOULD prefer role/name semantics over brittle CSS-selector-like or implementation-specific text.

#### Scenario: Multiple candidates compete
- **WHEN** multiple candidate names/anchors exist for the same actionable
- **THEN** query priority SHOULD favor user-visible role/name/label semantics before framework, DOM path, or long preview strings.

### Requirement: Locator/ref stability oracle
The system SHALL include tests or fixtures that protect stable Browser Pilot refs/locators against low-value implementation details.

#### Scenario: Stable semantic ref
- **WHEN** observe builds a ref for a visible actionable
- **THEN** the ref/locator evidence SHOULD include concise user-facing semantics and avoid SVG/path, HTML-like, selector-like, or long preview pollution.

#### Scenario: DOM implementation noise
- **WHEN** a page contains generated class names, SVG paths, or framework wrappers
- **THEN** observe SHALL not prefer those details as primary user-facing semantic names.

### Requirement: Observe/action/extract boundary oracle
The system SHALL preserve Browser Pilot's command boundary inspired by Stagehand-style layering while retaining Browser Pilot semantics.

#### Scenario: Structural observation
- **WHEN** `browser_observe` summarizes a page
- **THEN** it SHALL expose task entry points, refs, relations, content/artifact hints, diagnostics, and evidence without performing business data extraction as a default behavior.

#### Scenario: Precise extraction needed
- **WHEN** exact business values, table cells, product prices, or site-specific data are needed
- **THEN** the expected route SHALL remain `browser_execute` or artifact reads rather than expanding `browser_observe` into a site-specific extractor.

### Requirement: Runtime dependency boundary
The system SHALL NOT add Playwright, Testing Library, browser-use, or Stagehand as runtime dependencies for this P6 oracle step.

#### Scenario: Dependency review
- **WHEN** implementation completes
- **THEN** package/runtime dependencies SHALL remain free of those external framework dependencies unless a future spec explicitly approves one.

### Requirement: Regression coverage and documentation
The system SHALL add focused regression coverage and update owner documentation for P6 guardrails.

#### Scenario: Validation
- **WHEN** focused tests and repository gates run
- **THEN** they SHALL demonstrate the P6 oracle behavior without requiring live browsers or third-party services.

## MODIFIED Requirements
### Requirement: Long-term observe optimization plan
The long-term observe optimization plan SHALL treat P6 as a repository-local design oracle/guardrail derived from external projects, not as a mandate to replace Browser Pilot runtime or public command contracts.

### Requirement: Observe architecture documentation
The observe architecture documentation SHALL explain the relationship between user-centric locator/query ideas and Browser Pilot's canonical PageObservation, refs, actionables, artifacts, diagnostics, and execute/extract boundaries.

## REMOVED Requirements
### Requirement: P6 as only an informal reference list
**Reason**: A purely informal reference list does not prevent regressions in query priority, locator stability, or observe/action/extract boundaries.
**Migration**: Convert the reference list into explicit mapping notes, focused tests, and CODE_WIKI guardrails while keeping external libraries out of runtime dependencies.
