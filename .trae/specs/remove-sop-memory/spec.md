# 删除 SOP 并内核化 Memory Spec

## Why
当前 memory 模块同时承载 SOP 流程复用、fact 事实记忆、observe 自动注入、result 自动提示、profile/staleness 和本地持久化，导致功能语义偏宽且与浏览器执行链路耦合较深。需要彻底删除 SOP 部分，并将剩余 fact memory 收拢为独立、内核化、边界清晰的本地事实记忆能力。

## What Changes
- **BREAKING** 删除 memory 的 SOP 能力：不再允许记录、召回、读取、索引、自动注入或提示 `kind=sop` 记忆。
- 将 memory 的公开语义收缩为 fact-only 本地事实记忆，不再表达“操作流程复用”或“per-site procedures”。
- 移除 `.browser-pilot/memory/sop/` 扫描、`browser-memory://sop/<id>` URI 支持、`sop_` 新记录生成和 SOP frontmatter fallback。
- 解耦 observe/result middleware 与 memory 的 SOP 行为，保留必要的 fact memory 自动上下文能力时必须通过窄接口接入。
- 收拢 memory 模块边界：纯逻辑保持在 `src/kernels/memory/*`，文件系统/持久化保持在 `src/memory/*`，命令 schema 和 envelope 适配保持在 `src/commands/*`，不得跨层反向依赖。
- 更新权威文档中关于 SOP、Browser Memory、memory 模块边界、公共工具契约和验证方式的描述。
- 不编辑生成产物 `dist/` 和 `bridge/browser_pilot_bridge/`。

## Impact
- Affected specs: Browser Memory、`browser_memory` 公共工具、observe memory augmentation、result envelope memory、memory kernel 边界、repository validation workflow、架构文档一致性。
- Affected code: `src/commands/memoryCommand.ts`, `src/commands/memory/**`, `src/commands/observe/memoryAugmentation.ts`, `src/commands/observe/scanRunner.ts`, `src/commands/resultMiddleware.ts`, `src/commands/summaries/**`, `src/memory/**`, `src/kernels/memory/**`, `src/types/**`, `src/bridge/extension/service_worker/protocol.ts`, `README.md`, `CHANGELOG.md`, `CODE_WIKI.md`, `tests/**`。

## ADDED Requirements
### Requirement: Fact-only memory model
The system SHALL model browser memory as fact-only local context after this change.

#### Scenario: Recording fact memory
- **WHEN** `browser_memory` records a memory entry
- **THEN** the entry kind SHALL be `fact`, use the facts storage location, and produce a fact-compatible id, URI, index entry, recall card, and read result.

#### Scenario: Rejecting SOP record
- **WHEN** a caller attempts to record or validate `kind=sop`
- **THEN** the system SHALL reject the request through command schema or validation without creating files, index entries, tombstones, profile changes, or record hints.

### Requirement: No SOP recall or read surface
The system SHALL not expose SOP memory through automatic or manual memory surfaces.

#### Scenario: Automatic observe memory augmentation
- **WHEN** `browser_observe` builds memory augmentation for a page
- **THEN** SOP entries SHALL NOT be scanned, recalled, injected, summarized, or shown in `envelope.memory`.

#### Scenario: Manual recall and read
- **WHEN** `browser_memory action=recall` or `browser_memory action=read` is used
- **THEN** SOP entries and `browser-memory://sop/<id>` SHALL NOT be returned as supported memory resources.

### Requirement: Independent memory boundaries
The system SHALL keep memory as an independent capability with explicit layer boundaries.

#### Scenario: Kernel boundary remains pure
- **WHEN** memory kernel code is modified
- **THEN** `src/kernels/memory/*` SHALL remain pure logic with no browser, Node filesystem, Node crypto/path/process, npm runtime, bridge, commands, browser-runtime, or daemon dependencies.

#### Scenario: Command and observe integration stays narrow
- **WHEN** commands or observe need memory behavior
- **THEN** they SHALL depend on narrow memory APIs rather than duplicating storage, routing, staleness, or profile logic in command/result middleware code.

### Requirement: Documentation and compatibility clarity
The system SHALL document the SOP removal and fact-only memory behavior in existing authoritative documentation.

#### Scenario: Documentation updated
- **WHEN** the implementation changes public behavior or module ownership
- **THEN** `CODE_WIKI.md` and relevant public docs SHALL no longer describe SOP procedures as supported memory behavior and SHALL describe memory as fact-only local context.

## MODIFIED Requirements
### Requirement: `browser_memory` public command
`browser_memory` SHALL continue to provide fact-oriented memory operations that remain local to the caller `cwd`, but it SHALL no longer advertise, accept, create, index, recall, or read SOP memory.

### Requirement: Memory storage layout
The memory storage implementation SHALL use `.browser-pilot/memory/facts/`, `index.json`, `profiles/`, `.secret`, `.lock`, and tombstones as needed for fact memory, but SHALL not create or scan `.browser-pilot/memory/sop/` for active memory behavior.

### Requirement: Observe memory augmentation
`browser_observe` MAY surface relevant fact memory in `envelope.memory` when enabled and within response budget, but SHALL not surface procedural SOP content or use SOP entries as warm-start or recall input.

### Requirement: Result auto-surface
Result middleware SHALL NOT add next actions that suggest recording SOPs. Any remaining memory prompt SHALL be fact-oriented, conservative, and must not imply reusable operation-flow execution.

### Requirement: Validation workflow
The implementation SHALL run repository-appropriate `mise` validation. Scope validation SHALL use `mise run affected`; completion validation SHALL use `mise run verify`. If governance/workflow rules are changed, `mise run dev-governance` SHALL also pass.

## REMOVED Requirements
### Requirement: SOP memory kind
**Reason**: SOP entries represent reusable operation procedures that can blur the project’s live observation and explicit execution model, increase stale-flow risk, and expand memory’s product scope beyond fact/context support.
**Migration**: Stop accepting new SOP records, stop scanning existing SOP files, stop supporting SOP URIs, and update docs to describe fact-only memory. Existing `.browser-pilot/memory/sop/` files are left untouched on disk but ignored by the application.

### Requirement: SOP automatic record nudge
**Reason**: Automatic suggestions to record reusable procedures encourage flow capture and reuse in execution contexts.
**Migration**: Remove SOP-specific next actions. If any memory nudge remains, it must be fact-oriented and avoid procedural execution language.

### Requirement: SOP observe auto-surface
**Reason**: Automatically surfacing procedure bodies can steer agents toward stale action sequences even when no code directly executes SOPs.
**Migration**: Observe memory augmentation only considers fact memory and keeps live page observation as the execution basis.
