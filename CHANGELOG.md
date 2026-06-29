# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-06-14

### Added

- **`browser-pilot` CLI** — full shell frontend for all 22 browser tools. Auto-starting
  user-local daemon, `connect --wait` readiness gate, natural subcommands
  (`wait selector`, `network start`, `frame evaluate`, `hook install-targets`),
  `--script-file` / `@file` for large inputs, `--json` machine output.
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
