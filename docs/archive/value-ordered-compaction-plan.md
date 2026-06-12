# Value Ordered Compaction Plan

> Summary archive for `docs/archive/value-ordered-compaction-plan.full.md`.

Value-ordered compaction completed on 2026-06-11. Successor to the perception-renderer
and renderer-default-flip plans (first graduation: scan envelopes from ladder to salience
allocation). This plan is the second graduation: remaining positional-truncation paths
migrated to the distill-core token economy as value-ordered projection.

## Completed Outcome

- **P0 hygiene**: ABML kernel audit point fixes (A1–A6, B1–B3) executed first to
  clear recomputation debt; `grouping.ts` shared engine consumed by all 4 observe
  renderers; refId 1-pass stable FNV constants.
- **P1**: artifact JSON reads, generic sampling, and other hard "first-N" truncation
  paths replaced by value-ordered distill-core projection; scattered presentation-
  compaction logic consolidated into the kernel.
- **P3 caps ledger**: per-kernel output cap seeds committed to `distill-core`; caps are
  machine-gated via `check:compute-once` call-site ledger.
- **K6 selected/pressed eval probe**: eval fixture captures selected/pressed ARIA state
  for regression coverage.
- `classBBaseline` re-pin accepted deviation (101→97; prefix-rule + slack weakens
  new-kernel-cap guard; recorded for future tightening).

## Acceptance (2026-06-12, independent re-verification)

Verdict: **ACCEPTED**. Full `npm run check` and `npm run lint` exit 0. Token-economy
`medianRatio` 0.0607 IDENTICAL pre/post (byte-identity evidence). One stale
string-marker contract found and fixed at acceptance
(`check-abml-tree-diff:83` expected `templateGroupDescriptorForEntity` in `treeDiff.ts`
— moved to `grouping.ts` by B1; marker updated to assert new architecture).
Accepted drifts recorded; do not re-litigate.

## Evidence

- Full execution record: `docs/archive/value-ordered-compaction-plan.full.md`
- Predecessor plans: `docs/archive/perception-renderer-plan.full.md`,
  `docs/archive/renderer-default-flip-plan.full.md`
- ABML kernel optimisation: `docs/archive/abml-kernel-optimization-plan.full.md`
