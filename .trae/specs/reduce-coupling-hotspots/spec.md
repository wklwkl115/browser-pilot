# 高耦合热点整改 Spec

## Why
当前项目仍存在若干高耦合、深链路热点：extension command 分发重复、daemon `/invoke` 控制面职责过重、observe/execute/result/memory 等链路承担过多横切逻辑。需要按风险分层逐步建立 seam、收窄职责和明确边界，降低后续变更爆炸半径，同时保持公共协议和用户可见行为稳定。

## What Changes
- 统一 extension service worker 中 top-level command dispatch 与 batch dispatch 的分发来源，减少支持集漂移。
- 拆分 daemon `/invoke` 路由中的授权、参数准备、执行与响应组装 pipeline，保持协议与响应格式不变。
- 明确 `src/kernels/session/*` 使用 Node crypto 的边界规则，或将规则写成受治理测试覆盖的显式例外，避免文档与源码标准摇摆。
- 为 `browser_observe` scan runner 建立 characterization tests 与低风险 seam，优先抽离 summary/enrichment/artifact builder，不重写主流程。
- 拆分 result middleware 内部横切 helper，保持对外入口和 envelope shape 稳定。
- 抽出 `browser_execute` monitor adapter，降低 execute 主体与 observe/ABML scan 直接耦合。
- 为 `BrowserBridgeServer` 定义更窄的内部 port 或 dependency interface，先支持逐步迁移，不贸然删除公共方法。
- 分层 memory store 的 domain validation、repository、ranking、evidence/profile enrichment，保留 fact-only 边界行为。
- **不做 BREAKING 变更**：不改变 `browser_*` 公共工具名、daemon HTTP 协议、extension bridge command 协议、result envelope 用户可见字段语义。

## Impact
- Affected specs: extension bridge command dispatch, daemon control API, kernel governance boundary, observe scan pipeline, command result envelope, browser_execute monitor behavior, bridge server runtime port, fact-only memory.
- Affected code: `src/bridge/extension/service_worker/core_commands.ts`, `src/apps/daemon/server.ts`, `CODE_WIKI.md`, governance tests, `src/kernels/session/*`, `src/commands/observe/scanRunner.ts`, `src/commands/resultMiddleware.ts`, `src/commands/executeCommand.ts`, `src/bridge/server/BrowserBridgeServer.ts`, `src/commands/memory/store.ts`, related tests.

## ADDED Requirements

### Requirement: 统一 extension command dispatch
The system SHALL route supported extension bridge commands through one shared dispatch definition so top-level dispatch and batch dispatch cannot silently diverge.

#### Scenario: Single command dispatch succeeds
- **WHEN** a supported non-batch bridge command is dispatched directly
- **THEN** the existing handler is invoked and the response shape remains compatible with the current protocol.

#### Scenario: Batch command dispatch uses the same support set
- **WHEN** a supported command appears inside `batch`
- **THEN** batch dispatch SHALL reuse the same dispatch definition or equivalent shared path, with command-specific context handling preserved.

#### Scenario: Unknown command remains rejected
- **WHEN** an unknown command is dispatched directly or inside `batch`
- **THEN** the command SHALL still produce the existing invalid-rule style error response.

### Requirement: Daemon invoke pipeline seam
The daemon SHALL separate `/invoke` request processing into explicit authorization, argument preparation/validation, command execution, logging, and response shaping steps while preserving the existing HTTP contract.

#### Scenario: Authorized invoke remains compatible
- **WHEN** a valid paired or legacy-allowed client invokes an existing tool
- **THEN** the daemon SHALL return the same `ok`, `content`, `details`, and `terminate` semantics as before.

#### Scenario: Unauthorized invoke remains rejected
- **WHEN** pairing is required and the request has no valid pairing token
- **THEN** the daemon SHALL reject the request with the same status code and auth error code as before.

### Requirement: Kernel Node API boundary is explicit
The project SHALL have one canonical, test-backed rule for whether `src/kernels/session/*` may use Node crypto APIs.

#### Scenario: Governance rule is checked
- **WHEN** governance tests run
- **THEN** they SHALL enforce the chosen kernel Node API rule or explicit session-kernel exception consistently with `CODE_WIKI.md`.

### Requirement: Observe scan runner has safe seams
The observe scan runner SHALL expose internal seams for enrichment, summary projection, and artifact-related construction without changing `browser_observe` behavior.

#### Scenario: Observe output remains characterized
- **WHEN** existing observe scan behavior is exercised by tests
- **THEN** key result envelope fields, artifact hints, ABML summary fields, causal fields, memory surface behavior, and ledger side effects SHALL remain compatible unless explicitly covered by a follow-up spec.

### Requirement: Result middleware internal modules remain behavior-compatible
The result middleware SHALL split redaction, budget fitting, evidence construction, and next-action construction into internal helpers while preserving public command result entrypoints.

#### Scenario: Existing command result envelope remains stable
- **WHEN** representative command results are distilled
- **THEN** envelope shape, redaction behavior, budget fitting, evidence refs, saved artifact metadata, and next actions SHALL remain compatible with existing tests.

### Requirement: Execute monitor adapter
`browser_execute` SHALL delegate monitor before/after scan behavior to a narrow adapter so the command handler no longer directly owns monitor scan details.

#### Scenario: Program monitor still reports changes
- **WHEN** `browser_execute` runs a program with monitor enabled
- **THEN** before/after monitor metadata SHALL still be produced with existing fields and warning behavior.

#### Scenario: Script/program execution without monitor remains unchanged
- **WHEN** `browser_execute` runs without monitor
- **THEN** execution, effect journal, temporal profile, artifact threshold, and result distillation semantics SHALL remain compatible.

### Requirement: Bridge server public surface migration path
The bridge server SHALL gain narrower internal interfaces or ports for command/runtime consumers before any broad public method removal.

#### Scenario: Existing public callers continue working
- **WHEN** existing commands, daemon, and bridge services call `BrowserBridgeServer`
- **THEN** current behavior SHALL continue to work while new code can depend on narrower interfaces.

### Requirement: Memory store layering preserves fact-only behavior
The memory store SHALL separate validation, persistence, ranking, and evidence/profile enrichment responsibilities while preserving fact-only behavior and URI/index compatibility.

#### Scenario: Fact memory still records and recalls
- **WHEN** a valid fact memory is recorded and recalled
- **THEN** existing fact memory behavior, index generation, evidence warnings, and recall ranking semantics SHALL remain compatible.

#### Scenario: SOP-like or non-fact memory remains blocked
- **WHEN** SOP, workflow, playbook, checklist, or non-fact memory content is submitted or present on disk
- **THEN** it SHALL continue to be rejected, ignored, or excluded according to the existing fact-only boundary.

## MODIFIED Requirements

### Requirement: Existing architecture cleanup workflow
Architecture cleanup SHALL proceed in priority order: first low-risk/high-return dispatch and daemon seams plus kernel rule clarification; then characterization-backed observe/result/execute seams; finally long-term bridge server port narrowing and memory store layering.

### Requirement: Existing validation workflow
Every implementation slice SHALL run the relevant `mise` gate for touched areas, and final completion SHALL run `mise run verify`; governance or workflow documentation changes SHALL also run `mise run dev-governance`.

## REMOVED Requirements

### Requirement: None
**Reason**: This change set is refactoring and boundary clarification only.
**Migration**: Existing public behavior and protocol contracts remain in place.
