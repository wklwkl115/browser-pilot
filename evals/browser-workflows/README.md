# Browser Workflow ACI Evals

These evals measure agent-computer-interface quality for `pi-browser-tools` workflows. They are not callable tools and do not change runtime behavior.

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
- `28-mcp-network-request-handle.md`
- `29-mcp-middleware-coverage.md`

Use `spec-template.md` for new workflow evals. Fixture requirements live under `fixtures/README.md`.

`manifest.json` lists the eval suite for manual execution or a future runner. It is intentionally inert: it must not start a browser, open network sockets, or run scanners. Use `manual-result-template.json` to record hand-run evidence.

`future-runner.md` freezes the opt-in boundary for any later runner or fixture server. It is documentation only; the current suite remains static/manual.

`result-schema.json` defines the compact manual result record shape. Optional hand-run results belong under `results/` and should reference artifacts by path instead of pasting raw browser evidence.

`jshook-closure-ledger.md` maps TODO 241.2 jshookmcp capability classes to eval specs and closure states. It is a planning/evidence ledger only, not a tool contract.
