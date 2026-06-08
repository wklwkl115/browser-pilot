# Browser Tool Surface Consolidation Plan

> Status: COMPLETE / HISTORICAL — TODO 244-249 have all landed (observation-layer consolidation, execute/command split, recovery hints, bounded artifact multi-search, tool-level progress, explicit snapshots/operation metadata, and the original Web Security exposure-boundary decision; the 247 streaming phase 2 is intentionally deferred). Later agent-native architecture work removed the Web Security capability profile entirely: the current callable surface is 22 tools always-on, authoritative in the generated docs.

## Decision source

User accepted the OMO discussion matrix with one adjustment: `browser_observe` consolidation is approved as the desired canonical observation direction.

OMO discussion references:

- Architecture review: `metis` task `b71445b1-1123-479f-bdb8-5a94d9f4d8d3`
- Implementation feasibility: `hephaestus` task `525c14f9-3b1f-4b2c-9483-811bb7034e0e`
- Strict objection review: `momus` task `b1659120-64ff-4132-86ff-e9e4fb1d6ec1`
- Quick synthesis: `oracle` session `2026-05-26T17-56-40-716Z_019e656e-7e8c-70ad-b551-fecc1aeab928.jsonl`

## Governing principles

- Brain-Hand Separation: tools expose perception, execution, evidence, and recovery facts; agents decide strategy.
- Semantic Singularity: every capability class has one canonical callable surface after migration.
- Atomic Composability: prefer precise primitives and explicit modes over black-box workflows.
- Recoverable Diagnostics: failures include structured error facts, target/session state, limits, recovery hints, and artifact paths.
- Evidence First: large, sensitive, partial, or streaming data is persisted as local artifacts and read with bounded artifact tools.
- No Silent Fallback: no cache hit, selector fallback, target fallback, reconnect, or retry may hide its basis.
- No Capability Weakening: Web security tools remain available as explicit scoped follow-up tools; no capability profile, risk-tier gate, or hidden task classifier decides capability.

## Final decision matrix

| Area | Decision | Canonical outcome |
|---|---|---|
| Observation consolidation | Accept | Add `browser_observe` as the planned canonical observation tool. Migrate `browser_scan`, `browser_content`, and `browser_html` into implementation wrappers, then remove them after the compatibility window. |
| Execute/command split | Accept via RFC | Add `browser_command` as the planned bridge-command-only surface. Make `browser_execute` JavaScript-only after migration. Remove JSON-string command promotion from tool-level behavior. |
| Web security exposure tiers | Superseded | Keep all security capabilities in the same package. Later B1 removed capability profiles; current behavior is 22 tools always-on, with Web Security identified only by group metadata. |
| Progress / streaming | Modify | Start with Pi tool-level progress via `_onUpdate` and final artifact-backed envelopes. Add WebSocket stream semantics only after result/finalization/redaction contracts are frozen. |
| Tab content cache | Modify, default-off | No transparent cache. Only explicit snapshot/artifact-backed cache with target/version metadata, visible cacheHit state, and fail-closed stale handling. |
| Artifact multi-search | Accept | Extend `browser_artifact` with bounded multi-artifact search using explicit `paths` or constrained artifact root/glob, max files/bytes/matches, streaming reads, and default redaction. |
| Recovery hints | Accept | Add diagnostics/nextActions hints to errors. Hints are tool+parameter recovery facts, not strategy, not automatic execution, and never a replacement for original error codes. |
| Multi-agent operation metadata | Modify | Expose diagnostic metadata for leases, queues, active operations, progress, and conflicts. Do not auto-select, auto-preempt, or coordinate tasks inside tools. |

## Non-goals

- No `mode:"auto"` observation behavior.
- No selector miss fallback from one observe mode into another.
- No long-term duplicate callable entrypoints for the same capability.
- No `browser_orchestrate`, target resolver, desired-state coordinator, or hidden planner.
- No restoration of `browser_click`, `browser_type`, `browser_query`, or semantic DOM action tools.
- No new jshook-style public browser tools in this workstream; rejected tool-name policy remains documented only in the dedicated TODO 241 closure docs.
- No dynamic hiding of security tools based on site, prompt, risk, or model policy.
- No cache that returns stale DOM without explicit `snapshotId`, target metadata, and stale proof.
- No streaming output that bypasses redaction, budgets, final envelope, or artifact evidence.

## Workstream order

### TODO 244: Observation surface consolidation

Status: completed direct cutover. `browser_observe` is now the only callable observation-layer canonical tool. Legacy `browser_scan`, `browser_content`, and `browser_html` were removed in the same batch to avoid long-lived compatibility debt.

Goal: make `browser_observe` the only observation-layer canonical tool.

Scope:

- Add `browser_observe` with explicit `mode`.
- Preserve all current `browser_scan`, `browser_content`, and `browser_html` behavior through shared internal runners.
- Keep `browser_screenshot` and `browser_frame` separate: screenshot is visual evidence, frame is frame/CDP context management.
- Provide a short compatibility window for old tools; old tools must be thin wrappers and explicitly marked deprecated in metadata/docs during that window.
- Remove old tools at the end of the migration; no permanent aliases.

Planned parameters:

```ts
{
  mode?: "scan" | "content" | "html" | "text" | "tabs"; // default "scan"
  selector?: string;
  url?: string;                 // content navigation only
  includeLinks?: boolean;       // content mode
  maxNodes?: number;            // scan mode
  includeIframes?: boolean;     // scan mode
  htmlMode?: "fragment" | "raw" | "text" | "inner" | "outer";
  textOnly?: boolean;           // scan compatibility where needed
  tabsOnly?: boolean;           // migration alias for mode:"tabs"
  browserSessionId?: string;
  tabId?: number | string;
  detailLevel?: string;
  outputPath?: string;
  timeoutMs?: number;
  maxChars?: number;
}
```

Mode contracts:

- `mode:"scan"`: equivalent to current `browser_scan`, including Scan Manifest v2, actionables/list hints, text signals, same-origin iframe support, and `tabsOnly` behavior through `mode:"tabs"`.
- `mode:"content"`: equivalent to current `browser_content`, including optional URL navigation through durable wait supervisor, Markdown extraction, selector empty/miss/invalid semantics, and content timeout validation.
- `mode:"html"`: equivalent to current `browser_html`, including native `html.get`, exact HTML/text snapshot modes, and bridge selector error preservation.
- `mode:"text"`: deterministic visible/text observation shorthand. It must map to one documented implementation path and return `sourceMode` so agents know what was read. It must not auto-pick between scan/content/html.
- `mode:"tabs"`: tab list only. It must not replace `browser_tabs`; it exists only for observation workflows that need connected tab facts before selecting a target.

Output requirements:

- Include `summary.mode`, `summary.sourceMode`, and `details.sourceCommand`.
- Preserve `target.browserSessionId`, `target.tabId`, and selection/version diagnostics.
- Preserve original raw envelope in `artifactValue` for every mode.
- Preserve existing errors: `SELECTOR_NOT_FOUND`, `INVALID_SELECTOR`, content `empty:true`, content `INVALID_TIMEOUT`, bridge nested errors.
- Do not silently fallback across modes.

Implementation steps:

1. Extract internal runners: `runScanObservation`, `runContentObservation`, `runHtmlObservation`.
2. Register `browser_observe` using the runners.
3. Convert old tools to thin wrappers over the runners and mark deprecated/prefer-observe.
4. Update contracts, budgets, summaries, README, `docs/tool-boundaries.md`, generated docs, CHANGELOG, and global skill.
5. Add evals for structure observation, article extraction, exact HTML slice, selector miss recovery, and old-tool compatibility.
6. Remove old tools in a final migration batch after compatibility evidence is recorded.

Verification:

- `npm run docs:generate`
- `npm run check:tools`
- `npm run check:summaries`
- `npm run check:content-pick`
- `npm run check:scan`
- `npm run check:tool-docs`
- `npm run check`
- Runtime reload smoke: `npm run smoke:browser:scan-summary` plus an observe-specific smoke before old tools are removed.
- If global skill changes: `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`

Exit criteria:

- New tasks can use `browser_observe` for all structure/content/html observation without old-tool references.
- Old wrappers are removed, contracts no longer require `browser_scan`, `browser_content`, or `browser_html`, and docs no longer present them as callable tools.
- No behavior loss versus the three current tools is recorded in contracts/smoke/evals.

### TODO 245: JavaScript execution and bridge command split

Status: completed. `browser_execute` is now JavaScript-only and `browser_command` is the canonical bridge-command surface.

Goal: make JavaScript execution and native bridge command dispatch two precise surfaces.

Scope:

- `browser_execute`: JavaScript only, with optional `monitor` for before/after observation.
- `browser_command`: bridge command object only, with native protocol validation and existing unsafe-command guardrails.
- Tool-level JSON string command detection is removed after migration.
- Bridge router compatibility may remain for low-level external clients only if it is not exposed through `browser_execute` docs or schema.

Output requirements:

- `browser_execute` result details use `mode:"javascript"` only.
- `browser_command` result details use `mode:"command"` and include canonical native command metadata.
- Both preserve target/session/newTabs/acknowledged envelope and artifact behavior.

Implementation steps:

1. Add `browser_command` registration with `command: object` and shared tab-scoped params.
2. Deprecate `browser_execute.command` and JSON-string command path.
3. Update JS action examples to keep CDP command examples under `browser_command`.
4. Remove command support from `browser_execute` after compatibility tests and docs migrate.

Verification:

- `npm run check:tools`
- `tests/contracts/tools/check-execute-tool.mjs` update for JS-only monitor envelope.
- Native command contract coverage for `browser_command`.
- Runtime smoke covering JS action and CDP command separately.

Exit criteria:

- No callable path requires agents to remember JSON-string command promotion.
- No long-term duplicate command dispatch entrypoint remains.

### TODO 246: Recovery hints and bounded artifact multi-search

Status: completed. Errors now expose factual `diagnostics.nextActions` / `recovery`, and `browser_artifact` supports bounded multi-artifact search.

Goal: improve recovery and evidence navigation without adding strategy.

Recovery hints scope:

- Add `diagnostics.nextActions` / `recovery` facts to normalized errors.
- Hints are concrete and local: list tabs, re-observe selector, inspect artifact JSON path, retry with explicit tabId, increase timeout, read network body.
- Hints never auto-execute, never suppress original error code, and never recommend exploit strategy.

Artifact multi-search scope:

- Extend `browser_artifact` with bounded multi-artifact search.
- Accept explicit `paths` first. Optional `root`/`glob` must stay under `.pi/browser-artifacts` unless absolute paths are explicitly provided.
- Require max limits: `maxFiles`, `maxBytes`, `maxMatchesPerFile`, `maxTotalMatches`, `maxChars`.
- Reuse existing safe regex and redaction paths.

Verification:

- `npm run check:artifact`
- `npm run check:errors`
- `npm run check:token`
- `npm run check:summaries`
- `npm run check`

Exit criteria:

- Common tool failures include actionable recovery facts.
- Agents can locate evidence across a bounded artifact set without manually opening every file.
- Sensitive values remain redacted by default in all multi-search snippets.

### TODO 247: Explicit progress and stream-ready evidence contract

Status: phase 1 completed. Tool-level progress is live; stream protocol remains intentionally unimplemented.

Goal: expose long-running operation progress without changing final result semantics.

Phase 1: tool-level progress.

- Use Pi `_onUpdate` where available for crawl/fuzz/sqlmap/nuclei/template/replay long operations.
- Persist progress milestones in artifact metadata when useful.
- Final tool result remains the only success/failure authority.

Phase 2: WebSocket stream protocol.

- Add stream messages only after Phase 1 contracts pass.
- Stream chunks include `id`, `seq`, `event`, `browserSessionId`, `tabId`, `operationId`, redaction metadata, and finalization state.
- All streams end in a final compact envelope and artifact evidence.

Verification:

- Runtime fixtures for progress ordering, cancellation, timeout, redaction, and final result consistency.
- No stream chunk may bypass token budgets or privacy redaction.

Exit criteria:

- Long operations are observable while running.
- Partial progress never masquerades as success.
- Final artifacts reproduce what the model saw in summarized form.

### TODO 248: Explicit snapshots and operation metadata

Status: completed. `browser_observe` snapshots are explicit and artifact-backed; `browser_tabs action=snapshot` exposes snapshot/operation diagnostics.

Goal: improve repeated observation and multi-agent diagnostics without implicit state management.

Snapshot/cache scope:

- No transparent tab cache.
- Add explicit snapshot metadata only after `browser_observe` lands.
- Snapshot identity includes `snapshotId`, `browserSessionId`, `tabId`, URL, frame scope, selectionVersion, sourceMode, capturedAt, ttlMs, invalidatedReason.
- Stale snapshots fail closed unless the caller explicitly asks to read old artifact evidence.

Operation metadata scope:

- Track active operations for diagnostics: operationId, toolName, browserSessionId, tabId, startedAt, phase, progress, queueDepth, lease owner hash, conflict reason.
- Expose metadata through `browser_tabs` list/snapshot and relevant errors.
- Do not auto-select tabs, auto-wait for another agent, auto-preempt leases, or schedule work.

Verification:

- Lifecycle fixtures for lease conflict, queue depth, stale snapshot, disconnected tab, and multi-session operation visibility.
- Runtime smoke only if browser bridge behavior changes.

Exit criteria:

- Agents can diagnose who/what is operating on a tab.
- Repeated observations can reuse explicit artifact-backed snapshots without hiding stale state.
- Existing explicit `tabId` workflow remains the default.

### TODO 249: Web Security exposure boundary

Status: completed, then superseded by agent-native architecture B1. `PI_BROWSER_TOOL_PROFILE` no longer exists; Web Security follow-up tools are always registered as part of the 22-tool surface. Group metadata is organizational only.

Goal: reduce daily tool surface only through visible explicit configuration, without weakening capabilities.

Scope:

- Keep all Web Security tools in this package.
- Do not hide Web Security by prompt, page policy, target risk, LLM task classifier, capability profile, or compact mode.
- Generated docs and CLI discovery document every registered tool as currently callable.

Verification:

- Contract tests assert all 22 tools are registered and CLI parity exposes them.
- Generated docs distinguish core/security groups as metadata only, not enablement tiers.
- Skill text must state Web Security tools are first-class and exposed by default.

Exit criteria:

- Security users get the full explicit tool set with no hidden gating or capability shrinkage.
- Daily automation sees the same public surface; agents use skill guidance, command groups, and natural CLI routes rather than profile-based hiding.

## Documentation synchronization policy

During these workstreams, every implementation batch must update the same batch of docs and contracts:

- `CURRENT.md`
- `ROADMAP.md`
- `NEXT_PHASE.md` if phase ordering changes
- `docs/tool-boundaries.md`
- `docs/generated/browser-tool-contract.generated.md`
- `docs/generated/native-protocol.generated.md` when native protocol changes
- `README.md`
- `CHANGELOG.md`
- `D:/Pi/agent/skills/pi-browser-tools/SKILL.md` when runtime tool selection changes
- Relevant `evals/browser-workflows/*`
- Relevant `tests/contracts/*`

No implementation batch is complete until the docs describe the actual callable state and all planned/deprecated surfaces have either a completion date or a removal step in the same workstream.
