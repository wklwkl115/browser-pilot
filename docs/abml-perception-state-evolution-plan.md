# ABML — Agent-Native Page Model (Evolution Plan)

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

## Pinned decisions

1. AX authoritative; merge by default for interactive/structural entities; reuse
   `readAxEntities`; one AX fetch per observe.
2. **No new `mode`; default, invisible enrichment**; depth under `detailLevel`.
3. **Vocabulary defined across the full ARIA spectrum** (widget/structure/landmark/
   live), with `source` per field; implement by family, widget core first.
4. **Relationships are general** container↔member + ARIA relations; `radiogroup` is
   one instance, not the template.
5. Privacy: suppress sensitive-input values.
6. Effect-verified actions (state/navigation/content/request) + DOM/AX disagreement
   surfaced.
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

## Verification

- Unit: AX extraction maps the spectrum (widget/structure/landmark/live) with
  `source`; merge propagates AX state; relationship builder resolves members;
  sensitive inputs suppress value; `read(ref)` resolves a stored subtree with no
  bridge call.
- Contract: extend `check-abml-scan-entities` / `check-abml-ax-runtime`;
  `check-output-schema-conformance`.
- **Multi-type fixture suite (anti-overfitting acceptance):** article, feed/list,
  table/dashboard, dialog/modal, multi-step app, AND a Vue/Element-UI exam — each
  asserting correct semantic state, layered disclosure, and (where interactive)
  effect-verified actions, **with no page JS, no misread, bounded tokens**. If the
  model drifts toward forms, the non-form fixtures go red first.

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
