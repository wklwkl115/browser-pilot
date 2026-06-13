# ABML collection completeness + continuation kernel plan

> Status: COMPLETE — archived 2026-06-13 after Phase 1-3 execution. Phase 1-3 are
> evidence-backed by blind finding
> `evals/browser-workflows/blind-findings.md` L1, while the runtime continuation arm is parked by
> W2 and remains out of scope for this workstream.
> Scope: ABML perception model for long, virtualized, lazy, paginated, or partially observed
> collections.
> Boundary: no new public `browser_*` tool; no public ABML action verbs; no default unbounded
> scrolling/clicking during observe; no site/framework-specific selectors.
> Verification when activated: focused ABML collection contracts + observe envelope contracts;
> closing gate `npm run check`.

This plan turned "scroll more and look again" into an ABML perception-state problem. The agent should
see collection completeness, continuation, backing evidence, and state transitions. The agent should
not choose a scroll action, a click action, or a hidden interaction recipe. The current work item is
perception-only: expose the collection state and continuation signal as data. Runtime continuation
execution is explicitly parked until new evidence proves actuation, not perception, is the blocker.

Current state:

- ABML already has internal verbs in `src/abml-core/verbs/*`, including `scroll`.
- `executeBrowserAbmlScroll` in `src/abml/verbs/runtime.ts` can do bounded scroll probing and, with
  `collect:true`, bounded read-after-scroll entity collection.
- That is a mechanical substrate only. There is no first-class `collections` model with
  `completeness`, `continuation`, `dataSources`, or state-transition evidence, and there is no
  automatic observe-time classification of "this is a viewport window of a larger collection".
- Blind finding L1 (2026-06-13, runs=2: linux.do infinite-scroll topic feed + bilibili lazy card
  grid) confirms the perception half as a general defect: both independent agents named a first-class
  list-continuation signal on `browser_observe scan` as the #1 improvement. W2 records the execution
  half as WAI: both agents could hand-write scroll JS; neither was blocked on actuation.

The target is not "better scroll". The target is a collection kernel.

---

## Design decision

**Agent decides semantic need and budget; ABML decides mechanical collection path.**

Allowed agent-facing concepts:

- observe page structure,
- inspect a collection,
- know whether a collection is partial and what semantic continuation is available,
- compare collection state across observations.

Rejected agent-facing concepts:

- scroll the page,
- click next just to expose more items,
- probe lazy load manually,
- decide whether to use JS scroll vs CDP wheel vs pagination click.

Default `browser_observe mode=scan` must remain a perception call. It can classify collection
coverage and return continuation handles/signals, but it must not run a hidden interaction loop.
No implementation phase in this plan executes that continuation. A future runtime arm needs a new
reopen decision and eval evidence beyond L1/W2.

---

## Target model

Add a budget-immune top-level `collections` block to scan observe envelopes, mirrored into saved
observe artifacts next to `treeDiff`, `snapshotProjection`, `relations`, and `causal`.

Draft shape:

```ts
type CollectionCompleteness =
  | "complete"
  | "folded"
  | "viewport-window"
  | "virtualized"
  | "paginated"
  | "lazy"
  | "unknown";

type CollectionContinuationKind =
  | "read-ref"
  | "artifact-window"
  | "virtual-window"
  | "pagination-edge"
  | "expandable-edge"
  | "data-source"
  | "unknown";

type CollectionModel = {
  collectionId: string;
  kind: "list" | "table" | "grid" | "feed" | "menu" | "tree" | "region";
  containerRef?: string;
  containerRole?: string;
  containerName?: string;
  itemRole?: string;

  observedCount: number;
  itemRefCount: number;
  itemRefs: string[];
  declaredTotal?: number;
  estimatedTotal?: number;
  hiddenCount?: number;

  completeness: CollectionCompleteness;
  confidence: "high" | "medium" | "low";

  continuation?: {
    kind: CollectionContinuationKind;
    handle: string;
    confidence: "high" | "medium" | "low";
    evidenceRefs: string[];
  };

  dataSources?: Array<{
    source: "aria" | "dom" | "network" | "artifact" | "runtime-probe";
    ref?: string;
    summary: string;
    confidence: "high" | "medium" | "low";
  }>;

  evidence: Array<{
    source: "templates" | "itemEntities" | "list_hints" | "rows" | "relations" | "causal" | "growthProbe";
    summary: string;
    jsonPath?: string;
    ref?: string;
  }>;
};
```

The continuation `handle` is an evidence handle, not an executable route. It lets the envelope and
artifact point to the same incomplete collection consistently while Phase 1-3 are implemented.

---

## Execution order

| Order | Item | Why first | Focused verification |
|-------|------|-----------|----------------------|
| 0 | Activation + baseline | Prevent plan drift and prove the current lack of `collections` | `git diff --check`, `npm run check:doc-structure` |
| 1 | Pure collection model | Locks vocabulary before runtime behavior | `npm run check:abml-collections`, `npm run check:abml-core-boundary` |
| 2 | Observe envelope wiring | Makes the model visible through existing `browser_observe` | `npm run check:abml-scan-envelope`, `npm run check:summaries`, `npm run check:docs-sync` |
| 3 | Continuation signal/handle ledger | Lets ABML carry semantic continuation evidence without public gesture verbs | `npm run check:abml-collections`, `npm run check:surface-liveness` |
| 4 | Eval + docs/skill alignment | Proves agents read collection state without reopening public action surface | `npm run eval:browser-workflows -- --fixture-server`, `npm run check` |

Close with full `npm run check`.

Implementation is active through `CURRENT.md`, with the decision, boundary, contract, and
verification commands recorded there.

The former runtime continuation phase is not in the execution order. It is parked in
["Parked: semantic continuation runtime"](#parked-semantic-continuation-runtime).

---

## 0. Activation + baseline

### Problem

Blind finding L1 shows collection completeness / continuation is a real ABML perception gap, while
W2 says manual scroll execution is WAI. The repo currently has only internal scroll mechanics:

- `src/abml-core/verbs/router.ts` has `AbmlScrollInput.collect?: boolean`.
- `src/abml/verbs/runtime.ts` returns `virtualCollectionStop` and collected entities only when
  `collect:true`.
- No source type currently exposes `CollectionModel`, `completeness`, or semantic `continuation`.

### Design

Before code work, activate this plan in `CURRENT.md` and record:

- no public `browser_scroll`,
- no revived `browser_execute {action}`,
- no default unbounded scroll/click loop in observe,
- `collections` is a perception output, not an execution tool,
- Phase 1-3 are the activation scope; runtime continuation stays parked.

### Verification

1. `git diff --check`
2. `npm run check:doc-structure`
3. Confirm `CURRENT.md` has exactly one active execution line for this plan before implementation.

---

## 1. Pure collection model

### Problem

Existing ABML structures know about repeated entities (`templates`, `treeDiff`,
`snapshotProjection`) and scan-level list evidence (`list_hints`, `rows`), but no pure kernel
classifies collection coverage or continuation.

The blind run also exposed two traps:

- raw `outline.memberCount` / AX container member counts can conflate sidebars, categories, tags, and
  real items; linux.do overstated 30 actual topics as 241/925, and bilibili reported 84 mixed
  members. These counts must never be the item count or completeness oracle.
- `data.rows` is not a semantic list model. In the two runs it was sidebar/nav links or empty, while
  the real list/card items were elsewhere.

### Design

Add pure-core module:

- `src/abml-core/collections.ts`
- shim `src/abml/collections.ts`
- export from `src/abml-core/index.ts`
- update `docs/abml-kernel-manifest.md` generated manifest through `npm run docs:sync`

Primary pure functions:

```ts
export function buildCollectionModels(input: {
  entities: Entity[];
  templates?: StructureTemplate[];
  treeDiff?: TreeDiff;
  snapshotProjection?: SnapshotProjection;
  scanEvidence?: {
    listHints?: Array<Record<string, unknown>>;
    rows?: Array<Record<string, unknown>>;
    actionables?: Array<Record<string, unknown>>;
    growthProbe?: Record<string, unknown>;
  };
}): CollectionModel[];

export function summarizeCollectionCompleteness(model: CollectionModel): {
  completeness: CollectionCompleteness;
  reason: string;
  confidence: "high" | "medium" | "low";
};
```

Classification rules:

- `complete`: item-level ARIA `setSize`/`posInSet` or template instance refs cover a declared item
  total. Do not use raw AX/outline container member counts.
- `folded`: structure is complete but intentionally folded into refs/artifact windows.
- `viewport-window`: scan evidence shows visible rows/list hints but no total or boundary proof.
- `virtualized`: stable container plus item refs/window count conflict with declared/hidden count,
  rendered-vs-skeleton evidence, or a generic growth probe shows count/height growth after a window
  change.
- `paginated`: relation/actionable evidence finds explicit next/page controls tied to the
  collection container.
- `lazy`: observe/static evidence shows hidden count or load-more affordance but no total.
- `unknown`: not enough evidence.

No DOM tag/class/site selector rules. Reuse ARIA roles, templates, list hints, relations, and
scan facts already produced by the pipeline. `rows` and `outline` may support evidence strings, but
they are not authoritative collection membership or completeness inputs.

### Verification

1. Unit tests in `tests/unit/abml/collections.test.ts`:
   - complete ARIA set,
   - folded template,
   - viewport-window list hints,
   - virtualized hidden count/window,
   - rendered card + skeleton placeholder split,
   - generic growth-probe evidence,
   - paginated next control relation,
   - negative: raw `outline.memberCount` must not imply completeness,
   - negative: `data.rows` sidebar/nav links must not become semantic collection items,
   - unknown sparse evidence.
2. Contract gate `tests/contracts/tools/check-abml-collections.mjs`.
3. Add the new unit/contract files to `tests/contracts/drift/kernel-test-map.json`.
4. Run `npm run check:abml-collections` and `npm run check:abml-core-boundary`.

---

## 2. Observe envelope wiring

### Problem

Even after pure classification exists, agents will still miss it unless it is budget-immune and
artifact-mirrored like `treeDiff` and `snapshotProjection`.

### Design

Wire `collections` through the existing scan observe path:

- `src/tools/observe/scanRunner.ts` or current observe facade: build collections from attributed
  ABML entities plus `templates`, `treeDiff`, `snapshotProjection`, and raw scan data.
- `src/tools/resultMiddleware.ts`: add top-level `collections?: Array<Record<string, unknown>>`
  extraction from scan summary.
- `src/tools/summaries/outputSchemas.ts`: add schema for `collections`.
- `src/tools/summaries/scan.ts`: include compact collection summaries and artifact hints.
- Saved observe artifacts mirror `envelope.collections` and keep raw supporting data under `data.*`.

Output rules:

- `collections` is top-level and budget-immune.
- Each collection carries capped `itemRefs` plus true `itemRefCount`.
- Full detail stays in the saved artifact; summary fields stay compact.
- `nextActions` may mention semantic collection continuation, but not "scroll this page".

### Verification

1. Unit tests in `tests/unit/tools/observe-collections.test.ts`:
   - `collections` survives tight summary budget,
   - saved artifact mirrors top-level `collections`,
   - no `browser_scroll` or gesture-like nextAction is emitted.
2. Contract updates:
   - `check:abml-scan-envelope`,
   - `check:summaries`,
   - `check:output-schema-conformance`.
3. `npm run docs:sync` then `npm run check:docs-sync`.

---

## 3. Continuation signal/handle ledger

### Problem

A collection can be known incomplete without forcing the agent to choose the mechanical way to
continue it. The missing abstraction for this plan is a semantic continuation signal/handle scoped
to the observation, so the envelope can say "this collection is partial and has this continuation
evidence" without executing it.

### Design

Add continuation handle registration in the runtime/resource layer:

- handle form: `pi-cont://collection/<id>` or a `pi-ref://collection/...` descriptor kind if the
  existing ref policy supports it cleanly,
- owner scope: browser session, tab, origin, observation id, TTL,
- payload: `CollectionModel`, evidence paths, and a `ContinuationPlan`.

Pure core creates the plan; runtime registers the handle.

Draft continuation plan:

```ts
type ContinuationPlan = {
  collectionId: string;
  kind: CollectionContinuationKind;
  evidenceSummary: string;
  evidenceRefs: string[];
};
```

The handle is read-only evidence metadata for Phase 1-3. It must not dispatch scroll, click, page JS,
network replay, or any other actuation path.

### Verification

1. Unit tests for handle scope/TTL/etag behavior.
2. Negative tests: stale continuation handle, wrong tab/session, wrong origin.
3. `check:surface-liveness` confirms no new public callable tool.
4. `check:abml-collections` verifies continuation handles are present only for incomplete
   collections and cannot be executed.

---

## 4. Eval + docs/skill alignment

### Problem

The design is successful only if real agents stop reinventing completeness oracles and instead read
collection state. W2 says hand-written scroll itself is WAI; the metric is not "zero scroll JS", but
"no custom completeness model required".

### Design

Add deterministic and blind eval coverage:

- task: extract or compare items from a long list/table where only part is initially visible,
- allowed tools: existing public `browser_*` only,
- deterministic oracle: synthetic virtualized-list fixture returns
  `collections[].completeness != "complete"` and a continuation handle/signal,
- success metric: agent can tell the list is incomplete from `collections` without a custom
  count-scroll-wait-recount oracle,
- friction metric: fewer observe/execute retries caused by completeness uncertainty.

Docs/skill updates:

- `docs/abml-tool-coverage-map.md`: document `collections` as perception output.
- `skills/pi-browser-tools/SKILL.md` and CLI sibling: route long-list tasks to `collections` and
  semantic continuation signals, not scroll as a tool request.
- README: mention collection completeness under the existing ABML internal substrate section.

### Verification

1. `npm run eval:browser-workflows -- --fixture-server`
2. `npm run check:tool-docs`
3. Skill validation:
   `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`
4. Full `npm run check`

---

## Parked: semantic continuation runtime

The former Phase 4 proposed an internal `continueCollection(handle, budget)` runtime that would
choose artifact/read/data-source/pagination/virtual-scroll mechanics. Blind finding W2 rejects this
as an implementation target for the current plan:

- both agents could actuate scrolling with ordinary JS,
- neither task was blocked on execution,
- the friction was absence of completeness/continuation as perception data,
- a runtime continuation arm risks reopening the reverted B2 action surface.

Do not implement this arm under the L1 work item.

Reopen bar:

1. at least two new independent blind runs where `collections` already exposes completeness and
   continuation, but agents still fail or burn material effort because they cannot execute the
   continuation through existing `browser_execute` / `browser_command` / `browser_wait` paths;
2. proof that the needed fix cannot be a better perception field, artifact read, recovery hint, or
   skill route;
3. explicit owner decision that the new evidence does not revive the public action-arm failure mode.

If reopened, it needs a new execution contract and must still avoid public `browser_scroll`,
`browser_click`, and `browser_execute {action}`.

---

## Non-goals

- No public `browser_scroll`.
- No public `browser_click`, `browser_type`, or `browser_read`.
- No revival of `browser_execute { action: ... }`.
- No semantic continuation runtime in the L1 activation scope.
- No hidden unbounded observe-time scrolling.
- No site-specific CSS/class/DOM-structure heuristics.
- No use of raw `outline.memberCount` / AX container member count as item count or completeness
  verdict.
- No use of `data.rows` as the semantic list model.
- No claim that viewport-visible rows equal the whole page.
- No model-facing instruction that says "scroll more"; use collection continuation semantics.

---

## Governance gate impact

| Gate | Impact |
|------|--------|
| G1 `check:spec-truth` | Add collection contract markers only after implementation lands. |
| G2 `check:surface-liveness` | Must prove no new public `browser_*` tools and no public action arm. |
| G3 `check:compute-once` | Collection building must run once per scan observe and reuse existing attributed entities/templates. |
| G4 `check:purity-vocabulary` | New pure-core module must not import runtime/browser/Node code. |
| G5 `check:kernel-test-map` | Add `collections.test.ts` and `check-abml-collections.mjs`. |
| G6 `check:env-flags` | No env flag expected. If a staged escape is added, register it explicitly. |

---

## Activation note

This document is the completed execution record for the archived workstream:

1. The pure kernel landed in `src/abml-core/collections.ts` with shim/export coverage.
2. `browser_observe mode=scan` now lifts `collections` into the live envelope and saved artifact
   mirror.
3. Continuation handles are read-only `pi-cont://collection/*` evidence metadata; no public
   scroll/action surface or runtime continuation executor was added.
4. Verification is recorded in the commit that archived this file.
