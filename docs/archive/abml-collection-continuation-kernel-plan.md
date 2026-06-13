# ABML Collection Continuation Kernel Plan

> Summary archive for `docs/archive/abml-collection-continuation-kernel-plan.full.md`.

Completed 2026-06-13. The workstream shipped the ABML collection completeness +
continuation perception kernel:

- Added pure `src/abml-core/collections.ts`, `src/abml/collections.ts`, barrel,
  boundary manifest, export inventory, unit tests, and `check:abml-collections`.
- `browser_observe mode=scan` now emits top-level `collections` and mirrors it in
  saved observe artifacts under `envelope.collections`, top-level `collections`,
  and `abml.collections`.
- The model reports `completeness`, capped `itemRefs` with true counts,
  read-only `pi-cont://collection/*` continuation evidence, data sources, and
  supporting evidence refs.
- Negative controls pin the blind-eval lessons: raw AX/outline member counts are
  not item-count/completeness oracles, and `data.rows` alone is not a semantic
  list model.
- The parked runtime continuation arm stayed parked: no public `browser_scroll`,
  no `browser_execute {action}`, no hidden observe-time scroll/click loop, and no
  executable `continueCollection` path.

Primary gates: `check:abml-collections`, `test:unit:abml`,
`check:abml-contracts`, `check:governance`, docs/skill validation, and full
`npm run check`.
