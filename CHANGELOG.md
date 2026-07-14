# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Breaking

- Removed the redundant secondary CLI script-input flag. `browser-pilot execute --script` is now the single JavaScript input surface and uniformly accepts inline source, `@file`, or stdin (`-`). Temporary JavaScript must remain memory-only: complex/generated source must use stdin, transient local script files are forbidden, and `@file` is reserved for durable source.
- Scripted `browser_execute` intents now require a `postcondition` predicate. A non-idempotent script can no longer use `intentId` while treating ordinary JavaScript resolution as business success.

### Changed

- `connect --wait` and `doctor --check` now reject a connected extension whose loaded build does not match the unpacked runtime, report `extension-stale`, and return an exact self-reload recovery command. Readiness waits past stale peers when multiple browsers share the bridge and promotes a current-build instance over a stale default. Incoming extension-owned `tabIdentity` is authoritative on reconnect, so a full extension reload invalidates its old handle immediately instead of deferring the change until the next daemon restart.
- `browser_execute --postcondition` is now a first-class business completion proof. It evaluates a read-only predicate immediately and on DOM mutations, returns `completed/script-postcondition-verified` only for `true` or `{verified:true}`, and settles failed/lost/timed-out proof as ambiguous while preserving action acknowledgement.
- Daemon invocation cancellation now propagates from a disconnected control client through operation deadlines, per-tab queues, bridge pending requests, and program frames. A canceled queued write is never dispatched later; an in-flight acknowledged write remains explicit at-most-once uncertainty, and abortable program delays cannot release subsequent mutation frames in the background.
- Physical `browser_execute` programs now preserve and aggregate frame acknowledgement, including ACK recovered from a failed frame transport. The fully expanded frame sequence is revalidated; a non-navigation/download physical transaction reaches `completed/program-verified` only through one final `eval` frame marked `verify:true` whose result is `true` or `{verified:true}`. Aborts, failed verification, and bounded frame summaries remain visible instead of being discarded.
- `browser_execute` now accepts a stable `intentId` for non-idempotent mutations. The intent and payload hashes are protected from ordinary operation TTL/capacity pruning for the daemon-process lifetime: completed same-payload intents reuse their prior outcome without dispatch, uncertain repeats and different-payload conflicts are blocked, and ledger saturation fails closed. Same-target writes are serialized across execute/native routes; an acknowledged unverified write requires a fresh same-page canonical observation that begins after settlement.
- Same- and replacement-socket extension `workerBootId` changes are now classified as service-worker restarts. Only active operations owned by the restarted browser instance receive observer-loss evidence, stale disconnect timestamps are not reused as restart latency, and acknowledgement recovered from disconnect diagnostics remains in the root operation outcome so result loss settles as ambiguous rather than safe replay.
- Persistent CDP now coalesces concurrent attaches per tab, arms independent operation domains concurrently, lazily enables domains, caches background focus-emulation setup per live session, and keeps execute fallback sessions warm instead of attaching and detaching for every background/CSP execution.
- CDP precompilation now evaluates one-off scripts directly and compiles only scripts seen again. Hot-script tracking and compiled-script indexes are bounded, reducing the first-call round trips and preventing temporary JavaScript from growing an unbounded in-memory cache.
- Daemon/bridge shutdown now closes lingering loopback keep-alive connections, terminates live extension sockets, waits for both WebSocket and HTTP listeners to close, and gives the foreground daemon a bounded terminal-exit fallback, so CLI or offscreen reconnects cannot hold a draining stale daemon past the managed replacement deadline.
- Command-owned CLI routing now exposes canonical `tabs list` / `tabs snapshot` / `tabs switch` / `tabs create` / `tabs close` and `artifact inspect` / `artifact paths` / `artifact json` subcommands. Help, catalog references, route-specific schema, offline validation, invocation parsing, and the contract hash derive from the same route metadata.
- Browser identities now derive from stable extension-instance ids, while extension-owned tab identities persist in `chrome.storage.session` and transfer across `tabs.onReplaced`, keeping `targetRef` stable through daemon replacement and extension reconnect within the current browser runtime.

## [0.4.0] - 2026-07-12

### Breaking

- Removed the public `browser_wait` tool and CLI `wait` command, including its public schema, help, aliases, and recovery guidance. Internal selector/navigation/network-idle primitives now serve the operation supervisor only.
- Removed the public `browser_memory` tool and all built-in persistent knowledge state, including automatic observe recall/relevance augmentation, result-envelope memory planes, profile/secret storage, memory-specific parameters and environment switches, kernels, recovery codes, CLI help, and `.browser-pilot/memory/` persistence. Existing directories created by legacy releases are left untouched; current releases neither read nor manage them.
- All browser state-changing core commands now run as a single event-driven transaction and return `browser-operation/v2`. Listeners are armed before dispatch; `completed` requires command-specific mechanical evidence, while `effect_observed`, `no_effect`, `stalled`, `ambiguous`, `target_lost`, `failed`, and `deadline` report bounded factual terminal states.
- Operation v2 makes `completed` the only success (`classification:"success"`, `completionVerified:true`, `ok:true`, CLI exit 0). All other terminal states are explicitly inconclusive or failure, carry stable `OPERATION_*` codes, and return CLI exit 1; v1 is not emitted alongside v2.
- Removed silent deprecated-parameter stripping and default legacy action aliases. Unknown, internal, removed, and illegal cross-field/action combinations now fail immediately with a complete structured issue list and CLI exit 2.
- Removed `browser_execute.monitor` and the former snapshot-plus-150ms `effect/settled` result model. JavaScript with a non-`undefined` resolved value returns `completed/script-resolved`; physical programs without an observed effect return `no_effect`.
- CLI JSON artifact `readCommands` are now bounded structured placeholder templates with `pathRef` / `jsonPathRef`, rather than shell command strings containing actual paths. The actual saved path appears once in its artifact descriptor.
- Replaced command discovery with contract v3 only. `commands --json` now emits one compact `browser-pilot-command-catalog/v3` root and `schema <command> <action> --json` emits the closed `browser-pilot-command-schema/v3`; v2 catalog/schema output, repeated per-command flags/artifact prose, legacy action aliases, and verbose compatibility output are not emitted.
- Replaced canonical observe output with the single-root `browser-page-observation/v3` contract for inline, artifact, cache, full, delta, and re-anchor results. Removed the former nested observation wrapper, duplicated correlation/content/template/actionable planes, and the artifact observation mirror.
- Page-world scan output is now the strictly validated camelCase `browser-page-scan/v1` bundle. Legacy snake_case scan objects are rejected with `SCAN_BUNDLE_INVALID`, and an extension without `captureContractVersion:1` is rejected before observe with `EXTENSION_CONTRACT_MISMATCH` plus reload recovery.

### Added

- Added the daemon operation ledger with bounded sequenced events, five-minute active/terminal retention, owner/session-isolated late-effect surfacing, and a 30-second passive late-effect window.
- Added internal `operation.begin`, `operation.finish`, and `operation.cancel` protocol commands plus extension `operation_event` messages for tab/navigation/download/dialog/network/DOM/target lifecycle evidence.
- Added a compact, domain-aware `continuation` decision to terminal browser operations: page uncertainty observes, target loss/close/fan-out reacquires, present diagnostics are inspected, non-page uncertainty uses read-only command-state verification, and compacted successful results inspect their artifact without blindly replaying acknowledged mutations.
- Added artifact-backed progressive disclosure for every state-changing `browser-operation/v2` result. Oversized completion/effect/diagnostic evidence is saved once and replaced inline by a typed bounded summary with verified `artifact_hints` JSON paths.
- Operation artifact persistence now fails open: `ARTIFACT_SAVE_FAILED` reports unavailable large evidence without replacing the already-proven browser terminal status, and explicitly forbids replaying the mutation to recreate an artifact.
- Artifact reads now allow 40 MiB, above the default 32 MiB bridge frame; operation persistence preflights the final UTF-8 size and never publishes a path the reader would reject.
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
- Expanded the real Edge/Chrome smoke to require provider budget telemetry, completion-event waiter latency, BFCache back/forward identity, targeted frontier reads, real Prerender2 activation/replacement generation, and target close/new-target recovery without skips.

### Changed

- Observe/result `nextActions` now contain only actual recovery or continuation guidance. Browser Pilot no longer guesses `read(ref)`/`click(ref)` pseudo-actions from the first entity or duplicates optional artifact expansion already represented by `saved` and `artifact_hints`.
- Result middleware now derives artifact reads only from paths verified in the final persisted layout and keeps final `saved.bytes` / `saved.chars` descriptors equal to the actual file. Synthetic correlation reads were removed.
- Distilled envelope extreme fallback now honors the final character budget, retaining canonical observation markers, actionable errors, compact saved evidence, and required continuation while dropping duplicate artifact metadata and low-density planes.
- CLI artifact guidance now emits safe inspect → paths → targeted-read templates with strict count/character budgets, and human rendering exposes direct `browser-operation/v2` classification, status, completion verification, continuation, and artifact information instead of printing an empty line.
- CLI offline validation and daemon pre-execution validation now share the same reference-resolution, strict-key, schema, normalization, and pure semantic pipeline; successful validation returns the final normalized arguments.
- Daemon protocol is now 5 and command contract version is 3. The identity hash covers catalog/schema v3, every action-specific schema, PageObservation v3, page-scan v1, operation v2, and native protocol metadata.
- Operation settlement no longer polls at 25ms. Monotonic revisions and one-shot waiters wake on operation events or the next pure liveness boundary, and all finish/abort/reconnect/replacement paths release listeners and timers.
- Extension operation events are bound to the exact WebSocket that armed each operation, preventing completion evidence from being sent to a stale offscreen socket after reconnect. Prerender2 browsers that retain the numeric tab id now report a real activation as a same-tab target-generation replacement; browsers that emit `tabs.onReplaced` continue through the native replacement path.

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
