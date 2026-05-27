# Eval 14: jshook Replay Not Intercept

## Goal

Validate that request mutation and response-delta tasks are closed by passive capture plus `browser_http_replay`, without adding a live `browser_intercept` public tool.

## Fixture

- Local target: `fixtures/jshook-replay.html`
- Required files: page that issues deterministic same-origin JSON requests to a local fixture endpoint such as `/api/jshook/replay`.
- Setup notes: local endpoint should echo one request header, query value, or JSON body field; no external network and no real credentials.

## Allowed starting tools

- `browser_tabs`
- `browser_network`
- `browser_execute`
- `browser_http_replay`
- `browser_artifact`

## Expected tool sequence

1. Start `browser_network` recording for the explicit tab.
2. Trigger the fixture request with `browser_execute`.
3. Inspect the captured request through `browser_network list/get/body`.
4. Use `browser_http_replay` for one narrow header/query/body mutation.
5. Compare response status/body/header delta and cite artifact evidence.

## Success criteria

- The replay request is derived from captured evidence, not guessed from page code.
- Exactly one narrow mutation is applied per replay case.
- Response delta is sufficient to answer the task without pausing live page requests.
- The result states that live interception is not required for this class unless a separate RFC proves a live-flow-only need.

## Required evidence

- Summary evidence: captured-request URL/method and `replay-delta` summary.
- Artifact evidence: captured request or replay response `artifact` path.
- Diagnostics evidence: network recorder session id, body availability/unavailable reason, and replay baseline comparison facts.

## Recovery checks

- Expected failure mode: selected wrong request, missing body, or attempted page-side fetch monkeypatch/live intercept before passive capture.
- Required recovery path: filter recorder entries, inspect HAR/body artifacts, then replay the captured request with bounded mutation.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after wrong request or missing body
- artifact sufficiency
- scoped follow-up discipline

## Capability closure classification

- Classification: existing `browser_network` plus `browser_http_replay` is sufficient for offline mutation and response-delta work.
- Canonical surface: `browser_network`, `browser_http_replay`, and `browser_artifact`.
- Closure result: this eval must not introduce `browser_intercept`; a live interception tool requires separate RFC evidence for live-flow-only tasks.
