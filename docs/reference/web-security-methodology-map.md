# Web Security Methodology Map

This reference maps common web-security signals to Pi Browser tool routes. Use playbooks for execution steps; use this file to choose the route when several bug families look plausible.

| Signal / task | Primary route | Follow-up |
|---|---|---|
| Unknown page or app behavior | `browser_observe mode=scan` | first-pass browser triage playbook |
| Headers, redirects, tech hints, known files | `browser_crawl {action:"fingerprint"}` | `browser_crawl`, `browser_template` |
| Hidden routes, APIs, forms, JS endpoints | `browser_crawl` | `browser_fuzz {mode:"path"}`, request replay |
| Path/file/extension discovery | `browser_fuzz {mode:"path"}` | `browser_template` |
| Host routing / vhost suspicion | `browser_fuzz {mode:"vhost"}` | `browser_crawl {action:"fingerprint"}` per host |
| Need exact request | `browser_network start/list/get/body` | `browser_http_replay` |
| Replay or mutation | `browser_http_replay` | `browser_fuzz`, SQLi/OAST/template routes |
| Parameter behavior / parser difference | `browser_fuzz {mode:"param"}` | evidence/reporting |
| SQL error/time/boolean/UNION signal | `browser_sqli` | `browser_sqli {engine:"sqlmap"}` |
| Exposure/config/CVE-shaped check | `browser_template` | `browser_template {engine:"nuclei"}` |
| Mature template pack needed | `browser_template {engine:"nuclei"}` | artifact read and manual verification |
| Cookie/JWT/JWE/session analysis | `browser_cookie_analyze` | claim replay via explicit replay target |
| Authz/IDOR request comparison | `browser_http_replay compareBaseline:true` | `browser_fuzz {mode:"param"}` |
| URL/webhook/fetch/import field | `browser_callback_oast` + `browser_http_replay` | SSRF/OAST playbook |
| Console/error/storage/websocket/crypto/DOM sink evidence | `browser_hook` | `browser_evidence`, `browser_artifact` |
| Visual proof | `browser_screenshot` | observe/replay evidence for report |
| Large evidence | `browser_artifact` | targeted `jsonPath`, `pick`, offset, or search |

## Finding confidence levels

- Confirmed: stable baseline-vs-mutated delta, clear oracle/callback/data exposure, scoped request, preserved artifact.
- Potential: interesting signal but blocked by WAF/rate limit/auth expiry/noisy baseline; needs one focused follow-up.
- No finding: no stable delta, no callback, no accepted mutation, or evidence only shows normal app validation.

## Anti-patterns

- Using `browser_execute` page `fetch` instead of `browser_http_replay` for request mutation.
- Running broad fuzzing without explicit scope, bounds, baseline filtering, and output artifact.
- Mixing `browser_fuzz` modes without explicit `mode` when one focused path/vhost/param route is sufficient.
- Reporting decoded JWT claims without server acceptance of a mutated/replayed token.
- Treating browser-origin callback as SSRF without server-side correlation.
- Reading whole artifacts when a `jsonPath`, `pick`, or bounded search is enough.
