# Pilot Dom Accessibility API Spec

## Why
observe 当前仍维护大量手写 accessible name 规则，例如 `aria-label`、`aria-labelledby`、`title`、`alt`、label、sr-only 和 nearby text。引入 `dom-accessibility-api` 试点可以把标准 accessible name/description 计算交给成熟库，减少长期维护成本，并提升 icon-only button、表单 label、labelled-by 等场景的命名稳定性。

## What Changes
- 调研并引入 `dom-accessibility-api` 作为 browser-side scan 的可选 accessible name provider。
- 在 `labelOf(el)` 或等价扫描命名路径中优先使用 `computeAccessibleName(el)`，再 fallback 到现有手写规则。
- 试点范围限定在 actionables、list container candidates、heading/container label candidates，不进行全 DOM 无限制计算。
- 增加 bundle size、extension build、scan benchmark/fixture 回归验证，确保依赖引入不会破坏 MV3 扩展构建。
- 保留现有安全清洗与 ABML semantic guardrails，防止长 item/card preview、SVG/path、HTML-like、selector-like 字符串进入 semantic names。

## Impact
- Affected specs: `browser_observe` accessible naming、ABML entity semantic names、list/container label detection、observe regression benchmark。
- Affected code: `package.json`、lockfile、`capture-src/entries/scanTemplate.ts` 或 scan bundle entry、`scripts/build-bridge.mjs`/extension build path、observe/scan/benchmark tests。

## ADDED Requirements

### Requirement: Accessible name provider integration
The system SHALL use `dom-accessibility-api` to compute accessible names for selected scan candidates when it is available and safe to call.

#### Scenario: icon button has standard accessible name
- **WHEN** an actionable icon button has accessible text through `aria-label`, `aria-labelledby`, `<label>`, `title`, or equivalent standard accessible-name sources
- **THEN** scan SHALL prefer the `computeAccessibleName` result as the candidate label

#### Scenario: accessible name is empty or unsafe
- **WHEN** `computeAccessibleName` returns an empty, unsafe, or low-value value
- **THEN** scan SHALL fallback to the existing hand-written candidate logic and semantic sanitization

### Requirement: Bounded scan usage
The system SHALL call accessible-name computation only on bounded candidate sets.

#### Scenario: large DOM page is scanned
- **WHEN** observe scans a large page
- **THEN** `computeAccessibleName` SHALL only run for actionables and selected container/heading candidates, not every DOM node indiscriminately

### Requirement: Extension build compatibility
The system SHALL keep browser extension build and runtime compatible with Manifest V3 after adding `dom-accessibility-api`.

#### Scenario: bridge extension is built
- **WHEN** `npm run build:bridge` or the equivalent verification gate runs
- **THEN** the extension bundle SHALL build successfully and include only browser-compatible code

### Requirement: Naming safety is preserved
The system SHALL preserve existing observe naming safety guarantees after adopting `dom-accessibility-api`.

#### Scenario: accessible-name result contains markup-like or long item content
- **WHEN** computed accessible name contains SVG/path markup, HTML-like text, selector-like text, or long item/card preview
- **THEN** existing semantic sanitization SHALL reject it before it reaches ABML names, refs, or collection names

### Requirement: Benchmark captures accessible-name behavior
The system SHALL add regression coverage for accessible-name improvements and safety fallbacks.

#### Scenario: labelled-by control fixture
- **WHEN** an offline scan/benchmark fixture models a labelled-by or icon-only control
- **THEN** tests SHALL verify the accessible name is preferred when safe

## MODIFIED Requirements

### Requirement: Scan label candidate priority
The system SHALL compute labels for selected scan candidates using this priority: safe `computeAccessibleName` result, then existing explicit attribute/form/sr-only/nearby text fallback, then generic role/selector fallback where appropriate.

### Requirement: Observe regression benchmark
The observe regression benchmark SHOULD include at least one case that protects accessible-name provider behavior or validates fallback safety.

## REMOVED Requirements

### Requirement: Hand-written accessible name logic as the only label source
**Reason**: Maintaining custom accessible-name behavior for all ARIA/labelled-by/title/label cases is error-prone and duplicates standards work.
**Migration**: Use `dom-accessibility-api` for selected candidates, keep existing logic as fallback and safety net.
