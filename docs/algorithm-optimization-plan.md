# Algorithm Optimization Plan

> Status: READY — v9 (v8 + activation-state correction, item 8 primitive/accessor parity guard, item 9 `jsonBudgetLength`/projection surface, item 11/13 focused gate expansion)
> Scope: `src/distill-core/` (items 5, 7, 9, 12, including `fit.ts` / `projection.ts` budget-length consumers); `src/utils/json.ts` (item 8); `src/abml-core/` (items 10, 11, 13); `src/tools/observe/` (Step 0 measurement)
> Boundary: No runtime/driver/public-surface changes; no new env flags; new kernel-module exports declared `internal` in `kernel-export-inventory.json`
> Verification: per-item parity tests (red-first) + `bench:distill` + `check:all:src`; closing gate `npm run check`
> Activation: promote this to ACTIVE only by adding a `CURRENT.md` entry (decision/boundary/contract/verification) when execution starts

---

## Execution Order

| Order | Item | Class | Focused verification |
|-------|------|-------|---------------------|
| 0 | Harvest `observeTimings` stage profile | measurement | `npm run eval:browser-workflows -- --fixture-server` + ranked per-stage summary |
| 1 | 12 — `compactSummaryValue` unbounded array recursion | **defect fix** | stress regression test (deep arrays/objects, page-controlled values) |
| 2 | 7 — `tokenEstimate` in-place charCodeAt loop | CPU, leaf | parity unit test + `bench:distill` |
| 3 | 5 — salience fitter serialize-once | serialize count | byte-identity test + `bench:distill` before/after |
| 4 | 8 — `stableJson` tiered native fast path | CPU, chokepoint | byte-identity fuzz+corpus parity + micro-bench |
| 5 | 9 — exact-length cost probe (measure without materializing) | allocation/GC | length-parity fuzz+corpus + invocation-counter assertion |
| 6 | 10 — inference engine single-pass feature view | CPU + allocation, per-observe | output-identity test + `check:abml-inference` + micro-bench |
| 7 | 11 — hot-comparator decoration sweep | CPU, micro | exact-output tests + shared micro-bench |
| 8 | 13 — `groupEntities` single-slot memo (compute-once) | CPU + allocation, per-observe | output-identity fixtures + reference-identity memo-hit assertion + grouping-pinned gates untouched |

Items 5/8/9 share the distill serialization seam and land as one sequence; items 10/11/13 are abml-core and independent. Item 12 lands before 5/9 so their byte-identity baselines are captured post-defect-fix. Close the workstream with full `npm run check`, then archive per the workstream-plan procedure in `docs/agent-development.md`.

---

## Measurement Protocol & Results Ledger

The accept bars are only as trustworthy as the methodology behind them. Three rules:

1. **One bench helper, one methodology.** Add a shared micro-bench helper (`tests/unit/helpers/microBench.ts` — warmup runs, median-of-K, reports a ratio) used by every item's parity test. Seven ad-hoc timing loops with inconsistent methodology would make the accept bars incomparable; the helper is itself test code, not a new check (no `check:*` wiring, no re-litigation of the closed `bench:abml-kernel`).
2. **Single baseline, marginal deltas.** Capture the CPU baseline once before item 1 lands (bench-corpus timings via the helper + `bench:distill`); each subsequent item is measured as its **marginal** delta in landing order. Items 5/8/9 interact (each shrinks the others' headroom on the same seam) — sequential marginal attribution prevents double-counting the same win three times.
3. **Numbers or no landing.** Each item's row below is filled at execution time with the measured numbers; an empty or "expected" cell is not evidence (a claimed win that was never measured is treated as not landed).

| Item | Metric | Baseline | After | Marginal delta | Verdict |
|------|--------|----------|-------|----------------|---------|
| 12 | stack-overflow repro → bounded completion | — | — | (correctness; exempt) | — |
| 7 | `tokenEstimate` ns/char on mixed corpus | — | — | — | — |
| 5 | `stableJson` invocations per over-budget fit | — | — | — | — |
| 8 | `stableJson` ms on bench corpus (clean path) | — | — | — | — |
| 9 | probe-path allocations + ms per render (`jsonCost` + `jsonBudgetLength` clean paths) | — | — | — | — |
| 10 | `buildInferenceSummary` ms at N=500 | — | — | — | — |
| 11 | per-site comparator micro-ratios | — | — | — | — |
| 13 | grouping executions per default observe (2→1; 3→1 on no-attribution baseline) + ms at N=500 | — | — | — | — |

**Rollback unit:** every item lands as one commit with its parity/identity test; rollback is a single `git revert` — byte-identical outputs mean no data migration, no flag, no daemon-protocol impact.

---

## Step 0 — Harvest the Stage Profile

The instrumentation already exists and has never been harvested. `scanRunner.ts:96-510` records `tabRefreshMs`, `fingerprintMs`, `navigationMs`, `pageScriptMs`, `abmlMs`, `recorderMs`, `causalMs`, `eventCausalMs`, `renderMs`, and `bridgeRoundTrips`; `attachSerializeTiming` (`resultMiddleware.ts:537-549`) appends `serializeMs` — the final-transport serialization cost, which is exactly the number Forward Direction C's gate needs.

**Action:** run `npm run eval:browser-workflows -- --fixture-server`, collect `result.details.diagnostics.observeTimings` across all fixtures (not the public envelope; observe timings are intentionally kept in tool details), and write a ranked per-stage summary (median/p95) to `.pi/browser-artifacts/observe-timings-summary.json` (project artifact convention — referenceable by later acceptance). This sizes the wins of items 5/8/9 (`renderMs`) and items 10/11 (`abmlMs`), and is the admission gate for any future kernel-CPU proposal.

---

## 7. `tokenEstimate` — in-place charCodeAt loop

### Problem

`tokenEstimate` (`src/distill-core/cost.ts:3`) uses `for...of` iteration, which allocates an iterator and decodes code points per character. Hot caller: `allocate.ts:35` (per fact under the token cost model); item 9 keeps it as the per-text cost primitive.

### Design

```typescript
export function tokenEstimate(text: string): number {
    let tokens = 0;
    const len = text.length;
    for (let i = 0; i < len; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x80) tokens += 0.25;
        else if (code > 0x2e7f) {
            tokens += 0.6;
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;
                if (next >= 0xdc00 && next <= 0xdfff) i += 1; // consume pair only when it IS a pair
            }
        } else tokens += 0.4;
    }
    return Math.ceil(tokens);
}
```

Skip the next code unit only when it is actually a low surrogate, so output is exactly identical to the current implementation for all inputs (valid astral pairs and lone surrogates both weigh 0.6 either way). Optimize **in place** — no new export, no G2 churn.

### Verification

1. Copy the current implementation verbatim into a new parity unit test as `tokenEstimateReference`; red-first: perturb one weight to prove the test bites.
2. Parity cases: ASCII, Latin-1, CJK, emoji (astral), malformed surrogates (lone high mid-string, lone high at end, lone low, high+high), mixed; plus randomized strings.
3. Micro-bench inside the test (log ratio); macro check `npm run bench:distill`.
4. Map the test in `kernel-test-map.json` (G5). Gates: `check:distill-core-boundary`, `check:all:src`.

---

## 5. Salience Envelope Budget Fitting — serialize-once

### Problem

`fitSalienceEnvelopeBudget` (`src/distill-core/salienceEnvelope.ts:97`) runs on every over-budget envelope under the default renderer. Redundant serialization sites:

- `acceptedCandidate` (line 91) re-serializes `ladder` (and possibly `salience`) — envelopes already serialized above
- `countDistillTruncationMarkers` (line 93 → lines 82-84) re-serializes **both full envelopes** — the two largest redundant calls
- Worst-case ≈23 `stableJson` calls per over-budget envelope, before `fitEnvelopeBudget` internals

This completes the Tier-2 serialize-once class (already landed for the ladder fitter) on the now-default salience path.

### Design

1. **Thread serialized text** — reuse the `stableJson(out)` text computed at line 135; cache `ladderText` alongside the lazily-computed ladder in `fallbackLadder`.
2. **Marker counting on precomputed text** — add module-private `countTruncationMarkersInText(text: string)`; the exported `countDistillTruncationMarkers(value)` delegates to it (sole external consumer `tests/contracts/tools/check-distill-bench.mjs:49` keeps its value-shaped signature; no G2 change).
3. **`acceptedCandidate` takes `(salience, ladder, salienceText, ladderText)`** — internal, free to change. When the fitted result fell back through `fitEnvelopeBudget` (line 136) its text is unknown and is serialized once — unavoidable.

Decision semantics untouched: same candidates, same greedy order, same continuity/ratio/marker arbitration. Output byte-identical.

### Verification

1. Byte-identity unit test across under-budget, over-budget-salience-wins, over-budget-ladder-wins, continuity-key-missing cases; red-first by perturbing one threaded text.
2. `stableJsonInvocationCounter()` (`src/utils/json.ts:34`) before/after assertion: the per-fit invocation count drops and is pinned.
3. `npm run bench:distill` before/after. Gates: `check:distill-core-boundary`, `check:task-conditioned-salience`, `check:all:contracts`.

---

## 8. `stableJson` Tiered Native Fast Path — the serialization chokepoint

### Problem

`stableJson` (`src/utils/json.ts:20-32`) is the single serialization entry for all four kernels and the tool layer (32 importing files: every fitter cost probe, every envelope emission, summaries, HAR). Its replacer-based implementation pays two structural penalties on **every value of every call**:

1. Passing a replacer to `JSON.stringify` disables V8's native stringify fast path — each node (including every string/number leaf) takes a native→JS callback transition.
2. The cycle guard does `ancestors.includes(item)` — an O(depth) linear array scan per object node, plus a pop-loop.

The exotic cases the replacer exists for (bigint, `Error`, circular refs) are vanishingly rare in practice; the common case pays for them on every node.

### Design — classify once, then serialize natively

```
stableJson(value, spaces = 2):
  count invocation (counter semantics unchanged)
  if (classifyClean(value))            // one cycle-guarded walk over container nodes
      return JSON.stringify(value, undefined, spaces)   // V8 native fast path
  return JSON.stringify(value, replacer, spaces)        // today's path, byte-for-byte
```

`classifyClean` is an iterative walk over objects/arrays with an **ancestor-path `Set`** (add on descend, delete on ascend — O(1) membership vs today's O(depth) `includes`), returning false on: `bigint`, `instanceof Error`, a node revisited **on the current ancestor path** (a true cycle), or **any object with a callable `toJSON`** (conservative: routes `Date` etc. to the slow path so toJSON-interaction corners can never diverge). Ancestor-path semantics matter: a whole-walk visited `Set` would flag shared substructure (DAGs) as cycles and silently route those values to the slow path forever — output still correct, fast path lost. Native `JSON.stringify` serializes shared references identically to the replacer path, so DAGs classify clean; only genuine cycles fall back. Crucially the scan never inspects string contents — the expensive char-level work (escaping, indentation) runs entirely inside native `JSON.stringify`. Design details:

- **Primitive short-circuit:** `value === null || (typeof value !== "object" && typeof value !== "bigint")` skips the scan and goes straight to native — `stableJson` is called constantly on small/scalar values (line renderings, `jsonCost` of leaf facts); they must not pay a scan setup. Root `bigint` is excluded because today's replacer serializes it as a string while native `JSON.stringify(1n)` throws.
- **Accessor guard:** the classifier must inspect own property descriptors before reading values. Any accessor (`get`/`set`), descriptor read failure, or non-plain object/array prototype routes to the slow path. This prevents the classifier from firing getters before `JSON.stringify` and changing bytes or side effects. Do not implement the walk with `Object.values()` until the descriptor guard has accepted the object.
- **One classifier, two consumers:** `classifyClean` is the same module-private classifier item 9's length walker uses for its exotic fallback. A single implementation prevents the two from ever disagreeing about which values are "clean".

Byte-identity argument: for clean values the replacer is the identity function (`return item`), so replacer and native outputs are definitionally equal; all exotic and toJSON-bearing values take today's path unchanged. `try/catch` around the fast path as belt-and-suspenders (any throw → slow path).

**Recorded fallback design** (if parity fuzzing surfaces any divergence class that survives the toJSON-conservative rule): keep the replacer architecture unchanged and only mirror the `ancestors` stack in a parallel `Set` for O(1) cycle membership. Strictly smaller win (native fast path stays lost) but unconditionally identical by construction — the floor outcome of this item, not a parked alternative.

### Verification

1. Parity test: old implementation as reference oracle; byte-equality over the `bench:distill` corpus envelopes + randomized JSON-shaped fuzz + adversarial cases (root/nested `bigint`, Error, cycle, Date/toJSON, accessor getter with mutation, non-plain prototypes, lone surrogates, `undefined` in arrays/objects, deep nesting). Red-first: perturb the classify condition to prove the test bites.
2. Micro-bench in the test over corpus envelopes (log ratio; accept bar: measured speedup on the clean path, no regression on exotic path).
3. `stableJsonInvocationCounter` semantics unchanged (counter increments once per call regardless of tier).
4. `src/utils/json.ts` is shared (not kernel-inventory scope); confirm via `check:surface-liveness` that no ledger entry is touched. Gates: `check:all:src`, `check:all:contracts` (blast radius spans tools), then full `npm run check`.

---

## 9. Exact-Length Cost Probe — measure without materializing

### Problem

The default render path serializes values **only to read `.length` and discard the string**:

- Fact construction (`src/tools/summaries/registerBuiltinDistillers.ts:39-40`): `cost: jsonCost(value)` and `cost: jsonCost(compact)` — two full serializations per fact per render, strings thrown away (`jsonCost` = `stableJson(value).length`, `cost.ts:12`).
- Fitter probes: `salienceEnvelope.ts:99/:108/:118/:121` (envelope, base, per-key full+compact ≤16) and `ladder.ts:46-48` `stableJsonLength` + the `dropLowPrioritySummaryFields` re-measure loop (`ladder.ts:63`) — all length-only.

For hundreds of facts per observe this is pure allocation/GC churn: megabyte-scale strings built, measured, collected.

### Design

Add a kernel-internal exact-length walker `jsonCostFast(value, spaces = 2): number` (in `src/distill-core/cost.ts`, export declared `internal` in `kernel-export-inventory.json`) that computes the current stable-JSON length **without building the string** on clean values. It must support both pretty (`spaces = 2`) and compact (`spaces = 0`) modes because `src/distill-core/fit.ts` exports `jsonBudgetLength(value, spaces)` and `src/distill-core/projection.ts` calls that path repeatedly with `spaces = 0`.

- Pretty-print: newline + indent costs as a function of the recursive depth; `": "` key separators for `spaces = 2`; compact separators for `spaces = 0`; `{}`/`[]` compact empty forms
- String escaping lengths: `"` `\` and `\b \f \n \r \t` → 2; other control chars → 6 (`\u00XX`); lone surrogates → 6 (well-formed stringify escapes them); all other code units → 1
- Numbers: finite via `String(n).length`; **non-finite (`NaN`/`±Infinity`) cost 4 — `JSON.stringify` emits `null`** while `String(NaN)` is 3 chars (the same parity-bug class the v3 audit caught in item 7's surrogate skip); `-0` stringifies as `0` on both paths; `undefined`/function/symbol omitted in objects, `null` (4) in arrays
- Exotics and toJSON-bearing values: detected via the **same `classifyClean` classifier item 8 introduces** (shared implementation, never a second opinion), falling back to `stableJson(value).length` (correct by definition; rare)

The public result must preserve today's **standalone** probe semantics: `jsonCostFast(v, spaces) === (stableJson(v, spaces) ?? "").length`. The recursive implementation may track depth internally, but this workstream must not change salience/ladder candidate decisions by reinterpreting existing per-key costs as embedded envelope costs. Embedded-cost accounting is a separate behavior-changing allocator proposal.

Switch the length-only call sites to the walker: `jsonCost` body, `ladder.ts` `stableJsonLength`, `salienceEnvelope.ts` probe sites, and `fit.ts` `jsonBudgetLength` (which carries the projection budget surface). Sites that need the text (emission, stable keys, marker counting, item 5's threaded strings) keep `stableJson`.

### Verification

1. Length-parity test: `jsonCostFast(v, spaces) === (stableJson(v, spaces) ?? "").length` for `spaces = 0` and `spaces = 2` over the bench corpus + randomized fuzz including every escaping class above (control chars, astral pairs, lone surrogates, deep nesting, empty containers, `undefined` placements, non-finite numbers, `-0`). Red-first: perturb one escape-class length.
2. `stableJsonInvocationCounter` assertion: probe-heavy paths (fact construction, salience fit, inline JSON budget/projection fit) show the expected drop in string-building invocations.
3. `npm run bench:distill` before/after; accept bar: measured improvement on corpus envelopes, byte-identical fitted outputs (reuse item 5's byte-identity cases).
4. Map the test in `kernel-test-map.json` (G5); declare the export `internal` (G2). Gates: `check:distill-core-boundary`, `check:compute-once`, `check:all:contracts`.

---

## 12. `compactSummaryValue` Unbounded Array Recursion — defect fix

### Problem

`compactSummaryValue` (`src/distill-core/granularity.ts:36-51`) guards object depth (`depth >= 5` → placeholder, line 42) but the **array branch at line 41 sits before the guard and recurses without any depth check** — nested arrays bypass the cap entirely.

Reachability is verified, not assumed: `resultMiddleware.ts:486` calls `fitSummaryBudget` on **every distilled tool result**, and the generic summary path (`src/tools/summaries/generic.ts`) carries `browser_execute`'s arbitrary page-JSON results into it; `fitSummaryBudget` drives `compactSummaryValue` on its compaction rungs (`ladder.ts:85-94`). A hostile or malformed page returning deeply nested arrays (`[[[[…]]]]`, one line of page JS) therefore drives unbounded recursion in the host process: stack overflow. This is a correctness/resilience defect with a CPU dimension, not an optimization.

### Design

1. Move the depth guard above the array branch with a **high cap** (depth ≥ 64 → `{ type: "array", length }` / existing object placeholder). 64 preserves every realistic page value byte-identically (the object cap is already 5; legitimate scan/execute structures are far shallower) while bounding the pathological case. Behavior changes **only** for >64-deep nesting — document as the defect-fix exception to the byte-identity rule.
2. Sweep the same entry points for siblings: verify `stableJson` (native throws `RangeError` on extreme depth — caught behavior must be defined at the tool boundary, not a kernel crash) and `tokenEstimate` (linear, safe) under the same adversarial inputs.

### Verification

1. Red-first stress regression test: 10k-deep nested array, 10k-deep nested object, 1MB string, 5k-entity array — current code must demonstrably stack-overflow on the array case before the fix; post-fix all complete with bounded output.
2. Byte-identity spot check: realistic envelope fixtures (bench corpus) produce identical output pre/post.
3. Map the test in `kernel-test-map.json` (G5). Gates: `check:distill-core-boundary`, `check:all:src`.

---

## 10. Inference Engine — single-pass feature view

### Problem

`buildInferenceSummary` (`src/abml-core/inference.ts:411`) runs on every default observe. Verified waste, two patterns:

- **Repeated full-table passes with per-call string building.** Twelve detectors each scan the entire merged entity list (often several sub-passes: `filter`+`find`+`map`), and the shared helpers rebuild derived strings on every call — `textOf` concatenates and lowercases `name+role+selector` per invocation (`inference.ts:83-86`), `roleOf` allocates a lowercase string per call (`:79-81`). For N entities this is ~20-40 N element visits and thousands of throwaway string allocations per observe.
- **Score recomputation inside a sort comparator.** `detectLogin` (`:207-214`) calls `loginCandidateScore` — ~6 regex tests plus a `textOf` rebuild per call — once per entity in the filter, then **again twice per comparison** in `.sort((a, b) => loginCandidateScore(b) - loginCandidateScore(a))`. On link-heavy login pages (K candidates) that is 2·K·log K redundant score evaluations.

### Design

Same architecture move the relevance plan already landed (R1: compute once, hooks become lookups):

1. **Feature view pre-pass:** one pass over the entity list computes per-entity derived features — `roleLower`, `textLower` (the `textOf` concat), `nameLower`, `perceptible`, `isEditableControl` — into an array-aligned view passed to all detectors. Keep iteration over the original `entities` array and lookup by stable index/ref so evidence refs, tie order, and first-match behavior stay byte-identical. Helpers (`roleOf`, `textOf`, `isPerceptible`, …) become view lookups; detector predicates and regex tests run over precomputed strings.
2. **Decorate-sort-undecorate in `detectLogin`:** compute `loginCandidateScore` once per entity into `{entity, score}` pairs, filter `score > 0`, sort by the precomputed score. V8's stable sort plus the identical score values make the selected winner identical.
3. Detector logic, thresholds, regexes, and dedup rules are untouched — this is pure evaluation-order refactoring; `InferenceSummary` output must be deep-equal.

### Verification

1. Output-identity test: fixture entity sets covering all 12 intents (including first-match cases, equal-score login candidates, and grouped/scattered checkbox branches) assert deep-equal `buildInferenceSummary` output pre/post.
2. Existing contract gate `check:abml-inference` stays green untouched.
3. Micro-bench in the test at N=500 mixed entities (log ratio; accept bar applies).
4. Map the test in `kernel-test-map.json` (G5); no new exports (G2). Gates: `check:abml-core-boundary`, `check:all:src`.

---

## 11. Hot-Comparator Decoration Sweep — exact-output micro class

### Problem

Five verified sites do per-comparison or per-iteration work that should be computed once:

- `buildCausalSummary` (`src/abml-core/causal.ts:131`): the delta sort comparator calls `num(a.seq)`/`num(b.seq)` — a `Number()` conversion per side per comparison over the full since-baseline record set (hundreds after an SPA navigation).
- `typeRank` (`src/abml-core/relations.ts:52-55`): `TYPE_ORDER.indexOf(type)` — an O(13) array scan — runs inside two sort comparators (`sortRelations` per relation-bearing entity, `buildRelationSummary` highlight sort over all semantic edges).
- `changeScore` (`src/abml-core/diff.ts:135`): the salient-field array literal is re-created **inside the per-field loop** on every changed item scored by `summarizeEntityDiff`.
- `topLevelOrigin(context.url)` (`src/abml-core/entity.ts:276`, same pattern at `:330/:390/:432/:484`): every entity builder evaluates the condition-and-value spread `...(topLevelOrigin(context.url) ? { topLevelOrigin: topLevelOrigin(context.url) } : {})` — **two `new URL()` parses per entity built**, for a value that is constant across the entire scan.
- The same double-evaluation in the AX entity builder: `buildAxEntityFromNode` (`src/abml-core/ax.ts:303`) — two `new URL()` parses **per AX node built**, against `ax.ts`'s own private duplicate of `topLevelOrigin` (`ax.ts:55-62`, a twin of `entity.ts:129`). Found in the v8 sweep of the previously not-deep-read `ax.ts` non-merge regions.

### Design

Decorate-sort (precompute `seq` per record before sorting — the filter at `causal.ts:127-130` already computes `num(r.seq)` once per record, so decoration folds filter+sort into one pass), a module-level `Map<RelationType, number>` for `typeRank`, a hoisted module-level `Set` for the salient-field check, and for the builders a local `const origin = topLevelOrigin(context.url)` per call plus a module-private single-slot memo (last url → origin; deterministic, no clock/random — G4-safe). The origin change collapses `entity.ts` from 2N parses to at most one parse per repeated URL in that module; `ax.ts` gets the same local result with its own private memo. Each keeps its private helper + memo rather than introducing a new cross-module export, so G2 stays untouched. All five are exact-output by construction (same keys, same comparisons, same tie-breaks, same origin string).

### Verification

1. Exact-output unit tests per site (existing fixtures extended with tie cases); red-first by perturbing one rank.
2. One shared micro-bench (log ratio; accept bar applies — if the measured win is noise-level, record the number and do not land).
3. Map tests in `kernel-test-map.json` (G5); no new exports. Gates: `check:abml-core-boundary`, `check:abml-causal`, `check:abml-relation-graph`, `check:abml-diff`, `check:abml-scan-entities`, `check:abml-ax-runtime`, `check:all:src`.

---

## 13. `groupEntities` — one grouping per observe (single-slot memo)

### Problem

`groupEntities` (`src/abml-core/grouping.ts:88-98`) is the shared grouping engine the kernel-opt plan consolidated all template consumers onto. Consolidation unified the **code** but not the **execution**: the engine has no cache, and one default observe runs it repeatedly over the same entities:

- `snapshotProjection.ts:149` and `semanticRefAnchor.ts:110` (via `buildIdentityGraph`, `identityGraph.ts:24`) both group the **same `attributedEntities` array instance** back-to-back (`scanRunner.ts:381-382`) — a guaranteed duplicate execution on every default observe.
- On baseline observes, `treeDiff.ts:240-241` groups the before and after lists first (`scanRunner.ts:346-347`); when causal attribution leaves the list unrewritten (`scanRunner.ts:361` returns `abmlEntities`, which **is** `observation.abmlRead.entities` — `scanRunner.ts:342` — the same instance treeDiff received as its after list), the projection grouping is a third execution of the same instance.
- The verbs read path (`src/abml/verbs/runtime.ts:132`) calls `deriveSemanticRefAnchors` on its own flow and inherits the same memo for free.

Each execution is a full pass with a `JSON.stringify` descriptor key per grouped entity (`grouping.ts:43`) plus map/filter allocation. This is (d)-class counted redundant work on the default path — the same compute-once class as item 5, at the grouping seam.

**Not a reopen of the closed kernel-opt plan:** no A/B item adjudicated per-observe execution count (A-series consolidated four consumers onto one engine; B3 landed as capture-side string surgery). The consolidation is precisely what makes a single memo point well-defined — one engine, one seam. Recorded here so the do-not-re-litigate rule and this item never collide.

### Design

Module-private single-slot memo in `grouping.ts`: `lastInput` / `lastGroups` pair keyed by **array reference identity**; on hit return a fresh top-level copy (`lastGroups.slice()`), group objects shared structurally. Reference keying makes stale hits impossible (the attribution rewrite at `scanRunner.ts:362-368` builds a new array, so changed entities always miss — a safe miss, never a wrong hit).

The top-level copy is mandatory, not defensive paranoia: `suppressNestedNonControlGroups` returns its **input array unchanged** when no control groups exist (`grouping.ts:102`), and `semanticRefAnchor.ts:66` then `.sort()`s that array in place — without the copy, the memo's canonical order would be corrupted for the next consumer (templating breaks count ties by input order under stable sort).

Aliasing audit is the load-bearing safety argument: the four consumers (`treeDiff`, `snapshotProjection`, `templating`, `semanticRefAnchor`) must not mutate shared group internals (`descriptor` / `members`). Verified at the call sites during execution and pinned by a deep-freeze test (freeze the memoized groups, run all four consumers over them, no throw).

Deterministic (same input → same output), no clock/random reads (G4-safe), memo module-private (no G2 change).

### Verification

1. Output-identity fixtures: `buildTreeDiff` / `buildSnapshotProjection` / `buildIdentityGraph` / `buildTemplateSummary` outputs deep-equal pre/post across same-instance and fresh-instance call sequences. Red-first: return the memoized array without the top-level copy and assert the semanticRefAnchor-sort corruption is caught by the templating tie-order fixture.
2. Memo-hit assertion without a counter export: on a same-array second call, returned group objects are reference-equal (`groups1[0] === groups2[0]`) while the top-level arrays are not (`groups1 !== groups2`); a structurally-equal but fresh array misses (deep-equal output, non-identical groups).
3. Deep-freeze aliasing test per the design section.
4. Micro-bench: first-call vs memo-hit cost at N=500 entities (ledger row 13); executions-per-observe accounting from the call-site table above.
5. Remove `src/abml-core/grouping.ts` from the G5 grandfather list and map the new direct grouping test in `kernel-test-map.json`; no new exports (G2). Gates: `check:abml-core-boundary`, `check:abml-tree-diff`, `check:abml-templating`, `check:abml-snapshot-projection`, `check:abml-semantic-ref-anchor`, `check:abml-causal`, `check:session-delta-long-conversation`, `check:all:src`. **Marker caution:** run `npm run query:markers -- --file src/abml-core/grouping.ts` before landing; current marker impact includes the grouping contracts plus `check:abml-causal` and `check:session-delta-long-conversation` (the F3 lesson: narrow gates != closing gate).

---

## Sweep Coverage Map (2026-06-13 — do not re-litigate without new evidence)

The per-observe kernel chain was swept for complexity defects. Coverage is stated explicitly so "audited clean" never silently overclaims:

**Deep-read, clean** (findings, if any, extracted into items above):
- `diff.ts` — Map-based O(n) matching; top-12 selection is a bounded sort. Only the field-literal hoist (item 11).
- `relations.ts` — Map-keyed anchor resolution, O(entities + anchors); per-entity caps bound fan-out. Only the `typeRank` map (item 11).
- `causal.ts` — bounded by `MAX_CAUSAL_REQUESTS/EVENTS=12` after the delta sort. Only the seq decoration (item 11).
- `entity.ts` — all builders O(1) per entity, Set-based dedupe, `dedupeLocators` stringify bounded at ≤3 locators. Only the `topLevelOrigin` double-parse (item 11).
- `inference.ts` — extracted into item 10.
- `granularity.ts` — extracted into item 12.
- `salienceEnvelope.ts` / `ladder.ts` / `allocate.ts` / `cost.ts` / `fit.ts` / `projection.ts` / `relevance.ts` / `profile.ts` (memory-core) — read in the v2→v9 audit cycle; findings are items 5/7/9.
- `semanticRefAnchor.ts` (v8 sweep) — grouping cost extracted into item 13; the three trailing count-`filter`s over anchors (`:119-121`, three array passes to read `.length`) examined and **rejected as noise-level** (no string work, no nested loops).
- `identityGraph.ts` (v8 sweep) — clean: Map-keyed, O(entities + relations), no per-comparison work.
- `templating.ts` (v8 sweep) — clean: `buildTemplate` is 7 fields × N `every` (bounded), consumers capped at `MAX_TEMPLATES`; `structureScopeKey`'s per-call `JSON.stringify` in suppress filters examined and rejected as noise-level (bounded by group count).
- `ax.ts` non-merge regions (v8 sweep) — `topLevelOrigin` double-parse at `:303` extracted into item 11; per-node helpers are single-pass via `axPropertyMap` (`:72-81`), locator dedupe bounded at ≤3; the merge itself (`:405-429`) stays closed-plan territory below.

**Bounded by design** (data caps make hotspots structurally impossible):
- `memory-core` — `MAX_TERMS=48`, `MAX_SESSIONS=8`, `MAX_URLS=8`; clone-on-distill bounded by the same caps.
- `PerceptionLedger` — ring ≤32, frame LRU ≤8 per session+tab.

**Closed-plan territory** (reopen only via their recorded evidence bars):
- `treeDiff`/`grouping`/`snapshotProjection`/`refId` — kernel-opt plan (A1-A6/B1-B3, closed 2026-06-10).
- DOM-AX merge (`ax.ts:405`) — measurement-gated (Step 0 `abmlMs` + micro-attribution is the reopen bar).

**Sweep status:** the per-observe kernel-chain sweep is **complete** — every module on the default observe path is now deep-read, bounded-by-design, or closed-plan territory. Outside this sweep's scope (no claims made): the runtime integration layers (`src/abml/`, `src/distill/`, `src/memory/`), the tool layer, and `capture-src/` page templates — admissible for a future sweep only through the standing-rule evidence classes, not pattern hunts.

**Cross-cutting negatives:**
- No `new RegExp` construction anywhere in the kernels; no catastrophic-backtracking regex shapes in kernel hot paths (`inference.ts` patterns are alternation/literal classes, linear).
- V8 hidden-class/monomorphism shaping of entity objects — plausible but speculative; admissible only from a harvested CPU profile (standing rule).

---

## Forward Directions

**Standing rule:** new optimization items enter only from (a) a harvested stage profile, (b) a triaged blind-eval finding, (c) a `bench:distill` regression, or (d) a verified defect (reachable pathological input or counted redundant work on the default path, confirmed at source with file:line). Items 8/9/10/11 entered on (d)-class counted evidence with accept bars requiring measured wins before landing; item 12 is a reachability-verified correctness defect.

### B. Token economy: per-entity fitter granularity

Each lifted key offers only `full` or `compact` (`salienceEnvelope.ts:115-123`); a per-entity knapsack inside `entities` could retain more referenced/high-salience entities at the same character budget. Measurable offline against the `bench:distill` corpus. **Gate:** output-shape change, Tier-3 class — blind-eval transcript evidence required before landing.

### C. Emission reuse across the kernel boundary

After items 5/8/9, the remaining duplicate is structural: the fitter serializes the final fitted envelope (`salienceEnvelope.ts:135`) and the tool layer serializes it again for transport. Returning the fitted text alongside the envelope changes the kernel contract (G2 + runtime change). **Gate:** Step 0 evidence that `renderMs` remains significant after items 5/8/9 land.

### D. Large-page latency: the lever is already documented

The real large-page cost is N `DOM.getBoxModel` CDP round-trips. Replacing them with one `DOMSnapshot.captureSnapshot` joined by `backendNodeId` is the documented lever (`docs/archive/performance-overhead-audit.full.md:432-434`). Trigger only from measured stage-profile latency.

---

## Governance Gate Impact

| Gate | Impact |
|------|--------|
| G2 `check:surface-liveness` | Item 9's `jsonCostFast` declared `internal` in `kernel-export-inventory.json`; items 5/7/10/11/12/13 add no exports (feature view, rank map, depth guard, origin memos, and grouping memo are module-private; item 13's memo-hit assertion uses reference identity instead of a counter export); item 8 is in shared `src/utils/` (outside kernel inventory — confirm during execution) |
| G6 `check:env-flags` | None — no new flags |
| G3 `check:compute-once` | Item 5/9 invocation-counter assertions; add `CALL_SITE_LIMITS` ratchets for the final stableJson/jsonBudgetLength probe counts once the replacement sites are known |
| G4 purity vocabulary | No banned APIs across all items (deterministic `Set`/`Map`/`charCodeAt`/reference-keyed memos only; no clock/random reads) |
| G5 `check:kernel-test-map` | New test files for items 5, 7, 9, 10, 11, 12, 13 mapped in `kernel-test-map.json`; item 13 removes `grouping.ts` from grandfathering; item 8's test lives with utils tests |
| G1 `check:spec-truth` | This doc registers no contract claims |
| Behavioral contracts | Item 10 must keep `check:abml-inference` green untouched; item 11 must keep `check:abml-causal` / `check:abml-relation-graph` / `check:abml-diff` / `check:abml-scan-entities` / `check:abml-ax-runtime` green untouched; item 13 must keep `check:abml-tree-diff` / `check:abml-templating` / `check:abml-snapshot-projection` / `check:abml-semantic-ref-anchor` / `check:abml-causal` / `check:session-delta-long-conversation` green untouched; item 12 is the sole sanctioned output change (>64-deep nesting only) |
