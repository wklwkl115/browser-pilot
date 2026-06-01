# 30 · ABML internal routing evidence

## Goal

Collect task-level transcript evidence on whether current `browser_*` tools plus internal ABML integration are already sufficient, or whether the agent gets blocked by the lack of a public ABML verb surface.

## Fixture

- Local target: `fixtures/interactive.html`, `fixtures/abml-frame-same-origin.html`, `fixtures/abml-frame-child.html`, `fixtures/abml-vision-floor.html`, `fixtures/abml-ax-canvas-aria.html`
- Required files:
  - `evals/browser-workflows/fixtures/interactive.html`
  - `evals/browser-workflows/fixtures/abml-frame-same-origin.html`
  - `evals/browser-workflows/fixtures/abml-frame-child.html`
  - `evals/browser-workflows/fixtures/abml-vision-floor.html`
  - `evals/browser-workflows/fixtures/abml-ax-canvas-aria.html`
- Setup notes: run the dedicated local smokes that exercise the existing public `browser_*` tools while ABML stays internal.

## Allowed starting tools

- `browser_tabs`
- `browser_observe`
- `browser_execute`
- `browser_frame`
- `browser_artifact`

## Expected tool sequence

1. Start from explicit tab/session state under the existing `browser_*` tools.
2. Observe through `browser_observe` and keep the returned artifact/snapshot/correlation evidence.
3. Use `browser_execute monitor:true` only as a public JS escape hatch, not as a hidden verb tool.
4. Use `browser_frame` and `browser_artifact` only where frame or artifact evidence is explicitly needed.
5. Compare whether the task completes under the existing public surface while internal ABML evidence appears underneath.

## Success criteria

- Real smoke artifacts show internal ABML integration is exercised.
- Existing public `browser_*` tools remain sufficient to complete the task.
- Evidence shows whether ABML helps as internal substrate or whether a public verb surface is required.

## Required evidence

- Summary evidence:
  - `abml-internal-routing`
  - `monitor-comparison`
  - `frame-entities`
  - `vision-regions`
- Artifact evidence:
  - `.pi/browser-artifacts/smoke-browser-correlation-chain-results.json`
  - `.pi/browser-artifacts/smoke-browser-abml-monitor-comparison-results.json`
  - `.pi/browser-artifacts/smoke-browser-abml-frame-compare-results.json`
  - `.pi/browser-artifacts/smoke-browser-abml-vision-compare-results.json`
  - `.pi/browser-artifacts/smoke-browser-ax-merge-results.json`
- Diagnostics evidence:
  - whether the task stays completable under the existing `browser_*` public surface
  - whether internal ABML evidence appears without introducing a public verb tool

## Recovery checks

- Expected failure mode: a task can only be described as successful if a hypothetical public `browser_read` / `browser_click` existed.
- Required recovery path: retry the task with the existing public `browser_*` tools and inspect whether internal ABML evidence already made the task possible without a new public verb.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
- internal-routing sufficiency

## Expected conclusion shape

- sufficient_with_internal_abml
- blocked_without_public_verbs
- mixed_needs_more_evidence
