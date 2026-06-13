# Browser Tool Boundaries

This file defines the Semantic singleton boundary for each callable `browser_*` tool. Keep it aligned with `src/tools/register*.ts`, README, and the global `pi-browser-tools` skill.

Primary inputs are the tool parameters shown in `docs/generated/browser-tool-contract.generated.md`; this boundary file focuses on tool choice, evidence type, and follow-up flow.

## Primary workflow

1. `browser_tabs` establishes target and explicit `tabHandle`/`targetRef` (numeric `tabId` remains compatibility input).
2. Observe with `browser_observe mode=scan|content|html|text|tabs` (or omit mode when params deterministically imply content/html), `browser_screenshot`, or `browser_frame`.
3. Act with `browser_execute`, `browser_command`, `browser_upload`, `browser_download`, or `browser_wait`.
4. Capture evidence with `browser_network`, `browser_hook`, `browser_evidence`.
5. Read large or sensitive evidence with `browser_artifact`.
6. If a task succeeded, use `browser_memory` to persist or recall local reusable SOP/facts; durable evidence is recommended provenance, and any cited evidence must resolve.
7. Use Web Security tools only after baseline observation and explicit scoped inputs.

## jshookmcp capability migration boundary

jshookmcp research is treated as capability discovery only. Do not copy its AGPL code/text/schema/payloads/tests, do not import its MCP registry/runtime, and do not expose its tool names as Pi API. The public `browser_*` surface remains Semantic-singleton driven.

Rejected public tool names for this migration: `browser_sources`, `browser_debugger`, `browser_intercept`, `browser_storage`, `browser_canvas`.

Capability mapping:

| Capability class | Canonical Pi surface | Boundary |
|---|---|---|
| Page-side JS API observation, DOM sinks, console/error, storage/websocket/crypto/canvas events | `browser_hook` + `browser_evidence` + `browser_artifact` | Implement only as explicit hook targets or static preset expansion. `browser_hook` exposes `listTargets` / `installTargets` for bounded target expansion and diagnostics; no `all/auto/aggressive/ctf/exploit/stealth` strategy bundles. |
| One-shot runtime/debugger/storage/source reads or precise CDP calls | `browser_command` / `browser_frame` / `browser_execute` | Use `browser_command` for native bridge/CDP command objects and `browser_execute` for page JavaScript. Do not create a broad debugger/source/storage tool. Long-running observation belongs to hook/network. |
| Passive request/response/HAR capture | `browser_network` | Do not monkeypatch fetch/XHR for ordinary network observation. |
| Request replay, mutation, sequence, baseline deltas | `browser_http_replay` and follow-up Web Security tools | Do not mix replay/mutation into hook or create a live intercept Swiss-army tool. |
| JS endpoint, source map, service worker, OpenAPI/GraphQL discovery | `browser_crawl` + `browser_artifact` | Crawl remains bounded discovery. Large source/source-map data is artifact-first. |
| Large or sensitive evidence | `browser_artifact`; multi-source bundle via `browser_evidence` | Default redaction remains on; full local evidence requires targeted artifact reads. |

TODO 241 closure is tracked in `docs/jshookmcp-native-absorption.md`. Any future public tool in these areas requires a separate RFC with eval evidence, non-overlap proof against this table, contracts, budgets, summaries, README/skill updates, and runtime smoke artifacts.

Future frontend-reversing work is tracked only as RFC/eval problem areas, not as public tool commitments: `Debugger evidence workflow`, `deterministic runtime provenance/symbolization`, `scoped request intervention/replay gap`, `storage/service-worker evidence navigation`, `canvas/WebGL/Wasm observability`, and `multi-signal evidence correlation`. These areas must first map to existing canonical tools (`browser_execute`, `browser_command`, `browser_frame`, `browser_hook`, `browser_network`, `browser_http_replay`, `browser_crawl`, `browser_evidence`, `browser_artifact`). The rejected names `browser_sources`, `browser_debugger`, `browser_intercept`, `browser_storage`, and `browser_canvas` remain rejected by default, including synonymous replacement names. The archived next-phase plan at `docs/archive/next-phase-web-reversing-and-security-primitives-plan.md` is planning-only history and does not override this public-surface boundary.

## Observation mode boundary

`browser_observe` is the current canonical observation tool.
The former observation tools are historical implementation sources only; `browser_scan`,
`browser_content`, and `browser_html` are not current callable tools.

| Mode | Historical source | Boundary |
|---|---|---|
| `scan` | legacy `browser_scan` | Compact DOM/text perception, Scan Manifest v2, actionables, forms/lists/text signals, DOM-ordered visible rows, visible media candidates, collection completeness/continuation, same-origin iframe overview. |
| `content` | legacy `browser_content` | Readable Markdown extraction, optional URL navigation through durable wait supervisor, selector empty/miss/invalid semantics. |
| `html` | legacy `browser_html` | Native exact HTML/text snapshots through `html.get`, selector diagnostics, raw/inner/outer/text/fragment modes. |
| `text` | text-first observation shorthand | Uses the scan extraction path with text-first output and explicit `sourceMode`; it must not auto-select between scan/content/html. |
| `tabs` | legacy `browser_scan tabsOnly` convenience | Observation-only tab facts; it does not replace `browser_tabs` session/tab management. |

Hard rules:

- No `mode:"auto"`.
- No selector miss fallback across modes.
- `browser_screenshot` and `browser_frame` remain separate tools.
- `SELECTOR_NOT_FOUND`, `INVALID_SELECTOR`, content `empty:true`, durable navigation, and native `html.get` errors must remain stable.

## Runtime browser tools

ABML surface note: current public callable surface remains the documented `browser_*` tools.
Internal ABML refs and verb-like hints (`pi-ref://...`, `read(...)`, `click(...)`, `frame(...)`,
`read_saved_artifact ...`) are envelope/runtime semantics and recovery affordances, not additional
public Pi tool registrations. Public ABML action verbs are closed as a perception-first project
decision; reopening requires overturning that north star, not merely a new trigger-gated backlog
entry. Scroll/lazy-loading friction must first be treated as a collection-completeness,
continuation, data-source, or state-transition modeling gap; adding public gesture verbs only
reintroduces the human viewport loop into the agent surface.

| Tool | Purpose | Use when | Do not use when | Primary output/evidence | Follow-up |
|---|---|---|---|---|---|
| `browser_tabs` | Manage connected browsers, tabs, advanced browser sessions, and explicit runtime/snapshot diagnostics. | Start automation, list tabs, create/switch/close tabs, inspect active operations, or read explicit observation snapshot metadata. | Do not use as a page action primitive or to infer page content. Do not switch unless intentionally changing active tab. | Tab list, stable tab handles, browser ids, session snapshot, active operations, explicit observation snapshots. | Prefer explicit `targetRef` from `tabHandle` for tab-scoped tools; numeric `tabId` remains compatibility input. |
| `browser_observe` | Canonical observation tool for structure, readable content, exact HTML/text, text-first reads, and tab-fact reads through explicit modes plus deterministic omitted-mode inference from params. | Use `mode=scan` for structure/actionables/forms/lists/text signals, visible rows, media candidates, and collection completeness/continuation; `mode=content` for Markdown/article extraction; `mode=html` for exact HTML/text slices and selector diagnostics; `mode=text` for visible text-first observation; and `mode=tabs` when the target tab is unclear. If mode is omitted, `selector`/`includeLinks` infer content, `htmlMode`/`params` infer html, and `url` alone defaults to navigate+scan. | Do not use `mode="auto"`. Do not rely on page-shape guessing or selector-miss fallback across modes. Do not use screenshot when structured text is sufficient. | Scan Manifest v2, rows/media/actionables, `collections`, Markdown, HTML/text fragments, tab facts, selector diagnostics, artifact envelope, explicit `mode`/`sourceMode` metadata, and `details.modeInferred` diagnostics when params inferred the mode. | `browser_execute`, `browser_wait`, targeted `browser_artifact` jsonPath reads, `browser_screenshot`, `browser_frame`. |
| `browser_screenshot` | Save visual browser state as an image artifact. | Need visual proof, layout confirmation, or OCR/manual review fallback. | Do not use for text extraction when `browser_observe` can return structured text. | Image artifact path, format/mime, target metadata. | Use with textual tools for explanation. |
| `browser_frame` | Inspect or execute inside frames and manage new-document scripts. | Need frame tree, cross-frame evaluation, or CDP script injection lifecycle. | Do not guess iframe DOM access with top-frame `browser_execute` when frame targeting is required. | Frame tree, frame evaluation result, script identifiers. | `browser_execute`, `browser_observe`, `browser_hook`. |
| `browser_execute` | Precise JavaScript execution in a tab. | Need custom page action, state read, DOM mutation, focused interaction, or compact before/after monitor. | Do not use for native bridge commands, file upload, stable download handling, long waits, or bulk network replay. | JS result, target/newTabs metadata, optional monitor diff, artifact, operation metadata. | `browser_wait` then re-observe with `browser_observe`. |
| `browser_pick` | Let user select visible DOM elements interactively. | User must identify a specific visible element and selectors cannot be inferred confidently. | Do not use for autonomous bulk selection or background tabs where interaction is unavailable. | Selected selectors, element summaries, cancellation/timeout state. | `browser_execute`, `browser_observe`, `browser_upload` when file input is selected. |
| `browser_wait` | Durable waits and navigation state probes. | Need navigation, selector, load state, network idle, composite waits, immediate probe, or wait diagnostics. | Do not use manual sleeps or repeated polling loops in JS when native wait covers the condition. | Wait result, supervisor metadata, timeout/state-loss diagnostics. | Re-observe page/network; adjust condition or repeat action. |
| `browser_network` | Record and inspect browser network requests/responses/HAR. | Need captured requests, response bodies, postData, HAR, or wait for request/response evidence. | Do not monkeypatch fetch/XHR via page JS for ordinary request observation. | Recorder entries, body availability, request ids, HAR/artifact data. | `browser_http_replay`, `browser_evidence`, `browser_artifact`. |
| `browser_hook` | Install and collect page-side event hooks. | Need DOM/console/error/storage/websocket/crypto/dom_sinks or custom listener evidence across actions. | Do not use when passive network recorder or simple DOM scan is enough. | Hook sessions, event buffer, listener/performance data. | `browser_evidence`, `browser_artifact`, `browser_execute`. |
| `browser_evidence` | Aggregate hook, network, and performance evidence. | Need one compact proof bundle from already configured evidence sources. | Do not use as a replacement for initial observation or when a single source tool gives clearer data. | Combined evidence summary, source statuses, artifact. | `browser_artifact`; source tools for deeper reads. |
| `browser_artifact` | Read/search/sample local browser artifacts safely, including bounded multi-artifact search. | A browser tool returned `saved.path`, output is large, sensitive evidence must be inspected locally, or evidence must be searched across an explicit bounded artifact set. | Do not re-run expensive browser capture just to inspect already saved evidence. Do not bulk-read sensitive artifacts when a redaction pointer gives an exact `jsonPath`. Do not use multi-search without explicit `paths` or bounded `root`/`glob` plus limits. | Redacted text/json/search/sample snippets, targeted raw `jsonPath`/`pick` values, next offsets, privacy metadata, bounded grouped cross-artifact matches. | Continue targeted reads with narrower offsets/jsonPath/query or reduce the multi-search scope to one artifact. |
| `browser_memory` | Record, recall, read, or validate local browser memory entries with local-only persistence and optional provenance evidence. | A browser task succeeded and later similar origin/task/project-scoped tasks need bounded recall before acting; attach evidenceRefs when durable provenance is available. | Do not cite fake or unreadable evidenceRefs. Do not expect repo export/promote or embeddings. | Local memory cards, entry handles, derived index, bounded body reads through `browser-memory://...`. | `browser_artifact`, `browser_observe`, and targeted `browser_memory read` by id/URI. |
| `browser_download` | Trigger or wait for browser downloads and return local file path. | Need a stable Chrome download id/path via selector click, media extraction, or direct URL. | Do not script ad-hoc clicks when the task outcome is a downloaded file. | Download id/state/path, target metadata, artifact envelope. | Use `browser_artifact` or normal file tools on the local path. |
| `browser_upload` | Upload local files through a page file chooser. | User explicitly approved exact absolute file paths and selector points to file input/chooser. | Do not use without `confirm:true`; do not use `browser_execute` to bypass upload confirmation. | Upload result, file count, selector, bridge metadata. | `browser_wait` and re-observe page state. |

| `browser_command` | Canonical native bridge command execution surface. | Need explicit bridge command objects such as `tabs`, `management`, `cdp`, or `persistent_cdp`, with stable protocol validation and command-mode artifacts. | Do not use for page JavaScript, uploads that require `browser_upload`, or long waits already covered by canonical typed tools. | Command result, target/newTabs metadata, artifact, operation metadata. | `browser_observe`, `browser_wait`, `browser_artifact`. |

## Execute/command split boundary

TODO 245 is completed.

- `browser_execute` is JavaScript-only.
- `browser_command` is the canonical bridge-command-only surface.
- JSON-string command promotion is no longer part of the documented tool surface.

## Scoped Web follow-up tools

Web Security follow-up tools are always registered as part of the 22-tool surface. They remain a scoped follow-up group, not a separate capability profile or workflow mode.

| Tool | Purpose | Use when | Do not use when | Primary output/evidence | Follow-up |
|---|---|---|---|---|---|
| `browser_crawl` | Unified scoped fingerprinting and bounded same-origin crawl. | Need `action:"fingerprint"` for status/title/headers/tech hints/redirect/TLS/favicon/body hash before fuzzing, or default crawl for links/forms/known files/JS endpoints/OpenAPI/GraphQL/source maps/service-worker summaries. | Do not use for unbounded spidering, targeted replay mutation, or scanner conclusions without evidence. | Probe results, crawled pages/resources, endpoint hints, structured API summaries, archives. | `browser_http_replay`, `browser_fuzz`, `browser_template`. |
| `browser_http_replay` | Focused raw/captured/HAR request replay and mutation primitive. | Need deterministic request variants, sequence replay, cookie binding, baseline deltas, or HAR dependency evidence. | Do not use for live browser DOM actions, broad fuzzing, or external scanner automation. | Request/response steps, delta evidence, artifacts. | `browser_fuzz`, `browser_sqli`, `browser_template`. |
| `browser_fuzz` | Unified bounded path/vhost/parameter fuzzing surface. | Need `mode:"path"` for candidate route/file discovery, `mode:"vhost"` for Host/SNI variants, or `mode:"param"` for query/JSON/form/multipart/header deltas from explicit scoped inputs. | Do not use without explicit scope, bounds, and mode. Do not use path mode as a general crawler or param mode when a single replay variant is enough. | Matched paths/hosts/parameter cases, baseline clusters, parser/content-type variants, artifacts. | `browser_http_replay`, `browser_sqli`, `browser_template`, `browser_crawl`. |
| `browser_sqli` | Unified SQLi evidence and mature sqlmap automation surface. | Need default `engine:"builtin"` for boolean/error/time/union evidence with bounded cases, or `engine:"sqlmap"` for deeper mature automation from explicit URL/raw/captured/HAR request evidence. | Do not use as a generic parameter fuzzer or before capturing/scoping the request. | Oracle matches, DBMS hints, union/order evidence, extraction evidence, or sqlmap findings plus request/stdout/stderr artifacts. | `browser_http_replay`, `browser_artifact`. |
| `browser_template` | Unified built-in/custom HTTP template checks and mature nuclei automation surface. | Need default `engine:"builtin"` for small exposure/API baseline or explicit custom templates with bounded matchers, or `engine:"nuclei"` for mature template/workflow automation against explicit scoped targets or captured requests. | Do not use as the first observation step or without explicit scope/templates when precision matters. | Template matches/extracts, matcher evidence, or nuclei structured matches plus request/stdout/stderr artifacts. | `browser_http_replay`, `browser_artifact`. |
| `browser_callback_oast` | Local HTTP/HTTPS/DNS callback listener and correlation evidence. | Need callback URLs/hosts for SSRF, blind injection, deserialization, or out-of-band proof. | Do not use when no external callback path can reach the listener; do not leave unused sessions running. | Session ids, callback URLs/hosts, persisted events, artifacts. | Inject generated callback through `browser_execute` or `browser_http_replay`; then collect. |
| `browser_cookie_analyze` | Cookie/JWT/JWE/PASETO/session analysis and bounded mutation replay. | Need decode, signature/decryption verification, Rails cookie evidence, claim mutation generation, or browser cookie binding. | Do not use for arbitrary request replay unless claim replay is specifically needed. | Decoded claims, verification results, generated mutations, replay evidence, artifacts. | `browser_http_replay`, `browser_artifact`. |

## Boundary rules

- If the task is page perception, start with the smallest observation mode that returns structured text; use screenshots only for visual proof.
- If the task is page action, use `browser_execute` plus `browser_wait`, not fixed click/type tools.
- If the task is request mutation, use `browser_http_replay` as the primitive before specialized fuzzers or bridges; browser_http_replay as the primitive is the default boundary for focused request variants.
- If the task is broad Web Security automation, first capture baseline scope and evidence; scanners/fuzzers are follow-up layers.
- Web Security follow-up affordance stays additive only: `nextActions` are possible/common follow-ups and recovery hints, not a fixed workflow, not automatic cross-tool execution, and not a request-template synthesis layer.
- If output is large or sensitive, preserve it as an artifact and inspect with `browser_artifact`.
