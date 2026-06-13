# Algorithm Optimization Plan

> Summary archive for `docs/archive/algorithm-optimization-plan.full.md`.

Algorithm optimization completed on 2026-06-13. The workstream started with a
real observe-stage timing harvest, then executed the planned distill-core and
ABML kernel stages in order, landing only the optimizations that survived parity
checks and measured wins on the current repo workload.

## Completed Outcome

- **Step 0 harvest**: persisted `browser_observe` timing samples to
  `.pi/browser-artifacts/eval-browser-workflows/observe-timings-summary.json`
  so later kernel work was sized against measured `renderMs` / `abmlMs`, not
  draft intuition.
- **Item 12**: bounded pathological deep-array / deep-object summary inputs by
  adding the array depth guard and the `fitSummaryBudget` `RangeError` fallback.
- **Items 7 / 5 / 8 / 10 / 13**: landed the `tokenEstimate` char-code loop,
  salience-envelope serialize-once pass, primitive-root `stableJson` fast path,
  inference feature-view pass, and `groupEntities` same-array memo.
- **Item 11**: landed only the causal seq-decoration and repeated-URL origin
  memo subparts; relation-rank and diff-field experiments were measured and
  rejected as noise-level on this workload.
- **Item 9**: closed with no landing after the exact-length walker regressed the
  representative current corpora.
- Kernel test coverage expanded with the shared `tests/unit/helpers/microBench.ts`
  helper plus new direct tests for `cost.ts`, `salienceEnvelope.ts`,
  `inference.ts`, `grouping.ts`, and the item-11 ABML micro-sites; the
  `grouping.ts` grandfather entry was removed (`grandfathered=5/6`).

## Evidence

- Full execution record: `docs/archive/algorithm-optimization-plan.full.md`
- Observe timing artifact:
  `.pi/browser-artifacts/eval-browser-workflows/observe-timings-summary.json`
- Final closing gate: `npm run check`
