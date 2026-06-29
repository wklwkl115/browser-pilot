# Tighten Observe List Container Names Spec

## Why
第一轮 observe 语义命名修复已经消除了 SVG/path/HTML markup 污染，但实测 Krill AI pricing 页面时，模型卡片列表仍会把第一条业务卡片长文本作为 `collection.containerName`。这会让 observe 的页面地图把 item sample 误判成容器名，降低 agent 对列表结构的理解质量。

## What Changes
- 收紧 list hint 到 collection/list region 的命名策略：长业务 item preview 不再作为 `containerName`。
- 将 item preview 明确限制为 evidence/sample，用于说明列表内容，而不是默认提升为容器语义。
- 增加“item-like preview”检测，识别价格、倍率、多字段、过长文本、重复 key-value 片段等卡片内容。
- 优先从容器上下文提取短语义名称：aria/labelled-by、附近 heading、section/tab/filter context、稳定 group label。
- 当找不到安全容器名时，使用短 generic fallback，例如 `list-${index}`，并保留 sample 到 evidence。
- 保持 `browser_observe` 不做业务数据抽取，仍只提供结构、命名、refs、collections 和 evidence。

## Impact
- Affected specs: `browser_observe` PageObservation、ABML collection modeling、list hint evidence semantics。
- Affected code: `src/kernels/abml/semanticText.ts`、`src/kernels/abml/entity.ts`、`src/kernels/abml/collections.ts`、`src/scan/summary.ts`、`capture-src/entries/scanTemplate.ts`、observe/ABML 相关测试。

## ADDED Requirements

### Requirement: Long item previews are not authoritative container names
The system SHALL reject first item previews as collection/list-region names when they look like item/card content rather than a container label.

#### Scenario: first item preview is a long pricing card
- **WHEN** a list hint first item preview contains long multi-field business text such as model name, billing mode, rate, input/output prices, and cache prices
- **THEN** `collection.containerName` SHALL NOT use that preview
- **AND** list region `entity.name` SHALL NOT use that preview as the container name
- **AND** the preview MAY remain in evidence/sample fields

#### Scenario: first item preview is short but item-like
- **WHEN** a first item preview is short but clearly resembles an item value rather than a container label
- **THEN** observe SHOULD prefer a safe container label or fallback generic list name

### Requirement: Container names are short, stable labels
The system SHALL prefer short, stable container labels for list collection names.

#### Scenario: nearby section or heading exists
- **WHEN** a repeated list is inside or near a section with a meaningful heading, tab label, filter group label, or accessible container label
- **THEN** `collection.containerName` SHALL use that label if it is safe and concise

#### Scenario: no safe label exists
- **WHEN** no safe short container label can be found
- **THEN** `collection.containerName` SHALL use a generic fallback such as `list-${index}`
- **AND** evidence SHALL still expose a sanitized item sample for diagnostics

### Requirement: Evidence preserves samples without promoting them
The system SHALL preserve useful item previews as list evidence/sample while preventing them from becoming authoritative semantic names.

#### Scenario: item preview rejected as name
- **WHEN** a preview is rejected for `containerName` because it is too long or item-like
- **THEN** observe SHALL still be able to show it as `list hint sample` or equivalent evidence summary when safe

### Requirement: Naming heuristics are deterministic and bounded
The system SHALL use deterministic local heuristics for list naming and avoid broad business-data extraction or model-specific scraping.

#### Scenario: pricing page list is observed
- **WHEN** observe scans a pricing/model-card list
- **THEN** the list name SHALL be a short container label or generic fallback, not the full first card content

## MODIFIED Requirements

### Requirement: Collection model naming
The system SHALL produce `collection.containerName` from safe, concise container semantics. The system SHALL NOT use raw HTML/SVG/path snippets, selector-like strings, or long item/card previews as collection names. First item previews SHALL be treated as samples/evidence unless they pass strict concise-container-label criteria.

### Requirement: List region entity naming
The system SHALL name list region entities using the same safe concise container-name strategy as collections, so region and collection semantics remain aligned.

## REMOVED Requirements

### Requirement: Safe first item preview fallback as list container name
**Reason**: Even sanitized item previews can be semantically wrong when they are card/item content, especially on pricing, product, order, feed, or search-result lists.
**Migration**: Use container labels first; otherwise use generic fallback names while preserving first item preview as evidence/sample.
