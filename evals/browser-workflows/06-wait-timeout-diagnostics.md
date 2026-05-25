# Eval 06: Wait Timeout Diagnostics

## Goal

Trigger a bounded wait timeout and verify that diagnostics support a concrete recovery action.

## Fixture

- Local target: `fixtures/wait-timeout.html`
- Required files: page with one selector that appears and one selector that never appears.
- Setup notes: absent selector should produce a deterministic timeout.

## Allowed starting tools

- `browser_tabs`
- `browser_wait`
- `browser_html`
- `browser_evidence`

## Expected tool sequence

1. Run a bounded wait for an absent selector.
2. Inspect the timeout diagnostics.
3. Use `browser_html` or `browser_evidence` to understand current page state.
4. Retry only with a corrected selector or report the absent condition.

## Success criteria

- Timeout is bounded and does not hang.
- Output includes actionable diagnostics or a clear continuation path.
- Recovery uses page evidence rather than repeated blind waits.

## Required evidence

- Summary evidence: timeout target and current page state.
- Artifact evidence: optional HTML/evidence artifact path.
- Diagnostics evidence: timeoutMs, selector, target tab/session.

## Recovery checks

- Expected failure mode: retrying the same selector without new evidence.
- Required recovery path: inspect state before retrying.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after timeout
- artifact sufficiency
- diagnostic actionability
