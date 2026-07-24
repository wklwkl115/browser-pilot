# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.0] - 2026-07-24

### Breaking

- The bridge now accepts exactly one browser instance at a time. Same-instance reconnects and current-build replacement of a stale extension remain automatic; `browser_tabs selectBrowser` and its `browserId` parameter were removed.
- Removed browser approval, agent pairing tokens, `browser_pair`, consent messages, and pairing persistence; MCP clients now invoke the user-local daemon directly.
- Removed runtime-control fields and lifecycle/discovery commands from the public native surface: `tabId`, `sessionId`, `timeoutMs`, `bridge_wake`, `persistent_cdp`, `hook.list_sessions`, `hook.list_targets`, and `hook.install_targets`. `hook.install` now requires and publishes its target ids directly. Raw CDP remains available as `cdp { method, params }`; Browser Pilot owns targeting, attach/recovery, and cleanup.
- Removed `browser_observe.browserSessionId`; browser selection is runtime-owned.
- Replaced the per-command CLI with a persistent stdio MCP server. `browser-pilot-mcp` is now the Agent entrypoint, and the daemon starts through its own private executable.
- Removed dormant durable request redelivery. Disconnects now report `delivery-unknown` or `inflight-unknown` instead of claiming an unacknowledged browser write is safe to retry.
- Removed the Web Security product line: `browser_crawl`, `browser_fuzz`, `browser_sqli`, `browser_template`, `browser_callback_oast`, `browser_cookie_analyze`, and `browser_http_replay` no longer exist.
- Removed `browser-operation/v2`, including semantic settlement, intent replay, continuation decisions, operation events, the global operation registry, fences, and completion evidence. State-changing commands retain target serialization, hard timeout, caller cancellation, bounded effect diagnostics, and explicit postcondition verification.
- Removed the public `browser_network`, `browser_hook`, `browser_frame`, and `browser_evidence` wrappers. Native operations now have one public entry point: `browser_command`.
- Removed `browser_execute` Program DSL. `browser_execute` now accepts JavaScript only; trusted input uses native commands through `browser_command`.
- Removed all explicit `browser_observe` modes, navigation, Readability, axe diagnostics, and provider telemetry. `browser_observe` now has one canonical `PageObservation` result.
- Removed `browser_observe.maxChars`, output-path controls, budget fitting, silent field omission, and public artifact paths. Observation content is delivered directly; additional semantic regions are immutable MCP resources.
- Removed public `browser_observe.baseline`, `baselineSnapshotId`, and `actionRef`. `diff:true` now selects the latest valid same-page snapshot internally.
- Removed the public `browser_artifact` tool and its path/mode/query/offset reader stack. Internal artifacts remain private snapshot and binary-resource storage.
- Replaced generic result distillation with direct JSON and mandatory model-facing redaction.
- Removed compatibility-only public surfaces: top-level `tabId` targeting, `includeBridgePerTab`, the `browser-result://` resource store, and obsolete negative contract tests. Public targeting now uses `targetRef`; ABML references use `bp-ref://`.
- `browser_execute` and `browser_command` success values now use the stable `{ result, effect?, verification? }` envelope instead of flattening command data into Browser Pilot metadata. Target-scoped ABML differences moved from top-level `diff` to `verification.diff`.
- Write verification is now a top-level canonical ABML `VerificationResult`; the former `effect.verification` string is removed, and a deadline-unmet postcondition is reported as `unmet` rather than the over-strong `failed`.

### Changed

- Renamed the npm distribution to `browser-pilot-mcp` because the unscoped `browser-pilot` package is owned by another project; the Browser Pilot product name and `browser-pilot-mcp` executable are unchanged.
- Removed the all-page dialog override and CSP-stripping rule; the extension no longer changes normal page confirmation behavior or removes page security headers.
- Added one deterministic `verify` gate for Node, extension, tests, lint, and unit contracts; pull requests run it on Ubuntu and Windows, while tagged releases additionally require a real Windows browser smoke and SHA-256 identity verification of the exact published tarball.
- `browser_execute` and tab-scoped `browser_command` writes now pin the selected target before dispatch and return bounded best-effort page-effect feedback from the same target transaction. Read-only execution remains zero-overhead, and unavailable page signals are reported as `changed:null` instead of false certainty.
- Closed every public `browser_command` command schema, enforced the shared protocol before browser startup and extension dispatch, published canonical command names only, and split native discovery into a compact index plus per-command detail resources.
- Observation frontiers now expose opaque `browser-pilot://observation/<token>` resources instead of artifact paths and JSON read instructions.
- `browser_observe` is now passive and uncached: it never scrolls the page while observing, and it never replays a prior rendered envelope with stale causal state.
- Restricted the WebSocket bridge to the extension ID derived from the packaged manifest key and removed the ineffective service-worker keepalive port.
- Daemon invocation cancellation now propagates from a disconnected control client through per-tab queues and bridge pending requests. A canceled queued write is never dispatched later.
- Persistent CDP now coalesces concurrent attaches per tab, enables independent domains concurrently and lazily, caches background focus-emulation setup per live session, and keeps execute fallback sessions warm instead of attaching and detaching for every background/CSP execution.
- MCP clients now validate and cache one contract-identical daemon, carry the contract on each private invoke, and retry only failures proven to occur before dispatch. Observation reuses its session fingerprint, trusts synchronized tabs before refreshing, and counts every bridge round trip including coherence retries.
- Element refs now preserve unique semantic identity across observations and rebind by live CSS, attributes, or role/name when dynamic pages replace captured nodes, while semantic mismatches, ambiguity, occlusion, and page replacement still fail closed.
- CDP precompilation now evaluates one-off scripts directly and compiles only scripts seen again. Hot-script tracking and compiled-script indexes are bounded, reducing the first-call round trips and preventing temporary JavaScript from growing an unbounded in-memory cache.
- `browser_observe` now reuses one bounded page census, omits unconsumed pseudo-DOM and frame-note scan fields, keeps truncated root content expandable, reads independent AX inputs concurrently, and runs structural diffs in-process instead of spawning a native helper.
- Daemon/bridge shutdown now closes lingering loopback keep-alive connections, terminates live extension sockets, waits for both WebSocket and HTTP listeners to close, and gives the foreground daemon a bounded terminal-exit fallback, so MCP or offscreen reconnects cannot hold a draining stale daemon past the managed replacement deadline.
- Browser identities now derive from stable extension-instance ids, while extension-owned tab identities persist in `chrome.storage.session` and transfer across `tabs.onReplaced`, keeping `targetRef` stable through daemon replacement and extension reconnect within the current browser runtime.
- `browser_execute` and tab-scoped `browser_command` accept structured ABML postconditions. Targeted DOM+Partial AX settlement returns the same entity-state diff used by observation under `verification.diff`, and successful `input.ref` actions feed their action context into the perception ledger for later causal attribution.

## [0.4.0] - 2026-07-12

### Breaking

- Removed the public `browser_wait` tool and CLI `wait` command, including its public schema, help, aliases, and recovery guidance. Internal selector/navigation/network-idle primitives remain runtime-only.
- Removed the public `browser_memory` tool and all built-in persistent knowledge state, including automatic observe recall/relevance augmentation, result-envelope memory planes, profile/secret storage, memory-specific parameters and environment switches, kernels, recovery codes, CLI help, and `.browser-pilot/memory/` persistence. Existing directories created by legacy releases are left untouched; current releases neither read nor manage them.
- Removed silent deprecated-parameter stripping and default legacy action aliases. Unknown, internal, removed, and illegal cross-field/action combinations now fail immediately with a complete structured issue list and CLI exit 2.
- Removed `browser_execute.monitor` and the former snapshot-plus-150ms `effect/settled` result model.
- CLI JSON artifact `readCommands` are now bounded structured placeholder templates with `pathRef` / `jsonPathRef`, rather than shell command strings containing actual paths. The actual saved path appears once in its artifact descriptor.
- Replaced command discovery with contract v3 only. `commands --json` now emits one compact `browser-pilot-command-catalog/v3` root and `schema <command> <action> --json` emits the closed `browser-pilot-command-schema/v3`; v2 catalog/schema output, repeated per-command flags/artifact prose, legacy action aliases, and verbose compatibility output are not emitted.
- Replaced canonical observe output with the single-root `browser-page-observation/v3` contract for inline, artifact, cache, full, delta, and re-anchor results. Removed the former nested observation wrapper, duplicated correlation/content/template/actionable planes, and the artifact observation mirror.
- Page-world scan output is now the strictly validated camelCase `browser-page-scan/v1` bundle. Legacy snake_case scan objects are rejected with `SCAN_BUNDLE_INVALID`, and an extension without `captureContractVersion:1` is rejected before observe with `EXTENSION_CONTRACT_MISMATCH` plus reload recovery.

### Added

- Added a canonical public action catalog that combines generated native action metadata with command-owned synthetic metadata. The one-shot raw action `captureReload` is now routed as canonical CLI `network capture-reload`; camelCase is not a CLI alias.
- Added exact daemon contract identity (`packageVersion`, daemon protocol, command-contract version/hash, and tool count) to live status and lock metadata. Managed reuse requires every field to match, and stale replacement fails explicitly with `DAEMON_REPLACEMENT_FAILED` when graceful drain cannot be proven.
- Added real page epochs propagated from the extension through bridge target state and content fingerprints. Observation baselines, session deltas, perception-ledger frames, and render cache now use `browserSessionId + tabId + targetGeneration + pageEpoch` identity and fail open to a full observation with `reanchorReason` when continuity is not proven.
- Added closed nested parameter schemas for every public network/hook/frame action and the command-owned `network capture-reload` action. Help, action schema, real CLI parsing, offline validation, daemon HTTP validation, normalized arguments, execution routing, and the contract hash now share the same action owner.
- Added a unified observation frontier for folded template instances, collection windows, content, and diagnostics. Reads are verified against the persisted artifact after writing; an unavailable block carries an explicit reason, and silent truncation is forbidden.
- Added the pure `ObserveProviderPlan`: core scan/structure and render/persist reserves precede optional I/O, causal/axe/Readability receive a deterministic 2:1:1 split, eligible providers run concurrently with independent deadlines, and bounded telemetry records plan/status/reason/reserved/actual time, bridge round trips, and cost.
- Added the shared pure `CostVector` owner (`chars`, UTF-8 `bytes`, `estimatedTokens`) for fact allocation, frontier fitting, provider telemetry, final rendering, and benchmarks. Final observation cost is an exact serialization fixed point.
- Added an immutable observation benchmark baseline extracted directly from Git object `1573380`. The release gate requires at least 25% median byte/token reduction, no per-fixture regression above 5%, exact costs, full required-fact recall, zero duplicate ownership/leakage, and verified frontier coverage.
- Added `mise run package-smoke`: it packs one tarball, enforces the file allowlist and hard size ceilings, installs the `.tgz` into an isolated project, and verifies ESM/declarations, CLI contract/schema/validation/status, extension assets, native source, and the JavaScript fallback.
- Added a tag-only release workflow. Ubuntu and Windows verify and install-smoke the package, Windows runs the complete real-browser gate, Ubuntu retains one SHA-256-verified tarball, and npm 11 publishes that exact download through OIDC trusted publishing with provenance and no long-lived token.
- Expanded the real Edge/Chrome smoke to require provider budget telemetry, BFCache back/forward identity, targeted frontier reads, real Prerender2 activation/replacement generation, and target close/new-target recovery without skips.

### Changed

- Observe/result `nextActions` now contain only actual recovery guidance. Browser Pilot no longer guesses `read(ref)`/`click(ref)` pseudo-actions from the first entity or duplicates optional artifact expansion already represented by `saved` and `artifact_hints`.
- Result middleware now derives artifact reads only from paths verified in the final persisted layout and keeps final `saved.bytes` / `saved.chars` descriptors equal to the actual file. Synthetic correlation reads were removed.
- Distilled envelope extreme fallback now honors the final character budget, retaining canonical observation markers, actionable errors, and compact saved evidence while dropping duplicate artifact metadata and low-density planes.
- CLI artifact guidance now emits safe inspect → paths → targeted-read templates with strict count/character budgets.
- CLI offline validation and daemon pre-execution validation now share the same reference-resolution, strict-key, schema, normalization, and pure semantic pipeline; successful validation returns the final normalized arguments.
- Daemon protocol is now 5 and command contract version is 3. The identity hash covers catalog/schema v3, every action-specific schema, PageObservation v3, page-scan v1, and native protocol metadata.

## [0.3.0] - 2026-06-14

### Added

- **`browser-pilot` CLI** — full shell frontend for the then-current browser tools. Auto-starting
  user-local daemon, `connect --wait` readiness gate, natural subcommands
  (`network start`, `frame evaluate`, `hook install-targets`),
  file-backed script input for large durable sources, and `--json` machine output.
- **Web security tool suite** — `browser_crawl`, `browser_fuzz` (path/vhost/param),
  `browser_sqli` (builtin + sqlmap bridge), `browser_template` (builtin + nuclei bridge),
  `browser_cookie_analyze` (Cookie/JWT/JWE/PASETO/Rails), `browser_http_replay`,
  `browser_callback_oast` (local OAST listener).
- **ABML perception layer** — AX/DOM entity fusion, structural diff (`treeDiff`),
  causal network attribution, template compression for large lists/tables,
  snapshot projection for O(change) re-observation, backendNodeId identity lattice.
  Internal substrate only — no public ABML tool surface.
- **Session delta** — repeated no-mode `browser_observe` on the same tab produces
  compact P-frames with `delta:"session"`; use `diff:true`, `baselineSnapshotId`, or
  `baselinePath` for explicit incremental comparison, reducing token cost for multi-step workflows.
- **Task-conditioned relevance** — URL cold-start, behavioral trace, and intent signals
  reorder scan results within salience ranks. Disabled with `BROWSER_PILOT_RELEVANCE=0`.
- **Browser memory** — local `.browser-pilot/memory/` store with auto-recall on
  `browser_observe` and explicit `browser_memory record/recall/read`.
- **Four pure-logic kernels** — capture (sense), abml-kernel (perceive), distill-core
  (express), memory-kernel (retain). Zero browser/Node dependencies, CI-boundary-locked.
- **Living tab sessions** — stable `tabHandle`/`targetRef` across tab replacements,
  MV3 service worker restarts, and extension reconnects.
- **Trusted event escape** — `browser_command` with `input.pointer`/`input.keys` for
  CDP physical input when JS `el.click()` is silently blocked by trusted-event gates.
- **Interception primitives** — response auto-fulfill, script replacement,
  request mutation via bridge commands.
- **WebSocket session primitives** — open/send/replay/wait/collect/close for
  interactive WebSocket testing.
- **Background tab execution fix** — `browser_execute` on non-foreground tabs uses CDP
  with `Emulation.setFocusEmulationEnabled` to bypass timer throttling.
- **Artifact structured reading** — `browser_artifact` supports JSON path, regex search,
  line/column windowing, multi-artifact search, and always returns valid JSON.
- **Cross-tool correlation** — `operationId`, `snapshotId`, `waitId` thread through
  observe → execute → wait → evidence → artifact for audit trails.
- **CI pipeline** — GitHub Actions with lint, source checks, bridge/unit tests,
  contract tests, package acceptance (`npm pack --dry-run`), and optional browser/release smoke.
- **860+ contract and unit tests** covering protocol, tools, boundaries, runtime
  fixtures, lifecycle, and governance gates.

### Changed

- Default observation renderer switched from `ladder` to `salience` (token-efficient
  fact allocation). Override with `BROWSER_PILOT_RENDERER=ladder`.
- Extension architecture migrated to ESM import graph with strict TypeScript,
  offscreen durable WebSocket transport, and Manifest V3 service worker.
- Bridge port range `18765-18784` with automatic first-free selection; multiple
  bridge servers can share one browser extension.
- Tool results default to `detailLevel:"summary"` with cookie/token/authorization
  redaction. Raw evidence saved to local `.browser-pilot/artifacts/`.

## [0.2.0] - 2026-05-18

### Added

- Initial web security tools (crawl, fuzz, sqli, template, cookie, http-replay, oast).
- Network body/postData capture with configurable MIME filters.
- HAR export with bounded URL filtering.
- Frame evaluation and new-document script injection.
- Screenshot with visible-tab PNG/JPEG fallback.
- Download via click/media/URL modes; upload via file input.

### Changed

- Unified `browser_observe` as the canonical observation tool (merged scan/content/html/text).
- `browser_execute` restricted to JavaScript only (removed experimental action arm).

## [0.1.0] - 2026-04-20

### Added

- Chrome extension with WebSocket bridge to Node.js server.
- Core tools: `browser_tabs`, `browser_observe`, `browser_execute`, `browser_wait`,
  `browser_network`, `browser_hook`, `browser_evidence`, `browser_artifact`.
- GA-style simplified DOM scanning with actionable element detection.
- Browser Pilot native extension integration.
