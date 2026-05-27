# NEXT_PHASE

> 下一阶段核心遵循文件。Workstreams A-E 当前主线已完成；完成摘要见 `WORKSTREAMS_A_E_SUMMARY.md`。后续新阶段执行前先读 `AGENTS.md`、`CURRENT.md`、本文件；重大偏离先更新本文件再动代码。

## Phase Theme

工具接口治理与内部可组合性重构。Workstreams A-E 已完成当前主线；下一阶段按 `docs/tool-surface-consolidation-plan.md` 执行 TODO 244-249。目标是把观察层收敛到 `browser_observe` canonical surface，拆清 JavaScript execution 与 bridge command，补 recovery/artifact/progress/snapshot/operation diagnostics，并用显式 profile 管理 Web Security 可见工具面。

## Guiding Constraints

- 保持 Brain-Hand Separation：工具只暴露能力、证据和恢复信息，不替 agent 做策略判断。
- 保持 Semantic Singularity：同类能力只保留一个 canonical 工具；发现重叠先改描述/边界，不急于新增或删除工具。
- 保持 Atomic Composability：优先增强 `browser_execute`、`browser_http_replay`、`browser_artifact`、wait/state/evidence 面。
- 保持 Recoverable Diagnostics：失败结果必须可诊断、可复现、可恢复；长输出走 artifact。
- 保持契约稳定：工具名、参数 schema、错误码、summary/artifact envelope、README/skill 现有声明默认不破坏；TODO 244/245 是显式迁移例外，必须有 wrapper 兼容期、退出步骤、contracts、docs、evals 和 runtime smoke 证据。

## Non-Goals

- 不恢复 `browser_click`、`browser_type`、`browser_query`、semantic DOM 拆分工具。
- 不新增 `browser_orchestrate`、target resolver、desired-state coordinator 或黑箱流程工具。
- 不把 Web Security 拆成新扩展。
- 不新增工具层安全闸、风险分级默认值或能力收缩文案。
- 不新增 `mode:"auto"` observe、透明 tab cache、自动 tab 选择、自动 lease 抢占、自动 recovery 执行或 Web 安全任务分类器。
- 不引入远端 CI/SaaS 监控作为主线验收。

## Active Tool-Surface Workstreams

The active implementation contract is `docs/tool-surface-consolidation-plan.md`.

| TODO | Workstream | Required outcome |
|---|---|---|
| 244 | Observation surface consolidation | Completed: `browser_observe` is the canonical observation tool and legacy `browser_scan` / `browser_content` / `browser_html` are removed. |
| 245 | Execute/command split | Completed: `browser_execute` is JavaScript-only and `browser_command` is the bridge-command-only surface. |
| 246 | Recovery hints and artifact multi-search | Completed: errors expose factual nextActions/recovery and `browser_artifact` supports bounded multi-artifact search. |
| 247 | Progress and stream-ready evidence | Completed phase 1: tool-level progress lands first; final envelopes and artifacts remain authoritative. |
| 248 | Explicit snapshots and operation metadata | Completed: snapshot reuse is explicit and artifact-backed, and operation metadata is diagnostic only. |
| 249 | Web Security capability profiles | Completed: optional visible tool tiers are controlled only by explicit Pi config/profile. |

Each TODO must update `CURRENT.md`, `ROADMAP.md`, `docs/tool-boundaries.md`, README, CHANGELOG, generated docs, relevant contracts/evals, and the global `pi-browser-tools` skill when runtime tool selection changes.

## Workstream A: Tool Boundary & Semantic Singleton Audit

### Goal

建立清晰工具边界矩阵，压缩模型选择成本，防止工具语义漂移。

### Scope

重点审计：

- Observation：`browser_observe` / `browser_screenshot`
- State & Evidence：`browser_network` / `browser_hook` / `browser_evidence` / `browser_artifact`
- Web follow-up：`browser_recon_probe` / `browser_crawl` / `browser_template_check` / `browser_nuclei_bridge`
- Injection：`browser_sqli_probe` / `browser_sqlmap_bridge`
- Fuzzing：`browser_fuzz_paths` / `browser_fuzz_params` / `browser_fuzz_vhosts`
- Core primitive：`browser_http_replay` as focused request replay and mutation primitive

### Deliverables

- Add `docs/tool-boundaries.md` with one row per tool: purpose, use when, do not use when, primary inputs, primary output/evidence, follow-up tools.
- Rewrite overlapping tool descriptions only where boundary is unclear; preserve current schema.
- Update README and global `pi-browser-tools` skill tool-selection wording to the same boundary model.
- Add/extend contract coverage so docs/skill include every registered tool and removed tools stay absent.

### Verification

- `npm run check`
- Skill changed: `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`

## Workstream B: Unified Output & Diagnostics Envelope

### Goal

Make every browser tool result easy to inspect, continue, and recover from without loading raw dumps.

### Target Envelope

Keep current `DistilledEnvelope` compatible while converging summaries toward these optional fields:

- `summary`: compact semantic facts for immediate reasoning.
- `diagnostics`: actionable warnings, limits hit, omitted data, conflict metadata, bridge/session facts.
- `nextActions`: short suggested recovery/continuation actions, phrased as tool+parameter hints, not strategy decisions.
- `artifacts` or existing `saved`: artifact descriptors with path, bytes, mode, redaction status.
- `target`: browserSessionId, browserId/client, tabId, url/origin where applicable.
- `limits`: maxChars, maxBodyBytes, timeoutMs, truncation, match/filter caps.
- `privacy`: redaction metadata when sensitive values may exist.

### Compatibility Rule

Do not remove existing `tool`, `command`, `browserSessionId`, `detailLevel`, `summary`, `saved`. Additive fields only. Existing artifact paths and details must continue to work.

### Implementation Order

1. Add small internal helpers in `resultMiddleware` for `diagnostics`, `target`, `limits`, `privacy`, `nextActions` normalization.
2. Reuse existing `webSecurityToolError`, `ArtifactReaderError`, bridge nested errors; do not create a parallel error hierarchy.
3. Extend high-impact summaries first: network/hook/evidence/html/content/artifact/httpReplay/fuzz/sqli.
4. Standardize actionable errors for: no tab, selector missing, lease conflict, timeout, unsafe regex, artifact path outside root, replay target missing.
5. Keep raw sensitive data in artifacts only; default model-facing output remains redacted.

### Verification

- `tests/contracts/check-summaries.mjs`
- `tests/contracts/check-errors.mjs`
- `tests/contracts/check-artifact-reader.mjs`
- `tests/contracts/check-tools-contract.mjs`
- `npm run check`

## Workstream C: Web Security Internal Primitive Refactor

### Goal

Reduce large-file coupling while preserving the 12 callable Web Security tools and their contracts.

### Preserve Callable Contract

Do not change these tool names, top-level schema meanings, output artifact behavior, bounded execution controls, or bridge semantics:

- `browser_recon_probe`
- `browser_crawl`
- `browser_fuzz_paths`
- `browser_fuzz_vhosts`
- `browser_sqli_probe`
- `browser_sqlmap_bridge`
- `browser_nuclei_bridge`
- `browser_template_check`
- `browser_callback_oast`
- `browser_cookie_analyze`
- `browser_fuzz_params`
- `browser_http_replay`

### Candidate Internal Modules

Extract only internal primitives, in small steps:

- `shared/targets.ts`: scoped target and seed normalization currently spread across `http.ts`, crawl/fuzz/recon.
- `shared/fetchRunner.ts`: bounded fetch execution, redirect handling glue, timeout/maxBodyBytes plumbing.
- `shared/baseline.ts`: response fingerprint, distance, baseline cluster/delta matching for fuzz/replay.
- `shared/rateLimit.ts`: bounded sequential runner and rate-limit helper for crawl/fuzz/probe.
- `shared/matchers.ts`: status/body/header/template matcher and bounded regex helpers.
- `shared/har.ts`: HAR filtering and candidate extraction from `replay.ts`.
- `shared/requestTemplate.ts`: raw/captured request template parsing/building from `replay.ts`.
- `browserNative/crawlExtractors.ts`: HTML/JS/OpenAPI/GraphQL/source-map extraction from `crawl.ts`.
- `browserNative/oastWorkerManager.ts`: callback worker lifecycle from `callbackOast.ts`.

### Step Order

1. Extract no-behavior helpers with tests unchanged: `requestTemplate.ts` and `har.ts` from `shared/replay.ts`.
2. Extract baseline/delta helpers used by fuzz paths/vhosts/params and http replay.
3. Extract crawl extractors; keep `runBrowserCrawl` orchestration readable and bounded.
4. Extract OAST worker lifecycle; keep persisted event contract stable.
5. Only after extraction, tighten type names and remove duplicate loose helpers.

### Verification

- `tests/contracts/check-web-security-tools.mjs`
- `tests/contracts/check-tools-contract.mjs`
- Existing fixture-heavy Web Security checks through `npm run check`
- Runtime smoke only if bridge-facing behavior changes.

## Workstream D: Schema Builder Consolidation

### Goal

Reduce registration drift without hiding tool-specific meaning.

### Candidate Builders

- `targetScopeParams()`: `url`, `urls`, `paths`, `defaultScheme`, optional ports/schemes.
- `rawRequestParams()`: `rawRequest`, `request`, `baseUrl`, `method`, `headers`, `body`, `bodyBase64`, `mutations`.
- `harReplayParams()`: `har`, `harPath`, `harEntryIndex`, `harUrlPattern`, `harMaxEntries`.
- `boundedExecutionParams()`: `timeoutMs`, `maxBodyBytes`, `maxCases/maxCandidates/maxPages`, `rateLimitPerSecond`.
- `artifactResultParams()`: `detailLevel`, `outputPath`, `maxChars`.
- `browserCookieBindingParams()`: `bindBrowserSession`, `cookieMode`, `tabId`, `browserSessionId`.

### Rule

Builders may remove duplicate schema text only when the produced descriptions remain specific enough for the tool. Do not replace precise tool descriptions with generic vague wording.

### Final decision

Implemented high-signal builders only: cookie binding, HAR replay, raw/captured request, request sequence, external process timeout, redirect controls, rate limit, and bounded count/depth/page/template fields.

Do not add `targetScopeParams()` unless future register files introduce exact duplicate target field groups with identical semantics. Current target fields encode seed, base target, FUZZ target, candidate path, replay target, template expansion, port expansion, and nuclei/replay-specific meanings.

Do not add `artifactResultParams()` for current tools. Existing `sharedTabScopedToolParams()`, `sharedWebSecurityParams()`, `sharedWebSecurityBrowserSessionParams()`, and `sharedWebSecurityResultParams()` already centralize `detailLevel`, `outputPath`, and `maxChars` with session/tab/timeout context.

## Workstream E: Realistic ACI Eval Set

### Goal

Measure agent-computer interface quality, not just code contracts.

### Initial Eval Tasks

Create `evals/browser-workflows/` after A-D have stable boundaries:

1. Open local fixture, extract readable article, cite artifact path.
2. Inspect page, choose element via scan, execute JS action, wait for state.
3. Capture network request, replay with one header/body mutation.
4. Diagnose selector missing and recover with `browser_observe mode=html|scan`.
5. Download fixture file and inspect artifact.
6. Trigger wait timeout and verify actionable diagnostics.
7. Run bounded path fuzz against local fixture and explain baseline filtering.
8. Analyze JWT/cookie fixture and produce redacted summary.
9. SQLi oracle fixture: compare probe vs sqlmap bridge roles.
10. Multi-session lease conflict fixture: recover with explicit session/tab handling.

### Deliverables

Completed current static suite:

- `evals/browser-workflows/spec-template.md` plus 10 independent eval specs.
- Synthetic local fixtures under `evals/browser-workflows/fixtures/`.
- `evals/browser-workflows/manifest.json` for manual execution or a future runner.
- `evals/browser-workflows/manual-result-template.json` and `result-schema.json` for compact hand-run evidence records.
- `evals/browser-workflows/results/README.md` for optional manual result storage rules.
- `evals/browser-workflows/future-runner.md` to freeze opt-in runner/server boundaries without implementing them.
- `tests/contracts/check-eval-workflows.mjs` and `check:eval-workflows` in `npm run check`.

Current boundary: no callable tools, no browser execution, no fixture server, no external network, and no scanner/OAST execution. A future runner must be opt-in and separately scoped.

### Metrics

- success/failure
- tool calls
- tokens
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- whether advanced scanners were used only as follow-up

## Execution Policy

- Before each workstream, update `CURRENT.md` with concrete decision, boundary, files, and verification plan.
- Keep each PR/change batch behavior-preserving unless explicitly marked migration.
- Prefer one small extraction per batch over large mixed refactors.
- After each material batch, update `CURRENT.md`, `ROADMAP.md` if ordering changes, README/skill/contracts if user-visible behavior or wording changed.
