# Eval 11: jshook Runtime Hook Targets

## Goal

Observe page-side runtime sink calls from a local fixture and decide whether existing `browser_hook` flow is sufficient or a bounded hook target enhancement is justified.

## Fixture

- Local target: `fixtures/jshook-runtime-sinks.html`
- Required files: page with buttons that call `eval`, `Function`, string timers, `postMessage`, `localStorage`, `sessionStorage`, `WebSocket` constructor fallback path, and DOM sink writes.
- Setup notes: fixture actions must be deterministic and must not require outbound network; WebSocket construction may fail locally, but the constructor/send attempt remains observable.

## Allowed starting tools

- `browser_tabs`
- `browser_hook`
- `browser_execute`
- `browser_evidence`
- `browser_artifact`

## Expected tool sequence

1. Start from explicit tab/session state with `browser_tabs`.
2. Install only explicit page-side hooks with `browser_hook`; avoid strategy bundles or unbounded automatic instrumentation.
3. Trigger the fixture buttons with `browser_execute`.
4. Collect hook events and aggregate `hook-events` through `browser_evidence`.
5. Read large event buffers through `browser_artifact` if summary evidence is insufficient.

## Success criteria

- Runtime sink invocations are observed with function name, argument preview or redacted value, timestamp/sequence, and target tab metadata.
- The flow reports whether current custom hook installation is enough or whether static `expanded-targets` would reduce tool calls and error rate.
- No passive network observation is replaced by fetch/XHR monkeypatching.

## Required evidence

- Summary evidence: `hook-events` count grouped by sink class.
- Artifact evidence: bounded hook event `artifact` path when events exceed summary budget.
- Diagnostics evidence: installed listener/session ids, dispatcher version, cleanup/uninstall result, and proposed `expanded-targets` if enhancement is needed.

## Recovery checks

- Expected failure mode: hook code misses a sink or emits too much payload.
- Required recovery path: narrow the hook target list, keep redaction enabled, reinstall explicitly, and verify cleanup before retrying.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after missed hook target or noisy payload
- artifact sufficiency
- scoped follow-up discipline

## Capability closure classification

- Classification: needs hook enhancement only if manual hook installation requires repeated custom JS or produces inconsistent cleanup diagnostics.
- Canonical surface: `browser_hook` with `browser_evidence` and `browser_artifact`.
- Closure result: this eval must close as either `existing browser_hook flow sufficient` or `bounded static hook targets required`; it must not create a new public tool.
