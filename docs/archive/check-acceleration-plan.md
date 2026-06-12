# Check Acceleration Plan

> Summary archive for `docs/archive/check-acceleration-plan.full.md`.

Check acceleration completed on 2026-06-12. The work turned local verification from
"rerun every proof from scratch" into a reproducible incremental proof system while
preserving `npm run check` as the final full gate.

## Completed Outcome

- **`npm run check:trace`**: grouped runner trace with per-script wall-clock durations;
  writes `.pi/browser-artifacts/check-groups-summary.json`.
- **`npm run check:dag`**: graph-backed DAG runner using direct local binaries and
  ESLint; dependency edges prevent spurious re-runs; `--cache` flag adds coarse
  fingerprint caching for exact repeats.
- **`npm run check:smart`**: impact-selected graph subset with conservative expansion;
  records selected nodes and expansion reasons.
- **`node scripts/run-check-groups.mjs --json`**: structured JSON summary artifact
  for programmatic consumption.
- Miss-recording path: cache misses log which files triggered re-execution.
- `npm run check` unchanged as the final full gate; acceleration is opt-in for
  fast iteration cycles within a workstream.

## Evidence

- Full execution record: `docs/archive/check-acceleration-plan.full.md`
- Runner scripts: `scripts/run-check-groups.mjs`, `scripts/check-dag.mjs`
- Artifact output: `.pi/browser-artifacts/check-groups-summary.json`
