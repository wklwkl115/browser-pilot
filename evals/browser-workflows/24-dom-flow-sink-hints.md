# Eval 24: DOM flow sink hints

## Goal

Given an explicit target node in a local fixture, extract bounded heuristic source→sink hints based on observable listener/source/sink facts without claiming a full dynamic taint engine.

## Fixture

- Local target: `fixtures/dom-flow-listeners.html`
- Required files:
  - `fixtures/dom-flow-listeners.html`
- Setup notes:
  - Use explicit selector scope only.
  - Keep hints heuristic, factual, and bounded.

## Allowed starting tools

- `browser_tabs`
- `browser_hook`
- `browser_artifact`

## Expected tool sequence

1. Start from explicit tab/session state.
2. Use an explicit selector for sink-hint extraction.
3. Read compact sink hints first.
4. Use artifact paths only when the hint set is too large.
5. Do not broaden into whole-page DOM crawling or claim full taint tracking.

## Success criteria

- The result includes heuristic source→sink hints for the selected node.
- The result cites observable sink facts rather than exploit judgement.
- The workflow stays selector-scoped and bounded.

## Required evidence

- Summary evidence:
  - `sink-hints`
- Artifact evidence:
  - `artifact-path`
  - explicit selector or artifact path references
- Diagnostics evidence:
  - stable selector miss/invalid diagnostics when the selector fails

## Recovery checks

- Expected failure mode:
  - `SELECTOR_NOT_FOUND`
  - `INVALID_SELECTOR`
- Required recovery path:
  - correct or narrow the selector
  - do not fall back to broad DOM crawling

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
