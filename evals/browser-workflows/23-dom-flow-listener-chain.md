# Eval 23: DOM flow listener chain

## Goal

Given an explicit target node in a local fixture, extract bounded DOM listener facts, handler source metadata, and compact node→handler chain evidence without creating a new public browser tool or pretending to provide full dynamic taint tracking.

## Fixture

- Local target: `fixtures/dom-flow-listeners.html`
- Required files:
  - `fixtures/dom-flow-listeners.html`
- Setup notes:
  - Use explicit selector scope only.
  - Keep the result artifact-first when larger chain evidence is needed.

## Allowed starting tools

- `browser_tabs`
- `browser_hook`
- `browser_artifact`

## Expected tool sequence

1. Start from explicit tab/session state.
2. Use an explicit selector for listener extraction.
3. Read compact listener facts first.
4. Use compact chain evidence for follow-up, not a whole-page listener crawl.
5. Cite artifact paths when raw evidence is needed.

## Success criteria

- The result includes listener facts for the selected node.
- The result includes handler source metadata.
- The workflow stays bounded and does not claim full taint tracking.

## Required evidence

- Summary evidence:
  - `listener-facts`
  - `listener-chain`
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
  - narrow or correct the selector
  - do not fall back to broad DOM crawling

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
