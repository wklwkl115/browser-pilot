# Eval 03: Network Capture Replay

## Goal

Capture a local fixture request and replay it with one narrow header or body mutation.

## Fixture

- Local target: `fixtures/network.html`
- Required files: page that issues a same-origin JSON request such as `/api/echo` or `/api/item?id=1`.
- Setup notes: local server should return deterministic status/body and echo one header or parameter.

## Allowed starting tools

- `browser_tabs`
- `browser_network`
- `browser_execute`
- `browser_http_replay`
- `browser_artifact`

## Expected tool sequence

1. Start `browser_network` recording for the explicit tab.
2. Trigger the fixture request with `browser_execute` or a page action.
3. Inspect the captured request through `browser_network list/get/body`.
4. Replay the captured request using `browser_http_replay` with one narrow mutation.
5. Cite response delta from summary or artifact.

## Success criteria

- The replay target is derived from captured evidence.
- Exactly one narrow mutation is applied.
- Response status/body/header delta is reported.

## Required evidence

- Summary evidence: captured-request URL/method and replay status.
- Artifact evidence: network or replay-delta artifact path.
- Diagnostics evidence: body availability or unavailable reason when relevant.

## Recovery checks

- Expected failure mode: captured request lacks body or selected the wrong request.
- Required recovery path: inspect request body/HAR before replaying; do not guess request content.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after missing body/wrong request
- artifact sufficiency
- whether replay was used as the focused primitive
