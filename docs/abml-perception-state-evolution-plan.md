# ABML — Agent-Native Page Model (Evolution Plan)

*ABML doc set — index & map: [`docs/abml-kernel-manifest.md`](abml-kernel-manifest.md#abml-documentation-map).*

> Status: planning contract, **core feasibility verified by offline spike**.
> Establishes the first principle for what the browser tools return to an agent, a
> **generality principle** (ARIA full-spectrum as the design template — not any one
> page type), and a sequenced implementation. Does not describe currently shipping
> behavior until it lands and generated docs update. ABML stays an internal
> substrate (no new public verbs); everything lands through `browser_observe` + the
> existing verbs.

## First principle (north star)

**What the tools return is a page _affordance model_: a mechanism-agnostic, layered
semantic model that is trustworthy, actionable, and focusable.** Of the four page
representations — pixels (human eyes), DOM/JS (the engine), AX tree (screen-reader
linear read-out), ABML — only ABML is designed for the **agent's cognition +
action**. KPI: *fewest tokens, least ambiguity, for "what state is the page in, what
can I do, what will an action do".*

- **Trustworthy** — state can be believed directly. Semantic state comes from the
  **AX plane (authoritative)**; DOM only supplies geometry/labels. DOM/AX conflict →
  AX wins, mismatch flagged (no silent fallback). Honest about completeness ("N more
  folded"). Trustworthy = doesn't lie, doesn't pretend to be complete.
- **Actionable** — each entity carries affordances + preconditions; read/write
  isomorphism (the `pi-ref://` you read is the one you act on); write verbs verify
  the resulting **semantic effect** (state change, navigation, content appearance,
  request completion — not only control state).
- **Focusable** — layered progressive disclosure + **generic** semantic focus, never
  task-specific. Focusable ≠ full.

**Mechanism-agnostic, semantics-constant:** the same semantic thing looks identical
whether native HTML, Vue Element-UI, React, Web Component, or canvas-drawn. Per-site
SOPs (e.g. "use `.is-checked`") are the anti-pattern this kills.

## Generality principle — ARIA full-spectrum is the design template

The model must be **general across the whole page space, not tuned to forms.** The
heavy machinery here (disclosure tree, templating, diff/working-memory) is for *any*
large page — documents, feeds, chat, tables — and is least needed by forms. Forms
contributed only one *leaf* fix (control-state truth); they are **not** the blueprint.

The blueprint is **ARIA/AX itself** — the one standardized, cross-framework semantic
layer W3C defines for machine-understanding of *any* page. ABML's entity kinds,
state vocabulary, relationships, skeleton, and verification map systematically onto
its four families:

1. **Landmark** (banner/nav/main/complementary/contentinfo) → L0/L1 skeleton.
2. **Document structure** (heading/list/table/article/figure) → reading/content pages.
3. **Widget** (button/checkbox/tab/dialog/slider/…) → interactive/form pages.
4. **Live region + relationships** (aria-live/busy; owns/controls/labelledby/…) →
   real-time + structure.

Pages that don't follow ARIA (pure `div` / canvas / games) fall to **opaque nodes +
vision floor**. ARIA-mapped + opaque-fallback together cover the full page spectrum.

> **Rule: generality = "follow the full ARIA spectrum"; overfitting = "follow
> forms". xuetangx (Vue Element-UI exam) is a _verification instance_ of the widget
> family, never the design template. No site-specific or page-type-specific special
> casing is permitted in the tool layer.**

Generality check (each is just "fill the matching ARIA cell", not new architecture):

| Page type | Uses | ARIA dimension it exercises |
|---|---|---|
| Article/doc | L1 = heading tree + `article`/landmark; fold sections | structure, `heading level` |
| Feed/list | templating + fold + `list↔item` | `setsize/posinset` |
| Chat/social | living diff tree (append) + live region | `aria-live`, incremental |
| Dashboard/table/chart | table templating + canvas opaque node | `table/sort`, opaque |
| SaaS/multi-step app | effect-verified actions + `dialog` + diff | widget + effect assertion |
| Form/exam (xuetangx) | control-state truth + group/label | widget `checked/selected` |

## Four core abstractions

> **REF** (reference) · **ENTITY** (noun) · **VERB** (action) · **TREE** (semantic
> disclosure tree)

TREE organizes the first three into a foldable, navigable semantic map: a ref names
a branch, an entity is a node (carrying its own fold state), `read(ref)` expands.

## Disclosure model — the page is a foldable semantic tree

- A **complete semantic tree, default-folded to its shallow layers**; deep branches
  are `pi-ref://` handles with a count.
- **Expand = `read(ref)`** (the existing read verb, no new mechanism). One action
  navigates the whole tree.
- The envelope is a **view of the tree** (expanded branches + fold-point ref+count),
  never a byte-truncated summary. **"Truncation" disappears — only folded/expanded;
  data never vanishes.**
- Three layers: **L0 gist** (page semantic type + primary state + primary
  affordances, inferred from landmarks/roles — works for article/list/app/chat, not
  just exams) · **L1 skeleton** (ARIA landmarks + structure containers: nav / main /
  lists / tables / dialogs / control groups, each a ref) · **L2 entity detail** (by
  ref). `Entity.children` already supports `{handle, count}` — the fold point exists.

## Performance contract (make-or-break)

**Scan once, fold is a projection, expand never returns to the browser.**

- `observe` scans the full semantic tree once → stores it in the resource registry
  (`src/resources/resourceStore.ts`, TTL/etag); the envelope projects shallow layers
  + fold-point refs.
- `read(ref)` resolves a subtree from the **stored tree** — pure server-side read:
  **no tab, no bridge round-trip, no lease/queue, no CDP.** Concurrency-safe
  (read-only, session-scoped); cheaper than today's truncate→artifact→re-read (the
  xuetangx session did **11** artifact reads).
- Bound the one real cost (storing a tree) with existing TTL/etag + LRU + spilling
  large subtrees to artifact (registry keeps only the handle).
- **Excluded:** lazy "expand by going back to the browser" as the default (a bridge
  round-trip per expand eats concurrency/latency). Viewport-bounded lazy *scan* of
  off-screen regions is an allowed opt-in escalation, never the default expand.
- AX `getFullAXTree` is one CDP call **per observe** (not per expand), scoped to
  interactive/structural entities.

## Semantic vocabulary — ARIA full spectrum (not just controls)

State/attributes are defined across all four ARIA families, each field tagged with
`source`. Implement by family; the widget-state core is verified-feasible and lands
first, but the *vocabulary is defined for the whole spectrum* so it doesn't ossify
into a form model:

- **Widget state**: `checked / selected / pressed / expanded / disabled / value
  (aria-valuenow/min/max + input) / inputType`.
- **Structure**: `heading level`, list `setsize/posinset`, table `rowcount/colcount/
  sort`, `readonly/required/invalid`.
- **Landmark / region**: landmark role → L0/L1 placement; `current` (aria-current).
- **Live / relationship**: `busy (aria-busy/loading)`, `live (aria-live)`,
  `modal (dialog)`; relations `owns/controls/labelledby/describedby/activedescendant`.

**Relationships** are the general container↔member + ARIA relations — `list↔item`,
`table↔row↔cell`, `tablist↔tab↔panel`, `menu↔item`, `tree↔treeitem`, `dialog↔content`,
`form↔fields`, and `radiogroup↔option` (one instance, not the template). Groups
surface `selectedRef/selectedValue` where applicable; labels bind to their control.

**Privacy**: sensitive inputs (`password`, `autocomplete=cc-*`/`one-time-code`)
report "filled / N chars", never the value.

## Feasibility — verified (offline spike, 2026-06-02)

A spike fed Chrome `getFullAXTree` node shapes into the existing AX pipeline:

1. **Foundation exists** — `buildAxEntityFromNode` (`ax.ts:163`) already reads
   `checked` from AX; returns `checked=true` even when DOM `input.checked` would lie.
2. **Alignment exists** — `mergeDomAndAxEntities` (`ax.ts:242`) already matches DOM
   and AX entities (role + name + geometry).
3. **Root cause pinpointed** — `mergedEntity` (`ax.ts:228`) merges
   locators/geometry/hints but **not `state`**, so an aligned DOM entity keeps its
   lying `checked=false`.

**Verdict:** feasible, small blast radius — the trustworthy core is three local,
additive edits, no protocol/CDP/dependency change. The AX path generalizes for free:
the same `axPropertyBool`/`axProperty` reads any ARIA state, and `kindForAxRole`
already maps the widget/structure/frame roles.

## Multi-type real-agent validation (2026-06-02)

A connected agent stress-tested the SHIPPING `browser_*` tools across 5 page types
(form/exam, feed/list, doc/article, app/modal, dashboard/table) — the
anti-overfitting acceptance set. It **independently arrived at the same fixes this
plan specifies** (controls need `checked/selected/value/expanded/pressed/current/
options`; structured `forms[]/lists[]/tables[]/toc[]`; `viewportOnly/mainOnly/
excludeHidden`; screenshot visual summary + canvas/SVG data-source hints) — strong
external validation. It was forced to hand-write JS on **all 5/5 pages** (reading
state / re-assembling structure) — confirming the perception gap is **general, not
form-specific**. Four reinforcements:

1. **Mislabeling is worse than missing** — DOM scan tagged radio/checkbox as
   `role:"textbox"`. Reading *wrong* (not just absent) violates "trustworthy" hardest;
   the AX tree's role is correct → **AX is authoritative for role too**, not only state.
2. **Verify must wait for the semantic state, not read once** — modal animation / SPA
   async made an immediate post-action read mis-judge (`.modal.show` "not yet"). Verify
   asserts the *expected semantic state is reached* (wait-for-state), not that an event
   fired.
3. **Application state ≠ URL state** — dashboard filter/sort live in the DOM/component
   (`aria-sort`, `aria-expanded`, component state), not navigation; read from ARIA.
4. **content vs scan → one affordance tree with ref anchors** — `content` reads docs
   best but gives no anchors (headings lack selector/hash/ref); `scan` gives controls
   but poor state/structure. The unified model gives every entity (incl. a heading) a
   `pi-ref://` that is locatable/scrollable/actionable — the agent's proposed
   `toc[]:{level,text,id,selector,href}` is "headings as actionable ref entities".

This run replaces the single-fixture smoke as the concrete acceptance baseline.

## Real-browser validation (2026-06-03) — P1/P2/P3 verified end-to-end

A connected-browser agent validated the implemented stack across four observe-only rounds
(no hand-written JS except to capture ground-truth for failing items). Outcome: **P1/P2/P3
shipped and verified on real pages.**

- **Trustworthy (P1/P2) — the decisive proof.** On a component-lie fixture (`#native-checked-lie`:
  DOM `input.checked=false` while the element is really checked), `browser_observe` returned
  `checked:true` with `hints.mergedSources:["dom","ax"]` + `hints.stateSource:{checked:"ax"}` — the
  AX-authoritative merge corrects the DOM lie end-to-end. This is the xuetangx root cause, mechanically solved.
- **Focusable (P3 disclosure) — W3C ARIA radio page.** `envelope.gist` (6 landmarks / 62 controls /
  8 containers) and `envelope.outline` (two radiogroups folded with member refs) reached the model;
  entities carried `hints.containerRole/containerName`.
- **Two non-bugs clarified:** native honest inputs correctly stay `source:dom` (DOM already right,
  nothing for AX to correct); `stateSource` is intentionally a per-field object (`{checked:"ax"}`),
  richer than a bare string — keep it.
- **Deployment + budget fixes the rounds surfaced:** `src/` Node-layer changes need a host-process
  restart (injected scan scripts do not); and the disclosure layers (gist/outline) are lifted to the
  envelope top-level so the `summary` budget squeeze cannot hide them.

Commits (this line): P1 `040f1df` · P2 `23cca68` · P3-1 `6e78f77` · P2.1 `9cbae15` · P2.2 `1df7183` ·
P2.3 `39ec07d` · P2.1a `4242efb` · P2.4 `a317ce3` · P2.5 `6ff2fd4` · P2.6 `10140de` · P3-2 `2bcd603` ·
P3-3 `2f5432b` · P3-4 `9d55524` · P3-5 `169d96a` · P3-6 `c4e60d2`. test:unit 359 green.

Known remaining gap (not blocking): iframe AX is not aggregated — `readAxEntities` reads only the top
frame's `getFullAXTree`, so controls inside an iframe (e.g. a Vant demo sandbox) do not enter the model.
Independent, larger work (per-frame AX + coordinate alignment).

## Pinned decisions

1. AX authoritative for **role and state** (DOM heuristics mis-label, e.g.
   radio/checkbox → textbox); merge by default for interactive/structural entities;
   reuse `readAxEntities`; one AX fetch per observe.
2. **No new `mode`; default, invisible enrichment**; depth under `detailLevel`.
3. **Vocabulary defined across the full ARIA spectrum** (widget/structure/landmark/
   live), with `source` per field; implement by family, widget core first.
4. **Relationships are general** container↔member + ARIA relations; `radiogroup` is
   one instance, not the template.
5. Privacy: suppress sensitive-input values.
6. Effect-verified actions — verification asserts the **expected semantic state is
   reached** (wait-for-state; async/animation-safe; not a single immediate read),
   across state/navigation/content/request; DOM/AX disagreement surfaced.
7. **Generality over specialization: no site-specific or page-type-specific special
   casing**; generic focus only, never task-specific.

## Coupling map (files)

| Concern | File(s) | Change |
|---|---|---|
| **Merge propagates state (root cause)** | `src/abml/ax.ts:228` (`mergedEntity`) | merge `state` with AX-priority + per-field `source` |
| Vocabulary (ARIA spectrum) | `src/abml/ax.ts:163`, `kindForAxRole`, `src/abml/entity.ts` (`EntityState`) | extract all ARIA states/roles (widget+structure+landmark+live), not just controls |
| DOM scan | `src/scan/buildScanScript.ts:111-112` | aria-* states, structure (heading level/list/table), label binding |
| Default AX merge | `src/abml/verbs/runtime.ts:567`, `integration.ts`, `src/tools/observeRunners.ts` | route default `browser_observe` through AX-merged read |
| Disclosure tree | `src/tools/resultMiddleware.ts`, `src/resources/resourceStore.ts`, `src/tools/summaries/scan.ts` | store full tree once; project L0/L1 + fold refs; `read(ref)` resolves subtree; demote `fitSummaryBudget` to per-node fallback |
| Relationships + skeleton | `src/tools/summaries/scan.ts`, `src/abml/entity.ts` | landmark/structure containers + members; `selectedRef`; label↔control |
| Output schema | `src/tools/summaries/outputSchemas.ts:39-65` | spectrum state fields, `source`, group/fold hints |
| Verification + privacy | `src/abml/verbs/click.ts`, `runtime.ts`, `src/utils/redaction.ts` | assert semantic effect; suppress sensitive values |

## Phase gates

| Phase | Goal | Gate |
|---|---|---|
| P1 | trustworthy core: merge propagates state + widget vocabulary + `source` (flips the spike negatives) | `check:src:types` + `test:unit` |
| P2 | default `browser_observe` routes through AX merge | observe contract + abml runtime fixtures |
| P3 | full ARIA-spectrum vocabulary/relationships + disclosure tree (store-once, L0/L1, `read(ref)`) + schema | scan/summary contracts + `check:output-schema-conformance` |
| P4 | effect-verified actions + disagreement surfacing + privacy | abml verb runtime contracts |
| P5 | docs/skill + multi-type verification | `quality:local` + multi-type fixture suite |

## Optimization roadmap (post-core; the "living model" direction)

ABML's tree should be the agent's **page working memory** — persistent, versioned,
incrementally updated, focused, honest about reachability. All of these are
*general* (they help feeds/docs/chat/dashboards more than forms):

- **Near (high ROI):** living **diffable tree** (verb returns a `treeDiff`; agent
  consumes O(change); requires **ref semantic stability** = semantic anchor, also
  cures ref-stale); **structure templating** (repeated list/table/card → template +
  instances + handle).
- **Mid:** **salience-driven default disclosure** (generic salience: in-viewport /
  focused / recently-changed / interaction density); **opaque nodes** (closed shadow
  DOM / cross-origin iframe / canvas as honest fold points, expand via
  `pierce`/`vision`).
- **Far:** **causal plane** (hang network-entry/event refs on a control's subtree so
  "what happens if I click this" is navigable).

## Long-term roadmap — perception depth (the kernel-layer direction, 2026-06-03)

ABML is now a kernel perception layer (control-level truth: DOM+AX fusion, role/state/name,
salience, seed container relations — validated). This is the multi-phase direction for
covering complex web apps, **complementary** to the optimization roadmap above: that one is
*mechanism* (diff/template/disclosure), this one is *semantic depth*.

**Standing principle (set by the contract work — every layer obeys it):**
1. **Stabilize the output contract first, then add a layer.** Each layer is additive,
   surfaced at the envelope top-level, locked by a contract test. An agent can't rely on a
   layer that the budget can hide — so disclosure stability gates new depth.
2. **Reuse the cheapest existing source first** — AX relations/properties before any new
   perception source.
3. **Generic ARIA only — including the inference layer.** Patterns over ARIA structure, never
   per-site/per-type `if` branches (the overfitting smell, per Non-goals).
4. **Lower layers (P1/P2/P3) are load-bearing — no regression.** additive + unit-locked +
   real-browser validated, the way P1-P3 were.

### Phase R1 — Relationship-graph completion — COMPLETE (2026-06-03)
**Batch 1 + batch 2 landed + live-verified** — see `docs/abml-relationship-graph-execution-plan.md`.
Typed `EntityRelation[]` on entities + a budget-immune envelope-top-level `relations` summary. All
families materialize to `pi-ref://` targets from a real Chrome tree: labelledBy/describedBy/controls/
owns/expandedTarget + table cellOf/rowOf/columnOf/headerFor (AX-sourced), plus **currentIn** (DOM
`aria-current` — `getFullAXTree` omits it) and **occludes/coveredBy** (hit-test occluder, geometry).
`containerRole` was the seed; the rest were made explicit typed relations on the entity:
- labelledBy / describedBy (unify the AX/DOM label sources into one relation)
- row / column / cell / columnheader (table/grid — AX exposes rowindex/colindex)
- controls / owns / expandedTarget (combobox / menu / accordion — AX relations)
- current / active-route (promote the existing aria-current *state* to a nav *relation*)
- occludes / coveredBy (needs geometry — box overlap + z-order; pairs with vision region)

### Phase R2 — Inference layer — COMPLETE (2026-06-04)
New pure-core `src/abml-core/inference.ts`. 12 generic ARIA/temporal intent labels
at envelope top-level (`inference: { intents: DetectedIntent[] }`, budget-immune):
- **Landed**: login · search · filter-panel · single-choice · multi-choice · expandable ·
  data-grid (grid/treegrid role OR tableCells ≥ 50) · navigation · dialog · tabbed-interface ·
  alert-region · form-dependency
- **Real-page validated** on 9 pages (Bing, Amazon, W3C APG, MDN). data-grid threshold
  fixed post-validation (tableCells>0 → ≥50) to filter APG doc-table noise.
- **R3 unlocked dependency facts**: disabled→enabled + focused editable field now emits
  `form-dependency` evidence `{enabledRef, requiredRef}`.
- **inputKind** hint added to entity scan (HTML input type → login detection signal).
- Contract: `check:abml-inference`.

### Phase R3 — Runtime events / temporal diff — COMPLETE (2026-06-04)
- `src/abml-core/diff.ts` adds pure `diffEntities(before, after)` with appeared,
  disappeared, state/name changed, and `focusedRef`.
- `browser_observe mode=scan` accepts an optional `baseline` entity list / prior scan
  summary/envelope / snapshot id and lifts `diff` to the envelope top level.
- ABML read/click/type runtimes can attach post-action entity diff; same-page refs are
  now stable by semantic locator hash so two snapshots match by `pi-ref://`.
- R2 dependency inference consumes R3 diff to emit `form-dependency`.
- Contract: `check:abml-diff`; schema: `EntityDiffSchema`.

### Phase R3.x — Perception-source expansion (remaining independent sources)
- network/API semantics: tables/pagination/submit endpoints behind controls — reuse the
  existing network recorder; hang network/event refs on a control's subtree (the "causal
  plane" above)
- vision/layout + OCR: stays the on-demand floor / opaque-node expand per Non-goals — used
  as the geometry source for occludes/coveredBy and for canvas/closed-shadow regions, **not**
  a primary perception source

### Where the current "low-value" leftovers belong (folded into a phase, not abandoned)
- **iframe AX aggregation** → a piece of R3 perception completeness (multi-frame AX). Low ROI
  alone, a building block once full perception is in scope.
- **real-browser fixture smoke** → test/contract infrastructure; grows each phase as ABML
  becomes more load-bearing (regression protection matters more for a kernel layer).
- **artifact path tidy-up** → output-contract evolution; low-impact now (disclosure is at
  envelope top-level), but tidy it **before** stacking relation/inference layers onto the output.

**Sequencing:** R1 → R2 (inference needs the graph); R3 runtime events before R2 dependency
facts; vision/OCR last. **Do not open a new layer until the current output contract is stable.**

## Verification

- Unit: AX extraction maps the spectrum (widget/structure/landmark/live) with
  `source`; merge propagates AX state; relationship builder resolves members;
  sensitive inputs suppress value; `read(ref)` resolves a stored subtree with no
  bridge call.
- Contract: extend `check-abml-scan-entities` / `check-abml-ax-runtime`;
  `check-output-schema-conformance`.
- **Multi-type fixture suite (anti-overfitting acceptance; baselined 2026-06-02 — see
  Multi-type validation):** article, feed/list, table/dashboard, dialog/modal,
  multi-step app, AND a Vue/Element-UI exam — each asserting correct semantic state,
  layered disclosure, and (where interactive) **effect-verified actions that wait for
  the expected state** (async/animation-safe), **with no page JS, no misread, bounded
  tokens**. If the model drifts toward forms, the non-form fixtures go red first.

## Non-goals

- No new public `browser_abml_*` verb surface (internal substrate — P9).
- **No site-specific or page-type-specific special casing** (per-site/per-type
  branches are the overfitting smell); generic ARIA handling only.
- No vision-first perception (vision stays the on-demand floor / opaque-node expand).
- No lazy "expand by returning to the browser" as the default (perf contract).
- No `bridge/native_command_schema.json` change unless a new CDP call is needed (AX
  tree + box model already used).

## Risks / notes

- **Perf**: `getFullAXTree` per observe is non-trivial → interactive/structural
  scope, one fetch.
- **AX/DOM reconciliation**: backendNodeId match can miss → fall back to
  geometry/role; on miss keep DOM entity with state marked low-confidence (`source`).
- **Memory**: stored trees bounded via TTL/etag + LRU + artifact spill.
- **Orthogonal to the CLI/MCP frontend migration** — benefits every frontend.
