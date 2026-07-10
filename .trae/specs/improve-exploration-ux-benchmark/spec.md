# Improve Exploration UX And Observe Benchmark Spec

## Why
用户反馈指出 Browser Pilot 在快速探索场景中的主要摩擦集中在网络捕获时序、artifact 阅读路径、桥接往返延迟和 observe benchmark 样本覆盖。当前已有 artifact hints 与 observe benchmark 基础设施，但还缺少直接面向探索工作流的组合能力、命令级 artifact inspect/paths，以及更明确的 latency telemetry 和更多离线 benchmark 样本。

## What Changes
- 增强 network capture UX，提供“先开始捕获，再刷新/等待，再读取摘要”的顺滑流程，避免页面加载后才启动导致漏掉早期请求。
- 新增或扩展 artifact inspect / paths 命令能力，基于现有 `artifact_hints` 快速列出可读路径和读取建议。
- 增加 bridge latency telemetry 与小型 batch/compound UX，帮助用户识别桥接/CDP/命令耗时，并减少快速探索中的多次 round-trip。
- 扩展 observe regression benchmark 的离线样本，覆盖更多真实页面形态风险，例如 docs、dashboard/table、virtualized list、iframe/shadow DOM 等。
- 保持现有 public command surface 最小扩展；不改变 canonical `browser_observe` 的 sensing-only 语义。
- 不引入真实外站、真实浏览器或网络依赖到默认 benchmark 门禁。

## Impact
- Affected specs: network capture、artifact hints/schema、CLI artifact reading、command latency diagnostics、batch UX、observe regression benchmark。
- Affected code: network command handlers、CLI command metadata/help、artifact command/result middleware、bridge/client command timing、tests/memory benchmark fixtures、governance/docs、`CODE_WIKI.md` / README。

## ADDED Requirements
### Requirement: Network capture reload workflow
The system SHALL provide a straightforward workflow that starts network capture before reload/navigation and returns a useful capture summary afterward.

#### Scenario: Capture complete reload chain
- **WHEN** a user requests network capture with reload enabled
- **THEN** capture SHALL start before the page reload/navigation is triggered
- **AND** the result SHALL include captured requests emitted during reload, bounded summary counts, and an artifact path when saved.

#### Scenario: Capture timing guidance
- **WHEN** a user starts network capture without reload/navigation
- **THEN** the result or help text SHALL clearly explain how to capture early page-load requests using the reload workflow.

### Requirement: Artifact inspect and paths discovery
The system SHALL provide a user-facing way to inspect saved artifacts and list stable readable paths.

#### Scenario: List artifact paths
- **WHEN** a user runs artifact path discovery for a saved artifact
- **THEN** the command SHALL return artifact kind/schema version when available, saved path, preferred reads, JSON paths, and compact descriptions.

#### Scenario: Inspect artifact summary
- **WHEN** a user inspects a saved artifact
- **THEN** the command SHALL return a compact summary and the most useful read paths without inlining large raw payloads.

### Requirement: Bridge latency telemetry
The system SHALL expose compact latency telemetry for commands where timing is available.

#### Scenario: Command completes
- **WHEN** a command completes through the bridge/CLI path
- **THEN** the result diagnostics SHOULD include bounded timing fields that distinguish total command time from bridge/client/runtime timings when available.

### Requirement: Batch exploration UX
The system SHALL provide a minimal batch or compound exploration path for common multi-step flows.

#### Scenario: Network capture batch
- **WHEN** a user requests a network capture reload flow
- **THEN** the system SHALL perform the required start/reload/wait/read sequence as one user-facing operation where feasible.

#### Scenario: Observe batch remains sensing-only
- **WHEN** batch/compound UX includes observe
- **THEN** it SHALL not change `browser_observe` structural authority, actionability, refs, or sensing-only boundary.

### Requirement: Observe benchmark expanded fixtures
The system SHALL expand offline observe regression benchmark coverage for additional page archetypes.

#### Scenario: Benchmark runs offline
- **WHEN** the observe regression benchmark runs
- **THEN** new samples SHALL run without live browser, extension, network, external sites, or browser-only providers.

#### Scenario: New page archetype coverage
- **WHEN** benchmark cases model docs, dashboard/table, virtualized list, iframe/shadow DOM, or GitHub-like pages
- **THEN** they SHALL protect semantic names, collection stability, actionables precision, provider telemetry shape, and canonical PageObservation compatibility.

## MODIFIED Requirements
### Requirement: Network command usability
Network command UX SHALL support both low-level start/read flows and a higher-level reload capture flow for complete request-chain capture.

### Requirement: Artifact readability
Artifact readability SHALL include both embedded `artifact_hints` in command results and an explicit inspect/paths command for saved artifact files.

### Requirement: Command diagnostics
Command diagnostics SHALL prefer compact bounded telemetry and avoid exposing secrets, large request bodies, or large raw artifacts inline.

## REMOVED Requirements
### Requirement: Manual-only early network capture workflow
**Reason**: Requiring users to manually sequence `network start`, reload, wait, and read is error-prone and causes missed early requests.
**Migration**: Keep low-level commands for advanced use, but provide a higher-level reload capture workflow as the recommended path.
