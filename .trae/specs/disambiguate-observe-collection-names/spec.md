# Disambiguate Observe Collection Names Spec

## Why
前两轮优化已经解决 SVG/HTML 污染和长 item/card preview 被误用为容器名的问题，但 Krill AI pricing 实测中多个不同 list collection 仍可能共享同一个短名称，例如 `筛选`。同名 collection 会降低 PageObservation 作为页面地图的可读性，尤其在 sidebar filter、main content card list、导航列表同时存在时。

## What Changes
- 为 observe collection/list region 增加轻量、确定性的同名消歧策略。
- 当同一 PageObservation 中多个 collection 的 `containerName` 相同，使用安全上下文生成更可区分的短名称。
- 消歧上下文优先来自稳定结构信息：landmark/role、main/sidebar/nav 区域、附近 heading/tab/group label、安全 sample category、selector locality。
- 保持原始短容器名可追溯，例如在 evidence/hints 中记录 base name 或 disambiguation reason。
- 不引入站点 hardcode，不执行业务数据抽取，不将长 item/card preview 重新提升为容器名。

## Impact
- Affected specs: `browser_observe` PageObservation、ABML collection modeling、list region entity semantics、collection evidence diagnostics。
- Affected code: `src/kernels/abml/collections.ts`、`src/kernels/abml/entity.ts`、`src/kernels/abml/semanticText.ts`、`capture-src/entries/scanTemplate.ts`、observe/ABML 相关测试。

## ADDED Requirements

### Requirement: Duplicate collection names are disambiguated
The system SHALL avoid returning multiple sibling collection models with identical `containerName` when safe short disambiguation context is available.

#### Scenario: multiple collections share the same base name
- **WHEN** a PageObservation has more than one collection named `筛选`
- **THEN** observe SHALL produce distinguishable short collection names when safe context exists
- **AND** the names SHALL remain concise and user-facing

#### Scenario: no safe context exists
- **WHEN** duplicate collection names exist but no safe disambiguation context can be derived
- **THEN** observe MAY append a deterministic generic suffix such as an ordinal or role-based qualifier
- **AND** it SHALL NOT use long item/card preview as the disambiguator

### Requirement: Disambiguation uses bounded structural context
The system SHALL use bounded structural context for collection name disambiguation.

#### Scenario: collection is in sidebar/filter area
- **WHEN** a duplicate-named collection is located in sidebar, complementary, navigation, aside, or filter group context
- **THEN** its name SHOULD include a short qualifier such as sidebar/filter context if safe

#### Scenario: collection is in main content area
- **WHEN** a duplicate-named collection is located in main content, model list, pricing card, or result-list context
- **THEN** its name SHOULD include a short qualifier derived from safe structural context or generic collection role

### Requirement: Base names and evidence remain traceable
The system SHALL preserve evidence that explains how a collection name was disambiguated.

#### Scenario: name is disambiguated
- **WHEN** a collection `containerName` is changed from a base name to a qualified name
- **THEN** evidence or hints SHALL retain the base name and/or disambiguation reason for diagnostics

### Requirement: Disambiguation preserves previous safety guarantees
The system SHALL not regress the existing observe naming safety guarantees.

#### Scenario: pricing card sample exists
- **WHEN** a pricing/model-card preview exists as item sample
- **THEN** it SHALL remain evidence/sample only and SHALL NOT be used as the collection name or disambiguation suffix

#### Scenario: SVG markup exists in page
- **WHEN** SVG/path markup appears in DOM
- **THEN** it SHALL NOT be promoted into collection names, region names, or semantic refs

## MODIFIED Requirements

### Requirement: Collection model naming
The system SHALL produce collection names that are safe, concise, stable, and distinguishable within the same PageObservation when feasible. Duplicate base names SHALL be qualified using bounded structural context or deterministic generic suffixes.

### Requirement: List region entity naming
The system SHOULD align list region entity names with disambiguated collection names when both represent the same list hint, so PageObservation entities and collections remain coherent.

## REMOVED Requirements

### Requirement: Duplicate short collection names are acceptable without qualification
**Reason**: Duplicate names such as `筛选` for both sidebar filter lists and main model-card lists reduce agent readability and make collection references harder to reason about.
**Migration**: Preserve base names in evidence/hints and expose disambiguated names in `collection.containerName` where safe.
