# Distill Kernel Hygiene Plan (economy-kernel audit point fixes)

> Status: **complete (2026-06-11).** Derived from the 2026-06-11
> distill/economy kernel audit (6 subagent-verified dimensions: consumption surface,
> pipeline dataflow, constants/budget tree, determinism, performance, test coverage).
> Every item cites code verified during the audit; findings that did **not** survive
> verification are recorded in the "Accepted costs / rejected findings" section so
> they are not re-litigated.
>
> Relationship to `docs/value-ordered-compaction-plan.md`: this plan is an independent
> point-fix track with deterministic gates — no projection/frontier/tuning mechanism
> work. Sequencing constraint: D1/D7 touch `src/tools/observeRunners.ts` /
> `src/tools/resultMiddleware.ts`, which the compaction plan's P1 also touches —
> execute this plan **before** that plan's P1. The "P3 seed handoff" section at the
> end is input for that plan's P3 caps ledger; it does not modify that plan now.
>
> Governance: activation and completion are recorded in `CURRENT.md`.
> No public tool, schema, or envelope semantic changes landed anywhere in this plan.

## Evidence (audit summary)

Key verified facts:

- `src/distill-core/**` has **zero environment reads** (no Date.now / Math.random /
  process.env / Intl) — cleaner than abml-core pre-K3; the only locale-dependent ops
  are two `toLocaleLowerCase()` calls (D2).
- The default scan render **builds the full entity set twice**
  (`observeRunners.ts:900` + `scan.ts:492`) and **builds the envelope entity list
  twice** (`resultMiddleware.ts:198-209` + `:365`) — same defect class as the A1
  duplicate `buildSnapshotProjection` removed by the ABML kernel-optimization plan.
- `ladder.ts` (281 lines) — the budget engine every envelope passes through — has
  **zero direct tests**; `granularity.ts` (51) and `artifactPlan.ts` (28) likewise.
- The budget "tree" today is per-tool roots (`src/tools/budgets.ts`) plus derived
  ratios (0.7 / 0.25) plus a list of free-standing orphan constants — inventoried in
  the P3 seed handoff below.
- The relevance tuning surface is healthy: all 17 `RELEVANCE_TUNING` knobs are read
  and applied; bounds are contract-tested.

## D1 — Scan entity double-build (one build per render)

**Defect (verified).** Every default scan render builds the complete entity set
twice: `scanEntitiesForEnvelope` at `src/tools/observeRunners.ts:900` and again inside
`summarizeScanData → prepareScanSummary → buildScanEntities`
(`src/tools/summaries/scan.ts:492`, via `scan.ts:636`). Both runs perform the full
build + dedupe over all scan nodes (hundreds on large pages).

**Step 0 (blast radius, required first).** Confirm the two call sites produce
identical entity arrays under their differing options today: `scanEntitiesForEnvelope`
is called with `{ entityContext }` only, the inner call with full options including
`relevance` — verify `buildScanEntities` reads no option that differs (relevance must
affect ranking only, not entity construction). If any read differs, thread the full
options into the single build instead.

**Fix.** Build once in the runner; thread the prebuilt entities into
`summarizeScanData` through its existing options object (internal option, no schema
change). `scanEntitiesForEnvelope` keeps its signature for other callers.

**Files.** `src/tools/observeRunners.ts`, `src/tools/summaries/scan.ts`.

**Gates.** `tsx --test tests/unit/tools/observe-abml-integration.test.ts`
(whole-envelope byte-identity), `npm run check:scan`,
`npm run check:abml-scan-entities`, `npm run check:token-economy`,
`npm run test:unit`.

## D2 — Express-kernel locale purity

**Defect (verified).** The kernel's only locale-dependent operations:
`toLocaleLowerCase()` at `src/distill-core/relevance.ts:55` (`normalizeText`) and
`src/distill-core/relevanceTaps.ts:31` (dedupe key). Host locale (e.g. tr_TR
dotted/dotless i) changes term normalization and dedupe keys on the signal path.

**Fix.** Switch both to locale-independent `toLowerCase()`. Then lock the status quo
mechanically: extend `tests/contracts/drift/check-distill-core-boundary.mjs` with the
same purity bans the ABML K3 item adds to its boundary — `Date.now(`, `Math.random(`,
`new Date(`, `localeCompare(`, `toLocale` — distill-core has zero hits today, so the
ban is a pure ratchet.

**Files.** `src/distill-core/relevance.ts`, `src/distill-core/relevanceTaps.ts`,
`tests/contracts/drift/check-distill-core-boundary.mjs`.

**Gates.** `npm run test:unit` (relevance suites),
`npm run check:distill-core-boundary`, `npm run check:task-conditioned-salience`.

## D3 — Total-order tie-breaks at the allocation boundary

**Defect (verified).** `src/distill-core/allocate.ts:90` (per-floor candidates sorted
by salience alone) and `:108` (`density || salience`) are tie-fragile: equal-key facts
fall back to input order, and ties at the budget boundary decide **which facts
render**.

**Fix.** Append a `fact.ref` codepoint tie-break (the `relations.ts:90-93` idiom) to
both comparators, making the selection a total order independent of input
permutation. Extend `tests/unit/distill-core/allocate-render.test.ts` with an
equal-salience / equal-density tie case asserting stable selection.

**Files.** `src/distill-core/allocate.ts`,
`tests/unit/distill-core/allocate-render.test.ts`.

**Gates.** `npm run test:unit`, `npm run bench:distill` (relational assertions),
`npm run check:token-economy` (+10% guardrail catches any byte drift).

## D4 — Render-cache key misses renderer/cost-model env

**Defect (verified).** The observe render cache (`observeRunners.ts:642`
`observeRenderParamsSignature`, consumed by `renderCacheMatches` at `:663`) does not
key on `PI_BROWSER_RENDERER` / `PI_BROWSER_TOKEN_COST`. Flipping either env within the
cache TTL serves a cached result computed under the other renderer/cost model.

**Fix.** Fold both effective values (renderer marker, cost model) into the params
signature object.

**Files.** `src/tools/observeRunners.ts`.

**Gates.** Focused render-cache unit coverage in `npm run test:unit`.

## D5 — Dead-surface sweep (contract-pin aware)

**Verified dead in runtime:**

- `charCost` (`src/distill-core/cost.ts:3`) — zero importers anywhere (src, tests,
  evals).
- `RelevanceMatch` type (`src/distill-core/relevance.ts:28`) — no external importer.
- `RelevanceResult.sourcesForRef` (`relevance.ts:185`) — closure attached to every
  result, never called.
- `countRenderedTruncationMarkers` (`src/distill-core/render.ts:15`) — no runtime
  importer; tests use the `salienceEnvelope.ts` variant.

**Step 0 per removal.** Re-grep importers including `evals/` and the text-reading
contracts: `check-task-conditioned-salience.mjs` pins symbols by source text
(`computeRelevanceMap`/`scoreFields`/`RELEVANCE_TUNING`/`extract*`/`salience.relevance`)
— none of the four above are pinned; verify that remains true at execution time.

**Explicitly KEPT (pinned or reserved — do NOT remove):**

- `FactSalience.relevance` + the `allocate.ts:60` redundancy bypass, and
  `FactSalience.novelty` — V6 promotion machinery; the field is contract-pinned
  (`check-task-conditioned-salience.mjs:33`) and the shadow guard documents the
  promotion bar. Unfed today by design (shadow mode), not dead.
- `uniqueRecoveryActions` — export pinned by `check-recovery-boundary.mjs:14-16`.
- `assertRelevanceTuningBounds` — test-only by design (contract surface).

**Files.** `src/distill-core/cost.ts`, `relevance.ts`, `render.ts` (+ the unit/contract
files that reference removed symbols, if any surface at step 0).

**Gates.** `npm run test:unit`, `npm run check:distill-core-boundary`,
`npm run check:recovery-boundary`, `npm run check:task-conditioned-salience`,
`npm run check:all:contracts`.

## D6 — Ladder engine direct coverage

**Gap (verified).** Zero direct tests for `ladder.ts` (281 lines), `granularity.ts`
(51), `artifactPlan.ts` (28); existing distill tests are nearly all happy-path (the
only negative cases are an empty-terms relevance test and two execute-effect
fingerprint cases).

**Fix.** New `tests/unit/distill-core/ladder.test.ts`:

- `fitSummaryBudget` rung progression (the 4 compaction levels), `summaryOmitted`
  signal on low-priority drops, `summaryTruncatedToBudget` on the scalar fallback;
- `fitEnvelopeBudget` lifted-key compact→remove order, `envelope_omitted:` warning
  emission, essential-fallback floor behavior;
- negative rows: empty summary, zero and negative budget, oversized single scalar.

Plus `tests/unit/distill-core/granularity.test.ts` (depth-5 stub, string-ellipsis
marker, table `truncated` count, array silent slice) and
`tests/unit/distill-core/artifactPlan.test.ts` (reason combinations).

**Gates.** `npm run test:unit`.

## D7 — envelopeEntities computed twice per envelope

**Defect (verified).** `responseEnvelope` builds the merged/deduped entity list at
`src/tools/resultMiddleware.ts:198-209`, and `normalizedNextActions` rebuilds it via a
second `envelopeEntities` call (`:365`, invoked from `:525`) on every render.

**Fix.** Compute once and pass through. Byte-identical output expected — same pure
dedup over the same inputs.

**Files.** `src/tools/resultMiddleware.ts`.

**Gates.** `tsx --test tests/unit/tools/resultMiddleware-advanced.test.ts` +
resultMiddleware unit suites, `npm run check:token-economy`.

## Accepted costs / rejected findings (recorded so they do not resurface)

- **Always-computed ladder fallback on over-budget salience renders**
  (`salienceEnvelope.ts:137` calls `fallbackLadder()` inside `acceptedCandidate`) —
  this is the renderer-flip runtime acceptance guard (salience ≤ 1.05× ladder), an
  owner decision from `docs/archive/renderer-default-flip-plan.md`. Kept. Reopen bar:
  after a sentinel soak period, an owner decision may demote the runtime comparison
  to bench-only.
- **Over-budget double `responseEnvelope` pass** (`resultMiddleware.ts:581-583`) and
  the **7-clone envelope assembly** (`:219-255`, up to 3× under memory variants) stay
  closed behind the perf-audit 2.3/2.4 gates: the serialize-once rewrite needs the
  multi-rung golden; clone removal needs non-`[Circular]` contracts
  (`docs/performance-overhead-audit.md`).
- **"R3 arbitration rule missing from code"** — not a defect: it is the documented,
  unlanded precondition for V6 promotion, enforced by the shadow guard in
  `check-task-conditioned-salience.mjs:47-49`.
- **`granularityCeiling` ledger hysteresis** changing no-signal render bytes
  (`observeRunners.ts:601-606`) — designed budget-pressure behavior, not leakage.
- **`stableJson` does not sort keys** — by design (cycle-safety only); key order is
  insertion-deterministic per code path.
- **`bench:distill` has no committed absolute baseline** — intentional: its
  relational assertions (salience ≤ 1.05× ladder, coverage ≥, markers ≤) are the
  contract; absolute numbers would overfit fixtures. `check:token-economy` already
  carries the committed baseline (`medianRatio 0.0607`).
- **`PerceptionTraceTerm.at` is vestigial** — decay is ring-index based by design
  (`traceHalfLifeCalls` counts calls, not ms); harmless, leave.
- **`summarizeScanData` rung loop runs `buildSummary` up to 4×** — the limitSets
  staircase is the designed fitting mechanism; prepare-once already landed (perf-audit
  1.8); no further action here (the compaction plan's value economy is the successor).
- **`observeRunners.ts:870` raw `JSON.stringify` fallback** — bridge data is
  JSON-parsed (cycle-free); the purity ban is kernel-scoped; leave.

## P3 seed handoff (input for value-ordered-compaction-plan P3 — no action here)

When that plan's P3 caps ledger lands, the initial committed inventory must include
the distill-side entries verified by this audit:

**Orphan constants (free-standing, no root-budget derivation):**
`SUMMARY_MAX_CHARS` 12_000 (`ladder.ts:28`); `scanBudget` fallbacks 4_200/5_200
(`scan.ts:366`); `summaryThreshold` floor 8_000 (`resultMiddleware.ts:127`); emergency
summary 300 (`ladder.ts:258`); `MIN_MARGINAL_DENSITY` 0.12 (`salienceEnvelope.ts:9`);
overflow surplus 0.12 (`allocate.ts:124,133` — coincides with 0.12 above but is an
unrelated meaning, keep separate entries); compact-score discount 0.75
(`salienceEnvelope.ts:122`); the `limitSets` staircase tables (`scan.ts:373-381`).

**Silent caps (class-B candidates):**
`nextActions.slice(0,7)` (`resultMiddleware.ts:386`); envelope entities
`slice(0,12)` (`:209`); artifact-hint slices `(0,3)` (`:319,337`); ladder rung
`slice(0,4)` ×6 (`ladder.ts:124-188` — stays untouched per the compaction plan
non-goal until the escape hatch retires, but must be ledger-visible); headings
`slice(0,20)` (`content.ts:25`); selectors `slice(0,20)` (`pick.ts:20`).

## Execution order

1. D2, D3, D4, D5 — kernel-local, independent, cheapest-first, all deterministic.
2. D6 — test debt (can run parallel to 1; no production code touched).
3. D1 — after its step-0 blast-radius check (byte-identity gate decides).
4. D7 — after D1 (same middleware area, sequence to keep diffs reviewable).
5. Hand off the P3 seed inventory when the compaction plan's P3 activates.

## Acceptance

- Every item's focused gates green, then `npm run check:all:contracts` and a final
  `npm run check` + `npm run lint` (`check` does not run ESLint).
- D1/D7 prove byte-identity: `observe-abml-integration` whole-envelope test and
  `check:token-economy` baseline unchanged (no +10% drift).
- D2's purity ban and D3's total-order comparators are locked by contract/unit tests,
  not prose.
- `bench:distill` relational bars hold (salience ≤ 1.05× ladder, coverage ≥, markers
  ≤) on all fixtures after D3.
