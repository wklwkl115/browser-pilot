# Evidence and Reporting

## Trigger

Use when turning browser/tool output into a finding, final answer, triage note, or reproducible security report.

## Inputs

- Goal: finding, no-finding explanation, reproduction steps, executive summary, technical report, or next-step handoff.
- Evidence artifacts from observe/network/hook/replay/fuzz/SQLi/cookie/OAST/template tools.
- Scope and redaction requirements.

## Route

1. Gather identifiers:
   - `tabId`, URL, selector/frame ID
   - `operationId`, `snapshotId`, `requestId`, `waitId`, `listenerId`, `sessionId`
   - artifact paths
2. Read only needed evidence with `browser_artifact`:
   - use `jsonPath`/`pick` for structured fields
   - use `search` for bounded proof terms
   - use offsets for text snippets
   - keep default redaction unless the user explicitly requests local raw evidence
3. Validate the finding:
   - baseline and changed case are both known
   - response delta/oracle is stable
   - request/action is in scope
   - browser-side effects are separated from server-side effects
   - sensitive values are redacted
4. Write concise reproduction steps using callable tool names and key parameters, not giant raw payloads.
5. State severity only when impact is evidenced; otherwise state observation and next verification step.

## Finding template

```markdown
## Finding: <short title>

- Target: <URL/path/feature>
- Scope: <authorized scope>
- Evidence: <artifact path(s), requestId/sessionId/operationId>
- Baseline: <status/length/hash/behavior>
- Trigger: <changed field/action/payload family>
- Result: <stable delta/oracle/callback/data exposure>
- Impact: <data/authorization/action/control impact>
- Reproduce:
  1. <capture/open/action>
  2. <tool call route with bounded params>
  3. <artifact read or response check>
- Fix: <specific control: validation, authz, signing, parser alignment, secret rotation, etc.>
```

## No-finding template

```markdown
No confirmed finding.
- Tested: <route and params>
- Evidence: <artifact path>
- Result: <no stable delta/oracle/callback>
- Next step if needed: <narrow follow-up>
```

## Redaction rules

- Do not paste cookies, tokens, authorization headers, full request bodies, WebSocket payloads, or secrets.
- Prefer claim names, parameter names, status/length/hash, and small redacted snippets.
- Keep raw evidence local in `.pi/browser-artifacts/` and reference paths.

## Stop

Stop before reporting a vulnerability if evidence cannot distinguish baseline noise from exploit effect, artifact paths are missing, or reproduction requires actions outside user-authorized scope.
