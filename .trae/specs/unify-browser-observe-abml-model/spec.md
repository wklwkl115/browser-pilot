# 统一 browser_observe ABML 页面模型 Spec

## Why

`browser_observe` 当前把 `scan/content/html/text/tabs` 作为 agent 可见模式暴露，迫使 agent 在观察前选择策略；这与 ABML 的初衷相反。ABML 应把面向人类的浏览器页面编译为面向 agent 的统一、权威、可行动页面模型，让 agent 读取结构化页面事实，而不是选择观察模式、阅读原始 DOM、猜测正文抽取方式或手动请求证据。

## What Changes

- 将 `browser_observe` 的主语义改为“返回当前浏览器状态的权威 ABML 页面模型”，而不是“按显式 mode 返回不同观察投影”。
- **BREAKING**：agent-facing prompt、description、guideline 不再要求或推荐 agent 选择 `mode=scan/content/html/text/tabs`。
- **BREAKING**：省略 `mode` 时，`selector/includeLinks/htmlMode/params/intent` 等参数不得再自动把主返回切换为 `content/html/text/tabs` 投影；无显式 legacy mode 时始终走 canonical ABML 页面模型路径。
- 保留 `mode`、`selector`、`includeLinks`、`htmlMode`、`params` 等旧参数作为 legacy/debug/projection 兼容入口，但它们不再构成主路径，也不得出现在推荐调用心智中。
- 引入 canonical `PageObservation`/ABML envelope 构建层，把 scan、ABML read、tabs context、content digest、text index、HTML/evidence artifacts、memory、snapshot、diff、causal、diagnostics 统一映射到一个固定模型合同。
- 把 `content/html/text/tabs` 从 agent-facing 平级 mode 重新定义为内部 provider、projection、evidence 或 context 来源；它们可以辅助填充统一模型，但不能替代统一模型。
- 输出必须采用预算驱动与 artifact-backed completeness：内联模型保持可读、稳定、紧凑；大块正文、HTML、DOM evidence、截图或长文本通过 artifact 引用支撑完整性。
- 更新 `CODE_WIKI.md`、`README.md`、命令 schema 文案和测试，确保文档、prompt、源码、测试一致。
- 补齐 review 发现的契约缺口：render cache 命中不得改变 canonical 输出形态；显式 `mode=scan` 必须被定义为 legacy/debug scan projection；所有 agent-facing recovery、nextActions、promptGuidelines 不得继续推荐普通 `browser_observe mode=...`。
- 修正 canonical evidence/artifact hints 的 jsonPath 参照系，使 agent 能稳定读取 `PageObservation`、content digest、text index 和 raw evidence。
- 修正 `diff:true` 自动 baseline 选择，使 baseline 按 browser session + tab 维度隔离。
- 增加最终 envelope/CLI 级测试和全局文案扫描测试，防止 helper 级测试通过但实际 agent 输出退化。

## Impact

- Affected specs: `browser_observe` public tool contract, ABML perception contract, command result envelope, observe artifact/evidence handling, command catalog/schema tests, documentation model.
- Affected code:
  - `src/commands/observeCommand.ts`
  - `src/commands/observe/scanRunner.ts`
  - `src/commands/observe/contentRunner.ts`
  - `src/commands/observe/htmlRunner.ts`
  - `src/commands/observe/*` shared helpers/render/cache/artifact modules
  - `src/commands/resultMiddleware.ts`
  - `src/commands/resultNextActions.ts`
  - `src/commands/screenshotCommand.ts`
  - `src/browser-command-runtime/waitSupervisor.ts`
  - `src/bridge/extension/service_worker/wait.ts`
  - `src/kernels/evidence/distill/recovery.ts`
  - `CHANGELOG.md`
  - `src/kernels/abml/*` types only if pure canonical model types need kernel ownership
  - `src/browser-runtime/abml/*` only if provider output shape needs runtime adaptation
  - `tests/**` observe/schema/result coverage
  - `CODE_WIKI.md`
  - `README.md`

## ADDED Requirements

### Requirement: Canonical ABML Observation Contract

The system SHALL make `browser_observe` return one canonical ABML page model for the observed browser state whenever the caller does not explicitly request a legacy projection mode.

#### Scenario: Default observation

- **WHEN** an agent calls `browser_observe()` without `mode`
- **THEN** the command returns a single canonical page observation envelope
- **AND** the envelope represents the current active page as ABML-oriented structured data
- **AND** the envelope includes target context, page gist/outline, entities, actionables, refs, content digest, text index, evidence references, snapshot metadata, memory when available, diff/delta metadata when applicable, and diagnostics
- **AND** the command does not require or infer an agent-selected observation mode.

#### Scenario: Navigation observation

- **WHEN** an agent calls `browser_observe({ url })` without `mode`
- **THEN** the command navigates according to existing navigation behavior
- **AND** returns the canonical ABML page model for the resulting page state
- **AND** does not infer `content/html/text` from the presence of `url`.

#### Scenario: Deterministic model contract

- **WHEN** the same page state is observed under the same budget and runtime conditions
- **THEN** the top-level page observation contract remains structurally stable
- **AND** provider availability or page size may affect detail allocation but not replace the model with a different result shape.

#### Scenario: Render cache hit

- **WHEN** a no-mode `browser_observe` call is served from render cache because the page fingerprint has not changed
- **THEN** the result still exposes the canonical ABML `PageObservation` at the same stable response path as a fresh observation
- **AND** cache metadata such as `fromCache`, `cache.reason`, and `priorSnapshotId` is additive
- **AND** the result does not collapse into a cache-only or mode-specific envelope.

#### Scenario: Final response envelope stability

- **WHEN** the command result is rendered through the normal result middleware or CLI JSON path
- **THEN** the final response contains a stable canonical marker such as `model: "PageObservation"` and `canonical: true` on the documented `PageObservation` path
- **AND** the documented JSON path for gist/content/evidence remains valid under default budgets
- **AND** budget fitting may summarize details but must not remove the canonical observation marker.

### Requirement: No Agent Strategy Selection

The system SHALL not require the agent to choose observation strategy, mode, intent, content extraction, text extraction, or exact evidence as the primary way to use `browser_observe`.

#### Scenario: Prompt guidance

- **WHEN** command metadata is exposed to an agent
- **THEN** `browser_observe` is described as returning the canonical ABML page model
- **AND** prompt guidelines instruct the agent to call `browser_observe` for page observation without choosing modes
- **AND** `mode` is documented only as a legacy/debug/projection override.

#### Scenario: Recovery and next-action guidance

- **WHEN** any public command prompt, recovery action, next action, error hint, wait hint, evidence hint, screenshot guidance, baseline hint, README, CODE_WIKI, or current changelog guidance suggests observing the page
- **THEN** the normal recommendation uses no-mode `browser_observe` or boundary/time parameters such as `diff:true` and `baselineSnapshotId`
- **AND** it does not recommend `browser_observe mode=scan|content|html|text|tabs` unless the phrase explicitly marks the call as legacy/debug/projection compatibility
- **AND** exact DOM/HTML recovery guidance must prefer canonical observation plus artifact/evidence references before mentioning explicit legacy projection.

#### Scenario: No intent-driven planning

- **WHEN** the canonical observation path builds the model
- **THEN** provider selection and inline/detail allocation are based on page state, provider coverage, runtime evidence, budget, snapshot/delta state, and diagnostics
- **AND** not on agent-declared task intent.

### Requirement: Provider Fusion

The system SHALL internally fuse multiple observation sources into the canonical ABML page model. The implementation SHALL either execute real optional providers or explicitly record them as scan-backed/skipped/degraded; documentation and diagnostics must not claim a provider produced independent evidence when it was not executed.

#### Scenario: Provider fusion success

- **WHEN** scan/ABML, content, text, tabs context, memory, diff, causal, and evidence providers are available
- **THEN** their outputs are merged into one page observation envelope
- **AND** scan/ABML remains the authority for structural entities, actionables, stable refs, and actionability state
- **AND** content extraction contributes readable content digest/artifacts
- **AND** text extraction contributes visible text index/digest
- **AND** HTML/DOM exact data contributes evidence artifact references, not the primary model
- **AND** tabs data contributes browser context, not a replacement mode.

#### Scenario: Provider partial failure

- **WHEN** an optional provider fails or is unavailable
- **THEN** `browser_observe` still returns the canonical ABML page model if the core scan/ABML path succeeds
- **AND** diagnostics describe failed or degraded providers
- **AND** missing optional data is represented as absent/degraded fields rather than causing a mode-specific fallback shape.

### Requirement: Artifact-backed Completeness

The system SHALL keep the canonical ABML envelope agent-readable while preserving complete raw evidence through artifacts when needed.

#### Scenario: Large readable content exceeding inline budget

- **WHEN** a page contains long readable content exceeding inline budget
- **THEN** the canonical model includes a content digest and preview
- **AND** complete content is saved or referenced as an artifact when available
- **AND** the model includes artifact metadata sufficient for follow-up retrieval.

#### Scenario: Exact DOM/HTML evidence

- **WHEN** exact DOM/HTML evidence is produced
- **THEN** it is attached as evidence metadata or artifact references in the canonical model
- **AND** it does not replace the model with a raw HTML/text response unless an explicit legacy projection mode is used.

#### Scenario: Artifact hint path accuracy

- **WHEN** canonical observation artifact hints are emitted
- **THEN** each hint uses one documented path reference system, preferably saved artifact root paths
- **AND** the canonical model hint points to the actual `PageObservation` object, not a generic envelope mirror
- **AND** content digest, visible text index, raw scan evidence, and exact evidence hints point to readable locations that exist in the saved artifact or response envelope.

### Requirement: Observation Boundary Parameters

The system SHALL distinguish observation boundaries from observation strategy.

#### Scenario: Allowed primary parameters

- **WHEN** the agent uses primary `browser_observe` parameters
- **THEN** target boundary parameters such as `tabId`, `targetRef`, and `url` remain valid
- **AND** temporal relationship parameters such as `fresh`, `diff`, `baseline`, `baselineSnapshotId`, and `baselinePath` remain valid where applicable
- **AND** budget/output parameters remain valid if the command schema exposes them.

#### Scenario: Session-scoped diff baseline

- **WHEN** `diff:true` auto-resolves the most recent prior scan snapshot
- **THEN** it only selects snapshots from the same `browserSessionId` and effective tab
- **AND** it never uses a same-numbered tab from another browser session as the baseline
- **AND** if no matching snapshot exists it returns a full canonical observation without cross-session diff.

#### Scenario: Strategy parameters not primary

- **WHEN** parameters such as `mode`, `selector`, `includeLinks`, `htmlMode`, `params`, `maxNodes`, `includeIframes`, or `intent` are present
- **THEN** they are handled through explicit compatibility rules
- **AND** they are not used to silently change the default no-mode canonical observation into a different primary result shape.

### Requirement: Legacy Projection Compatibility

The system SHALL preserve existing projection functionality behind explicit legacy/debug mode requests during the transition.

#### Scenario: Explicit legacy content projection

- **WHEN** a caller explicitly requests `mode=content`
- **THEN** the command may return the legacy content projection behavior or a canonical envelope carrying the content projection
- **AND** the result must be clearly identified as legacy/projection in details/diagnostics
- **AND** default no-mode observation behavior remains unaffected.

#### Scenario: Explicit legacy scan projection

- **WHEN** a caller explicitly requests `mode=scan`
- **THEN** the command treats this as a legacy/debug scan projection rather than the canonical no-mode contract
- **AND** the result is clearly identified as legacy/projection in summary/details/diagnostics
- **AND** only omitted `mode` is considered the normal canonical ABML page model path.

#### Scenario: Explicit legacy HTML projection

- **WHEN** a caller explicitly requests `mode=html`
- **THEN** exact HTML/text behavior remains available for compatibility
- **AND** the command metadata must not present this as the primary agent path.

#### Scenario: Explicit legacy tabs projection

- **WHEN** a caller explicitly requests `mode=tabs`
- **THEN** tab inventory remains available for compatibility
- **AND** default no-mode observation includes target/tab context inside the canonical page model rather than requiring `mode=tabs`.

### Requirement: Source Authority Rules

The system SHALL define and enforce authority boundaries across fused providers.

#### Scenario: Structure and actionability authority

- **WHEN** providers disagree about page structure or actionable controls
- **THEN** scan/ABML-derived entities, actionables, refs, and runtime actionability state are authoritative
- **AND** content/text/HTML evidence may support diagnostics or evidence but must not independently mint actionable refs.

#### Scenario: Content authority

- **WHEN** readable document-like content is extracted
- **THEN** content provider output is authoritative for readable content digest/artifact
- **AND** it does not override structural/actionability facts.

#### Scenario: Evidence authority

- **WHEN** exact DOM/HTML/text artifacts are attached
- **THEN** they serve as traceable evidence for model claims
- **AND** they do not become the canonical page model.

## MODIFIED Requirements

### Requirement: `browser_observe` command definition

The system SHALL define `browser_observe` as the canonical ABML page observation command. Its command description, prompt snippet, prompt guidelines, schema descriptions, docs, and tests SHALL align with this definition and SHALL not describe explicit observation mode selection as the normal agent workflow.

### Requirement: Mode normalization

The system SHALL treat absent `mode` as canonical ABML observation. Parameter-based mode inference SHALL NOT switch absent-mode calls into `content/html/text/tabs` projections. Explicit legacy `mode` values SHALL remain accepted subject to compatibility validation.

### Requirement: Result envelope

The system SHALL render canonical no-mode `browser_observe` results as a stable ABML page observation envelope. Existing envelope fields such as `entities`, `gist`, `outline`, `diff`, `treeDiff`, `causal`, `snapshot`, `memory`, `evidence`, `operation`, `target`, and `diagnostics` may be reused, but their organization SHALL consistently communicate a single page model rather than multiple mode-specific outputs.

### Requirement: Documentation

The system SHALL update `CODE_WIKI.md` and `README.md` so they describe ABML as the agent-native page modeling layer and `browser_observe` as the public read entrypoint for the canonical ABML page model. Documentation SHALL make clear that legacy projections exist only for compatibility/debug use.

## REMOVED Requirements

### Requirement: Agent-facing mode choice as normal workflow

**Reason**: Requiring agent-selected `scan/content/html/text/tabs` mode leaks internal observation strategy, creates multiple competing page models, and undermines ABML’s purpose as a unified agent-native page model.

**Migration**: Agents should call `browser_observe()` with only target/time/budget boundaries. Explicit `mode` remains available as a legacy/debug/projection override during migration, but prompt guidance and docs should stop recommending it.

### Requirement: Parameter-implied mode switching for no-mode calls

**Reason**: Inferring `content/html/text` from parameters such as `selector/includeLinks/htmlMode/params/intent` silently changes the result shape and preserves the same trap as explicit mode selection.

**Migration**: No-mode calls always return canonical ABML observations. Strategy-shaped parameters are either rejected with clear diagnostics, ignored with diagnostics when safe, mapped to compatibility behavior only under explicit legacy mode, or represented as model/evidence metadata without replacing the canonical model.

## REVIEW FOLLOW-UP Requirements

### Requirement: Final Envelope Canonical Marker

The system SHALL expose the canonical `PageObservation` marker on a stable final response path that survives result middleware and default budget fitting.

#### Scenario: Low-budget final output

- **WHEN** no-mode `browser_observe` is rendered through result middleware or CLI JSON under a constrained/default budget
- **THEN** the final output still contains a documented canonical `PageObservation` marker with `model: "PageObservation"` and `canonical: true`
- **AND** the marker is not only present in a summary subtree that budget fitting can omit.

### Requirement: Cache-hit Shape Equivalence

The system SHALL make render-cache hits return the same documented canonical observation shape as fresh no-mode observations.

#### Scenario: Cached observation output

- **WHEN** render cache serves a no-mode observation
- **THEN** the final response is not a nested or re-distilled prior envelope
- **AND** only additive cache fields such as `fromCache`, `cache`, and `priorSnapshotId` differ from the fresh-path shape.

### Requirement: Artifact Path Accuracy

The system SHALL make every canonical artifact hint point to an actual readable path in either the final response envelope or saved artifact root.

#### Scenario: Artifact retrieval

- **WHEN** an agent follows a canonical artifact hint for `PageObservation`, content digest, visible text index, raw scan evidence, or exact evidence
- **THEN** the referenced JSON path resolves successfully
- **AND** path labels distinguish response-envelope paths from saved-artifact root paths.

### Requirement: Explicit `mode=scan` Parameter Isolation

The system SHALL not let explicit `mode=scan` use canonical-only semantics accidentally.

#### Scenario: Explicit scan with canonical-only options

- **WHEN** a caller explicitly passes `mode=scan` with canonical-only options such as `diff:true`, baseline auto-selection, causal `actionRef`, or no-mode-only model guarantees
- **THEN** the command either rejects the invalid combination clearly or handles it as an explicitly marked legacy/debug projection without claiming canonical semantics.

### Requirement: CLI Guidance Cleanup

The system SHALL apply no-mode guidance cleanup to CLI-facing help, recovery hints, and artifact/tabs suggestions, not only tool-call guidance.

#### Scenario: CLI text surfaces

- **WHEN** public CLI help, artifact recovery hints, tabs recovery hints, or tests mention observing the page
- **THEN** they recommend `browser-pilot observe --json` or equivalent no-mode/baseline options for normal observation
- **AND** any `--mode scan|content|html|text|tabs` mention is explicitly labeled legacy/debug/projection compatibility.

### Requirement: Runner-level Provider Diagnostics

The system SHALL bind provider diagnostics to actual runner behavior, not just helper defaults.

#### Scenario: Runtime provider degradation

- **WHEN** ABML read fails, tabs refresh falls back, raw artifact is unavailable, or optional content/text/html/evidence is not independently executed
- **THEN** final `PageObservation.diagnostics.providers` reflects the actual executed/scan-backed/skipped/failed/degraded state
- **AND** provider failures include actionable structured reason metadata where available.

### Requirement: Diff Baseline Ordering

The system SHALL select the most recent eligible same-session same-tab baseline independently of snapshot registry iteration order.

#### Scenario: Unsorted snapshot list

- **WHEN** `diff:true` sees multiple eligible snapshots returned in arbitrary order
- **THEN** the selected baseline is the non-expired same-session same-tab scan snapshot with the greatest `capturedAt` and a saved artifact path.
