# Repo Governance

This is the single contributor entry point for repo workflow rules and validation gates; other contributor-facing docs should point here instead of restating them.
Keep changes biased toward deletion, behavior preservation, and one canonical source of truth per workflow.

## Canonical Gates

- Use `mise run dev` for the normal local developer gate.
- Use `mise run affected` when you want changed-file validation with the repo's deterministic fallback.
- Use `mise run verify` before claiming completion; it is the release-readiness gate and already includes reachability audit, main/test/extension typecheck, required native build/parity, tests, coverage, lint, and build.
- Use `mise run smoke-browser` after changing bridge/daemon/extension/live-browser behavior. It launches an installed Chrome/Edge/Chromium with the unpacked MV3 extension and verifies handshake, tabs, execute, observe, network capture, and extension reconnect; Windows CI runs the same acceptance gate.
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
