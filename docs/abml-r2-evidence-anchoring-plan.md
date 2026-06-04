# ABML R2 — Evidence Anchoring + Explainability Execution Plan

> Status: **ready-for-activation — BLOCKED on the R3 `inference.ts` commit** (a parallel
> agent is mid-edit on `src/abml-core/inference.ts`, adding `form-dependency`; land this
> only on a clean tree to avoid a merge collision). Does **not** add public
> `browser_abml_*` tools. ABML stays internal substrate; the change rides the existing
> `browser_observe` envelope `inference` field.

Source roadmap: `docs/abml-perception-state-evolution-plan.md` → R2.

## 0. Baseline

R2 inference is shipped (commits `12c4b2f`, `508e1bf`, `da771e5`, `7209297`):

- `src/abml-core/inference.ts` — `buildInferenceSummary(entities, relSummary, diff?)` →
  `{ intents: DetectedIntent[] }`, lifted to envelope top-level (budget-immune).
- 11 page-level intents + `form-dependency` (R3): login · search · filter-panel ·
  single-choice · multi-choice · expandable · data-grid · navigation · dialog ·
  tabbed-interface · alert-region · form-dependency.
- `DetectedIntent = { intent, confidence, evidence? }`. Only `login` and `form-dependency`
  currently populate `evidence`. All others are **bare labels**.
- Live-validated on 9 real pages; 436 unit tests + `check:abml-inference` green.

## 1. Diagnosis — why bare labels aren't enough

R2's value over the sibling envelope layers (`entities` / `outline` / `relations` / `gist`)
is the **high-level semantic judgement**: "this is a login page", "this has a filterable
data table". But a bare label only saves the agent the *recognition* step — it still has to
go back into `entities` and **figure out which ref is the grid / dialog / expand trigger**
to actually act. That second step (locating the action target) is where the agent actually
spends tokens.

This is also the real root of the "false positives" the live validation flagged:

> `expandable` fired on Bing/GitLab/Amazon — not because detection was *wrong* (the nav menu
> genuinely has expand controls) but because the intent **wasn't anchored**: the agent
> couldn't tell "this expandable is in the navigation landmark, not the content accordion I
> want". The false-positive feeling is a **missing-location** problem, not a wrong-judgement
> problem.

Once each intent carries an evidence ref, disambiguation moves from R2's burden to the agent
(it cross-references the ref against `outline`/landmarks and skips what's not relevant) — a
healthier boundary, and the generic-ARIA-only principle is preserved (refs come from ARIA
entities, never a page-type check).

**Goal: upgrade every intent from a diagnostic label to a navigation anchor.**

## 2. Output contract changes

### 2.1 `DetectedIntent` gains `reason`

```ts
export type DetectedIntent = {
  intent: PageIntent;
  confidence: "high" | "medium" | "low";
  reason?: string;                       // NEW — short, human/agent-readable basis for the
                                         // judgement (the signal + the confidence rationale)
  evidence?: Record<string, unknown>;    // existing — now populated for every intent
};
```

`reason` is a terse explanation of *what signal fired* and *why this confidence* — so the
agent can decide how much to trust it instead of reading a bare `high`/`medium`. Keep it
short (token economy): e.g. `"radiogroup role"`, `"3 checkboxes in group 'Sport'"`,
`"2 ungrouped radios"`, `"table with 162 cells"`, `"1 expand trigger — likely nav toggle"`.

### 2.2 Per-intent `evidence` fields

Every detector resolves a representative entity (and related targets) to a `pi-ref://`:

| intent | evidence fields | source |
| --- | --- | --- |
| login | `submitRef` *(existing)* | first non-disabled button/link entity |
| search | `searchRef` or `regionRef` | searchbox entity, else search-landmark region |
| filter-panel | `regionRef`, `inputCount` | search-landmark region + editable-input count |
| single-choice | `groupRef` or `optionRefs[]` | radiogroup entity, else radio entity refs |
| multi-choice | `optionRefs[]`, `groupName?` | checkbox refs (dominant group first) |
| expandable | `triggerRefs[]` | entities whose `relations` include `expandedTarget` |
| data-grid | `gridRef` or `tableRef`, `cellCount?` | grid/treegrid entity, else `cellOf` targetRef |
| navigation | `currentRef`, `navRef?` | `state.current` entity, `currentIn` targetRef (nav) |
| dialog | `dialogRef`, `modal?` | dialog/alertdialog entity |
| tabbed-interface | `tablistRef?`, `tabRefs[]` | tablist entity + tab entity refs |
| alert-region | `regionRef`, `live` | alert/status entity (`live`: assertive/polite) |
| form-dependency | `enabledRef`, `requiredRef` *(existing, R3)* | diff state-change + focused field |

All ref arrays are **capped** (see §5). `evidence` stays optional: when no ref resolves
(e.g. the relation count comes from an entity outside `primary_entities`), the field is
omitted and the intent is still emitted. This is the zero-regression guarantee (§3).

## 3. Architecture — detection and evidence are DECOUPLED (zero-regression)

The single load-bearing principle:

- **Detection logic is unchanged.** Every detector keeps its exact current signal and
  threshold (`radiogroup` role, `expandedTarget >= 2`, `tableCells >= 50`, etc.). No
  existing intent's emit/skip decision or `confidence` changes.
- **Evidence + reason are best-effort additive.** After a detector decides to fire, it does
  a *separate* pass over `entities` / `entity.relations` to resolve representative refs. If
  resolution fails, `evidence` is omitted — the intent still fires identically.

Consequence: every shipped unit test and contract assertion about *which intents fire* and
*at what confidence* stays green untouched. New assertions only check the additive
`evidence`/`reason` fields. This is why the change is safe to land even after R3 adds
`form-dependency`.

> Note on count-only detectors (`expandable`, `navigation`, `data-grid` via `tableCells`):
> these currently judge purely from `relSummary` counts. **Keep the judgement on the count**
> (so the threshold semantics are identical), and resolve evidence refs from a *parallel*
> entity walk. Do NOT switch the judgement to the entity walk — that would subtly change the
> count semantics (relation total vs deduped source-entity count) and break zero-regression.

## 4. Per-detector evidence resolution logic

All helpers are pure (entities + their `relations` arrays only — no browser, no Node),
staying inside the `check:abml-core-boundary`.

- **login** — `submitRef` already set. Add `reason`: `"password input + actionable submit"`
  (high) / `"password input, no actionable button"` (medium).
- **search** — if a `searchbox`-role entity exists, `searchRef = that.ref`,
  `reason = "searchbox role"`. Else the search-landmark region entity → `regionRef`,
  `reason = "search landmark with input"`.
- **filter-panel** — search-landmark region entity → `regionRef`; `inputCount` = the same
  editable-control count the detector already computes; `reason = "search landmark, N inputs"`.
- **single-choice** — radiogroup entity → `groupRef`, `reason = "radiogroup role"`. Else
  collect radio entity refs → `optionRefs` (capped), `reason = "N ungrouped radios"`.
- **multi-choice** — reuse the group-count map the detector already builds; pick the
  dominant group (≥3), collect its checkbox refs → `optionRefs` (capped) + `groupName`;
  `reason = "N checkboxes in group 'X'"` (high) / `"N scattered checkboxes"` (medium).
- **expandable** — walk `entities`, collect `e.ref` for any `e` whose `relations` include a
  `type === "expandedTarget"` edge → `triggerRefs` (capped). Judgement stays on
  `relSummary.summary.expandedTarget >= 2`. `reason = "N expand triggers"`.
- **data-grid** — grid/treegrid entity → `gridRef`, `reason = "grid role"`. Else find any
  entity with a `cellOf` relation, take its `targetRef` (the table) → `tableRef`;
  `cellCount = relSummary.summary.tableCells`; `reason = "table with N cells"`.
- **navigation** — entity with `state.current` truthy → `currentRef`; if it has a
  `currentIn` relation, `navRef = that.targetRef`. `reason = "aria-current item in nav"`.
- **dialog** — dialog/alertdialog entity → `dialogRef`; `modal` from the entity if known;
  `reason = "dialog role"` / `"alertdialog role"`.
- **tabbed-interface** — tablist entity → `tablistRef`; collect tab entity refs → `tabRefs`
  (capped); `reason = "tablist, N tabs"` (high) / `"N ungrouped tabs"` (medium).
- **alert-region** — alert/status entity → `regionRef`; `live = "assertive"` for `alert`,
  `"polite"` for `status`; `reason = "alert live region"` / `"status live region"`.

Shared helper sketch (illustrative, not final):

```ts
function firstRefByRole(entities: Entity[], ...roles: string[]): string | undefined {
  const set = new Set(roles.map((r) => r.toLowerCase()));
  return entities.find((e) => e.role && set.has(e.role.toLowerCase()))?.ref;
}
function refsWithRelation(entities: Entity[], type: RelationType, cap: number): string[] {
  const out: string[] = [];
  for (const e of entities) {
    if (e.relations?.some((r) => r.type === type)) out.push(e.ref);
    if (out.length >= cap) break;
  }
  return out;
}
```

## 5. Cap strategy

Ref arrays (`optionRefs`, `triggerRefs`, `tabRefs`) are capped to keep the envelope compact
and deterministic — same philosophy as `relations.highlights`:

- `MAX_EVIDENCE_REFS = 6` per array.
- When truncated, add a sibling count so the agent knows the total: e.g.
  `{ tabRefs: [...6], tabCount: 14 }`. Count is the untruncated total.
- Ordering is document order (the order entities arrive in), deterministic — no
  `Date.now()`/random, so contract snapshots don't flake.

## 6. Schema + test requirements

### 6.1 Schema

`src/tools/summaries/outputSchemas.ts` — `InferenceSummarySchema.intents` item gains
`reason: Type.Optional(Type.String())` (evidence is already `Type.Optional(LooseObject)`).

### 6.2 Unit tests (`tests/unit/abml/inference.test.ts`)

For each intent, add an assertion that the expected `evidence.<ref>` resolves to the planted
entity's ref, and that `reason` is a non-empty string. Reuse the existing `entity()` helper.
Critically — **keep every existing detection/confidence assertion unchanged** (proves §3).

Add a "no-ref" boundary test per count-only detector: detector fires from a `relSummary`
count with NO matching entity present → intent still emitted, `evidence` omitted (or the ref
field absent). This locks the zero-regression decoupling.

### 6.3 Contract test (`tests/contracts/tools/check-abml-inference.mjs`)

Extend the existing end-to-end block: assert a representative intent (e.g. `tabbed-interface`)
carries `evidence.tablistRef` matching `pi-ref://` and a `reason` string, and that these
survive to the envelope top-level under the tight budget.

## 7. Activation steps (run only on a clean tree, post-R3)

1. Confirm `git status` clean (R3's `inference.ts` + `diff.ts` committed). Re-read
   `inference.ts` to rebase this design onto the final `form-dependency` code.
2. Add `reason?: string` to `DetectedIntent`; add `MAX_EVIDENCE_REFS` + the two shared
   helpers (`firstRefByRole`, `refsWithRelation`).
3. Per detector: after the fire decision, resolve `evidence` + set `reason` (detection
   branch logic untouched).
4. Update `InferenceSummarySchema` (`reason` optional).
5. Extend unit + contract tests (§6); keep all existing assertions intact.
6. Gates: `check:abml-core-boundary` → `test:unit -- tests/unit/abml/inference.test.ts`
   → `check:abml-inference` → `npm run check`.
7. Hand a fresh validation prompt to a browser agent: re-run the 9-page sweep and confirm
   each intent's `evidence` ref resolves to the right region (esp. that `expandable` on
   nav-heavy pages points at nav-landmark refs, proving the disambiguation story).

## 8. Risks / constraints / non-goals

- **Concurrency**: this plan edits `inference.ts`, which R3 is actively editing. Do not start
  until R3's `form-dependency` work is committed — otherwise a guaranteed merge collision.
- **No detection-logic change**: thresholds/roles/confidence are frozen. Only additive
  `evidence`/`reason`. If a future tweak wants to *change* a threshold, that is a separate
  change with its own validation — not bundled here.
- **No primary-intent ranking** (deferred): marking a page's "dominant" intent is high-value
  but risks page-type overfitting (defining "dominant" generically is hard). Explicitly out
  of scope for this plan; revisit only with a generality-safe definition.
- **Generality**: every ref comes from an ARIA entity or its R1 relation — no per-site/
  per-type branch. Preserved.
- **Privacy**: evidence carries only refs + counts + role/live metadata — never input
  values. `reason` must not embed user-entered text (use role/landmark/count only).
- **Budget immunity**: `inference` stays lifted to the envelope top-level; the added
  evidence refs are capped (§5) so the field can't balloon.
```
