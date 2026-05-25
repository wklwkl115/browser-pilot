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

Use `spec-template.md` for new workflow evals. Fixture requirements live under `fixtures/README.md`.

`manifest.json` lists the eval suite for manual execution or a future runner. It is intentionally inert: it must not start a browser, open network sockets, or run scanners. Use `manual-result-template.json` to record hand-run evidence.

`future-runner.md` freezes the opt-in boundary for any later runner or fixture server. It is documentation only; the current suite remains static/manual.

`result-schema.json` defines the compact manual result record shape. Optional hand-run results belong under `results/` and should reference artifacts by path instead of pasting raw browser evidence.
