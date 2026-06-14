# Browser Workflow ACI Evals

These evals measure agent-computer-interface quality for `pi-browser-tools` workflows. They are not callable tools and do not change runtime behavior.

## Two layers

1. **Deterministic regression runner** — `runner.mjs` (`npm run eval:browser-workflows -- --fixture-server`).
   Replays human-authored tool sequences against the **local fixtures** below and asserts. Guards
   against regressions; cheap and reproducible. Boundary frozen in `future-runner.md`.
2. **Blind-agent discovery loop** — the standing real-agent friction finder (mature-maintenance
   optimization driver). A blind subagent reads the `pi-browser-tools` skill and works a task on a
   **real, mainland-China-reachable website** (READ-ONLY), then reports friction. Run via the
   `pi-browser-blind-eval` skill. Files: `launch-blind.mjs` / `pb-blind.mjs` / `teardown-blind.mjs`
   (`npm run eval:blind:launch -- --confirm --url <site>` / `npm run eval:blind:teardown`),
   `blind-agent-prompt.md` (prompt), `blind-tasks-realsite.md` (targets), `blind-findings.md` (rolling
   triaged backlog). Execution-feedback adoption uses the same harness against local isolated
   fixtures via `blind-tasks-execution-feedback.md` because those tasks intentionally mutate page
   state. Boundary in `future-runner.md` → "Blind-agent discovery layer". The spec files below are
   the deterministic layer's; ordinary blind discovery uses real sites, not these fixtures.
   `pb-blind.mjs` bounds each forwarded CLI call to 300000ms by default; set
   `PI_BROWSER_BLIND_CLI_TIMEOUT_MS=<positive-ms>` for a specific blind run when a different hard cap
   is needed.

## Eval format

Each eval should define:

- goal
- fixture or local target
- allowed starting tools
- expected tool sequence
- success criteria
- required evidence or artifact paths
- recovery checks
- metrics

## Metrics

- success or failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- whether scoped Web follow-up tools were used only after observation/capture/replay

## Spec files

- `01-readable-content-artifact.md`
- `02-scan-execute-wait.md`
- `03-network-capture-replay.md`
- `04-selector-missing-recovery.md`
- `05-download-artifact.md`
- `06-wait-timeout-diagnostics.md`
- `07-bounded-path-fuzz-baseline.md`
- `08-cookie-jwt-redaction.md`
- `09-sqli-probe-vs-bridge.md`
- `10-multi-session-lease-conflict.md`
- `11-jshook-runtime-hook-targets.md`
- `12-jshook-source-map-artifact.md`
- `13-jshook-storage-evidence.md`
- `14-jshook-replay-not-intercept.md`
- `15-jshook-canvas-observation.md`
- `16-scan-high-entropy-summary.md`
- `17-debugger-evidence-workflow.md`
- `18-debugger-script-provenance.md`
- `19-debugger-pause-lifecycle.md`
- `20-debugger-navigation-recovery.md`
- `21-cross-tool-correlation-chain.md`
- `22-js-ast-artifact-summary.md`
- `23-dom-flow-listener-chain.md`
- `24-dom-flow-sink-hints.md`
- `25-wasm-artifact-metadata.md`
- `26-wasm-wat-bridge.md`
- `27-websocket-session-transcript.md`
- `30-abml-internal-routing-evidence.md`
- `31-execution-plane-cdp-fusion.md`
- `32-abml-identity-bootstrap-evidence.md`
- `33-layer-paint-occlusion-boundary.md`
- `34-oopif-composite-key-boundary.md`

Use `spec-template.md` for new workflow evals. Fixture requirements live under `fixtures/README.md`.

`manifest.json` lists the eval suite for manual execution and for the opt-in runner. The manifest itself is intentionally inert: it must not start a browser, open network sockets, or run scanners. Use `manual-result-template.json` to record hand-run evidence.

`runner.mjs` is the explicit opt-in browser workflow runner. It starts a local-only fixture server and isolated browser only when invoked with `--fixture-server`:

```bash
npm run eval:browser-workflows -- --fixture-server
npm run eval:browser-workflows -- --fixture-server --eval 01-readable-content-artifact
```

The runner writes schema-compatible `*.result.json` files plus `browser-workflow-eval-summary.json` under `.pi/browser-artifacts/eval-browser-workflows/<run-id>/`. The default implemented suite now covers every manifest eval (`01`-`27` and `30`-`34`); result files remain runtime artifacts and are not required CI output.

`future-runner.md` records the original activation boundary and now serves as the runner boundary reference: explicit opt-in, local-only fixture server, ephemeral ports, isolated temp profile, no default scanner/OAST/external network.

`result-schema.json` defines the compact result record shape. Optional hand-run results belong under `results/` and should reference artifacts by path instead of pasting raw browser evidence.

`jshook-closure-ledger.md` maps TODO 241.2 jshookmcp capability classes to eval specs and closure states. It is a planning/evidence ledger only, not a tool contract.
