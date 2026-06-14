# Eval 32: ABML Identity Bootstrap Evidence

## Goal

Collect deterministic evidence for the proposed DOM scan `backendNodeId` bootstrap: page-world scan
rectangles can be compared with `DOMSnapshot.captureSnapshot` bounds, and ambiguous or drifted
cases must remain fail-open instead of being treated as proven joins.

## Fixture

- Local target: `fixtures/abml-identity-bootstrap.html`
- Required files: `evals/browser-workflows/fixtures/abml-identity-bootstrap.html`
- Setup notes: the page contains stable, scrolled, transformed, drifted, and duplicate-overlap
  targets. It is synthetic and deterministic.

## Allowed starting tools

- `browser_tabs`
- `browser_observe`
- `browser_execute`
- `browser_command`
- `browser_artifact`

## Expected tool sequence

1. Open the fixture in an explicit tab.
2. Run `browser_observe mode=scan` and save the scan artifact.
3. Use `browser_execute` to collect page-world viewport and target rects.
4. Mutate only the drift target after the page-world sample.
5. Use `browser_command persistent_cdp` to call `DOMSnapshot.captureSnapshot`.
6. Write a comparison artifact with sample windows, normalized bounds, IoU diagnostics,
   per-target status, and `bootstrapStats`.

## Success criteria

- The comparison artifact includes `scanStartedAt`, `snapshotStartedAt`, viewport diagnostics,
  per-target `backendNodeId` when available, normalized geometry, and IoU.
- At least two stable targets are classified as `matched`.
- The duplicate-overlap case is classified as `ambiguous`.
- The post-scan mutation case is classified as `stale`.
- The eval does not claim that product scan entities already carry `backendNodeId`.

## Required evidence

- Summary evidence: `scan-rects`, `snapshot-bounds`, `coordinate-parity`, `bootstrapStats`,
  `fail-open-cases`.
- Artifact evidence: saved scan artifact and `32-abml-identity-bootstrap-evidence-comparison.json`.
- Diagnostics evidence: sample window timing, viewport/scroll scale, matched/ambiguous/stale counts,
  and explicit non-claim that this is eval evidence only.
- Manifest evidence labels: `scan-rects`, `snapshot-bounds`, `coordinate-parity`, `bootstrapStats`,
  `fail-open-cases`.

## Recovery checks

- Expected failure mode: scan and snapshot samples drift or duplicate geometry creates multiple
  high-IoU candidates.
- Required recovery path: classify as `stale` or `ambiguous` and keep the target un-stamped.

## Metrics

- success/failure
- tool call count
- artifact sufficiency
- matched coverage
- ambiguous count
- stale count
- sample window duration
