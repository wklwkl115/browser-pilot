# Future Browser Workflow Eval Runner

This document freezes the boundary for any future runner or fixture server for `evals/browser-workflows/`. The current suite is static and manual; this file is not an implementation plan for the current workstream.

## Current status

- Specs, fixtures, manifest, and manual result template are present.
- `check:eval-workflows` validates static structure and local-safe constraints.
- No browser, server, scanner, callback listener, or external network is started by default.

## Non-goals

- Do not add a callable `browser_*` tool.
- Do not run as part of `npm run check` unless the mode remains static-only.
- Do not start Chrome, connect to a user browser, or mutate existing browser sessions by default.
- Do not run sqlmap, nuclei, OAST listeners, or external scanners by default.
- Do not fetch external URLs or depend on internet access.
- Do not keep a long-lived server or reserve fixed ports.
- Do not replace the human ACI judgment metrics with only pass/fail assertions.

## Opt-in runner boundary

A future runner may be added only as an explicit command such as `npm run eval:browser-workflows -- --manual-fixtures` or a separate script under `evals/browser-workflows/`. It must:

- Require an explicit opt-in flag.
- Read `manifest.json` as the source of eval metadata.
- Write results that match `manual-result-template.json` shape.
- Use a temporary artifact directory for run output.
- Fail closed when a fixture or route is missing.
- Print the selected fixture port, artifact directory, and result path.
- Exit cleanly and close any fixture server it starts.

## Fixture server boundary

A future local fixture server may serve only files and deterministic endpoints under `fixtures/`:

- `GET /` redirects or maps to `article.html`.
- `GET /fixtures/*` serves fixture files with safe content types.
- `POST /api/echo` returns deterministic JSON/text for network replay evals.
- Path fuzz routes are generated only from `fixtures/path-fuzz-routes.json`.
- SQLi simulation reads `fixtures/sqli-request.txt` but must remain a deterministic mock, not a database-backed target.

Server constraints:

- Bind to `127.0.0.1` only.
- Use an ephemeral port by default.
- Reject path traversal and unknown fixture roots.
- Never proxy requests.
- Never make outbound network requests.
- Close on process exit and after the run deadline.

## Browser execution boundary

If a later phase adds browser automation, it must be opt-in and separate from static checks:

- Use an isolated browser session or explicit `browserSessionId`/`tabId`.
- Never rely on mutable active-tab fallback after the first observation.
- Preserve tool-call traces and artifact paths in result records.
- Record first wrong tool choice, recovery, artifact sufficiency, and scoped follow-up discipline.
- Treat scanner bridge usage as follow-up only after scoped request evidence exists.

## Static contract requirements

`check:eval-workflows` should remain cheap and deterministic. It may validate:

- The future runner document exists before any runner script is added.
- `manifest.json` remains local-safe while included in `npm run check`.
- Spec text, manifest fixtures, primary tools, and evidence labels stay aligned.
- Fixture files contain no external HTTP(S) URLs or obvious secret-like material.
- Any future runner script contains explicit opt-in wording and does not appear in the default `check` script unless guarded as static-only.

## Activation gate

Before implementing a runner or fixture server, update `CURRENT.md` with:

- exact command name and default behavior;
- server route table and port lifecycle;
- result schema path;
- cleanup and timeout behavior;
- verification commands;
- rollback plan.
