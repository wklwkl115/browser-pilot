# Fuse CDP Accessibility Tree Spec

## Why

当前 observe 已有 DOM scan 与 ABML AX runtime 两条采集路径，但 scan 侧的 selector/ref/visibility/hit-test 与 CDP Accessibility tree 的 role/name/state/层级信息还没有形成稳定的融合输出。完成 CDP Accessibility tree + DOM scan fusion 可以减少控件语义缺失、状态不准和 DOM/AX 两套实体割裂的问题，同时保持 `browser_observe` 的 canonical PageObservation 边界。

## What Changes

- 将现有 CDP `Accessibility.getFullAXTree` / `DOMSnapshot.captureSnapshot` 结果与 DOM scan actionables / list hints / entity refs 进行 bounded fusion。
- 以 `backendNodeId`、已有 ref descriptor、geometry overlap 和 bounded structural context 作为融合键，不引入站点特定规则。
- 将 AX role/name/description/states 与 DOM scan selector/ref/rect/actionability/evidence 合并到 ABML/PageObservation 可消费的实体与 diagnostics。
- 对 AX provider 失败、CDP 不可用、节点缺失或跨 frame 不匹配场景提供 degraded diagnostics，并保留现有 scan-only 输出。
- 更新离线 regression benchmark 和 focused tests，保护命名安全、状态融合、provider diagnostics 与性能边界。
- 同步 `CODE_WIKI.md` 与长期优化记录中 P2 路线状态。

## Impact

- Affected specs: `browser_observe` canonical PageObservation、ABML entity/relations/collections、observe regression benchmark、scan provider diagnostics。
- Affected code: `src/browser-runtime/abml/axRuntime.ts`、`src/commands/observe/scanRunner.ts`、`src/commands/observe/scanProjection.ts`、`src/kernels/abml/*`、`src/scan/*`、`tests/bootstrap/*`、`tests/memory/*`、`CODE_WIKI.md`、`.trae/notes/abml-observe-long-term-optimization.md`。

## ADDED Requirements

### Requirement: DOM scan and CDP AX fusion

The system SHALL fuse DOM scan entities with CDP Accessibility tree entities when both providers are available and can be matched safely.

#### Scenario: actionable DOM node has matching AX node

- **WHEN** DOM scan reports an actionable with a stable ref/selector/geometry and CDP AX reports a node with matching `backendNodeId` or equivalent bounded identity
- **THEN** the resulting PageObservation entity SHALL preserve DOM scan actionability/ref data and enrich it with AX role/name/description/states where safe.

#### Scenario: AX node has useful state metadata

- **WHEN** AX tree contains states such as expanded, selected, checked, disabled, level, posinset, setsize, or value for a matched actionable/list item
- **THEN** the fused entity SHALL expose those states through existing ABML-compatible fields or a bounded metadata field without breaking existing output shape.

#### Scenario: AX-only meaningful control exists

- **WHEN** AX tree contains an interesting named control that DOM scan did not surface but geometry/ref resolution is available
- **THEN** observe MAY append it as an AX-backed entity with diagnostics indicating source `ax`, while preserving existing DOM scan entities.

### Requirement: Safe fallback and diagnostics

The system SHALL degrade to current DOM scan behavior when CDP Accessibility tree collection or fusion is unavailable.

#### Scenario: CDP AX provider fails

- **WHEN** `Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`, or geometry resolution fails
- **THEN** `browser_observe` SHALL still return the existing scan-backed PageObservation and include a provider failure or degraded diagnostic instead of failing the whole observe.

#### Scenario: fusion match is ambiguous

- **WHEN** multiple AX nodes could match one DOM scan node or geometry overlap is insufficient
- **THEN** the system SHALL avoid unsafe enrichment and keep the DOM scan entity unchanged, optionally recording bounded diagnostics.

### Requirement: Safety and boundary preservation

The system SHALL preserve existing semantic safety and architecture boundaries while adding AX fusion.

#### Scenario: unsafe AX text is present

- **WHEN** AX name/description contains SVG/path markup, HTML-like text, selector-like text, editable values, or long item/card preview text
- **THEN** the value SHALL NOT enter user-facing semantic names.

#### Scenario: kernel boundary is evaluated

- **WHEN** implementing fusion
- **THEN** `src/kernels/*` SHALL remain pure logic and SHALL NOT call CDP, browser APIs, file I/O, bridge APIs, or page DOM directly.

### Requirement: Bounded performance

The system SHALL bound CDP AX fusion cost and avoid unbounded per-node CDP calls.

#### Scenario: large page observe runs

- **WHEN** a page contains many DOM/AX nodes
- **THEN** fusion SHALL reuse `Accessibility.getFullAXTree` and `DOMSnapshot.captureSnapshot` data where possible, cap fallback geometry calls, and expose timing/count diagnostics.

## MODIFIED Requirements

### Requirement: browser_observe canonical PageObservation

The system SHALL continue to return canonical PageObservation for no-mode `browser_observe`, now allowing provider diagnostics and fused evidence to distinguish scan-only, AX-enriched, AX-only, degraded, and skipped provider states.

### Requirement: ABML entity construction

The system SHALL construct ABML entities from DOM scan and AX evidence using deterministic, safe, and bounded fusion rules, with DOM scan remaining the source of actionability/ref execution data and AX tree serving as semantic/state enrichment.

## REMOVED Requirements

None.
