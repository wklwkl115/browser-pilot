# Browser Workflow Fixtures

Fixtures in this directory must be local, deterministic, synthetic, and safe to commit.

## Planned fixtures

- `article.html`: article page with title, byline, body, navigation noise, and footer noise.
- `interactive.html`: deterministic UI state change for scan/execute/wait and lease-conflict evals.
- `network.html`: page that triggers a same-origin JSON request against a local fixture server.
- `selector-recovery.html`: page with a misleading absent selector and a discoverable correct selector.
- `download.html`: page linking to `files/report.txt`.
- `files/report.txt`: deterministic downloaded text file.
- `wait-timeout.html`: page with one present selector and one absent selector.
- `intercept-response.html`: deterministic Fetch interception fixture for synthetic fulfilled response replacement.
- `intercept-script-loader.html`, `assets.intercept-target.js.txt`: deterministic script-replacement fixture for synthetic JS response substitution.
- `cookies.json`: synthetic Cookie/Set-Cookie/JWT samples; no production secrets.
- `jshook-runtime-sinks.html`: synthetic runtime sink calls for hook target evaluation.
- `jshook-source-map.html`, `jshook/bundle.js`, `jshook/bundle.js.map`: synthetic source-map discovery fixture.
- `jshook-storage.html`: synthetic localStorage/sessionStorage/IndexedDB state fixture.
- `jshook-replay.html`: deterministic captured-request/replay fixture for non-live-intercept evaluation.
- `jshook-canvas.html`: synthetic canvas scene metadata and visual evidence fixture.
- `scan-high-entropy.html`: synthetic scan summary quality fixture with forms, repeated lists, status text, and primary actions.
- `debugger-evidence.html`: synthetic debugger-evidence fixture for one-shot CDP / artifact / RFC-only workflow evaluation.
- `debugger-provenance.html`, `debugger/provenance-helper.js`: synthetic authored-script provenance fixture for helper-script URL/source correlation.
- `debugger-pause.html`: synthetic pause-lifecycle fixture with a deterministic ticking state.
- `debugger-navigation.html`: synthetic navigation/reload recovery fixture for stale-state diagnostics.
- `js-ast-minified.js`: synthetic minified-but-readable JS fixture for bounded AST facts and suspicious-pattern summaries.
- `js-ast-malformed.js`: synthetic malformed JS fixture for bounded parse failure diagnostics.
- `js-ast-reduction.js`: synthetic deterministic string-array reduction fixture for readable preview checks.
- `js-ast-patterns.js`: synthetic decoder-alias and object-dispatch fixture for second-batch suspicious-pattern summaries.
- `js-ast-constant-folding.js`: synthetic deterministic constant-folding fixture for narrow readable reduction checks.
- `js-ast-decoder-inline.js`: synthetic deterministic decoder-inline fixture for narrow readable reduction checks.
- `js-ast-alias-propagation.js`: synthetic const-alias propagation fixture for deterministic readability reduction.
- `js-ast-object-dispatch.js`: synthetic object-dispatch fixture for deterministic readability reduction.
- `dom-flow-listeners.html`: synthetic DOM listener/source/sink fixture for explicit node listener extraction and compact handler-chain evidence.
- `wasm-minimal.wat`, `wasm-minimal.wasm`: synthetic Wasm fixture pair for bounded module metadata extraction and later bridge/WAT validation.

## Rules

- Do not require external network access.
- Do not include real tokens, credentials, cookies, or private data.
- Keep payloads small enough for bounded artifact reads.
- SQLi fixtures must be local simulations, not real database exploitation targets.
- OAST/bridge/scanner evals must use bounded local fixtures and explicit scope.
