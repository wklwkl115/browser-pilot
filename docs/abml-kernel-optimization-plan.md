# ABML kernel optimization — point-fix execution plan

> Status: **COMPLETE — activated and executed 2026-06-10.** Activation and completion are recorded in `CURRENT.md`.
> This is the successor point-fix queue for the ABML perception kernel (`src/abml-core/` + its
> runtime arms `src/abml/verbs/axRuntime.ts`, `src/abml/verbs/runtime.ts`, and the page-side
> `src/scan/buildScanScript.ts`). It opens a NEW execution contract as required by the **closed**
> `docs/performance-overhead-audit.md`. It is the orthogonal *compute* track to the architecture
> contract `docs/perception-renderer-plan.md` (token economy); nothing here changes agent-facing
> output — every fix in this plan must be **byte-identical at the envelope level**.
>
> Provenance: two audit passes (2026-06-10) — a fan-out subagent sweep followed by a line-by-line
> source verification of every adopted claim. Items the verification pass REFUTED are recorded in
> §5 so they are not re-flagged. Subagent claims that were not source-verified were not adopted.

Typical scale used for cost models below: raw AX nodes **1000–3000**, interesting AX nodes
**100–500**, DOM scan entities **200–800**, observe with baseline runs diff + treeDiff +
projection + relations + causal + inference in one call.

## Tier A — verified waste, zero/near-zero risk, land first

### A1 — Duplicate `buildSnapshotProjection` per scan observe (computed and thrown away) ✅
- **Where:** `src/tools/observeRunners.ts:536-538` builds a projection from
  `observation.abmlRead.entities`; `:567` builds it again from `attributedEntities`. The two
  trigger conditions are equivalent (`attributedEntities !== null` ⇔ `abmlRead.ok === true`), and
  the `:645` fallback (`isRecord(summaryRecord.snapshotProjection) ? … : abmlSnapshotProjection`)
  is dead on the integrated path because `:582` always sets `snapshotProjection`.
- **Cost:** one full ARIA grouping + template build + per-entity `JSON.stringify` descriptor keys
  per scan, discarded. `triggered` relations do not affect grouping (container/role/kind), so the
  two results are identical.
- **Fix:** delete `:536-538`; compute once at `:567`; thread that result to the `:645` artifact
  path.
- **Risk:** near-zero. **Guards:** `observe-abml-integration.test.ts`,
  `check-abml-scan-envelope`, `check:summaries`. **Note:** `snapshotProjection.ts` has NO unit
  test (§4) — add one in the same change.
- **Coordination:** `observeRunners.ts` carries in-flight uncommitted causal-P1 edits; land or
  rebase that first.

### A2 — `isInterestingAxNode` pays 3 linear property scans on EVERY raw AX node ✅
- **Where:** `src/abml-core/ax.ts:100-108`. `:103-104` compute `axName` AND `axValue`
  unconditionally for all raw nodes (1000–3000); `axValue` (`:80`) chains up to **three**
  `axProperty` calls, each a linear `.find` over `node.properties` (`:53-61`). The branch at
  `:105`/`:107` only needs `value` when `name` is falsy.
- **Cost:** ~3000 nodes × up to 3 × O(P) property scans in the filter phase alone — the most
  expensive work in extraction happens on nodes that are mostly about to be dropped.
- **Fix:** lazy-evaluate — compute `name` first; compute `value` only on the code paths that
  consult it (`Boolean(name || value)` short-circuits via a closure or explicit branch). Keep
  predicate semantics identical.
- **Risk:** zero (pure predicate refactor; identical truth table). **Guards:**
  `tests/unit/abml/ax.test.ts` (`isInterestingAxNode` cases).

### A3 — `mergeDomAndAxEntities` O(N×M) per-pair property re-extraction ✅
- **Where:** `src/abml-core/ax.ts:384-404`; `axMatchScore` (`:366-382`) re-runs
  `entityName` (`:284-286`, **trim().toLowerCase() string allocation per pair**), `entityRole`,
  `entityBox`, `entityPoint` for every (dom, ax) pair. 200 DOM × 150 AX = 30k pairs ⇒ ~60k
  string normalizations.
- **Fix (step 1, this plan):** pre-extract per-entity box/name/role/point into parallel arrays
  before the loop; `axMatchScore` consumes pre-extracted values. Output byte-identical.
- **Explicitly deferred (step 2, NOT this plan):** spatial bucketing to cut the pair count —
  `:379-380` matches entities with `geomKnown === false`, so geometry-less entities must stay in a
  full-candidate lane; do not attempt without a dedicated parity proof. (The audit's closed 2.1
  rule also still stands: do not change the geometry SOURCE.)
- **Risk:** step 1 zero. **Guards:** `ax.test.ts` merge cases,
  `observe-abml-integration.test.ts` entity counts/geometry.

### A4 — Role-class lookups via inline array `.includes` per node ✅
- **Where:** `src/abml-core/ax.ts:91-98` (`kindForAxRole` — 4 inline arrays rebuilt/scanned per
  call) and `:105` (the boring-role list). Called for every raw node (via
  `isInterestingAxNode`) and again per built entity.
- **Fix:** hoist to module-level `Set`s. **Risk:** zero. **Guards:** `ax.test.ts`.

### A5 — `stableHash24` iterates the descriptor text three times ✅
- **Where:** `src/abml-core/refId.ts:7-18` — `seeds.map(...)` runs a separate full-text FNV loop
  per seed. Called once per minted ref (~80–300 per scan, plus semantic re-mints).
- **Fix:** single pass updating all three hash accumulators simultaneously. Hash values —
  and therefore every existing `pi-ref://` id — are unchanged.
- **Risk:** zero. **Guards:** `tests/unit/abml/semanticRefAnchor.test.ts` +
  `check-abml-ref-registry.mjs` (stable ref ids asserted by value).

### A6 — Per-node AX property lookups are linear; index once per built node ✅
- **Where:** `src/abml-core/ax.ts:53-61` (`axProperty` linear `.find`), consumed ~6–8× per
  interesting node by `buildAxEntityFromNode`/`axStructure`/`axPropertyBool` (state flags:
  disabled/focused/expanded/checked/selected/pressed/…).
- **Fix:** in `buildAxEntityFromNode`, build one `Map(name → value)` from `node.properties` and
  thread it to the helpers (keep `axProperty` as the fallback path for external callers). Do NOT
  build the map in the filter phase (A2's lazy approach covers filtering).
- **Risk:** low. **Guards:** `ax-state.test.ts`, `ax-structure.test.ts`.

## Tier B — consolidation refactors (low–medium risk, need a parity guard each)

### B1 — One grouping engine: 4 implementations + in-group re-derivation ✅
- **Where:** `groupEntities` exists 4× — `templating.ts:170` (inside `buildTemplateSummary`),
  `treeDiff.ts:132` (runs on BOTH baseline and after arrays), `snapshotProjection.ts:69`,
  `semanticRefAnchor.ts:83` (via `runtime.ts:128` at ref-mint time). Each derives
  `templateGroupDescriptorForEntity` per entity (`JSON.stringify` key, `templating.ts:82`).
  Verbatim helper duplication: `structureScopeKey` ×3 (`templating.ts:144`, `treeDiff.ts:120`,
  `semanticRefAnchor.ts:71`), `suppressNestedNonControlGroups` ×2 (`treeDiff.ts:126`,
  `semanticRefAnchor.ts:77`), `fieldValue` ×2 (`templating.ts:99`, `treeDiff.ts:114`),
  `dedupeLocators` ×2 (`ax.ts:110`, `entity.ts:138`), normalize/display text helpers ×3.
- **Sub-finding (new, source-verified):** `snapshotProjection.ts:110` `templateFromGroup` calls
  `buildTemplateSummary(group.members)` — re-running the FULL grouping pipeline (descriptor per
  member again) on an already-grouped member list, just to obtain one template. Export
  `buildTemplate(members)` from `templating.ts` and call it directly.
- **Fix:** new `src/abml-core/grouping.ts`: descriptor derivation + raw grouping (with index),
  consumed by all four; suppression filters stay per consumer (`suppressNestedNonControlGroups`
  vs `suppressRedundantTextLeafGroups` have different semantics — do NOT merge them). Per-observe
  descriptor recomputation can then be eliminated by threading the grouped result (preferred,
  explicit) — module-level caches stay out of the kernel.
- **Risk:** low-medium (byte-identical required; Map insertion order preserves output ordering).
  **Guards:** `templating.test.ts`, `treeDiff.test.ts`, `semanticRefAnchor.test.ts`, plus the NEW
  `snapshotProjection.test.ts` from A1.

### B2 — Two ancestor tree-walks per built AX node ✅
- **Where:** `src/abml/verbs/axRuntime.ts:279` (`nearestContainer`, walk #1, during entity build)
  and `:291-294` (`builtCurrentContainerKeys`, walk #2 over the whole tree again per node —
  structurally required to run after `builtByKey` is complete, per the comment at `:289-290`).
  Each walk is ≤24 `parentByChildId` lookups per node; N=500 ⇒ ~24k extra map hops.
- **Fix:** collect the full ancestor container chain (role/key pairs) ONCE during walk #1; the
  post-pass filters the pre-collected chain against `builtByKey` without re-walking the tree.
  (The `keys.includes` at `:161` flagged by the sweep is NOT the cost — the chain is ≤~5 entries;
  the second tree-walk is.)
- **Risk:** low-medium. **Guards:** `ax-container.test.ts`, `ax-runtime.test.ts`
  (currentContainerKeys fallback-chain cases).

### B3 — Page-side `selectorFor` is quadratic on wide containers ✅
- **Where:** `src/scan/buildScanScript.ts:257-274` — per ancestor level:
  `Array.from(parent.children).filter(...)` + `siblings.indexOf(cur)`. For a 200-row
  table/feed, EVERY row's selector pays an O(S) sibling scan ⇒ O(S²) per wide container
  (200 rows ⇒ ~480k ops just for `nth-of-type`). Called per actionable, per `refTargets`
  target (`:287`), per occluder (`:311`).
- **Fix:** per-scan `WeakMap<parent, Map<tagName, index>>` built lazily on first touch of a
  parent, so each parent's children are scanned once. Output selectors identical.
- **Risk:** low, but this is injected-script territory: template-literal escape rules apply
  (`\\s` doubling — see the standing lesson), verify the built `dist` bundle, and re-run scan
  smokes. **Guards:** scan fixture tests + `smoke:browser:scan-summary`.
- **Absorption note:** if `docs/capture-core-plan.md` activates first, B3 lands inside its C-2
  (TS `lib/selector.ts` with direct unit tests) instead of as string surgery here. Either order
  is safe; do not do both.
- **Verified non-issue nearby:** `visibleInfo` (`:293-319`) breaks on the first passing
  hit-test point (`:312`) — the "5 hit-tests per element" worst case is rare; `innerText` reads
  on hit targets are layout-forcing but capped and quality-bearing. Leave as is.

## Tier C — micro (opportunistic only, when already touching the file)

- **C1** `inference.ts:209-211` — `detectLogin` recomputes `loginCandidateScore` in filter AND
  sort comparator (~6 regexes per call). Precompute a score map. Only runs on pages with a
  password field; impact small.
- **C2** `inference.ts:353-357` — alert-region freshness does `.some`/`.includes` over
  `diff.changed`/`diff.appeared` per region. Pre-index into Sets. Only when a baseline diff
  exists; impact small.
- **C3** `ax.ts:165,175,245` — repeated `role.toLowerCase()` and `Object.keys(structure).length`
  empty-check per node. Fold into A4/A6 edits if convenient.

## §4 Test-coverage gap (closed during execution)

`tests/unit/abml/snapshotProjection.test.ts` was added during A1/B1 landing and now covers current-template
delta attach, partial-baseline unavailable carry-through, delta-only projection when the current group drops
below `MIN_TEMPLATE_INSTANCES`, and control-first ranking under noisy mixed scopes.

## §5 Refuted / rejected during verification (do NOT re-flag)

- **`dedupeEntities` "O(E²)"** — WRONG: `entity.ts:505-519` is Set-based linear.
- **`dedupeRelations` "O(n²)"** — WRONG: `relations.ts:72-82` is Set-based linear.
- **`builtCurrentContainerKeys` `keys.includes`** — keys chain is ≤~5 entries; negligible.
  The real cost is the second tree-walk (B2).
- **`snapshotProjection` "duplicate treeDiff loop" (`:148`/`:159`)** — T ≤ MAX_TEMPLATES (12);
  negligible. Subsumed stylistically by B1 if convenient.
- **`visibleInfo` "5 hit-tests + reflow per element"** — overstated; first-point break at `:312`
  makes 1 hit-test the common case. Accepted cost.
- **`errors.ts` module-load maps** — small constants; lazy-loading them buys nothing.
- **"Merge runtime.ts post-merge passes 4/5/6 into one map"** — rejected for this plan: each pass
  (`deriveStateRelationAnchors`, `materializeRelations`, relation count) is O(N) with distinct
  contracts; fusing them trades clarity for ~2 array passes. Revisit only if profiling shows it.
- **Per-site/per-DOM-shape tuning of any threshold** — out of scope by standing rule
  (no overfit; ARIA-grounded generality).

## §6 Execution order & verification

Executed result:
1. Activation was recorded in `CURRENT.md` / `TODO.md` and the in-flight renderer-default-flip edits on `observeRunners.ts` were treated as baseline reality.
2. A1 landed with new `tests/unit/abml/snapshotProjection.test.ts`; focused gates passed.
3. A2 + A4 + A5 landed together; AX predicate/role/hash behavior stayed byte-identical under existing unit/contracts.
4. A3 step 1 + A6 landed; AX merge/state/structure tests plus `test:observe-abml-integration` passed.
5. B1 landed with new shared `src/abml-core/grouping.ts` + `buildTemplate()` export; `templating/treeDiff/snapshotProjection/semanticRefAnchor` now share one grouping kernel.
6. B2 landed in `src/abml/verbs/axRuntime.ts`; B3 landed in `src/scan/buildScanScript.ts` with cached sibling indices and unchanged selector output.
7. C-tier stayed out of scope.
8. Final gates passed: `check:all:bridge`, `npm run check`, `npm run smoke:browser:scan-summary`.

**Optional bench harness (recommended, cheap):** the kernel is pure — add `bench:abml-kernel`,
a node script timing `mergeDomAndAxEntities` / grouping / `buildTreeDiff` /
`buildSnapshotProjection` over recorded large-page fixtures (the `check:summaries` high-entropy
fixture is a seed). Run before/after each tier to keep claims honest; numbers are for regression
detection, not capability claims (per `real-agent-eval-over-self-justification`, perf numbers
here are internal — no agent-facing claims are made by this plan).

## §7 Relationship to other tracks

- `docs/perception-renderer-plan.md` — the architecture track (token economy, Fact/salience
  renderer, distill-core). This plan is pure compute; it neither blocks nor is blocked by the
  renderer work, EXCEPT B1's `grouping.ts`, which the renderer's factify stage will also consume
  — land B1 before renderer K2 if both are active.
- `docs/performance-overhead-audit.md` — closed; its verified-clean entries still bind
  (notably 2.1: do not change the AX geometry source).
- `docs/abml-mechanism-arm-execution-plan.md` — the M1/M2 substrate these modules implement.
- `docs/capture-core-plan.md` — the page-world sensing kernel (third kernel). Its C-2 absorbs
  B3 when active; its C-1 golden harness also strengthens this plan's scan-side guards.
