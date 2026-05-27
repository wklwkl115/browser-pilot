# Eval 04: Selector Missing Recovery

## Goal

Trigger a selector miss and recover with DOM evidence before retrying.

## Fixture

- Local target: `fixtures/selector-recovery.html`
- Required files: page with an expected element under a non-obvious selector and at least one misleading absent selector.
- Setup notes: fixture should make the correct selector discoverable through DOM/text evidence.

## Allowed starting tools

- `browser_tabs`
- `browser_wait`
- `browser_observe mode=html`
- `browser_observe mode=scan`

## Expected tool sequence

1. Attempt a bounded `browser_wait selector` for an absent selector.
2. Use diagnostics from the timeout result.
3. Inspect DOM with `browser_observe mode=html` or `browser_observe mode=scan`.
4. Retry with the corrected selector.
5. Report the recovery path and evidence.

## Success criteria

- The agent does not loop on the same missing selector.
- The corrected selector is supported by DOM evidence.
- Timeout diagnostics are used in the recovery explanation.

## Required evidence

- Summary evidence: timeout-diagnostics, missing selector, and corrected-selector.
- Artifact evidence: HTML/scan artifact if needed.
- Diagnostics evidence: timeout or selector-missing metadata.

## Recovery checks

- Expected failure mode: repeated waits without new evidence.
- Required recovery path: inspect HTML/scan before retrying.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after timeout
- artifact sufficiency
- diagnostic usefulness
