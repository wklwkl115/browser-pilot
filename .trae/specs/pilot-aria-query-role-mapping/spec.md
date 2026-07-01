# Pilot aria-query Role Mapping Spec

## Why
当前 browser-side scan 仍用手写 `roleOf(el)` 推断少量 HTML implicit roles，覆盖面有限且可能与标准 ARIA/HTML role mapping 存在偏差。继续完成 aria-query 线路优化，可以减少 role mapping 维护成本，提升 `browser_observe` 中 actionables、references、controls_pairs 与 ABML entities 的 role 稳定性，同时保留 Browser Pilot 自己的 actionability、hit-test 与 semantic safety 规则。

## What Changes
- 调研 `aria-query` 的 package 入口、license、browser/MV3 兼容性、bundle size 与 API 形态。
- 比较 `aria-query` 与现有 `dom-accessibility-api.getRole(el)` 的能力重叠，选择最小可行 role provider 方案。
- 在 scan script 构建链路中新增 bounded role provider，优先补强 `roleOf(el)` 的 implicit role mapping。
- 保留 explicit role 安全处理与现有 hand-written fallback，provider 初始化失败或返回低价值结果时不影响 scan。
- 不把 `aria-query` 或 role provider 依赖引入 ABML kernels、extension/bridge 公共协议或 command catalog。
- 不用 `aria-query` 替代 clickable、editable、hit-test 或 Browser Pilot actionability 判断。
- 增加 focused tests 与 observe regression benchmark case，覆盖标准 role mapping 改善和 actionability 不退化。
- 同步 `CODE_WIKI.md` 与长期优化记录中 P3 线路状态。

## Impact
- Affected specs: `browser_observe` role mapping、scan actionables、reference targets、controls_pairs、ABML entity role semantics、observe regression benchmark。
- Affected code: `package.json`、lockfile、`src/scan/buildScanScript.ts`、scan provider bundle 文件、`capture-src/entries/scanTemplate.ts`、scan/summary/observe benchmark tests、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements
### Requirement: Role provider strategy
The system SHALL choose a minimal role provider strategy for scan implicit role mapping after comparing `aria-query` with the already bundled `dom-accessibility-api.getRole(el)` capability.

#### Scenario: Strategy selected
- **WHEN** implementation begins
- **THEN** the selected strategy SHALL record whether a new `aria-query` dependency is required, whether existing provider code can be reused, and why the selected path is the smallest safe step.

### Requirement: Browser-side role provider integration
The system SHALL expose a bounded browser-side role provider to the scan template without importing npm packages directly from `capture-src/entries/*`.

#### Scenario: Provider available
- **WHEN** scan evaluates an element with no explicit role
- **THEN** `roleOf(el)` SHALL use the provider's implicit role result when it is safe and meaningful.

#### Scenario: Provider unavailable
- **WHEN** the provider fails to initialize, throws, or returns an empty/unsafe/low-value role
- **THEN** scan SHALL fall back to the existing legacy `roleOf(el)` behavior and still produce PageObservation output.

### Requirement: Standard implicit role improvements
The system SHALL improve standard HTML implicit role mapping for common elements where the current hand-written mapping is incomplete or overly broad.

#### Scenario: Anchor with href
- **WHEN** scan sees `<a href="/docs">Docs</a>`
- **THEN** role mapping SHALL classify it as `link`.

#### Scenario: Anchor without href
- **WHEN** scan sees `<a>Docs</a>` without `href`
- **THEN** role mapping SHALL NOT promote it to implicit `link` solely because it is an anchor element.

#### Scenario: Input with datalist
- **WHEN** scan sees an editable input associated with a datalist
- **THEN** role mapping SHOULD follow standard role semantics while preserving Browser Pilot editable/actionability state.

#### Scenario: Structural landmarks
- **WHEN** scan sees structural elements such as `nav`, `main`, `section`, `form`, `header`, or `footer`
- **THEN** role mapping MAY expose meaningful landmark roles without turning those elements into actionables by role alone.

### Requirement: Explicit role and fallback safety
The system SHALL keep explicit role handling safe and preserve the existing fallback behavior for important controls.

#### Scenario: Explicit role present
- **WHEN** an element has an explicit `role` attribute
- **THEN** scan SHALL prefer a safe explicit role value over implicit provider results.

#### Scenario: Legacy critical controls
- **WHEN** provider output is unavailable for `button`, `input`, `select`, or `textarea`
- **THEN** the existing control role fallback SHALL continue to classify these elements consistently enough for actionables and form summaries.

### Requirement: Actionability boundary
The system SHALL NOT treat ARIA role metadata as a replacement for Browser Pilot actionability, hit-test, visibility, editable, or event-handler logic.

#### Scenario: Role-only structural element
- **WHEN** a non-interactive element receives a structural role from the provider
- **THEN** Browser Pilot SHALL NOT mark it clickable unless existing clickable evidence applies.

#### Scenario: Interactive evidence remains authoritative
- **WHEN** an element is clickable due to existing Browser Pilot evidence such as event handlers, cursor, hit target, or native interactive semantics
- **THEN** role provider changes SHALL NOT remove that actionable solely because provider role metadata is narrower.

### Requirement: Regression coverage
The system SHALL include focused tests and observe regression benchmark coverage for role provider behavior.

#### Scenario: Focused scan tests
- **WHEN** focused scan tests run
- **THEN** they SHALL cover provider initialization/fallback and representative implicit role cases including anchor with href, anchor without href, search input, datalist input, image alt edge cases, summary/details, and structural landmarks.

#### Scenario: Observe benchmark
- **WHEN** observe regression benchmark runs
- **THEN** it SHALL protect canonical PageObservation behavior from actionables pollution or role-based regression caused by provider changes.

## MODIFIED Requirements
### Requirement: Scan role mapping pipeline
The scan role mapping pipeline SHALL derive element roles through this bounded order: safe explicit role, selected browser-side role provider implicit role, and legacy hand-written fallback. It SHALL sanitize and normalize role output before downstream use by actionables, references, controls_pairs, scan summary, and ABML integration.

### Requirement: Dependency and runtime boundaries
Accessibility helper libraries used for scan role/name semantics SHALL be bundled or injected through `src/scan/*` build-time provider code and page-world wrappers. They SHALL NOT be imported by `src/kernels/*`, public command catalog, bridge protocol types, or generated output directories.

## REMOVED Requirements
### Requirement: Hand-written role mapping as the only implicit role source
**Reason**: Maintaining all HTML/ARIA implicit role behavior manually is error-prone and duplicates standard accessibility mapping knowledge.
**Migration**: Keep the current `roleOf(el)` mapping as fallback while adding a bounded provider path for standard implicit roles.
