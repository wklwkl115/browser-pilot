# Eval 19: Debugger pause lifecycle

## Goal

Determine whether a future debugger lifecycle enhancement is justified by measuring pause/resume cleanup risk on a deterministic local fixture, without assuming a new public debugger tool exists.

## Fixture

- Local target: `fixtures/debugger-pause.html`
- Required files: `evals/browser-workflows/fixtures/debugger-pause.html`
- Setup notes: the page must expose a visible counter or state that keeps changing until paused or resumed.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_wait`
- `browser_artifact`

## Expected tool sequence

1. Open the fixture with `browser_tabs` and keep explicit `tabId`.
2. Observe the changing page state with `browser_observe mode=scan` or `browser_observe mode=html`.
3. Use `browser_execute` command mode only for bounded debugger lifecycle reads or control attempts.
4. Verify whether the page can be paused, resumed, and cleaned up without leaving stale debugger state.
5. Save diagnostics or state evidence as artifacts when needed.
6. If lifecycle control is insufficient, record the gap as RFC-only evidence rather than inventing a new public tool.

## Success criteria

- The eval clearly distinguishes between current evidence/control that works and lifecycle gaps that remain unresolved.
- Pause/resume cleanup behavior is independently verified through page state or diagnostics.
- The result does not imply that a new public debugger tool already exists.
- The result states whether lifecycle support remains RFC-only.

## Required evidence

- Summary evidence: observed counter/state before and after debugger control attempts.
- Artifact evidence: saved lifecycle diagnostics, CDP responses, or page-state evidence when needed.
- Diagnostics evidence: cleanup-diagnostics, stale-state risk, detach/reload behavior.
- RFC-only evidence: explicit lifecycle insufficiency statement if the current recipe is not robust enough.

## Recovery checks

- Expected failure mode: pause or resume leaves the page in a stale or unrecoverable state, or current tools cannot drive the lifecycle reliably.
- Required recovery path: detach/cleanup, re-observe page state, and record the insufficiency as RFC-only evidence.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
