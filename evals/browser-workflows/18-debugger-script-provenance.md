# Eval 18: Debugger script provenance

## Goal

Determine whether existing canonical tools can recover authored script provenance for a local fixture, including external script URL, bounded source evidence, and debugger correlation hints, before any stronger runtime provenance RFC is considered.

## Fixture

- Local target: `fixtures/debugger-provenance.html`
- Required files:
  - `evals/browser-workflows/fixtures/debugger-provenance.html`
  - `evals/browser-workflows/fixtures/debugger/provenance-helper.js`
- Setup notes: serve the fixture from a local-only fixture server so the external helper script keeps a stable same-origin URL.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_crawl`
- `browser_artifact`

## Expected tool sequence

1. Use `browser_tabs` to open the fixture with explicit `tabId`.
2. Use `browser_observe mode=scan` or `browser_observe mode=html` only to confirm the trigger and state text.
3. Use `browser_crawl` or targeted artifact reads to capture authored script resource evidence.
4. Use `browser_execute` command mode only for bounded debugger/runtime provenance reads.
5. Save larger evidence to artifacts and read them back with `browser_artifact`.
6. If authored script provenance still cannot be correlated, record it as RFC-only debugger evidence instead of inventing a new public tool.

## Success criteria

- The result captures some form of script-provenance evidence through existing canonical tools.
- The result distinguishes authored script provenance from thrown eval source evidence.
- The result clearly states whether current evidence is sufficient or remains RFC-only.
- The result does not widen the public tool surface.

## Required evidence

- Summary evidence: script-provenance findings from current tools.
- Artifact evidence: helper script or crawl/debugger artifact paths.
- Diagnostics evidence: provenance gap notes or cleanup-diagnostics when the authored script cannot be fully correlated.
- RFC-only evidence: an explicit statement if authored script provenance remains RFC-only.

## Recovery checks

- Expected failure mode: current one-shot debugger evidence only recovers eval-thrown source or unstable script identifiers.
- Required recovery path: collect bounded artifact evidence and classify the remaining gap as RFC-only instead of widening scope.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
