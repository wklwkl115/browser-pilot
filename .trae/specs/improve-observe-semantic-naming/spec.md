# Improve Observe Semantic Naming Spec

## Why
`browser_observe` 已经按设计承担页面结构感知与行动地图职责，业务数据提取继续由 `browser_execute` 完成。当前 observe 在复杂 React/Tailwind 页面中仍会把 SVG/path 或第一条列表项误用为语义名称，导致控件、列表和 collection 的 agent-facing 描述不够稳定。

## What Changes
- 为 observe/ABML 的控件、列表区域和 collection 命名引入统一的语义文本清洗与候选选择规则。
- 防止 SVG/path/HTML-like 片段进入 `entity.name`、ref semantic name、list region name 或 `collection.containerName`。
- 将 list hint 的“容器名称”和“样例项预览”职责拆清：容器名优先来自列表容器语义，样例项只作为 evidence/sample。
- 增强 icon/SVG-heavy 控件的命名来源，但保持 observe 不直接提取业务数据。
- 增加专项测试覆盖 SVG/icon、list hint、collection name 和 ABML entity semantic 行为。
- 不改变 `browser_execute` 作为精确业务数据提取路径的设计边界。

## Impact
- Affected specs: canonical `browser_observe` PageObservation、ABML entity/ref semantic、collection modeling、scan evidence。
- Affected code: `capture-src/entries/scanTemplate.ts`、`src/kernels/abml/entity.ts`、`src/kernels/abml/collections.ts`、`src/scan/summary.ts`、observe/ABML 相关测试。

## ADDED Requirements

### Requirement: Semantic text sanitization for observe names
The system SHALL sanitize candidate semantic names used by observe/ABML so that SVG/path snippets, HTML-like markup, selector-like strings, and low-value technical tokens are not promoted as user-facing semantic names.

#### Scenario: SVG path is present as candidate text
- **WHEN** a scan actionable or list hint provides `<path ...>` or `<svg ...>` as candidate text
- **THEN** observe SHALL not use that value as `entity.name`, ref semantic name, list region name, or `collection.containerName`

#### Scenario: meaningful text is present with SVG noise
- **WHEN** a candidate set includes both meaningful visible/accessible text and SVG/HTML-like noise
- **THEN** observe SHALL prefer the meaningful text and discard the SVG/HTML-like noise

### Requirement: List container naming is separate from item samples
The system SHALL treat list container names and list item samples as separate concepts.

#### Scenario: list has a container label
- **WHEN** a repeated list container has an accessible label, labelled-by text, nearby heading, or stable container heading
- **THEN** `collection.containerName` and list region entity name SHALL prefer that container label over the first item preview

#### Scenario: first item is only SVG/icon markup
- **WHEN** a repeated list's first item preview is SVG/path/HTML-like markup and no container label is available
- **THEN** `collection.containerName` SHALL fall back to a safe generic name such as `list-${index}` rather than exposing markup
- **AND** the raw sample MAY remain in local artifact evidence only if it is not promoted as semantic name

### Requirement: Icon-heavy control names use accessible and nearby semantics
The system SHALL improve names for icon/SVG-heavy controls by using accessible attributes and safe textual affordances before falling back to technical selectors.

#### Scenario: icon button has aria-label or title
- **WHEN** an icon-only button or SVG-backed control has `aria-label`, `title`, `alt`, or labelled-by text
- **THEN** observe SHALL use that accessible text as the semantic control name

#### Scenario: icon button has no accessible name
- **WHEN** an icon/SVG-heavy control has no accessible or safe nearby text
- **THEN** observe SHALL avoid naming it with SVG/path markup and MAY leave it unnamed or use a generic role-based fallback

### Requirement: ABML entity semantic naming is consistent with observe summaries
The system SHALL align ABML entity semantic naming with the cleaned candidate strategy used by observe summaries, while preserving privacy rules for editable values.

#### Scenario: displayLabel is the best safe candidate
- **WHEN** scan evidence provides a safe `displayLabel` and no higher-priority safe action/label/text exists
- **THEN** ABML entity semantic naming MAY use `displayLabel`

#### Scenario: editable field has a value
- **WHEN** an editable field has a runtime value
- **THEN** observe SHALL NOT promote that value into `entity.name` or `entity.value` beyond existing safe behavior

## MODIFIED Requirements

### Requirement: `browser_observe` returns an agent-facing page map, not business data extraction
The system SHALL keep `browser_observe` focused on structure, actionability, refs, semantic names, collections, relations, evidence pointers, and diagnostics. It SHALL NOT attempt to extract complete business records that should be obtained through `browser_execute` or artifact-specific reads.

### Requirement: Collection model naming
The system SHALL produce `collection.containerName` from safe container semantics when available. The system SHALL NOT use raw HTML/SVG/path snippets as collection names. First item previews SHALL be treated as samples/evidence, not authoritative container labels.

## REMOVED Requirements

### Requirement: First item preview as authoritative list container name
**Reason**: First item previews are samples, not container names, and can contain SVG/path/HTML markup on icon-heavy pages.
**Migration**: Use safe container labels first, then safe generic fallback names. Preserve first item previews only as sanitized sample/evidence where useful.
