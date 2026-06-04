# Browser Workflow Eval Runner Boundary

This document freezes the boundary for the opt-in runner and fixture server for `evals/browser-workflows/`. It started as a future-runner boundary note; `runner.mjs` now implements the explicit opt-in path while preserving the same default-safety constraints.

## Current status

- Specs, fixtures, manifest, manual result template, and opt-in runner are present.
- `check:eval-workflows` validates static structure and local-safe constraints.
- `npm run eval:browser-workflows -- --fixture-server` starts the runner explicitly and writes schema-compatible results.
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

The runner may be invoked only as an explicit command such as `npm run eval:browser-workflows -- --fixture-server` or by directly running `evals/browser-workflows/runner.mjs`. It must:

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

- The runner document and opt-in runner script exist.
- `manifest.json` remains local-safe while included in `npm run check`.
- Spec text, manifest fixtures, primary tools, and evidence labels stay aligned.
- Fixture files contain no external HTTP(S) URLs or obvious secret-like material.
- Any runner script contains explicit opt-in wording and does not appear in the default `check` script unless guarded as static-only.

## Activation record

The runner activation records:

- exact command name and default behavior: `npm run eval:browser-workflows`, refuses to run without `--fixture-server`;
- server route table and port lifecycle: see fixture server boundary above, ephemeral port printed in summary, closed on exit;
- result schema path: `evals/browser-workflows/result-schema.json`;
- cleanup and timeout behavior: temp profile/extension removed unless `--keep-temp`; per-eval `--timeout-ms` applies;
- verification commands: `npm run check:eval-workflows`; runtime smoke via `npm run eval:browser-workflows -- --fixture-server --eval 01-readable-content-artifact` or the default full manifest suite;
- rollback plan: remove `eval:browser-workflows` script and `runner.mjs`; static specs/manual results remain valid.
