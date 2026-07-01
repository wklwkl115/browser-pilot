# Pilot Readability Content Plane Spec

## Why
`browser_observe` 已能输出 canonical PageObservation，并把 content/text 作为 digest、index、evidence 或 artifact 融入模型，但当前 readable content 主要来自 scan/text 提取，容易保留导航、页脚、广告或样板内容。引入 Mozilla Readability 作为 content plane 的可选 provider，可以改善 article/document 主体内容抽取和 boilerplate removal，同时不影响 actionables、collections、refs 或 ABML 结构权威。

## What Changes
- 调研 `@mozilla/readability` 的 license、browser/MV3 兼容性、bundle size、DOM clone 要求与运行成本。
- 选择最小可行接入形态：作为 explicit 或 bounded optional content provider，而不是替代 scan/ABML 主结构。
- 在 browser-compatible 路径中建立 fail-closed Readability runner，输出 readable title/byline/excerpt/text/content length 与本地 artifact。
- 将 Readability 结果融合到 canonical PageObservation 的 content plane/digest/artifact hints 或 selected legacy content projection 中。
- 保留现有 content/text/html evidence 路径作为 fallback；provider skipped/failed/degraded 状态必须诚实表达。
- 确保 Readability 不生成 actionables、refs、entities、relations、collections，不参与表单/control/actionability 判断。
- 增加 deterministic focused tests、content fixture、artifact/redaction/bounding 覆盖，以及至少一次 live observe/content 对照验证。
- 同步 `CODE_WIKI.md` 与长期优化记录中 P5 Readability 线路状态。

## Impact
- Affected specs: `browser_observe` content plane、PageObservation content digest/artifact hints、legacy/debug content projection、provider diagnostics、observe regression benchmark。
- Affected code: `package.json`、lockfile、`src/commands/observe/*` content/scan projection、artifact handling、tests、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements
### Requirement: Readability provider strategy
The system SHALL choose a minimal Readability provider strategy after evaluating `@mozilla/readability` compatibility, bundle size, DOM clone/runtime constraints, and the safest trigger path.

#### Scenario: Strategy selected
- **WHEN** implementation begins
- **THEN** the selected strategy SHALL document whether `@mozilla/readability` is added as a dependency, where it runs, how it is bounded, and why it does not become ABML structure authority.

### Requirement: Bounded readable content runner
The system SHALL provide a fail-closed readable content runner that can execute in a browser-compatible context and return bounded readable content metadata plus local artifact when enabled.

#### Scenario: Article-like page
- **WHEN** Readability is enabled on an article/document-like page
- **THEN** the system SHALL return a readable title or excerpt, text length, content length, and artifact reference for the extracted readable content.

#### Scenario: Non-article page or provider failure
- **WHEN** Readability returns null, fails to load, throws, times out, or exceeds budget
- **THEN** the system SHALL keep normal observe/content behavior available and mark Readability as skipped, failed, or degraded with a concise reason.

### Requirement: Content-plane-only boundary
The system SHALL treat Readability output as content evidence only, not as Browser Pilot structural, actionability, or collection authority.

#### Scenario: Readability extracts article content
- **WHEN** Readability extracts headings, paragraphs, links, or article body HTML/text
- **THEN** Browser Pilot SHALL NOT create, remove, or reorder actionables, refs, entities, relations, or collections solely from that readable content.

#### Scenario: Default observe
- **WHEN** no-mode `browser_observe` runs without explicit Readability enablement or selected bounded provider trigger
- **THEN** it SHALL preserve the current canonical PageObservation shape and SHALL NOT replace scan/ABML structure with Readability output.

### Requirement: Safe artifact and redaction
The system SHALL store full readable content details in local artifacts and keep inline summaries bounded and safe.

#### Scenario: Large article
- **WHEN** readable content exceeds inline response budget
- **THEN** inline output SHALL contain a bounded digest/preview while full readable text/content stays in a local artifact with safe read commands.

#### Scenario: Sensitive values or raw HTML
- **WHEN** readable content includes URLs, form values, tokens, raw HTML, scripts, styles, or long snippets
- **THEN** summaries and diagnostics metadata SHALL not expose sensitive values or unsafe raw HTML; scripts/styles SHALL be excluded or sanitized from readable output.

### Requirement: Provider diagnostics truthfulness
The system SHALL report Readability provider state according to actual execution state.

#### Scenario: Readability not requested
- **WHEN** Readability is not requested and not selected by the bounded provider policy
- **THEN** diagnostics SHALL omit it or mark it skipped according to the final contract, but SHALL NOT imply it executed successfully.

#### Scenario: Readability executed
- **WHEN** Readability completes within budget
- **THEN** diagnostics SHALL mark it as executed and include content/artifact counts or references.

### Requirement: Regression and live validation
The system SHALL include deterministic tests and bounded live validation for Readability content-plane behavior.

#### Scenario: Focused tests
- **WHEN** focused tests run
- **THEN** they SHALL cover runner success, null/failure fallback, summary bounding, artifact shape, provider status, redaction, and content-plane-only boundary.

#### Scenario: Live validation
- **WHEN** extension and tab are available
- **THEN** a bounded Readability content run SHALL complete on an article/document test page or record a clear environment blocker.

## MODIFIED Requirements
### Requirement: Observe content plane
The observe content plane SHALL be able to reference optional Readability output when explicitly requested or selected by a bounded provider policy, while preserving existing canonical PageObservation semantics, scan-backed fallback content, and provider status honesty.

### Requirement: Dependency and runtime boundaries
Readability libraries SHALL run through a bounded browser-compatible content provider path. They SHALL NOT be imported by `src/kernels/*`, SHALL NOT modify public `browser_*` command catalog unless a deliberate explicit content diagnostics option is selected, and SHALL NOT be treated as scan/ABML/actionability authority.

## REMOVED Requirements
### Requirement: Readable content only from scan/text projection heuristics
**Reason**: Scan/text projection can over-include navigation, footer, ads, and boilerplate on article/document pages.
**Migration**: Keep scan-backed content/text as fallback and add Readability as an optional content-plane provider that can improve readable article/document extraction.
