# Repo Governance

This is the single contributor entry point for repo workflow rules and validation gates; other contributor-facing docs should point here instead of restating them.
Keep changes biased toward deletion, behavior preservation, and one canonical source of truth per workflow.

## Canonical Gates

- Use `mise run dev` for the normal local developer gate.
- Use `mise run affected` when you want changed-file validation with the repo's deterministic fallback.
- Use `mise run verify` before claiming completion; it is the release-readiness gate and already includes reachability audit, main/test/extension typecheck, required native build/parity, tests, coverage, the exact complexity ratchet, lint, and build.
- Use `mise run smoke-browser` after changing bridge/daemon/extension/live-browser behavior. It launches an installed Chrome/Edge/Chromium with the unpacked MV3 extension and verifies handshake, tabs, execute, observe, network capture, hook install/collect/uninstall, and extension reconnect; Windows CI runs the same acceptance gate.
- Use `mise run dev-governance` when changing governance or workflow artifacts.
- Do not teach raw package-script gate commands in governance docs; `mise` is the canonical entrypoint.

## Child-Agent Workflow

- `scout`: gather codebase context, hotspots, and file-level evidence before edits.
- `planner`: turn that evidence into the smallest change set with explicit boundaries.
- `worker`: implement one bounded slice at a time after RED exists.
- `reviewer`: check for regressions, missing tests, and weak evidence before claiming done.
- `oracle`: use only for decision deadlocks or consistency checks that need a second pass.
- Keep the main thread for decisions and proof; delegate independent recon, review, and narrow implementation slices.

## Repository Boundaries

- Treat these as product entrypoints: `index.ts`, `src/apps/cli/bin.ts`, `src/apps/cli/main.ts`, `src/apps/daemon/server.ts`, the extension entry files under `src/bridge/extension/`, and `src/commands/webSecurity/browserNative/callbackOastWorker.mjs`.
- Treat `bridge/browser_pilot_bridge/` as packaged shell output and `dist/` as local build output. Edit source under `src/` and `capture-src/`, then rebuild through the canonical gates.
- Keep public surface changes explicit. Root `index.ts`, the CLI contract, and schema-derived native protocol files are not cleanup fodder.
- Current high-risk zones: `src/bridge/server/`, `src/apps/daemon/`, and `src/bridge/extension/service_worker/`.
- `tsconfig.json` excludes `src/bridge/extension/**`; that code is validated separately by `tsconfig.bridge-src.json` and ESLint's second project binding.

## Public Command Contract

- `src/commands/commandCatalog.ts` is the only public `browser_*` tool list. The public surface has no wait/sleep tool; selector, navigation, and network-idle observers are internal operation-supervisor primitives.
- Every public browser state-changing command must return `browser-operation/v1` and must have a command-specific completion resolver. Governance tests enumerate native protocol write commands and fail when a resolver is missing; acknowledgement or page quiet cannot produce `completed`.
- Every `withBrowserOperation()` call site must return through `browserOperationCommandResult()`. The root `browser-operation/v1` terminal contract stays inline; oversized completion/effect/diagnostic evidence is saved once, replaced by a bounded typed summary, and exposed through verified `saved.path` plus `artifact_hints` JSON paths.
- Artifact persistence is downstream of the browser terminal state and must fail open: a save error reports `ARTIFACT_SAVE_FAILED` and `replay:"do_not_retry"`, but it must never erase or rewrite the already-proven operation status or `completion.source`. A saved operation artifact must fit the artifact reader's byte ceiling before its path is published; the reader ceiling must remain above the default bridge payload ceiling.
- Read-only commands remain immediate. Write commands must arm `operation.begin` before dispatch, preserve target generation, and terminate as `completed`, `effect_observed`, `no_effect`, `stalled`, `ambiguous`, `target_lost`, `failed`, or `deadline`.
- Operation `continuation` is a compact safety decision, not a success claim. Page-state uncertainty uses `observe`; lost, closed, replaced, or fanned-out targets use `reacquire_target`; `inspect_diagnostics` is emitted only when diagnostics exist; non-page uncertainty without diagnostics uses a read-only `verify_command_state`; a compacted successful result uses `inspect_artifact`. None of these decisions may encourage blind replay of an acknowledged mutation.
- Result `nextActions` may expand only final artifact paths that were verified against the persisted layout. Final `saved.bytes` / `saved.chars` descriptors must match the bytes and characters actually persisted, and optional artifact expansion remains in `artifact_hints` rather than being synthesized from correlation IDs.
- The final rendered distilled envelope must honor its committed character budget. Under extreme pressure, retain canonical observation markers, actionable error state, the compact saved descriptor, and at most the required continuation before dropping duplicate diagnostics, artifact metadata, or structural planes.
- CLI artifact read metadata must use bounded placeholder templates and structured field references. Never interpolate an untrusted saved path, JSON path, or snapshot ID into a display shell command; retain the actual saved path once in its artifact descriptor.
- Public schema/help/Skill guidance must not reintroduce a post-action wait, sleep loop, compatibility alias, or optional transaction/monitor switch.
