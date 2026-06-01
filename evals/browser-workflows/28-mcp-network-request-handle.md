# Eval 28: MCP network request handle

## Goal

Measure whether an MCP agent can carry a captured network request into typed follow-up tools without manual JSON reconstruction, and decide whether per-entry `http-request` sub-resources are justified.

## Fixture

- Local target: `fixtures/mcp-network-request-artifact.json`
- Required files:
  - `fixtures/mcp-network-request-artifact.json`
- Setup notes: fixture is a deterministic synthetic browser_network-style artifact. It must contain multiple captured HTTP requests and one explicit SQLi candidate request. It must not require a live browser, external network, sqlmap, scanners, or OAST.

## Allowed starting tools

- `browser_artifact`
- MCP `resources/read`
- `browser_network`
- `browser_sqli`
- `browser_http_replay`

## Expected tool sequence

1. Start from the provided synthetic network artifact or a `browser-result://` raw-result handle that points to it.
2. Inspect the bounded request list with `resources/read` or `browser_artifact mode=json jsonPath=...`.
3. Select the request marked as the SQLi candidate by method, URL, and parameter evidence.
4. Attempt to pass the selected request into `browser_sqli.request` or `browser_http_replay.request` using a typed handle rather than copying raw JSON by hand.
5. If no per-entry `http-request` handle exists, record the gap and the manual workaround separately.

## Success criteria

- Passing state: a single per-entry `browser-result://...` URI with kind `http-request` can be supplied directly to `browser_sqli.request` or `browser_http_replay.request` and expands through MCP ingress handle resolution.
- Current expected state: blocked/insufficient until `browser_network` or its MCP adapter registers bounded per-entry `http-request` sub-resources.
- The eval must distinguish raw artifact readability from typed follow-up readiness.
- The workflow must not invent a request template or silently copy an unvalidated object into `browser_sqli`.

## Required evidence

- Summary evidence: selected request method, URL, parameter names, and request index.
- Artifact evidence: `fixtures/mcp-network-request-artifact.json`; if implemented later, the generated `browser-result://.../request-*` URI or section handle.
- Diagnostics evidence: absence or presence of `kind:http-request`, etag/hash metadata, and ingress resolution result (`HANDLE_KIND_MISMATCH`, `HANDLE_ETAG_MISMATCH`, success, or not available).

## Recovery checks

- Expected failure mode: only a raw-result resource exists, so `browser_sqli.request` cannot consume a per-entry request handle directly.
- Required recovery path: use bounded `resources/read jsonPath=...` to inspect the request, but mark artifact sufficiency as `insufficient` for typed follow-up until per-entry handles exist.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
- manual JSON reconstruction steps avoided or required
- typed handle availability (`none`, `raw-result-only`, `http-request-entry`)
