# ABML Relationship Graph Execution Plan

> Status: ready-for-activation. This is the concrete execution contract for the next ABML line after the completed internal-substrate work. It does **not** add public `browser_abml_*` tools. Activate by moving it into `CURRENT.md` after the current active workstream is paused/completed or explicitly superseded.

## 0. Baseline

Current validated ABML baseline:

- Kernel split is locked by `docs/abml-kernel-manifest.md` and `npm run check:abml-core-boundary`.
- `browser_observe` already exposes AX-merged entities through existing `browser_*` surfaces.
- Envelope top-level `gist` / `outline` are stable and budget-immune.
- `hints.containerRole` / `hints.containerName` already prove seed membership relations for W3C `radiogroup`.
- Public surface remains canonical `browser_*`; ABML remains internal substrate.

Source roadmap: `docs/abml-perception-state-evolution-plan.md` → R1/R2/R3.

## 1. Objective

Turn current seed container metadata into a typed, testable ABML relationship graph that agents can use without page JS:

- controls know their labels/descriptions;
- controls know owned/controlled expanded targets;
- table/grid cells know row/column/header context;
- current navigation state is represented as a relation, not only a scalar state;
- occlusion/coverage is represented as geometry-backed relations;
- envelope exposes a compact top-level relation summary that cannot disappear under summary budget.

## 2. Non-goals

- No new public `browser_abml_*` tool surface.
- No site-specific or page-type-specific branches.
- No R2 semantic inference labels yet (`login`, `single-choice`, `filter-panel`) except as fixture names/tests.
- No runtime event/network causal plane yet.
- No vision/OCR-first perception; geometry-only occlusion is allowed in R1.
- No `@pi/abml-core` workspace promotion in this workstream.

## 3. Output contract

R1 adds two stable outputs.

### 3.1 Entity-level relations

Extend `Entity` with optional typed relations:

```ts
type EntityRelation = {
  type:
    | "labelledBy"
    | "describedBy"
    | "controls"
    | "owns"
    | "expandedTarget"
    | "currentIn"
    | "cellOf"
    | "rowOf"
    | "columnOf"
    | "headerFor"
    | "occludes"
    | "coveredBy";
  targetRef: string;
  source: "ax" | "dom" | "geometry";
  confidence: "high" | "medium" | "low";
  evidence?: Record<string, unknown>;
};
```

Rules:

- Relations use `pi-ref://...` targets only after ref materialization.
- Pre-ref extraction may use backend node ids / AX node ids / idrefs internally, but those must not leak as final relation targets.
- Scalar compatibility remains: existing `hints.containerRole`, `state.current`, `state.expanded` stay for old callers.
- Sensitive label/description text follows existing redaction rules.

### 3.2 Envelope top-level relation disclosure

Add top-level `relations` to `browser_observe` envelopes, sibling to `gist` and `outline`:

```json
{
  "gist": { "controlCount": 12, "containerCount": 3 },
  "outline": [{ "container": "radiogroup", "memberCount": 3 }],
  "relations": {
    "summary": {
      "labelledBy": 8,
      "describedBy": 3,
      "controls": 2,
      "tableCells": 16,
      "occluded": 1
    },
    "highlights": [
      {
        "type": "controls",
        "sourceRef": "pi-ref://control/...",
        "targetRef": "pi-ref://region/...",
        "source": "ax"
      }
    ]
  }
}
```

Budget rule:

- `relations.summary` must always be present when `abmlIntegrated === true`.
- `relations.highlights` may be capped, but cap must be deterministic and documented.
- Full relations remain available through entity refs/artifacts.

## 4. Architecture

### 4.1 Pure core

Add or extend pure-core modules only:

- `src/abml-core/entity.ts`
  - add `EntityRelation` and `relations?: EntityRelation[]`.
- `src/abml-core/relations.ts` *(new, preferred if model code grows)*
  - relation anchor types;
  - relation dedupe;
  - relation materialization from anchors to refs;
  - relation summary builder.
- `src/abml-core/ax.ts`
  - extract AX relation anchors from AX properties / child relationships;
  - keep DOM↔AX merge authoritative for state, but relation extraction separate and auditable.

Pure-core still must pass `check:abml-core-boundary`: no browser, no Node, no tools/resources/scan imports.

### 4.2 Runtime

Runtime only supplies raw browser evidence and ref registration:

- `src/abml/verbs/axRuntime.ts`
  - preserve AX properties needed for relations: labelledby, describedby, controls, owns, expanded, current, row/col metadata.
- `src/abml/verbs/runtime.ts`
  - run relation materialization after DOM/AX entity merge and after refs are minted.
- `src/tools/observeRunners.ts`
  - surface `relations` at envelope top-level next to `gist` / `outline`.
- `src/tools/summaries/outputSchemas.ts`
  - add schema for `EntityRelation` and top-level relation summary.

### 4.3 Two-pass relation pipeline

1. **Extract anchors** from AX/DOM/geometry:
   - `{ sourceEntityKey, type, targetEntityKey, source, confidence, evidence }`
2. **Merge entities** DOM↔AX.
3. **Mint/register refs**.
4. **Materialize relations** by converting entity keys to `targetRef`.
5. **Build top-level relation summary** from materialized relations.

This avoids leaking unstable backend ids and keeps refs as the only public handle.

## 5. Phase gates

### R1.0 — Contract baseline and fixture map

Tasks:

- Add fixture inventory under `evals/browser-workflows/fixtures/abml-relations-*` or reuse W3C/APG pages where stable.
- Add failing contract scaffold: `tests/contracts/tools/check-abml-relation-graph.mjs`.
- Add unit scaffold: `tests/unit/abml/relations.test.ts`.

Required fixtures:

| Relation | Fixture |
| --- | --- |
| labelledBy / describedBy | input/button with `aria-labelledby`, `aria-describedby`, native label fallback |
| controls / owns / expandedTarget | combobox or accordion with `aria-controls` / `aria-expanded` |
| table/grid | table with row/column headers and cell positions |
| currentIn | breadcrumb/nav with `aria-current` |
| occludes / coveredBy | modal or sticky overlay covering a button |

Gate:

- `npm run check:abml-core-boundary`
- `npm run check:abml-scan-envelope`
- New scaffold contract fails only on missing R1 fields before implementation.

### R1.1 — Relation data model in pure core

Tasks:

- Add `EntityRelation` type and schema.
- Add pure relation dedupe and summary builder.
- Keep old `Entity` consumers compatible.

Acceptance:

- Unit tests cover dedupe, invalid anchor drop, deterministic cap ordering.
- `EntitySchema` validates entity relations.

Gate:

- `npm run test:unit -- tests/unit/abml/*.test.ts`
- `npm run check:abml-core-boundary`

### R1.2 — Label/description relations

Tasks:

- Extract AX/DOM label and description anchors.
- Materialize `labelledBy` / `describedBy` relations.
- Preserve current clean name behavior; relation adds provenance, not duplicate display text.

Acceptance:

- W3C/native label fixtures show control relation targets.
- `relations.summary.labelledBy > 0` in envelope.
- No sensitive input value leaks through label/description relation evidence.

Gate:

- `npm run check:abml-relation-graph`
- `npm run check:abml-scan-envelope`

### R1.3 — Table/grid relations

Tasks:

- Extract row/column/cell/header anchors from AX table/grid roles and row/col properties.
- Materialize `cellOf`, `rowOf`, `columnOf`, `headerFor` relations.
- Keep `outline` table folding stable.

Acceptance:

- Table fixture: cells expose row/column context and header relations.
- Envelope `relations.summary.tableCells` equals expected fixture count.
- No per-site table logic.

Gate:

- `npm run check:abml-relation-graph`
- targeted table smoke with `browser_observe(mode:"scan")` only.

### R1.4 — controls/owns/expanded target relations

Tasks:

- Extract `aria-controls`, AX controls/owns, and expanded target anchors.
- Materialize `controls`, `owns`, `expandedTarget`.
- Keep scalar `state.expanded` unchanged.

Acceptance:

- Combobox/accordion fixture: trigger control points to controlled/expanded region.
- Collapsed/expanded state is represented both as scalar and relation.

Gate:

- `npm run check:abml-relation-graph`
- targeted APG combobox/accordion live smoke when network available.

### R1.5 — current/active route relation

Tasks:

- Promote `aria-current` from scalar state into `currentIn` relation to owning nav/list/breadcrumb.
- Preserve `state.current`.

Acceptance:

- Breadcrumb/nav fixture: current item has `state.current` and `currentIn` target.
- Envelope relation highlights include one current navigation relation.

Gate:

- `npm run check:abml-relation-graph`

### R1.6 — Geometry occlusion relations

Tasks:

- Add geometry-only overlap relation builder for visible entities.
- Materialize `occludes` / `coveredBy` when overlap and z-order/hit-test evidence are sufficient.
- Keep confidence explicit; do not guess through CSS complexity.

Acceptance:

- Modal/sticky overlay fixture: covered button has `coveredBy` relation with geometry evidence.
- False positives bounded by fixture negatives.

Gate:

- `npm run check:abml-relation-graph`
- local smoke with modal fixture.

### R1.7 — Integration, docs, and live validation

Tasks:

- Update docs/README/CHANGELOG/skill only after runtime behavior is callable and verified.
- Add live W3C/APG validation for at least:
  - radio/radiogroup baseline remains green;
  - combobox or accordion relation;
  - table/grid relation;
  - breadcrumb/current relation.
- Run grouped gates before full check.

Final gate:

- `npm run check:all:contracts`
- `npm run check:all:package`
- `npm run check`
- Skill validation if skill text changes.
- Runtime smoke artifacts written under `.pi/browser-artifacts/` and summarized with paths.

## 6. R2/R3 handoff conditions

Do not start R2 until R1 is stable in envelope + entities.

R2 can start only when:

- `relations.summary` is stable in model-facing output;
- relation fixtures cover label, controls, table/grid, current, occlusion;
- no R1 field is hidden by budget;
- real browser smoke proves at least 3 public pages/fixtures.

R3 runtime events can start before R2 dependency facts, but only as a separate execution plan. Network causal plane and OCR/vision expansion remain deferred.

## 7. Verification command map

Add scripts when implementation starts:

```json
{
  "check:abml-relation-graph": "tsx tests/contracts/tools/check-abml-relation-graph.mjs",
  "smoke:browser:abml-relations": "tsx tests/smoke/smoke-abml-relations.mjs"
}
```

Preferred iteration:

1. `npm run check:abml-core-boundary`
2. `npm run test:unit -- tests/unit/abml/*.test.ts`
3. `npm run check:abml-relation-graph`
4. targeted runtime smoke
5. `npm run check`

## 8. Activation checklist

Before coding:

- Move this workstream into `CURRENT.md` or explicitly pause the current active queue.
- Update `TODO.md` only as navigation if this becomes the active queue.
- Ensure dirty files from other workstreams are not mixed into ABML commits.
- Record success criteria and smoke artifact paths in final summary.
