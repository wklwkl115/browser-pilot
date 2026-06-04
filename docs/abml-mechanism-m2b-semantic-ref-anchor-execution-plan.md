# ABML mechanism arm M2b — gated semantic ref anchor execution contract

> Status: **P1/P2 COMPLETE; P3 GATED / NOT STARTED**. M2b is active after M2a. Pure candidate
> derivation and shadow-ref stability are implemented, but there is still no ref-minting feed. No
> direct `stableRefIdForDescriptor` / ref-minting mutation until the P3 gates below pass.

## 1. Goal

M2a proved structure-level `treeDiff` can match repeated-list instances by high-confidence semantic
keys without changing live refs. M2b evaluates whether a subset of those same anchors can safely make
`pi-ref://` handles stable across repeated-list/table reorder and insertion.

Target outcome:
- A template-eligible item with a unique accessible name under the same ARIA/AX container keeps a
  stable ref across reorder/insert/delete around it.
- Non-template entities and ambiguous/duplicate/unnamed template instances keep current locator-based
  ref behavior.
- Low-confidence positional anchors remain diff-only unless a later gate explicitly proves them safe.

## 2. Hard boundaries

- No new public `browser_*` tools.
- No native protocol/schema surface change.
- No DOM tag/class/selector pattern guessing.
- No site/framework-specific heuristic.
- No global `stableRefIdForDescriptor` rewrite.
- No action-resolution change before scan/diff/read/click/ref-registry blast-radius gates pass.

## 3. Evidence reused from M1/M2a

- M1 template grouping is ARIA-grounded via `hints.containerRole` / `hints.containerName` or
  `aria-setsize`, plus shared `role` + `kind`.
- M2a `treeDiff` already computes high-confidence `name` anchors for unique accessible names and keeps
  `posInSet` / index as low-confidence fallback.
- M2a shipped with no ref minting change and is validated by `check:abml-tree-diff`,
  `smoke:browser:abml-templating`, and full `npm run check`.

## 4. Candidate anchor model

Add an internal semantic anchor only for template-eligible entities:

```ts
type SemanticRefAnchor = {
  scope: "abml-template";
  confidence: "high" | "low";
  containerRole?: string;
  containerName?: string;
  setSize?: number;
  role: string;
  kind: EntityKind;
  name?: string;
  posInSet?: number;
};
```

Activation rule for ref minting:
- **Allowed candidate:** `confidence:"high"` with same container signal + role/kind + unique normalized
  accessible name across the current template group.
- **Not allowed by default:** duplicate names, missing names, `posInSet`-only anchors, index anchors,
  entities outside template groups, visual regions, frames, network/event refs.

## 5. Phases

### P0 — contract + blast-radius inventory  (COMPLETE)

- Keep this document as the source of truth.
- Inventory all ref-sensitive paths before implementation:
  - `src/resources/resourceStore.ts` (`stableRefIdForDescriptor`, registry/resolve),
  - scan entities / flat `diffEntities`,
  - `browser_observe` summary/envelope,
  - `read(ref)` / action resolution / click paths,
  - snapshot registry and result artifact replay.
- Add or identify baseline contracts that prove current behavior before any minting change.
- Result: `check:abml-semantic-ref-anchor` guards that `resourceStore.ts` does not import/use semantic-ref-anchor logic, so ref minting remains untouched.

### P1 — pure candidate derivation, not wired to minting  (COMPLETE)

- Add a pure helper that derives candidate anchors from M1/M2a template grouping.
- Store/return candidates only inside tests or internal diagnostics.
- Do not feed candidates into `stableRefIdForDescriptor`.
- Required tests:
  - unique-name repeated list item gets high-confidence anchor,
  - duplicate-name items get no high-confidence anchor,
  - unnamed items get no high-confidence anchor,
  - `posInSet`-only stays low-confidence/diff-only,
  - non-template entities get no anchor.
- Result: `src/abml-core/semanticRefAnchor.ts` derives high-confidence unique-name anchors and low-confidence duplicate/unnamed positional diagnostics only.

### P2 — shadow ref experiment  (COMPLETE)

- Compute old ref id and candidate semantic ref id side-by-side in tests.
- Assert semantic ref stability across reorder/insert for high-confidence anchors.
- Assert current locator ref behavior remains unchanged in runtime output.
- Produce no user-visible ref change.
- Result: `semanticRefAnchorHashInput` proves stable shadow payloads across reorder/insert while runtime refs remain unchanged.

### P3 — gated minting change  (GATED / NOT STARTED)

Only after P1/P2 pass:
- Extend `RefDescriptor.semantic` or equivalent internal descriptor field with high-confidence anchor.
- Feed only allowed high-confidence anchors into `stableRefIdForDescriptor`.
- Keep existing locator fallback for every unsupported/ambiguous case.
- Add a feature gate or narrow branch so rollback is one small diff.

### P4 — live smoke + regression gate  (NOT STARTED)

Required before shipping P3:
- Fixture: repeated list/table with unique names.
- Sequence: observe -> reorder/insert -> observe baseline -> resolve/read/click old stable item ref.
- Expected: stable item ref survives; new item appears; duplicate/unnamed items do not claim semantic
  stability.
- Full gate: `npm run check`, plus targeted contracts for scan/diff/read/click/ref registry.

## 6. Acceptance

M2b is complete only when:
- high-confidence semantic refs are stable across reorder/insert in live browser smoke,
- low-confidence/ambiguous cases preserve old behavior,
- ref-sensitive contracts pass,
- no public tool/protocol surface changed,
- docs state the exact blast radius and rollback path.

## 7. Rollback path

If any ref-sensitive path regresses, revert only the P3 minting feed. P1/P2 candidate derivation can
remain because it does not affect live refs.
