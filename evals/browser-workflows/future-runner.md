# Browser Workflow Eval Runner Boundary

This document freezes the boundary for the opt-in runner and fixture server for `evals/browser-workflows/`. It started as a future-runner boundary note; `runner.mjs` now implements the explicit opt-in path while preserving the same default-safety constraints.

## Current status

- Specs, fixtures, manifest, manual result template, and opt-in runner are present.
- `check:eval-workflows` validates static structure and local-safe constraints.
- `npm run eval:browser-workflows -- --fixture-server` starts the runner explicitly and writes schema-compatible results.
- No browser, server, scanner, callback listener, or external network is started by default.

## Non-goals

> Scope: these non-goals constrain the **deterministic runner** (`runner.mjs`) + its fixture server.
> The separate **blind-agent discovery layer** (see below) is an explicit `--confirm` opt-in that
> *deliberately* starts Chrome, uses the real network (real sites), and holds a transient isolated
> daemon — governed by its own boundary, not these. The one rule both share: never touch the
> operator's real browser, and never run inside `npm run check`.

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

## Blind-agent discovery layer (opt-in, real-site)

This realizes the browser-execution phase above as the project's standing real-agent **discovery**
loop (complementing the deterministic runner's regression role). Driven by the `pi-browser-blind-eval`
skill; scripts: `launch-blind.mjs` / `pb-blind.mjs` / `teardown-blind.mjs`; prompt `blind-agent-prompt.md`;
targets `blind-tasks-realsite.md`; backlog `blind-findings.md`. Its boundary:

- **Explicit opt-in.** `launch-blind.mjs` refuses to run without `--confirm` (it starts a browser).
- **Isolated daemon, never the operator's browser.** A dedicated `PI_BROWSER_DAEMON_STATE_DIR` + a
  forced bridge port (18801+, above the default 18765–18784) gives the stage its own user-local
  daemon. The blind agent drives it ONLY via `pb-blind.mjs`, which pins it to that state dir — it
  cannot see or act on the operator's real browser. Verify isolation (stage daemon lists only its own
  tab) before fanning out.
- **Real sites, real network — by design.** Unlike the deterministic runner, blind eval targets REAL
  websites (the deterministic runner stays fixture-only). Targets must be **mainland-China reachable**
  (the agent's network); pre-flight with `observe` (reject `chrome-error://`). Real-site actions are
  **READ-ONLY** (no login/submit/post).
- **Transient, torn down.** The stage holds a daemon + browser only for the run; `teardown-blind.mjs`
  (`daemon stop` on the isolated state dir + hard-kill pids + remove temp) must always run. Temp lives
  under `.pi/temp-profiles/` and is never packaged.
- **Skill-guided, implementation-blind.** The agent reads `skills/pi-browser-tools/SKILL.md` as its
  guide; it must NOT read tool implementation source. Findings are triaged `fixable | WAI | reliability`
  (+ skill↔tool fidelity); execution-authoring friction is WAI by project decision.
- **Not in `npm run check`.** It is operator-/cron-driven, never part of the default check.

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
