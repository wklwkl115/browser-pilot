# Eval 09: SQLi Probe vs Bridge

## Goal

Compare SQLi oracle probing with sqlmap bridge roles using a local fixture request.

## Fixture

- Local target: local HTTP endpoint that simulates deterministic SQLi oracle behavior from `fixtures/sqli-request.txt`.
- Required files: raw request template or fixture endpoint with one query parameter.
- Setup notes: fixture must be local and bounded; no real external target or destructive payloads.

## Allowed starting tools

- `browser_http_replay`
- `browser_sqli_probe`
- `browser_sqlmap_bridge`
- `browser_artifact`

## Expected tool sequence

1. Replay or inspect the request template first if target ambiguity exists.
2. Use `browser_sqli_probe` for bounded boolean/error/time/union oracle evidence.
3. Use `browser_sqlmap_bridge` only as explicit deeper automation when scoped request evidence exists.
4. Preserve request/stdout/stderr artifacts when bridge is used.

## Success criteria

- Probe and bridge roles are clearly distinguished.
- Scope and parameter names are explicit.
- Case count and timeout are bounded.
- Bridge is not used as the first observation tool.

## Required evidence

- Summary evidence: request-baseline plus vulnerable parameter/oracle-evidence or negative result.
- Artifact evidence: replay/probe path or bridge-artifact path.
- Diagnostics evidence: bounded cases, timeout, selected parameter.

## Recovery checks

- Expected failure mode: jumping directly to sqlmap without request baseline.
- Required recovery path: replay or probe the captured/raw request first.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after over-broad bridge use
- artifact sufficiency
- scoped follow-up discipline
