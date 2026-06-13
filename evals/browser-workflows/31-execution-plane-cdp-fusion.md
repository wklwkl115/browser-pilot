# Eval 31: Execution Plane CDP Fusion

## Goal

Prove that `browser_execute` can call `pi.click(ref)` against a fresh observed ref and dispatch
physical CDP input in one execute step, while raw `el.click()` is swallowed by a trusted-event-gated
control.

## Fixture

- Local target: `fixtures/execution-plane-cdp-fusion.html`
- Required files: page with a visible button whose listener ignores untrusted synthetic clicks and
  only inserts `#trusted-result` for trusted input.
- Setup notes: the fixture records synthetic ignored count, trusted activation count, status text,
  and a deterministic success marker.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_command`
- `browser_wait`
- `browser_observe mode=html`

## Expected tool sequence

1. Use the old escape path on one tab: `browser_execute` measures the target and proves
   `el.click()` is ignored, then `browser_command input.pointer` dispatches at the measured point.
2. Use the fused path on a fresh tab: `browser_observe mode=scan` mints a fresh `pi-ref://` for the
   button, raw `el.click()` proves the trusted-event wall, then `browser_execute` runs
   `await pi.click(ref)`.
3. Use `browser_wait` / `browser_observe` to verify `#trusted-result` and status text after each
   physical dispatch.

## Success criteria

- Raw `el.click()` increments the synthetic ignored state but does not insert `#trusted-result`.
- `browser_command input.pointer` succeeds as the existing two-call physical fallback.
- `pi.click(ref)` returns dispatch facts with `dispatchOnly:true`, `resolution:"backendNodeId"` or
  the explicit point tier, and three mouse events.
- Semantic success is verified only by wait/observe evidence after dispatch.
- The eval records the old path as two action calls and the fused path as one execute call once the
  ref already exists.

## Required evidence

- Summary evidence: raw-click ignored state, physical fallback success, `pi.click` dispatch facts,
  final trusted status text.
- Artifact evidence: before scan artifact, old-path command artifact, `pi.click` execute artifact,
  final HTML/text artifact.
- Diagnostics evidence: action-call count comparison and dispatchOnly-vs-semantic-verification note.
- Manifest evidence labels: `raw-click-ignored`, `dispatchOnly`, `trusted-result`,
  `action-call-comparison`.

## Recovery checks

- Expected failure mode: stale/missing ref or unsupported backend-node session.
- Required recovery path: re-observe `mode=scan` to mint a fresh ref; do not double-click merely
  because semantic intent is not verified inside `pi.click`.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovered after trusted-event wall
- artifact sufficiency
- old-path action calls vs fused-path action calls
- dispatch facts vs semantic verification separation
