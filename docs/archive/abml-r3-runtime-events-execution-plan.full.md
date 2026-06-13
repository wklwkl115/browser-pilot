# ABML R3 — Runtime Events Execution Plan

> Status: **complete (2026-06-04)**.
> Does **not** add public `browser_abml_*` tools. ABML stays internal substrate; new
> output fields ride existing `browser_observe` + action verb envelopes.

Source roadmap: `docs/archive/abml-perception-state-evolution-plan.full.md` → R3.

## 0. Baseline

ABML P1/P2/P3 + R1 + R2 are complete and stable:

- `browser_observe` envelope exposes `abmlIntegrated / gist / outline / relations / inference`
  at top-level (budget-immune). All locked by contract tests.
- R1 provides typed `EntityRelation[]` on entities; R2 adds page-level intent labels.
- Both are **snapshot-only**: one `observe` call = one frozen page state. No temporal
  information: what changed, what was focused, what appeared after an action.

This is the gap R3 fills.

## 1. Objective

Add a **temporal dimension** to the ABML entity model so agents can understand page
transitions without hand-writing JS:

- **Entity diff**: what entities changed state / appeared / disappeared between two
  observe calls (pre-action vs post-action).
- **Focus migration**: which entity received focus after an action (click, type, keyboard).
- **Dependency inference (R2 extension)**: "this button is disabled because field X is
  empty" — detectable by observing that filling X enables the button.

All three share a common architecture: two AX snapshots diffed in pure core.
No new CDP calls needed beyond what `observe` already uses; no new browser hooks.

## 2. Non-goals

- No network/API causal plane yet (separate execution contract: what request fired when
  a control was activated — needs the existing network recorder, separate scope).
- No vision/OCR expansion (stays on-demand floor per Non-goals).
- No iframe AX aggregation (deferred to broader R3 perception completeness work).
- No live streaming diff (push model). R3.1 is pull model only: caller drives two
  observe calls and passes both snapshots to the diff function.
- No `bridge/native_command_schema.json` change.

## 3. Output contract

### 3.1 Entity diff

New pure-core function in `src/abml-core/diff.ts`:

```ts
type EntityChangeKind = "appeared" | "disappeared" | "state-changed" | "name-changed";

type EntityChange = {
  ref: string;
  kind: EntityChangeKind;
  before?: Partial<EntityState>; // state before (for state-changed)
  after?: Partial<EntityState>;  // state after
};

type EntityDiff = {
  appeared: string[];    // refs of new entities
  disappeared: string[]; // refs that are gone
  changed: EntityChange[]; // entities whose state/name changed
};

function diffEntities(before: Entity[], after: Entity[]): EntityDiff;
```

Rules:
- Match entities across snapshots by `ref` (stable pi-ref across same-page snapshots).
- `appeared` = refs in `after` not in `before`.
- `disappeared` = refs in `before` not in `after`.
- `changed` = same ref, different `state` fields or `name`.
- Empty arrays when nothing changed. Pure function (no browser calls).

### 3.2 Focus migration

New field on `EntityDiff`:

```ts
type EntityDiff = {
  ...
  focusedRef?: string; // entity that has focus in the `after` snapshot (if any)
};
```

Populated from the entity whose `state.focused === true` in the `after` snapshot.
No new CDP call — `focused` already comes from the AX tree (`getFocusedNode` merged
into entity state by the existing AX pipeline).

### 3.3 Envelope surface

`browser_observe` gains an optional `diff` field at envelope top-level (same
budget-immune lift pattern as `gist`/`outline`/`relations`/`inference`):

```json
{
  "gist": {...},
  "relations": {...},
  "inference": {...},
  "diff": {
    "appeared": ["pi-ref://control/dropdown-item-1", ...],
    "disappeared": [],
    "changed": [
      { "ref": "pi-ref://control/submit", "kind": "state-changed",
        "before": { "disabled": true }, "after": { "disabled": false } }
    ],
    "focusedRef": "pi-ref://control/username"
  }
}
```

`diff` is **only present** when a baseline snapshot is provided (opt-in). When absent
(standard single observe), the envelope is unchanged — full backwards compatibility.

### 3.4 Dependency inference (R2 extension)

New `inference` intent kind `"form-flow"` (or added evidence on existing intents):
once R3.1 is available, R3.3 detects:

- A disabled button that became enabled after a field's `editable` entity changed
  value → emit `inference.dependsOn: [{controlRef, requiredRef}]` on the enabled entity.
- This is the R2 "dependency facts" gate: not added until R3.1 diff is stable.

## 4. Architecture

### 4.1 Pure core additions

New module `src/abml-core/diff.ts` (pure, zero browser deps):

- `diffEntities(before: Entity[], after: Entity[]): EntityDiff`
  — ref-keyed comparison, state delta extraction.
- `EntityDiff`, `EntityChange`, `EntityChangeKind` types.
- Locked by `check:abml-core-boundary` (add `"diff.ts"` to PURE_CORE; 18th module).

### 4.2 Runtime integration

`src/abml/verbs/runtime.ts` (or a new helper): expose a two-call helper:

```ts
// Optional: caller can pass a prior snapshot as baseline for diff computation.
type AbmlReadOptions = { ... baseline?: Entity[] };
```

When `baseline` is provided, call `diffEntities(baseline, mergedEntities)` and
attach to the result. The baseline is the caller's responsibility (they ran a prior
`readStructure` call, usually before an action verb).

### 4.3 Tool surface

`src/tools/observeRunners.ts`: thread `baseline` entities through `abml.readStructure`
if the caller passes `params.baseline` (a prior entity list or snapshot ref). Surface
`diff` in focus when present.

`src/tools/resultMiddleware.ts`: add `diff?: Record<string, unknown>` to
`DistilledEnvelope` + `envelopeDiff()` lift (same pattern as `envelopeRelations`).

`src/tools/summaries/outputSchemas.ts`: add `EntityDiffSchema`.

### 4.4 Action verb integration (post-R3.1)

In `src/abml/verbs/runtime.ts` click/type verb result: capture pre-action entities,
execute the verb, observe post-action entities, compute diff, attach to verb result.
This makes "what changed" visible without a separate observe call.

## 5. Phase gates

### R3.0 — Scaffolding + failing contract

- Add `tests/unit/abml/diff.test.ts` (unit scaffold — diff logic, appeared/disappeared/changed).
- Add `tests/contracts/tools/check-abml-diff.mjs` (contract scaffold — static wiring guards,
  envelope diff field).
- Gate: `check:abml-core-boundary` still green after adding `diff.ts` placeholder.

### R3.1 — Entity diff pure core

- Implement `diffEntities` in `src/abml-core/diff.ts`.
- Unit tests: appeared/disappeared/changed (state delta), focusedRef, empty diff.
- Gate: `test:unit -- tests/unit/abml/diff.test.ts` green.

### R3.2 — Runtime integration + envelope surface

- Thread `baseline` option through `readStructure` → `diffEntities`.
- Lift `diff` to envelope top-level in `resultMiddleware`.
- Gate: `check:abml-diff` contract green; `check:abml-scan-envelope` still green.

### R3.3 — Dependency inference (R2 extension)

- Detect disabled→enabled transitions in `EntityDiff.changed`.
- Emit `inference.intents` entry `"form-dependency"` with evidence `{enabledRef, requiredRef}`.
- Gate: unit test covers disabled→enabled detection; contract test asserts new intent kind.

### R3.4 — Integration, docs, live validation

- Real-page validation: click a form submit button (disabled), type in required field,
  re-observe — `diff.changed` must show `disabled: true → false` on the button.
- Update `docs/archive/abml-perception-state-evolution-plan.full.md` R3 status.
- Gate: `npm run check` green + live smoke passes.

## 6. R3.x handoff conditions

Network/API causal plane (R3.x) starts only when:
- R3.1 entity diff is stable in model-facing output.
- At least one real-page validation shows meaningful diff on a state-transition.

## 9. Completion notes (2026-06-04)

Implemented:
- Pure core `src/abml-core/diff.ts` + `src/abml/diff.ts` shim + barrel/boundary manifest.
- `runAbmlRead` baseline → `EntityDiff`; click/type action runtimes attach post-action diff.
- `browser_observe mode=scan` optional `baseline` parameter; accepts inline entity arrays,
  prior summary/envelope objects, or saved observation `snapshotId` artifacts.
- Envelope top-level `diff`, `EntityDiffSchema`, `check:abml-diff` contract, and full check-group wiring.
- Stable same-page pi-ref minting from semantic locator hashes to make snapshot diff matching useful.
- R2 extension: `form-dependency` intent with `{enabledRef, requiredRef}` evidence.

Verified:
- `npm run check:src:types`
- `npm run check:abml-core-boundary`
- `npm run test:unit -- tests/unit/abml/diff.test.ts tests/unit/abml/inference.test.ts tests/unit/abml/verbs.test.ts tests/unit/abml/verbs-runtime.test.ts`
- `npm run check:abml-diff`
- `npm run check:abml-inference`
- `npm run check:abml-scan-envelope`

## 7. Verification command map

Add scripts when implementation starts:

```json
{
  "check:abml-diff": "tsx tests/contracts/tools/check-abml-diff.mjs"
}
```

Preferred iteration:
1. `npm run check:abml-core-boundary`
2. `npm run test:unit -- tests/unit/abml/diff.test.ts`
3. `npm run check:abml-diff`
4. targeted runtime smoke (baseline → action → re-observe → diff)
5. `npm run check`

## 8. Activation checklist

Before coding:
- Historical note: this plan was the active ABML queue while R3 runtime events were landing.
  It is now complete; current activation state belongs in `CURRENT.md` / `TODO.md`.
- Confirm `check:abml-core-boundary`, `check:abml-relation-graph`, `check:abml-inference`
  all green before starting (they are the load-bearing R1/R2 contracts).
- Confirm A/B test JSON files cleaned from repo root (done 2026-06-04).
