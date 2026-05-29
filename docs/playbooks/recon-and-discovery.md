# Recon and Discovery

## Trigger

Use for discovering status, redirects, headers, technology hints, known files, routes, API endpoints, forms, JavaScript endpoints, source maps, service workers, paths, files, extensions, or virtual hosts.

## Inputs

- Explicit target `url` or bounded `urls`.
- Scope: same-origin only or specific allowed origins.
- Optional seed `paths`, wordlist, extensions, auth requirement, and rate limit.

## Route

1. Establish browser context when needed: `browser_tabs list` -> `browser_observe mode=scan` for current URL and visible app shape.
2. Baseline small scope with `browser_crawl {action:"fingerprint"}`:
   - use explicit `url`/`urls`/`paths`
   - include redirects, title, headers, tech hints, TLS/favicon only when useful
3. Discover app surface with `browser_crawl`:
   - set `maxDepth`, `maxPages`, `sameOrigin`, `knownFiles`, `extractJs`, `outputPath`
   - use `bindBrowserSession:true` only when authenticated discovery needs browser cookies
4. Discover hidden paths with `browser_fuzz {mode:"path"}`:
   - provide bounded `words`/`wordlistPath`, `extensions`, `appendSlash`, `filterBaseline:true`
   - set `maxCandidates`, `timeoutMs`, optional `rateLimitPerSecond`
5. Discover virtual hosts only when Host routing is in scope: `browser_fuzz {mode:"vhost"}` with explicit host candidates and baseline filtering.
6. Read saved results using `browser_artifact` with `jsonPath`, `pick`, or bounded search.

## Evidence

- For each interesting endpoint: URL, status, redirect, title, body hash/length, content type, discovered source.
- For fuzz hits: baseline comparison, status/body-size delta, title/hash difference, artifact path.
- For crawl hits: forms, methods, parameters, OpenAPI/GraphQL hints, source map or service-worker evidence.

## Pivot

- Endpoint has parameters/forms -> request capture and replay playbook, then `browser_fuzz {mode:"param"}`.
- Endpoint has SQL-like errors or DB behavior -> SQLi verification playbook.
- Endpoint exposes tokens/cookies/JWKS/session values -> auth/session playbook.
- Endpoint accepts URL/webhook/import/fetch fields -> SSRF/OAST playbook.
- Endpoint matches exposure/config template -> `browser_template`.

## Stop

Do not continue broad discovery when:
- target scope is unclear;
- baseline is noisy and not filtered;
- wordlist/candidate count is unbounded;
- results show only generic 404/403/wildcard responses without stable deltas.
