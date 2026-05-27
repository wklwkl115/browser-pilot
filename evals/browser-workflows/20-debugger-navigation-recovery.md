# Eval 20: Debugger navigation recovery

## Goal

Determine whether existing canonical tools can recover cleanly from navigation or reload after debugger-like evidence collection, and whether any remaining stale-state risk justifies future internal lifecycle work.

## Fixture

- Local target: `fixtures/debugger-navigation.html`
- Required files: `evals/browser-workflows/fixtures/debugger-navigation.html`
- Setup notes: the page should expose a visible state and a same-origin navigation or reload trigger so recovery can be verified deterministically.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_wait`
- `browser_artifact`

## Expected tool sequence

1. Use `browser_tabs` to open the fixture and keep explicit `tabId`.
2. Observe the initial page state.
3. Use `browser_execute` command mode only for bounded debugger evidence or lifecycle attempts.
4. Trigger navigation or reload using the narrowest available action.
5. Re-observe the page and verify whether debugger-related state was cleaned up or lost safely.
6. Preserve larger diagnostics in artifacts and classify unresolved gaps as RFC-only.

## Success criteria

- The result shows whether debugger-like evidence collection survives, resets, or fails safely across navigation.
- The result records cleanup-diagnostics or stale-state symptoms when present.
- The result does not assume a new public debugger tool already exists.
- The result explicitly states whether navigation recovery remains an RFC-only lifecycle gap.

## Required evidence

- Summary evidence: before/after page state and lifecycle observations.
- Artifact evidence: saved debugger command or recovery diagnostics when needed.
- Diagnostics evidence: stale-state notes, detach behavior, navigation recovery details.
- RFC-only evidence: explicit statement if current tools cannot recover cleanly across navigation.

## Recovery checks

- Expected failure mode: debugger-related state becomes stale or lost after navigation/reload and cannot be explained or cleaned up cleanly.
- Required recovery path: detach if possible, re-open or re-observe the tab, and record the insufficiency as RFC-only evidence.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
