# ABML mechanism arm — structure templating + living tree-diff execution contract

> Status: **M1 COMPLETE; M2a COMPLETE; M2b/M2c PLANNED**
> (reactivated 2026-06-04 by explicit user priority — "开机制臂" / "先开 M2a"). ABML
> mechanism line has its own execution contract + CURRENT.md activation. This is the *mechanism*
> line (token efficiency on large pages), complementary to the now-complete *semantic-depth* line
> (R1/R2/R3 + R3.x causal plane).

## 1. Goal

The semantic layers (R1/R2/R3) are correct but **flat and full**: every observation re-emits the
entity set, and a large page (a 200-row table, a 50-card feed, a long menu) costs O(N) tokens even
though it is really one repeated shape. The mechanism arm makes large pages cheap:

- **M1 — structure templating:** recognise repeated sibling entities (list/table/card/menu) and
  emit them as **one template + N compact instances + handles**, instead of N full entity blobs.
  The model understands "20 of these, each differing in {name}" in one block; per-item detail is a
  `read(ref)` away.
- **M2 — living tree-diff:** across observations, emit **what changed at the template/structure
  level** (`treeDiff`: instances appeared / disappeared / a field changed) so re-observe is
  O(change), not O(all). Requires **ref semantic stability** (a semantic anchor that survives list
  reorder/insert — also cures `REF_STALE`).

Both are the plan's "Optimization roadmap — the living model direction" (`docs/abml-perception-
state-evolution-plan.md` §Optimization roadmap), and the page-type map there (Feed/list → templating
+ fold; Chat → living diff append; Table → table templating).

## 2. What already exists (reuse, do not rebuild)

- **AX container membership** (`axRuntime.ts` line ~278): merged entities carry
  `hints.containerRole` + `hints.containerName` (the nearest AX list/grid/menu/group). This is the
  primary, ARIA-grounded "these are siblings" signal — no DOM nth-child guessing.
- **aria-setsize / posInSet** (`EntityStructure.setSize/posInSet`, from P3-1): a declared set of N,
  the secondary grouping signal + the true (possibly-virtualized) size.
- **Disclosure layers** (`observeRunners` `buildEntityOutline` L1 / `buildPageGist` L0): already fold
  by container into `focus.outline`/`focus.gist`. Templating is the per-instance compression that
  sits alongside them; `read(ref)` is the existing expand verb (no new mechanism).
- **Entity diff** (`abml-core/diff.ts` `diffEntities`): the flat ref-keyed appeared/disappeared/
  state-changed/name-changed primitive. M2's `treeDiff` is the template-level projection of this
  over semantic-stable refs.
- **Budget-immune envelope lift** (`resultMiddleware.ts`): `relations`/`inference`/`causal` are
  lifted to the envelope top-level. `templates` (M1) and `treeDiff` (M2) ride the same path.
- **Ref minting** (`resourceStore.registerRefDescriptor`, `stableRefIdForDescriptor`): M2's semantic
  anchor is a stabler input to this same hash (container + role + name + posInSet, not the css
  nth-child locator).

## 3. The core constraint that shapes the design

**Generality, ARIA-grounded, no per-site, no DOM-structural guessing** (the standing rule). A
"template" is recognised ONLY from the accessibility tree: shared AX container (`containerRole` +
`containerName`) or a shared `aria-setsize`, plus a shared `role`/`kind`. No tag/class/selector-
prefix pattern matching (that overfits to a framework's DOM). A group is a template only at
`MIN_TEMPLATE_INSTANCES` members. This makes templating work identically on native HTML, Vue,
React, Web Components — the mechanism-agnostic invariant.

Token compression is **lossless at the handle level**: every instance keeps its `pi-ref://` handle
in the template (`instanceRefs`, capped + a true count), so `read(ref)` recovers full detail. The
template carries only the *varying* fields inline; the constant fields are stated once.

## 4. Design

### M1 — structure templating  (COMPLETE)

**M1 slice 1 — pure-core selector (`src/abml-core/templating.ts`).**
`buildTemplateSummary(entities): { templates: StructureTemplate[] }`:
- Group key: `containerRole + "\u0000" + (containerName ?? "")` when `containerRole` is present,
  else `set:<setSize>` when `structure.setSize >= MIN_TEMPLATE_INSTANCES`, else ungrouped. Members
  of a group must share the same `role` + `kind`.
- A group with `>= MIN_TEMPLATE_INSTANCES` members → one `StructureTemplate`:
  - `container`/`containerName` (the AX container), `role`, `kind`, `count` (member count),
    `setSize?` (declared aria-setsize if any),
  - `varies`: which fields differ across instances (`name|value|checked|selected|pressed|current|
    disabled` — checked per field),
  - `constant`: the fields identical across all members (role/kind + any uniform state),
  - `instanceRefs`: member refs, capped at `MAX_TEMPLATE_INSTANCE_REFS` (true count via `count`),
  - `sample`: the first member's `{ ref, name?, value? }` (one representative).
- Sorted by `count` desc, capped at `MAX_TEMPLATES`. Pure, zero deps; tolerant of partial fields.

**M1 slice 2 — runtime wiring.** `observeRunners.runScanObservation` builds templates from the
attributed entity set and adds `focus.templates`; templated instances may be dropped from
`primary_entities` (they are represented by the template + their refs), freeing the salience cap for
non-repeating controls. `resultMiddleware.envelopeTemplates` lifts `focus.templates` to
`envelope.templates` (budget-immune, cloned, alongside relations/inference/causal).

**M1 slice 3 — contract** `check:abml-templating` (pure grouping/varies/cap + budget-immune
envelope lift + static wiring). **M1 slice 4 — live smoke**: a fixture with a repeated list/table →
observe → `envelope.templates` has a template with `count >= N`, `varies`, `instanceRefs`.

### M2 — living tree-diff

#### M2a — treeDiff-first, no ref-mint change  (COMPLETE)

- Add pure-core `src/abml-core/treeDiff.ts`.
- Reuse M1's ARIA-grounded template groups (`templateGroupDescriptorForEntity`) and project two
  observations into template-level deltas.
- Match instances by semantic key for diff only:
  - high confidence: `container + role + normalized accessible name` when unique across before/after,
  - low confidence fallback: `posInSet`, then local index for nameless/duplicate-name instances.
- Report `treeDiff.summary` + `treeDiff.templates[]` with:
  - `appeared`, `disappeared`, `changed`, `reordered`,
  - bounded `instances`, true `count`, confidence/anchor fields,
  - no change to `stableRefIdForDescriptor`, no change to live-action resolution.
- Wire into `browser_observe(mode:scan, baseline)` and lift `envelope.treeDiff` budget-immune.
- Validated by `check:abml-tree-diff`, `smoke:browser:abml-templating`, and full `npm run check`; shipped in commit `5e92dcc`.

#### M2b — gated semantic ref anchor  (PLANNED, after M2a evidence)

- Add optional semantic-anchor input to ref descriptors for template-eligible entities only.
- High-confidence name-anchor may feed `stableRefIdForDescriptor`; low-confidence positional anchors
  remain diff-only unless separately proven safe.
- Non-grouped entities keep current locator-based refs.

#### M2c — living snapshot projection  (PLANNED)

- Attach `templates[].delta` from `treeDiff` where useful and persist enough structure metadata in
  snapshot artifacts for O(change) follow-up.
- Boundaries identical to M1/M2a.

## 5. Behavior boundaries

- No new public `browser_*` tool; templating/treeDiff ride `browser_observe` envelope (like
  relations/inference/causal). No `native_command_schema.json` change.
- Pure-core boundary held: the selectors are pure (`abml-core/templating.ts`); the runtime only
  feeds entities in + lifts the block out. No npm/Node import in abml-core.
- ARIA-grounded grouping ONLY — no per-site/per-framework/DOM-structural heuristics.
- Budget immunity + handle-losslessness: templates lift to the envelope top-level; every instance
  keeps a `pi-ref://` handle (capped list + true count) so `read(ref)` recovers detail.
- Privacy: instance fields follow the existing entity-output contract (accessible names/values, not
  redacted beyond what entities already are; no raw payloads).

## 6. Phases, contracts, acceptance

- **M1**: `check:abml-templating` (pure selector: container + setSize grouping, MIN threshold,
  varies/constant, instanceRefs cap + count, sorted; envelope `templates` lift incl. tight budget;
  static wiring) + unit tests; live `smoke:browser:abml-templating` (or extend an observe smoke).
- **M2a**: `check:abml-tree-diff` (semantic template matching across reorder/insert/change;
  partial-baseline unavailable; envelope lift; static observe wiring) + live smoke (mutate a list
  between observations → O(change) diff). Ref minting must remain untouched in this phase.
- **M2b**: semantic-anchor ref stability contract only after M2a evidence; gated blast-radius tests
  over scan/diff/read/click/ref registry before any `stableRefIdForDescriptor` mutation.
- Gate each phase on `npm run check` green + the live smoke. Update
  `docs/abml-perception-state-evolution-plan.md` §Optimization roadmap as phases land.

## 7. Out of scope (unchanged ABML non-goals)

- No vision/OCR expansion; no iframe AX aggregation; no public ABML verb tools; no orchestration
  revival; no per-site/per-framework templating. The mechanism arm stays internal substrate
  surfaced through `browser_observe`.
