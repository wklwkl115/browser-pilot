# Eval 15: jshook Canvas Observation

## Goal

Inspect a local canvas/WebGL-style fixture with existing browser perception and focused JavaScript, then decide whether canvas needs are already closed or require a separate RFC.

## Fixture

- Local target: `fixtures/jshook-canvas.html`
- Required files: page with one 2D canvas containing deterministic shapes, labels, and a small interactive region; optional WebGL context should be synthetic and bounded.
- Setup notes: fixture must not implement CAPTCHA, gameplay automation, or external assets.

## Allowed starting tools

- `browser_tabs`
- `browser_screenshot`
- `browser_execute`
- `browser_hook`
- `browser_evidence`
- `browser_artifact`

## Expected tool sequence

1. Start from explicit tab/session state with `browser_tabs`.
2. Capture visual proof with `browser_screenshot` when needed.
3. Use focused `browser_execute` JavaScript to list canvases, dimensions, bounding rects, 2D context availability, and deterministic pixel or object metadata exposed by the fixture.
4. If canvas API calls are the evidence target, use explicit `browser_hook` instrumentation and aggregate events with `browser_evidence`.
5. Store larger image or event evidence as artifact and read it through `browser_artifact`.

## Success criteria

- Canvas dimensions, selector, and deterministic scene metadata are reported.
- Visual artifact or bounded pixel/object evidence is available.
- The result separates observation from strategy: no automatic gameplay, solver, CAPTCHA bypass, or broad scene-analysis workflow.
- The result classifies whether existing screenshot/execute/hook primitives are sufficient.

## Required evidence

- Summary evidence: canvas selector, dimensions, context type, and scene-metadata or `canvas-events` count.
- Artifact evidence: screenshot or bounded event/pixel `artifact` path.
- Diagnostics evidence: traversal/pixel limits, redaction state for event payloads, and hook cleanup if used.

## Recovery checks

- Expected failure mode: screenshot alone is insufficient, pixel dump too large, or tool drifts toward solver behavior.
- Required recovery path: use focused JS metadata reads, reduce canvas/pixel bounds, and keep strategy decisions outside the tool.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after insufficient screenshot or oversized dump
- artifact sufficiency
- no-strategy-boundary preservation

## Capability closure classification

- Classification: existing `browser_screenshot`, `browser_execute`, `browser_hook`, `browser_evidence`, and `browser_artifact` are sufficient for bounded canvas observation unless eval proves a repeated perception primitive gap.
- Canonical surface: existing perception/action/evidence tools.
- Closure result: this eval must not introduce `browser_canvas`; any canvas-specific public tool needs a separate RFC and no solver semantics.
