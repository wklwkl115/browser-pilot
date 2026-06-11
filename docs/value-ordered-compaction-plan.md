# Value-Ordered Compaction Plan

> Status: **complete 2026-06-11.** Approved
> in direction by the maintainer (2026-06-11); updated 2026-06-11 to fold in the
> ABML kernel audit decisions — new P0 hygiene slice, P3 kernel cap-ledger seeds,
> and the K6 selected/pressed eval probe.
> This contract migrates the remaining hard numerical truncation ("first-N" selection)
> into the distill-core token economy as value-ordered projection, consolidates
> scattered presentation-compaction logic into the kernel for decoupling, and clears
> the audit-confirmed ABML kernel defects first.
>
> Lineage: successor to `docs/archive/perception-renderer-plan` /
> `docs/archive/renderer-default-flip-plan` (the first graduation: scan envelopes moved
> from ladder truncation to salience allocation). This plan is the second graduation:
> the paths that still truncate by position — artifact JSON reads, generic sampling,
> per-tool distiller leftovers — move onto the same value economy.
>
> Tactical precursors: `docs/real-session-friction-plan.md` E2 (empty-array fold) and
> E3 (notFound nearest-parent frontier) are **complete** (2026-06-11); P1 below
> generalizes both and E2's regression test carries over.
>
> Governance: activation entry registered in `CURRENT.md` before execution started.

## Evidence

- Real session `019eb646` (2026-06-11, deepseek-v4-flash, Huawei SRC form): a
  `data.actionables` read of 80 homogeneous items returned 7 items/page under byte
  budget (requested limit 80); the agent abandoned enumeration after 3 pages. Per-item
  weight ~600 bytes, of which >70% is constant across all 80 items (empty `handlers`
  window envelopes, constant booleans, repeated structure).
- Hard-truncation survey: **107 `slice(0, N)` occurrences across 40 files in `src/`**,
  plus page-side caps in capture templates. Representative presentation-layer sites:
  `src/tools/artifactReader.ts:498` (json item limit 40),
  `src/distill-core/ladder.ts:124,130,138,154,170,188` (rung-internal `slice(0,4)`),
  `src/tools/summaries/generic.ts:4` (`SAMPLE_LIMIT = 5`),
  `src/tools/toolAdapter.ts:246` (binary-search byte fit — mechanics correct, kept).
- Replay golden available: the session's scan artifact
  (`observe-scan-1781174652248.json`, 502,782 bytes, 80 actionables) still exists
  locally and becomes the P1 regression fixture (copied into `tests/fixtures/` in
  redacted form).
- ABML kernel audit (2026-06-11, 11 subagent-verified dimensions: consumption surface,
  spec drift, diff-family liveness, determinism, caps/redaction, test coverage). Every
  P0 item below cites code verified during the audit; findings that did **not** survive
  verification are recorded at the end of P0 so they are not re-litigated.

## Completion Evidence (2026-06-11)

- **P0 complete.** K1-K5 landed with direct ABML unit/contract coverage; K6 took the
  schema-surface branch: `EntityStateSchema` now carries `selected`, `pressed`, and
  `current`, and output-schema conformance checks a full widget state.
- **P1 complete.** `browser_artifact mode=json` homogeneous array reads now use
  `projection:"folded-v1"` by default, preserve deterministic source order, expose
  frontier retrieval, and keep heterogeneous / escape-hatch fallback controls.
- **P2 complete.** The measured inline JSON fit engine lives in distill-core and is
  consumed by tool result rendering and projection without changing public tools.
- **P3 complete.** `docs/compaction-ledger.json` is committed and
  `check:compaction-ledger` is wired into the contracts group; current ledger evidence:
  `slice sites=243, classB=97/101, migratedB=2`.
- **P4.1 complete.** Generic bridge-result sampling now uses value-ordered folded
  projection for large homogeneous object arrays; selector/actionability-like arrays
  stay on compact shape fallback to avoid token growth.
- **Blind sentinel executed.** Two fresh-context Codex subagents used
  `pb-blind.mjs` against isolated real `https://www.bilibili.com/`. The list-heavy
  card task completed without enumeration abandonment. The active-tab K6 probe
  completed, confirmed the ARIA schema branch was necessary, and recorded a separate
  n=1 CSS-class active-state hypothesis in `blind-findings.md` without overfitting.
  Runtime follow-up after rebuild verified large execute projections now include a
  saved artifact path and correct top-level target URL:
  `.pi/browser-artifacts/execute-1781193991324.json`.

## Problem Statement

Truncation is a selection problem. A byte budget (how much) is a **constraint**; which
bytes survive is a **ranking**. Fixed `slice(0, N)` welds the ranking to "document
order, first N" — uncorrelated with task value on high-variability pages, so
information density collapses as pages grow. Three independent defects compound:

1. **Position-ordered selection.** First-N keeps whatever happened to serialize first.
2. **Dead weight.** Homogeneous arrays repeat constant fields N times; empty
   sub-windows render ~90-byte envelopes; the budget pays for entropy-free bytes.
3. **Uncoordinated multi-layer cuts.** The same data is truncated up to three times on
   one read path (capture cap → distiller cap → byte fit), each layer blind to the
   others, each reserving its own margin.

## Cap Taxonomy (not all numbers are the problem)

| Class | Examples | Treatment |
|---|---|---|
| A — work/safety bounds | page-side 100 aria-pairs, 500-element visibility scan, 25MB read cap, safe-regex limits | **Keep where the work happens.** Register in the caps ledger (P3) so they are visible, never silently grown. |
| B — presentation selection | json item limit 40, `slice(0,4)` rung interiors, `SAMPLE_LIMIT 5`, per-tool distiller cuts | **Migrate to value-ordered projection** under distill-core. |
| C — windowing mechanics | binary-search byte fit, `nextOffset` paging | **Keep mechanics, fix density.** Consolidate the fit engine into the kernel (P2). |

Mechanical classification test for any constant: *does changing it alter what the agent
sees (B), or how much work the page/tool performs (A)?* Presentation constants belong
to the kernel; work bounds stay at the work site.

## Owner Decision Recorded

Scattered presentation-compaction logic **enters distill-core** (the express kernel)
for decoupling: one auditable subsystem owns "what reaches the agent's context",
benchmarkable by `bench:distill`-class harnesses, tunable through one capped surface,
boundary-locked by `check:distill-core-boundary`. Public surface stays thin; the
internal engine thickens — per the agent-first constitution.

## Design Principles

1. **Budget is a constraint, selection is a ranking, every cut is a frontier.** The
   three concerns stay orthogonal in code: budget arrives from the existing
   ladder/envelope contract; selection is computed by projection; whatever is cut emits
   a navigable frontier (count + one concrete retrieval call).
2. **Value selects, order presents.** Ranking decides *membership* of the rendered set
   (top-K under budget); the surviving items render in **document/source order**.
   Agents reason spatially (form fields in order); scoring must never scramble
   presentation order.
3. **Fold structure before spending budget.** Homogeneous arrays render as
   template + variant tuples: constant fields stated once (with exceptions called out:
   "all `hitOk:true` except item 17"), per-item output limited to discriminative
   fields ranked by empirical variance/cardinality; numeric near-constants fold to
   range summaries. Precedent: `abml-core/grouping.ts` `buildTemplate()` does exactly
   this for DOM siblings; this plan generalizes it to arbitrary JSON.
4. **Cut once, at the last responsible moment.** Upstream layers pass full-fidelity
   data (within class-A bounds); the projection layer applies the single budget cut.
   No layer re-truncates what a later layer will fit anyway.
5. **Deterministic and self-describing.** Same input + same relevance context ⇒
   byte-identical output (stable tie-breaks by source index, no Map-iteration order).
   Output carries `projection:"folded-v1"` self-description (the `renderer:"salience-v1"`
   precedent) and frontier metadata.
6. **Zero unjustified constants — not zero constants.** Rate-distortion structure:
   a fidelity-vs-cost system must be given a budget (or a distortion tolerance) from
   outside; that number cannot be derived from the data being compressed. The end
   state is therefore a **single-axiom budget tree**: one root budget (constant, or
   caller/harness-supplied at runtime — `detailLevel` is the existing crude form),
   with every sub-budget a documented ratio/allocation derived from it. All other
   numbers must be one of: (a) decisions derived from the objective function itself
   (see principle 7), (b) work bounds on untrusted input whose values are derived
   once from a declared latency model and documented next to the constant (counts,
   not deadlines — counts are the deterministic proxy that preserves replay
   contracts), or (c) recorded tolerances/floors (value judgments, contract-tested).
   Axiom count is O(1) and does not grow with code sites.
7. **Self-justifying decisions replace predictive thresholds.** Wherever measuring is
   cheap, decide by measured comparison instead of a threshold that predicts the
   comparison: fold iff computed byte savings > 0 (precedent: the binary-search fit
   engine measures actual serialized length rather than estimating). Such decisions
   carry zero parameters and are self-limiting — an unprofitable fold can never be
   selected.

## Non-goals

- No LLM-in-the-loop compression. Deterministic, auditable mechanical expertise only.
- No hidden adaptive state or learned caps; replayability is a contract.
- The budget ladder spine and escape hatches (`PI_BROWSER_RENDERER=ladder`,
  `PI_BROWSER_SESSION_DELTA=0`) are untouched; `ladder.ts` rung interiors keep their
  current shape until the escape hatch itself is retired (separate decision).
- The closed owner decision excluding entity `line` granularity from default envelopes
  is **not reopened**. "Resolution adapts under constant budget" inside projection
  means per-item variant-field count only.
- No public `browser_*` tool, schema, or parameter changes. Artifacts remain full
  fidelity — intelligence applies to presentation, never to stored evidence.
- Class-A bounds do not migrate; webSecurity probe/fuzz work bounds are class A.
- The 31 grandfathered per-tool distiller positions keep their existing
  `check:summary-boundary` shrink-only ratchet — migrations count down through that
  ledger; this plan adds no parallel mechanism for them.

## Target Architecture

New pure modules in `src/distill-core/` (zero Node/browser deps, existing boundary
gate covers them):

- `projection.ts` — single-pass shape inference (homogeneity detection,
  constant/variant field split, empty/degenerate detection, numeric range folding) +
  variant-field ranking (cardinality, presence variance, type) + item selection
  (relevance-ranked when a `RelevanceContext` is supplied, structural otherwise,
  **no-signal ⇒ byte-identical to source order**, boost-not-gate) + render under
  budget via the consolidated fit engine.
- `frontier.ts` — the overflow contract type and builders: every cut emits
  `{ dropped: {count, kinds}, retrieve: <one concrete call> }`. E3's notFound
  nearest-parent hint is an instance of this type.
- `compactionTuning.ts` — registered, capped presentation constants
  (`relevanceTuning.ts` precedent); the class-A ledger lives beside it as a declared
  exemption list.
- Fit engine consolidation: `fitInlineJsonToBudgetMeasured` moves from
  `src/tools/toolAdapter.ts:246` into the kernel beside `fitEnvelopeBudget`
  (`ladder.ts:218`); the kernel already owns `stableJson` (used by
  `salienceEnvelope.ts`, `cost.ts`), so the move adds no dependencies.

Import order unchanged: `capture → abml-core → distill-core`; tools/runtime consume
the kernel, never the reverse. Capture templates keep their class-A caps; their values
get registered in the ledger with class labels.

## P0 — ABML Kernel Hygiene (audit-confirmed point fixes)

Independent of the projection work (zero file overlap with P1-P4); lands first because
every item is a verified defect with a deterministic gate. No public tool, schema, or
envelope semantic changes; K6 is the only agent-visible candidate and it is eval-gated.

### K1 — Spec truth: dual locator priority + unimplemented scoring table

**Defect (verified).** `docs/abml-p1-spec.md:43-46` claims one fixed locator priority
(`backendNodeId > axNodeId > attrSignature > css > xpath > textAnchor > point`), but
the code deliberately runs **three concern-specific orders**: identity hashing is
css-first (`src/abml-core/refId.ts:38-42` — backendNodeId/axNodeId are session/AX-rebuild
scoped; hashing them would churn refs and break baseline diff matching), builders emit
css→textAnchor→point (DOM, `entity.ts:213-215`) and backendNodeId→axNodeId→textAnchor
(AX, `ax.ts:165-167`), and runtime resolution tries array order
(`src/tools/executeStdlib.ts:115-119`). Separately, spec §2.2's candidate scoring
weights (100/95/…/40) describe machinery that was never built: `CandidateSummary` /
`ResolveResult` (`src/abml-core/types.ts:104-117`) are never constructed anywhere —
documenting future capability as current, which the governance rules forbid.

**Fix.** Rewrite the p1-spec locator clause to state the two real priorities and why
they differ (resolution accuracy vs identity persistence); move §2.2 weights +
`CandidateSummary` to an explicitly-marked "reserved, unimplemented" appendix (types
stay — resolution handlers for `attrSignature`/`xpath` at `executeStdlib.ts:86,93-96`
remain valid forward-compat). Add rationale JSDoc at `refId.ts` (identity-priority) and
at `templating.ts:108 buildTemplateSummary` — the audit initially flagged it dead, but
`check-abml-templating.mjs:104,112` pins both its existence and observeRunners'
non-use: it is the contract-test harness for the M1 engine, and the comment must say so
to stop future dead-code mislabeling.

**Files.** `docs/abml-p1-spec.md`; comment-only edits in `src/abml-core/refId.ts`,
`src/abml-core/templating.ts`.

**Gates.** `npm run check:doc-structure`, `npm run check:abml-templating`,
`npm run check:all:contracts`.

### K2 — Causal event ref collision

**Defect (verified).** `src/abml-core/causal.ts:170` — events lacking both `id` and
`seq` all mint `pi-ref://event/event`; distinct events collide on one ref.

**Fix.** `buildCausalEvent(record, fallbackIndex?: number)`; when id and seq are both
absent the id becomes `event-<fallbackIndex>` (deterministic — index = position in the
delta window). Callers thread the index: the delta map in `buildCausalEvents`
(`causal.ts`) and `shapeEventStreamEntity` (`src/abml/verbs/runtime.ts:549`, index
available at the `delta.map` call site `:630`).

**Regression.** `tests/unit/abml/causal.test.ts`: two id-less/seq-less events get
distinct refs; mirror assertion in `check:abml-causal`.

**Gates.** `npm run test:unit`, `npm run check:abml-causal`,
`npm run check:abml-stream-plane`.

### K3 — Kernel time purity: `Date.now()` out of abml-core

**Defect (verified).** The pure kernel's only environment reads:
`stream.ts:81` and `:129` (`context.capturedAt ?? Date.now()`) and `refId.ts:68`
(`mapCaptureState(value, now = Date.now())`). Verified dead-in-practice — every
`CaptureRefContext` construction in `src/abml/verbs/runtime.ts` already supplies
`capturedAt` (`:597-604, :669, :700, :999, :1023`) — but live-by-type: a future caller
omitting it silently breaks replay determinism.

**Fix.** Make `capturedAt` required on `CaptureRefContext` (`stream.ts`); delete both
`Date.now()` fallbacks; remove the `refId.ts:68` default param and thread `now` from
its callers (enumerate via grep). Then make the purity mechanical: extend
`tests/contracts/drift/check-abml-core-boundary.mjs` to ban `Date.now(`,
`Math.random(`, `new Date(`, and `localeCompare(` in `src/abml-core/**`.

**Gates.** `tsc -p tsconfig.json`, `npm run check:abml-core-boundary`,
`npm run check:abml-stream-plane`, `npm run test:unit`.

### K4 — Deterministic tie-break in diff salience

**Defect (verified).** `src/abml-core/diff.ts:161` is the kernel's only
Intl-dependent comparator (`a.signal.localeCompare(b.signal)` tie-break feeding the
top-12 selection at `:178`); same input can order differently across locales, and the
kernel's own idiom elsewhere is codepoint comparison (`relations.ts:90-93, 205-210`).

**Fix.** Replace with codepoint compare (the `relations.ts` idiom); add an equal-score
tie case to `tests/unit/abml/diff.test.ts` asserting stable order. The K3 boundary ban
then locks the whole kernel Intl-free.

**Survey closure (no action, recorded).** All remaining `localeCompare` sites live
outside the perception kernel (memory-core profile/staleness/recall, driver
registries, webSecurity) on controlled ASCII ids where no byte-identity contract spans
locales — left as-is; do not resurface as a finding.

**Gates.** `npm run check:abml-diff`, `npm run test:unit`,
`npm run check:abml-core-boundary`.

### K5 — Kernel test debt: `ax.ts` + `refId.ts` direct coverage

**Gap (verified).** `ax.ts` (429 lines — DOM/AX merge, the kernel's most complex
module) and `refId.ts` (the identity root) have zero direct tests; existing kernel
tests are almost entirely happy-path.

**Fix.** New `tests/unit/abml/ax.test.ts` (buildAxEntityFromNode state/structure
extraction including `selected`/`pressed` capture, buildAxLocators order,
isInterestingAxNode, mergeDomAndAxEntities merge+dedupe) and
`tests/unit/abml/refId.test.ts` (semantic-anchor vs locator path, css-first selection,
same-descriptor ⇒ same-id, tabId/url sensitivity, `makePiRefUri` shape). Both include
malformed-input rows (missing fields, nulls, wrong types) — the kernel's first
negative-shape coverage.

**Gates.** `npm run test:unit`.

### K6 — `selected`/`pressed` perception probe (eval-gated, rides the P1 sentinel)

**Finding (verified).** AX builders capture `state.selected`/`state.pressed`
(`ax.ts:274-275`) but `EntityStateSchema` (`src/tools/summaries/outputSchemas.ts:39-48`)
omits them and nothing consumes them — the agent cannot see which tab is selected or
which toggle is pressed. Whether that is real friction needs a real-agent signal, not
static analysis (eval-fixes rule: prove a true general defect before changing
agent-facing surface).

**Action now.** Add a READ-ONLY task to
`evals/browser-workflows/blind-tasks-realsite.md`: tabbed/toggled UI on a
mainland-reachable site (e.g. bilibili home tab bar) — "state which tab is currently
active and how you know". The post-P1 blind sentinel run required by this plan's
Acceptance carried the task; no extra run was required.

**Branch.** Friction confirmed → surface `selected`/`pressed` in `EntityStateSchema` +
the scan summary high-signal set (same slice as the `checked`/`current` precedent,
`src/tools/summaries/scan.ts:473`) gated by `check:token-economy` + `bench:distill`.
No friction → closed decision in `ROADMAP.md` with a reopen evidence bar.

### Rejected audit findings (recorded so they do not resurface)

- **refId "cross-run instability" via backendNodeId** — refs are session-scoped by
  design (`owner.tabId` is in the hash payload, `refId.ts:44-51`); css-first is the
  mitigation, not a bug.
- **`attrSignature`/`xpath` defined-but-never-produced** — speculative resolution
  handlers are harmless forward-compat; kept (and labeled by K1).
- **`EntityStructure.level/sort` slack, inert `stabilityScore`, evidence-only
  `rowIndex/colIndex`** — schema surface debt with no consumer harm; fold into the
  next schema revision, not standalone churn.
- **`src/abml/` shim layer as maintenance burden** — deliberate, CI-locked compat
  design (`check-abml-core-boundary.mjs:156-169`); not debt.
- **diff/treeDiff/snapshotProjection overlap** — three distinct granularities
  (ref-level / template-level / snapshot+delta), all live; no consolidation.
- **`hints` open-record sprawl** — current usage is narrow and grouped by entity
  source (~30 keys); reopen only if a hint key lands outside its entity-kind grouping.

## P1 — JSON Projection + Artifact Consumer

**Decision.** Replace `compactJsonValue` (`src/tools/artifactReader.ts:497-521`) as the
default rendering for `browser_artifact mode=json` with `projection.ts` output.

**Behavior.**
- Homogeneous object arrays → `{projection:"folded-v1", template:{constants,
  exceptions}, fields:[ranked variant fields], items:[compact tuples in source order],
  frontier}`.
- Fold decision is cost-based, not threshold-based (principle 7): fold iff computed
  byte savings > 0, where savings ≈ (N−1) × constant-field bytes − template-header
  overhead, evaluated O(1) from the single inference pass. No homogeneity magic
  number; unprofitable folds are structurally unreachable.
- Heterogeneous arrays, scalars, deep mixed objects → **fallback to the current
  windowing path unchanged** (never worse than today). Escape hatch
  `PI_BROWSER_JSON_PROJECTION=0` forces the old path globally.
- Item membership under budget: relevance-ranked when the session has signal
  (scan-artifact items are entities — reuse `entitySalienceRank` through the existing
  `RelevanceContext` dual surface), structural otherwise; rendered in source order
  (principle 2).
- `params.limit`/`offset` keep their meaning against the *item list*; explicit
  paging still works.
- Frontier always present when anything folds or drops.

**Files.** New `src/distill-core/projection.ts`, `src/distill-core/frontier.ts`;
changed `src/tools/artifactReader.ts`, `src/tools/resultMiddleware.ts` (nextActions
teach expansion: re-read by offset / jsonPath into a folded field);
`tests/unit/distill-core/projection.test.ts` (new),
`tests/contracts/tools/check-artifact-reader.mjs` (updated expectations + fallback
negative controls).

**Replay golden.** Redact and commit the session artifact
(`observe-scan-1781174652248.json`, 80 actionables) as a fixture; contract asserts:
single default-budget read returns **all 80 items** with template folding, byte size at
or below the old 7-item page, and byte-identical output across two runs.

**Gates.** `check:distill-core-boundary`, `test:unit`, `check:artifact`,
`check:output-schema-conformance`, `check:cli-json-envelopes`, `check:token-economy`,
`docs:generate` + `check:tool-docs` (artifact tool docs mention json shape),
final `npm run check` + `npm run lint`.

**Completion evidence.** The replay golden passes; heterogeneous-input negative control
is byte-identical to the pre-change path; escape hatch verified.

## P2 — Fit Engine Consolidation

**Decision.** One fitting engine in the kernel. Move
`fitInlineJsonToBudgetMeasured` (pure) from `toolAdapter.ts` into
`src/distill-core/ladder.ts` (or a `fit.ts` sibling); `toolAdapter` and
`projection.ts` both consume it. No behavior change — relocation + dedup only.

**Gates.** `check:distill-core-boundary`, `test:unit` (move existing fit tests),
`check:artifact`, `check:summaries`, final `npm run check`.

## P3 — Frontier Contract + Caps Ledger Ratchet

**Decision.** Make "no silent caps" machine-enforced.

- A new drift gate (`tests/contracts/drift/check-compaction-ledger.mjs`,
  npm script `check:compaction-ledger`) inventories `slice(0, N)`-class sites in
  `src/` (the survey grep, refined) against a committed ledger that classifies each
  site A/B/C. New unregistered sites fail the gate; class-B count is a **shrink-only
  ratchet** (baseline: current survey), decremented as P1/P4 migrate consumers.
- `frontier.ts` type adopted by the artifact reader (P1) and notFound path (E3);
  remaining adopters tracked in the ledger, not as a big-bang rewrite.
- Presentation constants referenced by kernel code move into `compactionTuning.ts`
  with caps and a contract test (`relevanceTuning` precedent).
- **Kernel cap seeds (from the 2026-06-11 audit).** The initial committed ledger
  classifies the abml-core cap sites by name, separating the already-signaled
  precedents (causal `requestCount`/`eventCount`, treeDiff instance `truncated` flag,
  inference `<key>Count`) from the silent drops:
  `relations.ts:86` (8/entity), `relations.ts:219` (highlights 8),
  `treeDiff.ts:173` (changed fields 8), `treeDiff.ts:263` (summary names 6),
  `diff.ts:169,178` (churn samples 8 / changed items 12),
  `templating.ts:117` + `snapshotProjection.ts:161` (MAX_TEMPLATES 12),
  `grouping.ts:85` (display text 120 chars), `entity.ts:110-112` (stringArray 8),
  `causal.ts:232` (triggered relations 8). These stay in the perceive kernel (the
  envelope path is out of P1/P4 migration scope per Determinism & Interplay), but they
  are ledger-visible and shrink-only like every other class-B site.
- **Honesty-signal micro-slice.** Where a count field is cheap and matches an existing
  precedent, add it during P3: relations highlights and treeDiff changed-fields gain
  `<x>Count`-style truncation signals, gated by `check:token-economy` + `bench:distill`
  (byte cost must stay within the renderer-flip bar). Remaining silent sites are
  classified class-B-accepted with a recorded reason instead.

**Gates.** the new `check:compaction-ledger` wired into the `contracts` group of
`scripts/run-check-groups.mjs`, `check:doc-structure`, final `npm run check`.

## P4 — Remaining Presentation Consumers

**Decision.** Migrate by evidence-bearing order, decrementing the P3 ratchet:

1. `src/tools/summaries/generic.ts` sampling (`SAMPLE_LIMIT = 5`,
   `compactSample`) → projection (generic bridge-result arrays gain folding).
2. Per-tool distiller leftovers: continue through the existing 31-position
   `check:summary-boundary` ratchet as those tools get factify migrations — **no new
   mechanism**, this plan only points its ledger at the same debt line.
3. Scan summary fixed tables (`data.rows`, `media_candidates` caps) — only if the
   P1/P4.1 evidence shows folding wins there too; otherwise leave and record as
   class-B-accepted in the ledger with reason.

**Gates per migration.** The owning tool's focused checks + `check:summaries` +
`check:token-economy` + `bench:distill` comparative (salience chars ≤ 1.05× ladder,
fact coverage ≥ baseline — the renderer-flip acceptance bar carries over), final
`npm run check`.

**Completion evidence.** P4.1 migrated `src/tools/summaries/generic.ts` and decremented
the P3 class-B ledger via `summary-generic-sampling`. The Bilibili runtime sentinel
verified folded generic execute output with concrete values (`href`, `i`, `text`),
`saved.path`, and executable `cliNextActions` for `data.all`.

## Determinism & Interplay Contracts

- Same artifact + same params + same relevance state ⇒ byte-identical output; ties
  break by source index. Covered by a repeat-run assertion in the P1 golden.
- No-signal neutrality: with no relevance signal, item selection degrades to source
  order — the no-signal ⇒ byte-identity family of tests extends to projection.
- Session-delta/P-frames operate on observe envelopes, not artifact reads; projection
  does not alter envelope rendering. Any future envelope adoption of projection must
  re-pass the R3 arbitration rule (relevance holds ≤1 rung above degradation) — out of
  scope here.

## Risk Register

| Risk | Control |
|---|---|
| Shape inference misjudges a heterogeneous array | cost-based fold criterion is self-limiting (folding is only chosen when it measurably saves bytes); fallback path is the unchanged current renderer; negative controls byte-identical |
| Agents confused by folded shape | `projection:"folded-v1"` self-description + frontier `retrieve` call + nextActions teaching expansion; blind sentinel after landing |
| Variant-field ranking hides a field an agent needed | fields are folded, never dropped: constants live in `template.constants`, every field reachable by jsonPath; frontier names folded fields |
| Relevance ranking destabilizes paging | ranking selects membership only at default reads; explicit `offset`/`limit` paging stays source-ordered and deterministic |
| Kernel scope creep | distill-core boundary gate; projection/frontier/tuning are pure modules; class-A bounds explicitly excluded |
| Double maintenance during migration | P3 ratchet makes remaining class-B sites visible and shrink-only; no parallel ledgers (31-position distiller debt stays on its existing gate) |

## Acceptance

- **P0 kernel hygiene complete.** K1-K5 focused gates green (`check:abml-templating`,
  `check:abml-causal`, `check:abml-stream-plane`, `check:abml-diff`,
  `check:abml-core-boundary` with the new purity bans, new `ax.ts`/`refId.ts` unit
  files in `test:unit`); spec no longer documents unimplemented scoring; the event-ref
  collision and the kernel's `Date.now()`/`localeCompare` reads are gone.
- **Session-derived numbers beaten.** `data.actionables` (replay golden): 7 → 80
  items in one default-budget read; bytes ≤ old single page. Effect-style vacuity
  not in scope here (resolved by `real-session-friction-plan.md` E5).
- `bench:distill` comparative stays within the renderer-flip bar on all fixtures.
- No-signal byte-identity and heterogeneous-fallback identity are proven by negative
  controls.
- `check:compaction-ledger` green with a recorded class-B baseline (including the
  named kernel cap seeds) and at least two decrements (P1 artifact reader, P4.1
  generic sampling) by plan completion.
- Final gates: focused gates and runtime sentinels are green; final `npm run check` +
  `npm run lint` are the closing gates for this worktree.
- Blind real-site sentinel recorded no new enumeration-abandonment friction on the
  list-heavy page and carried the K6 selected/pressed probe with its schema branch
  executed. The separate CSS-class active-state gap is recorded as n=1 in
  `blind-findings.md`, not patched from one site.

## Execution Order

1. P0 kernel hygiene K1-K5 (independent of projection work, deterministic gates,
   cheapest-first) + K6's task-list edit. E2/E3 precursors are already complete.
2. P1 projection + artifact consumer (with replay golden).
3. P2 fit-engine consolidation.
4. P3 ledger ratchet + tuning surface (including the kernel cap seeds and the
   honesty-signal micro-slice).
5. P4 consumers by evidence, ratchet counting down.
6. Post-P1 blind sentinel run (Acceptance) carries the K6 probe; its branch decision
   (schema surface vs ROADMAP closure) is executed inside this plan.

First useful milestone is P0+P1: the kernel defects close with deterministic gates,
and the highest-evidence pain (80-item enumeration) closes with one new pure module
and one consumer swap, behind an escape hatch, with a committed real-world replay
golden.

All items above were executed in this workstream; no plan item remains open.
