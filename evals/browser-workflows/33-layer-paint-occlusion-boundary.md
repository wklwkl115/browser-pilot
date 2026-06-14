# Eval 33: Layer Paint Occlusion Boundary

## Goal

Collect bounded evidence for the current LayerTree / paint-order boundary: existing scan evidence can
see geometry-level top-hit occlusion, but it does not yet prove a LayerTree owner-to-`backendNodeId`
relation model.

## Fixture

- Local target: `fixtures/abml-layer-occlusion.html`
- Required files: `evals/browser-workflows/fixtures/abml-layer-occlusion.html`
- Setup notes: the page has overlapping fixed/sticky/opacity/transform elements and deterministic
  `elementFromPoint` samples.

## Allowed starting tools

- `browser_tabs`
- `browser_observe`
- `browser_execute`
- `browser_command`
- `browser_artifact`

## Expected tool sequence

1. Open the occlusion fixture.
2. Run `browser_observe mode=scan` and save the scan artifact.
3. Use `browser_execute` to capture deterministic `elementFromPoint` samples.
4. Probe `LayerTree.enable` and a bounded LayerTree owner-mapping method if available.
5. Write a boundary artifact summarizing current scan relation coverage and missing layer-owner
   evidence.

## Success criteria

- The fixture proves a top-hit occluder exists through page-engine evidence.
- The artifact states whether the scan envelope has `relations.summary.occludes`.
- The artifact records that no artifact-backed LayerTree owner-to-`backendNodeId` relation is
  currently proven by this runner.
- Passing this eval means the boundary evidence is complete, not that LayerTree relations shipped.

## Required evidence

- Summary evidence: geometry top-hit sample, scan relation summary, LayerTree probe status.
- Artifact evidence: saved scan artifact and `33-layer-paint-occlusion-boundary-boundary.json`.
- Diagnostics evidence: `elementFromPoint` result, LayerTree method result/error, and no-new-public-tool
  boundary.
- Manifest evidence labels: `geometry-top-hit`, `scan-relations`, `layerTree-probe`,
  `boundary-diagnostics`.

## Recovery checks

- Expected failure mode: LayerTree method is unavailable or does not return owner mappings.
- Required recovery path: record the unsupported/missing owner-map state and keep LayerTree as a
  closed decision pending a dedicated execution contract.

## Metrics

- success/failure
- tool call count
- artifact sufficiency
- top-hit sample count
- layer-owner mapping availability
