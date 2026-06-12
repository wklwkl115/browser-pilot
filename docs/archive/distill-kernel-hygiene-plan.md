# Distill Kernel Hygiene Plan

> Summary archive for `docs/archive/distill-kernel-hygiene-plan.full.md`.

Distill kernel hygiene (economy-kernel audit point fixes) completed on 2026-06-11.
Independent point-fix track — all items cited verified audit evidence; findings that
did not survive verification are recorded in the full doc under "Accepted costs /
rejected findings". Sequencing note: D1/D7 were executed before the value-ordered
compaction plan's P1, which touches the same files.

## Completed Outcome

- **D1/D7** (`observeRunners.ts` / `resultMiddleware.ts`): eliminated slice-scoped
  recomputation of `buildSnapshotProjection`, `scanEntitiesForEnvelope`,
  `buildScanEntities`, and `envelopeEntities`; threaded computed values through
  the render path instead of recomputing per-call.
- **D2**: extracted shared purity vocabulary to `tests/contracts/drift/purity-vocabulary.js`
  (G4 ride-along); fixed locale-sensitive ordering in `profile.ts`, `recall.ts`,
  `staleness.ts` before memory-core boundary check runs.
- **D4**: expanded `observeRenderParamsSignature` to key on all output-affecting
  `PI_BROWSER_*` flags; G6 env-flag registry ride-along.
- **D6**: direct test coverage for previously delta-only kernel modules; G5
  kernel-test-map ride-along.
- Serialization-count canary added to `resultMiddleware` unit tests (G3 ride-along).
- P3 seed handoff section prepared as input for the value-ordered compaction plan.

## Evidence

- Full execution record: `docs/archive/distill-kernel-hygiene-plan.full.md`
- Related gates: `check:compute-once`, `check:purity-vocabulary`, `check:env-flags`,
  `check:kernel-test-map`
