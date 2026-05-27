# Eval 02: Scan Execute Wait

## Goal

Inspect a local interactive fixture, identify an element, execute a JavaScript action, and wait for a visible state change.

## Fixture

- Local target: `fixtures/interactive.html`
- Required files: page with a button or control that changes visible status text after click or script action.
- Setup notes: state change should be deterministic and observable in DOM text.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_wait`
- `browser_observe mode=html`

## Expected tool sequence

1. Use `browser_tabs` to get an explicit `tabId`.
2. Use `browser_observe mode=scan` to identify the actionable element and current state.
3. Use `browser_execute` for a narrow DOM action.
4. Use `browser_wait` for a selector/text state change.
5. Verify final state with `browser_observe mode=scan` or `browser_observe mode=html`.

## Success criteria

- The element choice is grounded in scan evidence.
- The action is narrow and targeted.
- The state change is verified independently after execution.

## Required evidence

- Summary evidence: before-state and after-state text.
- Artifact evidence: optional scan/html artifact if summaries are truncated.
- Diagnostics evidence: wait target and timeout if a wait fails.

## Recovery checks

- Expected failure mode: scan identifies multiple similar controls.
- Required recovery path: use a more specific selector or targeted HTML snapshot before acting.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after ambiguous element selection
- artifact sufficiency
- verification after action
