# SSRF and OAST Proof

## Trigger

Use when an app accepts URLs, webhooks, import/fetch fields, avatar/image/PDF generation inputs, XML external entities, template callbacks, DNS names, SMTP/FTP/Gopher-like targets, or any blind injection that requires out-of-band proof.

## Inputs

- Explicit target request or page action that sends attacker-controlled URL/host/payload to the server.
- Allowed callback mode: HTTP, HTTPS, DNS.
- Scope and rate limits.

## Route

1. Capture the normal request using the request capture and replay playbook.
2. Start callback listener with `browser_callback_oast start`:
   - choose `mode` needs via `enableHttps` or `enableDns`
   - set `correlationId`, `maxEvents`, `maxBodyBytes`
   - include `publicBaseUrl`/`publicDnsBaseDomain` only when externally reachable values are available
3. Inject callback URL/host through the smallest path:
   - browser form action via `browser_execute`, or
   - request mutation via `browser_http_replay`
4. Use `browser_callback_oast collect` with the session ID; read saved callback artifacts if present.
5. Stop the listener with `browser_callback_oast stop` when done.
6. If callback proves reachability but impact is unclear, replay targeted internal-safe checks only within scope.

## Evidence

- Listener `sessionId` and correlation ID.
- Injected field and request/template used.
- Callback event: protocol, method/query/path/host, source metadata when available, timestamp, body size.
- Replay/action artifact path.

## Pivot

- HTTP callback received -> confirm server-side fetch behavior; test method/header/body control only if scoped.
- DNS callback only -> report blind DNS interaction or continue with HTTP callback if feasible.
- No callback but response changes -> use `browser_http_replay` and `browser_fuzz {mode:"param"}` to isolate parser behavior.
- XML body accepted -> consider XXE-shaped template check or custom replay payload.
- URL parser discrepancy suspected -> test one mutation at a time and preserve baseline deltas.

## Stop

Do not report SSRF/OAST when:
- only the browser made the callback;
- callback cannot be correlated to the injected request;
- listener was not externally reachable;
- payload was reflected client-side but no server-side request occurred;
- target scope does not allow internal probing.
