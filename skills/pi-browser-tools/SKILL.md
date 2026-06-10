---
name: pi-browser-tools
description: "Pi-native in-process frontend for operating live browser pages — use when the agent HAS the browser_* tools and calls them directly to: open/list/switch tabs, scan/read DOM/text/HTML/content, click/type via JavaScript or CDP, wait for page state, capture network/hook/screenshot evidence, read result artifacts or browser-result:// resources, download/upload files, replay or fuzz HTTP requests, crawl endpoints/source maps, analyze cookies/JWT/JWE/PASETO/session, check SQLi/template/nuclei/OAST findings. A shell-capable agent that instead drives the `pi-browser` command-line tool: use the pi-browser-cli skill. Runtime browser-use only; not for extension source development or repo tests."
license: MIT
compatibility: Pi browser-tools extension 0.3.0+, Native Browser Bridge connected. Pi-native in-process frontend — call `browser_*` tools directly. For the shell `pi-browser` CLI, see the sibling **pi-browser-cli** skill.
---

# Pi Browser Tools (Pi-native)

Operate live browser pages by calling `browser_*` tools directly, in-process.

**This skill complements the tools; it does not restate them.** Each `browser_*` tool definition is already in your context — its params, enums, defaults, error codes, and per-result `recovery.nextActions` come from the tool itself. **Read the tool's schema (or `docs/generated/browser-tool-contract.generated.md`) for exact params** instead of expecting them here. What follows is the part the per-tool schema can't give: how to sequence the tools, where each capability's boundary is, and the non-obvious gotchas. Shell/CLI agents: use the **pi-browser-cli** skill instead.

Surface decision: the public callable surface is the `browser_*` tools. ABML `read/click/type/scroll/pierce/frame` is internal/runtime vocabulary that may surface in result hints as `read(pi-ref://...)`, not extra tool names.
Coverage reality: **ABML is observation-only — it does not execute.** Its **read** path is wired into `browser_observe` (AX merge, entities, relations/diff/templates), so perception is genuinely strengthened. **Page actions are the JavaScript you write via `browser_execute`** (run verbatim). For a **trusted-event-gated** control that silently ignores a synthetic `el.click()`/input, escalate via **`browser_command` CDP** (`Input.dispatchMouseEvent` / `Input.insertText` at the element's rect center). A structured `action` arm was tried and **removed** (agents reverted to JS) — **there is no public action verb: JS is the action language, CDP is the escape.** Prefer `causal` (which APIs an action hit) and the reading products (`outline`/`gist`/`templates`) on long lists/tables; `diff`/`treeDiff` churn on dynamic pages, so read `diff.summary` first. Full map: `docs/abml-tool-coverage-map.md`.

## Invocation

- Call tools directly: `browser_tabs {action:"list"}`, `browser_observe {mode:"scan"}`, `browser_execute {script}`. Outputs default to a compact, redacted salience summary (`renderer:"salience-v1"` on summary envelopes; `PI_BROWSER_RENDERER=ladder` forces the legacy ladder path) — size reads with `offset`/`limit`/`jsonPath`, not by asking for more detail (`detailLevel`/`maxChars` input knobs are deprecated and stripped).
- **No connect step** — readiness is ambient. Just call a tool; a not-yet-connected extension gets a brief grace wait, then a command fails `NO_BROWSER_EXTENSION` with `recovery.nextActions`. The bridge is a server the extension dials into; it cannot dial the browser for you — if the extension is genuinely not loaded/enabled, that is a human action, so surface it rather than retry-looping.

## Loop

1. `browser_tabs {action:"list"}` → note the target `tabId`. A `tabId` is **not stable** (changes on navigation/reload) — omit `tabId` to act on the active tab, or re-read it after navigating; pass it explicitly mainly to disambiguate open tabs. `TAB_NOT_FOUND` returns the live id in `recovery`.
2. Pick the route by intent (Routes).
3. Run **one bounded step**.
4. Verify: `browser_wait` / re-observe / network|hook evidence / read artifact.
5. Report: `tabId`, URL, selector/request/session IDs, artifact URI/path, next step.

`browser_tabs {action:"create"}` opens a tab; `switch` only to intentionally change the active one. `browserSessionId` is managed via `browser_tabs` session actions — omit it unless juggling concurrent sessions.

Memory is a Loop bookend: on a known origin `browser_memory recall` before step 2 and apply any SOP; on success `browser_memory record` at step 5. See Memory.

## Memory

Local store under `.pi/browser-memory/` (`origin|task|project` scope) so you stop re-deriving action sequences. `sop` = reusable **procedure** (HOW); `fact` = stable **knowledge** about a site (endpoints, auth shape, durable selectors). Recall/record are default habits — the store stays empty until you record.

- **Recall (task start):** before acting on a repeat origin — or whenever a result's `nextActions` shows a `relevant memory: … top:"…"` hint — `browser_memory {action:"recall", url|scopeKey}` (or `query="keywords"` to route across scopes). Cards come ranked with `updatedAt`; a dominant card's **body is inlined** — apply directly. Following a `relevant memory:` hint is not optional. `m.`/`mobile.`/`app.` subdomains share the apex memory.
- **Record (crystallize on success):** `browser_memory {action:"record", kind:"sop", scopeKind:"origin", url, title, triggers, body}`. Make it reusable: verb-y `title`; `triggers` = the keywords you'd search by; HOW-only `body` of numbered steps with **exact selectors / inputs / waits**, no secrets. Evidence optional. Prefer `origin` scope. A `record candidate:` hint means the origin has no SOP yet. Recording auto-dedups and returns `duplicateCandidates` — supersede, don't pile up.
- **Self-heal:** if a recalled SOP no longer works, re-`record` a corrected version — it supersedes the old one.

## Routes (intent → tool)

Pick the tool by intent; its params/enums are in the tool's own schema.

| Intent | Call |
|---|---|
| Page structure / model | `browser_observe {mode:"scan"}` |
| Main article text | `browser_observe {mode:"content"}` |
| Exact DOM/HTML for a selector | `browser_observe {mode:"html", selector, htmlMode}` |
| Visible text fast | `browser_observe {mode:"text"}` |
| Visual layout | `browser_screenshot` |
| Inside iframe | `browser_frame {action:"list"}` (read child `frameId`) → `browser_frame {action:"evaluate", frameId, expression}`. A top-level scan does NOT cover child frames structurally |
| Click/type/scroll/mutate | `browser_execute` (JS) → `browser_wait` → re-observe |
| Action returned ok but page didn't change | trusted-event-gated → `browser_command` CDP `Input.dispatchMouseEvent`/`Input.insertText` at the rect |
| CDP / native command | `browser_command` with explicit command object |
| Wait nav/selector/load/idle | `browser_wait` (never sleep-loop) |
| User points to element | `browser_pick` |
| Download / upload | `browser_download` / `browser_upload` {absolute path, `confirm:true`} (no hand-scripted clicks) |
| Record requests/HAR/body | `browser_network {action:"start"}` → act → `list\|get\|body\|exportHar` |
| Capture console/error/storage/ws/crypto/DOM-sink/listener | `browser_hook installTargets\|install` → act → `collect` or `browser_evidence` |
| Status/title/headers/redirect/TLS/tech | `browser_crawl {action:"fingerprint"}` + scope |
| Links/forms/API/source-maps/SW | `browser_crawl` (scope+bounds; `activeGraphqlIntrospection` for active GraphQL) |
| Replay/mutate one request | `browser_http_replay` (never page `fetch`) |
| Path/file/route discovery | `browser_fuzz {mode:"path"}` + wordlist/baseline |
| Virtual hosts | `browser_fuzz {mode:"vhost"}` + host candidates |
| Query/JSON/form/multipart/header params | `browser_fuzz {mode:"param"}` + captured/raw request |
| SQLi | `browser_sqli` (`engine:"builtin"` default; `"sqlmap"` only for bounded deep) |
| Exposure/config/custom templates | `browser_template` (`builtin` default) |
| Mature nuclei | `browser_template {engine:"nuclei"}` |
| OAST callback proof | `browser_callback_oast {action:"start"}` → inject/`trigger` → `collect` → `stop` |
| Cookie/JWT/JWE/PASETO/Rails session | `browser_cookie_analyze` |
| Local browser memory | `browser_memory {action:"recall"}` → `browser_memory {action:"read"}` |

## Observe products (scan envelope)

`browser_observe {mode:"scan"}` returns an envelope whose **top-level fields are where the page MODEL lives** — reach for them before hand-writing extraction JS. Boundary: observe gives **structure / relations / change / causality**; **per-item data VALUES (prices, ratings, cell text, titles) are JS** — once the structure tells you *where* a value is, extract it with `browser_execute`.

| You need | Read this envelope field | Then |
|---|---|---|
| A big repeated list/table as a group | `outline` / `gist` (fold by AX container) | per-item values → `browser_execute` |
| What changed after operating a control | scan with a `baseline` → **`treeDiff`** (template-level appeared/disappeared) | raw `diff` churns on dynamic pages — prefer `treeDiff`; per-item content → `browser_execute` |
| Row/column/header relations of a table | `relations` (`summary.tableCells` + cell `relations[]` `cellOf`/`headerFor`) | exact cell values → `browser_execute` |
| Which requests an action fired | **`browser_network {action:"start"}` FIRST**, then scan with `baseline` → `causal.requests` | — |

Pass a baseline **by reference**: a prior scan's `snapshotId` (daemon-resolved) or its auto-saved artifact path (`saved.path`) — never inline the prior envelope. `treeDiff`/`causal`/`relations` are top-level live AND mirrored into the saved artifact's `envelope.*`; absent ≠ error. The scan points you at them via `nextActions`.

## Read results

Results return a `summary` + `resource_link`(s) + `sections`. Sensitive fields are redacted; a redacted field carries `{redacted:true, raw, jsonPath}` — read that exact path with `browser_artifact mode=json jsonPath` or `pick`. Read large/sensitive payloads on demand — never re-run a capture to re-read it, never paste raw bodies/tokens. Non-obvious bits:

- Most artifacts keep primary results under `data` → start `mode=json jsonPath:"data"`, then `data.<key>` (e.g. `data.items`, `data.links`).
- **Find text** with `mode=search` + `query` — a plain `query` windows a match even inside one very long line (minified JS/HTML, one-line `data.markdown`); `regex:true` only for short-line patterns. `query` errors outside `mode=search`.
- Long scalar (`data.content`) → `offset`/`limit` char windows, follow `nextOffset`. Explicit `jsonPath`/`pick` returns the named local raw value (the way to follow a redaction pointer).
- `read_saved_artifact ...` in `nextActions` = read already-saved evidence without re-capturing.

## Tool visibility

All 22 `browser_*` tools — including web-security — are first-class and exposed by default. There is no capability profile, compact/minimal mode, or discovery step. `browser_memory` is local-only under `.pi/browser-memory/`; `record/validate` require durable evidence (a saved artifact path or non-stale snapshot-backed artifact); scopes `origin|task|project`, no repo export/promote.

## Bounds (before expansive routes)

Bound expansive routes by **explicit scope first** — `url` / captured request / raw request / HAR entry / `paths` / `words` / `templates` / host candidates — then each tool's real knobs (in its schema: e.g. fuzz `matchStatus`/`filter*`, template `maxRequests`/`severities`, sqli `level`/`risk`, OAST `triggerTimeoutMs`/`maxRuntimeMs`). Generic per-run caps (`maxDepth maxPages maxCases maxCandidates timeoutMs rateLimitPerSecond outputPath`) are **deprecated and stripped** — passing them is a no-op.

- Private/link-local/metadata blocked → `allowPrivateTargets:true` only for explicit internal testing. Launcher overrides (`sqlmapPath`/`nucleiPath`) → `allowLauncherOverride:true`. `wordlistPath` limited to CWD or `.pi/`.
- `bindBrowserSession:true` injects browser cookies only (traffic does not route through the tab) and reflects a double-submit CSRF cookie into its header by default (`csrfReflected` reports the names) — so authenticated `browser_http_replay` works without page `fetch`. Override with `csrfCookie`/`csrfHeader`, or `reflectCsrf:false` to test CSRF protection.
- `nextActions` are suggestions, not a mandatory pipeline — except a `relevant memory:` hint. Do not fabricate request templates when a captured/HAR request is required.

## Action

- Always set `browser_observe.mode` (`scan`/`content`/`html`/`text`/`tabs`). No `auto`, no cross-mode selector fallback. For read-only before/after, give the second scan a baseline to get `diff`/`treeDiff`/`snapshotProjection`/`form-dependency`. Pass the baseline **by reference** (`snapshotId` or `saved.path`). `pi-ref://` and baselines are short-lived; on stale/expired/`HANDLE_NOT_FOUND`, re-observe — never retry the old handle. Selector miss → re-observe `scan`/`html` → `browser_frame` → verified retry.
- `browser_execute {script}` = raw JS only; return `{ok, reason, value}`. Input: focus → native setter or CDP `Input.insertText` via `browser_command` → dispatch `input`/`change` → read back. If a synthetic `el.click()`/input returns `ok` but nothing changed (trusted-event-gated), escalate via `browser_command` CDP at the rect center.
- `monitor:true` only when a before/after DOM diff helps. Don't ask for `redact:false`; follow redaction pointers. Track when present: `operationId snapshotId requestId waitId listenerId sessionId browserSessionId selectionVersion sourceMode`.

Click:
```js
(() => {
  const el = document.querySelector('SELECTOR');
  if (!el) return { ok: false, reason: 'not_found' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return { ok: false, reason: 'covered' };
  el.click();
  return { ok: true, text: el.innerText || el.value || '' };
})()
```

## Native command

`browser_command` for explicit objects: `tabs management cdp persistent_cdp cookies contentSettings intercept.* ws.*`. Pass explicit `tabId` + exact `sessionId`/`requestId`/`ruleId`/`url`/`steps`/matchers. `ws.replay` fail → inspect `stepIndex`/`lastSeq`/`partialSteps`/`partialTranscript`, resume from the failing step. Do not invent withdrawn tool names; `/browser-js-ast`, `/browser-wasm`, `/browser-ws` are local-file slash commands, not a public browser tool surface.

## Recovery

| Symptom | Do |
|---|---|
| No bridge/browser/tab | A command briefly waits, then fails `NO_BROWSER_EXTENSION` with `recovery.nextActions` — follow them. Confirm the extension is loaded/enabled and a tab is open. If genuinely not loaded, that is a human action — surface it, don't retry-loop |
| Stale tab | `browser_tabs {action:"list"}`; use live `tabId` |
| Selector missing | re-observe `scan`/`html`; `browser_frame`; verified retry |
| Timeout | `browser_wait {action:"diagnose", waitId}` (selector-specific `selectorDiagnostics`: match/visible count, iframe clues, recovery); narrow/raise bound |
| Body/request missing | start recorder before action; list exact requests |
| Resource `stale`/`HANDLE_NOT_FOUND`/baseline expired | re-capture with `browser_observe mode=scan` or the original capture tool to mint fresh `browser-result://`/`pi-ref://` evidence; never retry the old handle |
| Tool not found | all 22 `browser_*` tools should be available unless the package/daemon is stale |
| `browser_crawl`/`browser_fuzz`/`browser_http_replay` TLS `unable to verify the first certificate` | TLS-intercepting proxy/AV/corporate CA. The runtime trusts the OS/browser CA store on Node ≥22; if it persists set `NODE_EXTRA_CA_CERTS=<root.pem>` and restart. The error's `remediation` names the fix |

## Index

- Playbooks: `docs/playbooks/` — triage · recon · capture-and-replay · sqli · ssrf-oast · auth-session-jwt · evidence-and-reporting
- Methodology map: `docs/reference/web-security-methodology-map.md`
- Tool contracts: `docs/generated/browser-tool-contract.generated.md` · Native protocol: `docs/generated/native-protocol.generated.md` · Boundaries: `docs/tool-boundaries.md`
- Install/runtime SOP: `AI_INSTALL.md` · Shell `pi-browser` CLI frontend: **pi-browser-cli** skill · `docs/cli.md`

## Output

Answer in Chinese unless asked otherwise. Concise: action, result, evidence, next step + relevant IDs and artifact URIs/paths. Never expose secrets or large raw payloads.
