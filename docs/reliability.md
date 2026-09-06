# Reliability and recovery

## Writes and verification

Execution receipts, assertions and business outcomes are independent. `verification.status: "verified"` means only the supplied assertion holds, including an assertion that a failure UI appeared. Writes expose `operationId`, `execution`, and `business`; without explicit business conditions the outcome stays `unknown`. See [operation outcomes](operation-outcomes.md) for declarative conditions, evidence boundaries, and the read-only `browser_operation` continuation tool.

`effect.settled` describes a short interval of page stability, not completion of background requests. Retryable `expect` checks use a five-second observation budget by default, configurable with bounded `verificationWaitMs` and capped by the operation deadline. A terminal non-retryable result or cancellation ends assertion polling earlier; declared business conditions may still need observation.

`unmet` and `inconclusive` do not undo a write. Inspect business state before retrying; for work exceeding the budget, follow up with an explicit wait. Script timeouts and unknown execution outcomes are not replayed through another executor. CDP fallback is allowed when the initial page-world eval is explicitly blocked before user code starts, not when user code throws a CSP-like error after a side effect. Page security headers remain unchanged.

## Extension updates

The installer copies and validates the package in a private sibling staging directory before replacing the installed extension. It keeps the previous directory until activation and pairing persistence succeed, and restores it on a detected failure. Pairing files use temporary-file replacement instead of truncating the live secret. A valid existing secret is reused so reinstalling one browser does not invalidate another paired browser.

Concurrent installers sharing a state directory are rejected by `extension-install.lock`. Browser-page launch failure happens after installation; the paired extension remains installed and the error provides the path to load manually.

This is rollback on reported errors, not a crash-proof transaction across two filesystem objects. If the process is killed or the machine loses power:

1. Confirm no installer is still running; inspect the PID in `extension-install.lock`.
2. Inspect any `.browser-pilot-install-*` sibling directory. If rollback failed, its `previous/` directory is retained for recovery; do not delete it before checking the installed state.
3. Restore or reinstall deliberately, then reload the extension. Remove an abandoned lock only after confirming its owner is gone.

Custom installation paths must not overlap the source, be symbolic links, or contain their own pairing-state directory. Windows file locks can still prevent activation/rollback; recovery files are retained rather than silently deleted.

## Evidence handling

Network and page evidence is unredacted and manually retained. Use trusted MCP clients, keep `.browser-pilot/` and `.cache/` out of commits, and review artifacts before sharing them. Pairing authentication is not a data-redaction or permission-isolation layer.
