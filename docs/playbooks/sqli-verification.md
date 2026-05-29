# SQLi Verification

## Trigger

Use when a URL, captured request, parameter, header, cookie, JSON/form/multipart field, or response suggests SQL injection: SQL errors, quote sensitivity, boolean differences, time delays, UNION behavior, database-specific text, login bypass suspicion, or user request to check SQLi.

## Inputs

- URL, raw request, captured request, or HAR entry.
- Candidate parameter names and locations when known.
- Auth requirements and scope limits.
- Probe family requested: boolean, error, time, union, or all.

## Route

1. Capture or build the request through the request capture and replay playbook.
2. Run a baseline replay with `browser_http_replay compareBaseline:true` when the request was captured from browser state.
3. Run `browser_sqli_probe`:
   - pass `url`, `rawRequest`, or captured `request`
   - set `paramNames` when known
   - set `locations`, `probeTypes`, `payloadMode`, `maxCases`, `timeoutMs`
   - set `bindBrowserSession:true` when browser cookies are needed
   - set `stopOnFirstMatch:true` for quick confirmation or false-positive reduction
   - set `outputPath` for evidence
4. If the oracle is confirmed and deeper enumeration is explicitly useful, run `browser_sqlmap_bridge` with bounded `paramNames`, `technique`, `level`, `risk`, `timeoutMs`, and artifact output.
5. Read probe/sqlmap artifacts with `browser_artifact`; extract matched payload, response delta, DBMS hints, and request template.

## Evidence

A reportable SQLi finding needs at least one stable oracle:
- boolean: true/false payload pair causes consistent body/status/length/content difference;
- error: injected payload triggers database-specific error not present in baseline;
- time: elapsed delta exceeds threshold and repeats;
- union/order: column count or reflected UNION position is evidenced.

Record:
- request template or `requestId`;
- parameter/location;
- payload family, not a large payload dump;
- baseline vs injected delta;
- DBMS hint if present;
- artifact path.

## Pivot

- No stable SQLi but parameter behavior changes -> `browser_fuzz_params`.
- WAF/rate-limit suspected -> reduce `maxCases`, split probe types, add `rateLimitPerSecond`, mark as inconclusive unless repeated.
- Auth/CSRF expiry -> recapture request and replay with browser cookies.
- UNION works but extraction is needed -> `browser_sqlmap_bridge` with narrow params.

## Stop

Do not report SQLi when only one noisy response differs, the baseline is unstable, the time delta is below threshold, the error is generic app validation, or payloads are blocked before reaching the app.
