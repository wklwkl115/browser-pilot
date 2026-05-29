# Request Capture and Replay

## Trigger

Use when the task asks to inspect requests, replay an action, compare responses, mutate method/header/body, verify authorization, test parser differences, or reproduce a finding from HAR/raw/captured HTTP traffic.

## Inputs

- Target tab/URL or existing raw request/HAR/captured request.
- Relevant action in the page, or request URL/method/body to replay.
- Mutation goal: auth removal, ID change, method change, header change, JSON/form/multipart/body change, sequence replay.

## Route

1. `browser_tabs action=list`; keep `tabId`.
2. `browser_network start` before performing the browser action.
3. Perform action with `browser_execute` or user interaction; use `browser_wait` for completion.
4. `browser_network list`; identify relevant `requestId` by URL/method/type/status.
5. `browser_network get` and `browser_network body` when needed; export HAR for multi-step flows.
6. Replay baseline with `browser_http_replay`:
   - pass captured request/raw request/HAR entry
   - set `compareBaseline:true` for mutation work
   - set `bindBrowserSession:true` only when cookies from the browser session are required
   - set `outputPath` for non-trivial evidence
7. Apply one mutation class at a time through `browser_http_replay` or route to a specialized tool:
   - params -> `browser_fuzz_params`
   - SQLi -> `browser_sqli_probe`
   - templates/exposures -> `browser_template_check`
8. Read replay artifacts with `browser_artifact`.

## Evidence

- Original request: method, URL, headers summary, parameter/body shape, auth state, `requestId`.
- Baseline response: status, length/hash/title/body snippet, timing if relevant.
- Mutation delta: exact changed field, response delta, stable reproduction count if repeated.
- Artifact path for raw request/replay result/HAR.

## Pivot

- Mutation changes authorization outcome -> evidence/reporting playbook.
- Parameter deltas appear but not classifiable -> `browser_fuzz_params` with small value set.
- Time/error/boolean response appears -> SQLi verification playbook.
- URL fetch/webhook/internal target field appears -> SSRF/OAST playbook.
- Needs browser-rendered effect -> replay request, then re-observe page or hook/network evidence.

## Stop

Do not report a finding when the mutated response differs only by volatile fields, rate limits, CSRF expiry, cache state, or unauthenticated redirect noise. Rebuild baseline or repeat with a fresh captured request first.
