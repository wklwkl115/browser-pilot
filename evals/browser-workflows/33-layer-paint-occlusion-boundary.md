# Eval 33: Layer Paint Occlusion Boundary

## Goal

Collect bounded evidence for the current LayerTree / paint-order boundary: scan evidence can see
geometry-level top-hit occlusion, LayerTree may be unavailable in the current CDP surface, and
DOMSnapshot paint-order owner evidence must map back to `backendNodeId` and feed capped ABML
`coveredBy` / `occludes` relations.

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
4. Probe internal `layer.probe` evidence (`LayerTree.enable` + `layerTreeDidChange`) and fall back
   to `DOMSnapshot.captureSnapshot(includePaintOrder:true)` when LayerTree is unavailable.
5. Write a boundary artifact summarizing current scan relation coverage, LayerTree availability,
   compact paint-order runtime stats, and artifact-only full paint-order evidence.

## Success criteria

- The fixture proves a top-hit occluder exists through page-engine evidence.
- The artifact states whether the scan envelope has `relations.summary.occludes` and
  `relations.summary.coveredBy`.
- The artifact records whether LayerTree owner `backendNodeId` values or DOMSnapshot paint-order
  owner `backendNodeId` values are available.
- Passing this eval requires a page-engine top-hit occluder plus at least one owner-mapped
  paint-order path, capped ABML occlusion relations, and full paint-order rows kept out of the
  model-facing envelope.

## Required evidence

- Summary evidence: geometry top-hit sample, scan relation summary, LayerTree event probe status,
  DOMSnapshot paint-order owner status, and compact runtime paint-order stats.
- Artifact evidence: saved scan artifact and `33-layer-paint-occlusion-boundary-boundary.json`.
- Diagnostics evidence: `elementFromPoint` result, LayerTree event/owner result or error,
  DOMSnapshot paint-order owner result or error, `abml.data.paintOrderEvidence.entries` in the
  saved artifact, and no-new-public-tool boundary.
- Manifest evidence labels: `geometry-top-hit`, `scan-relations`, `layerTree-probe`,
  `boundary-diagnostics`.

## Recovery checks

- Expected failure mode: LayerTree domain/events are unavailable or do not return owner mappings.
- Required recovery path: fall back to DOMSnapshot paint order; if that also lacks owner mappings,
  record the unsupported/missing owner-map state. If `includePaintOrder` is unsupported but plain
  DOMSnapshot works, preserve geometry and expose compact fallback diagnostics.

## Metrics

- success/failure
- tool call count
- artifact sufficiency
- top-hit sample count
- layer-owner mapping availability
- paint-order owner mapping availability
