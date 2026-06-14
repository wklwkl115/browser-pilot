# Eval 35: ABML Growth Probe Evidence

## Goal

Collect deterministic product evidence that `browser_observe mode=scan` emits bounded
`growthProbe` evidence and that collection completeness consumes it as a virtualized window signal.
This closes the `collections.ts` consumer / scan production gap without adding a public continuation
or scroll action surface.

## Fixture

- Local target: `fixtures/abml-growth-probe.html`
- Required files: `evals/browser-workflows/fixtures/abml-growth-probe.html`
- Setup notes: the page contains a fixed-size virtual list. Scrolling the container changes the
  visible row text while the DOM row count remains fixed.

## Allowed starting tools

- `browser_tabs`
- `browser_observe`
- `browser_execute`
- `browser_artifact`

## Expected tool sequence

1. Open the fixture in an explicit tab.
2. Run `browser_observe mode=scan` and save the scan artifact.
3. Read product `data.growthProbe`, `collections`, and collection evidence from the saved artifact.
4. Use `browser_execute` only for fixture state verification after the scan has restored scroll.
5. Write a comparison artifact with growth probe stats, collection classification, and no-public-action
   boundary evidence.

## Success criteria

- The saved scan artifact contains `data.growthProbe.supported=true`.
- The growth probe records a shifted observed window (`windowShifted=true`) with restored scroll.
- Collection output is `virtualized` with `continuation.kind="virtual-window"`.
- Collection evidence includes source `growthProbe`.
- The boundary artifact states that no public continuation/scroll action was added.

## Required evidence

- Summary evidence: `growthProbe`, `windowShifted`, `restoredScrollTop`, `collectionCompleteness`.
- Artifact evidence: saved scan artifact and `35-abml-growth-probe-evidence-comparison.json`.
- Diagnostics evidence: before/after row texts, counts, scrollTop/scrollHeight, collection evidence,
  and no-new-public-tool boundary.
- Manifest evidence labels: `growthProbe`, `windowShifted`, `collectionCompleteness`,
  `no-public-continuation`.

## Recovery checks

- Expected failure mode: no scrollable/list candidate or a page whose visible window does not change.
- Required recovery path: record unsupported/no-growth diagnostics and do not mark the collection
  virtualized from growth evidence.

## Metrics

- success/failure
- tool call count
- artifact sufficiency
- growth probe support
- window shift status
- collection completeness
