# Eval 16: Scan high-entropy summary

## Goal

Verify that `browser_observe mode=scan` returns a compact high-entropy summary that lets the agent identify primary actions, form fields, repeated lists, status text, and artifact read paths without immediately opening the raw scan artifact.

## Fixture

- Local target: `fixtures/scan-high-entropy.html`
- Required files: `evals/browser-workflows/fixtures/scan-high-entropy.html`
- Setup notes: serve the fixture from a local-only fixture server or open it through the manual browser fixture flow. The page is synthetic and deterministic.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_artifact`
- `browser_execute`
- `browser_wait`

## Expected tool sequence

1. Use `browser_tabs` to select or create the fixture tab and keep explicit `tabId`.
2. Run `browser_observe mode=scan` with default `detailLevel:"summary"`.
3. Use only scan summary evidence first: `focus.primary_actions`, `focus.forms`, `focus.lists`, `focus.text_signals`, and `artifact_hints`.
4. If raw evidence is needed, use `browser_artifact` with the exact jsonPath suggested by `artifact_hints`, not a blind full artifact read.
5. Use `browser_execute` on the chosen selector and verify the state change with `browser_wait` or a follow-up `browser_observe mode=scan`.

## Success criteria

- The summary includes compact primary action evidence for Search, Apply coupon, Pay now, and the newsletter field.
- The summary exposes form field evidence without leaking the prefilled synthetic field value.
- The repeated product list appears as a compressed list summary with representative samples.
- `focus.text_signals` includes high-signal status or cart text instead of relying on a long raw `textPreview`.
- `artifact_hints` includes jsonPath entries for actionables, content, and list hints.
- The agent can choose a grounded action from the summary before reading the artifact.

## Required evidence

- Summary evidence: `summaryVersion`, `focus.primary_actions`, `focus.forms`, `focus.lists`, `focus.text_signals`, `artifact_hints`.
- Artifact evidence: saved scan artifact path and targeted `browser_artifact` read using an `artifact_hints` jsonPath when needed.
- Diagnostics evidence: `truncated` / `summaryOmitted` / `saved.path` when the scan result exceeds summary budget.

## Recovery checks

- Expected failure mode: the default summary is too shallow and only returns a raw artifact path or low-value head text.
- Required recovery path: inspect `artifact_hints` first, then read a narrow `browser_artifact` jsonPath such as `data.actionables` or `data.content`.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
