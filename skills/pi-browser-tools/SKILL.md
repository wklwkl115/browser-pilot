---
name: pi-browser-tools
description: "Pi-native in-process frontend for operating live browser pages — use when the agent HAS the browser_* tools and calls them directly to: open/list/switch tabs, scan/read DOM/text/HTML/content, click/type via JavaScript or CDP, wait for page state, capture network/hook/screenshot evidence, read result artifacts or browser-result:// resources, download/upload files, replay or fuzz HTTP requests, crawl endpoints/source maps, analyze cookies/JWT/JWE/PASETO/session, check SQLi/template/nuclei/OAST findings. A shell-capable agent that instead drives the `pi-browser` command-line tool: use the pi-browser-cli skill. Runtime browser-use only; not for extension source development or repo tests."
license: MIT
compatibility: Pi browser-tools extension 0.3.0+, Native Browser Bridge connected. Pi-native in-process frontend — call `browser_*` tools directly. For the shell `pi-browser` CLI, see the sibling **pi-browser-cli** skill.
---

# Pi Browser Tools (Pi-native)

Operate live browser pages by calling `browser_*` tools directly, in-process.

**This skill complements the tools; it does not restate them.** Each `browser_*` tool definition is already in your context — its params, enums, defaults, error codes, and per-result `recovery.nextActions` come from the tool itself. **Read the tool's schema (or `docs/generated/browser-tool-contract.generated.md`) for exact params** instead of expecting them here. What follows is the part the per-tool schema can't give: how to sequence the tools, where each capability's boundary is, and the non-obvious gotchas. Shell/CLI agents: use the **pi-browser-cli** skill instead.

Three facts shape everything below:
- **Perception is `browser_observe`.** ABML (AX merge, entities, relations, diff) is wired into it and observes only; verbs like `read(pi-ref://...)` appearing in result hints are vocabulary, not callable tools.
- **Action is the JavaScript you write in `browser_execute`** (run verbatim). There are no separate click/type tools and none are planned — a structured action arm was tried and removed because agents reverted to JS. The one narrow stdlib escape is `pi.click(ref)` for physical trusted clicks against a fresh observed `pi-ref://`.
- **The escape for synthetic-event-blind targets is physical input.** When `el.click()` is silently ignored (trusted-event-gated control, canvas, WebGL, cross-origin iframe) **or JS-typed text never registers** (React/Vue controlled input reverts on re-render, a `contenteditable` editor still reads empty, a submit button never enables), stop escalating JS hacks. For a fresh observed ref use `browser_execute` with `await pi.click(ref)`; otherwise use `browser_command` `input.pointer` / `input.keys` at measured coordinates. CDP trusted events trip framework reactivity that synthetic events cannot.

On long lists/tables first read top-level `collections` for completeness / continuation evidence, then `outline`/`gist` for orientation and `causal` for which APIs an action hit; raw `diff` churns on dynamic pages — read `diff.summary` first and prefer `treeDiff`. Full map: `docs/abml-tool-coverage-map.md`.

## Invocation

- Call tools directly: `browser_tabs {action:"list"}`, `browser_observe {mode:"scan"}`, `browser_execute {script}`. Outputs are compact, redacted salience summaries (`renderer:"salience-v1"`); repeated scans may be delta-compressed (`delta:"session"`), and equal-rank scan actions/entities may be reordered toward your URL / top-level `intent` / recent-call context. Size reads with `offset`/`limit`/`jsonPath`, not by asking for more detail — `detailLevel`/`maxChars` input knobs are deprecated and stripped.
- **No connect step** — readiness is ambient. Just call a tool; a not-yet-connected extension gets a brief grace wait, then a command fails `NO_BROWSER_EXTENSION` with `recovery.nextActions`. The bridge is a server the extension dials into; it cannot dial the browser for you — if the extension is genuinely not loaded/enabled, that is a human action, so surface it rather than retry-looping.

## Loop

1. `browser_tabs {action:"list"}` → note the target `tabHandle` and pass it as `targetRef` when you must disambiguate. Numeric `tabId` is still accepted for compatibility and auto-follows unambiguous in-place replacement; omit `targetRef`/`tabId` to act on the selected active tab. `TAB_NOT_FOUND` returns replacement/live-id recovery when available.
2. Pick the route by intent (Routes).
3. Run **one bounded step**.
4. Verify: `browser_wait` / re-observe / network|hook evidence / read artifact.
5. Report: `targetRef`/`tabId`, URL, selector/request/session IDs, artifact URI/path, next step.

`browser_tabs {action:"create"}` opens a tab; `switch` only to intentionally change the active one. `browserSessionId` is managed via `browser_tabs` session actions — omit it unless juggling concurrent sessions.

Memory is a Loop bookend: `browser_observe` may surface matched local memory in `envelope.memory`; on success `browser_memory record` at step 5. See Memory.

## Memory

Local store under `.pi/browser-memory/` (`origin|task|project` scope) so you stop re-deriving action sequences. `sop` = reusable **procedure** (HOW); `fact` = stable **knowledge** about a site (endpoints, auth shape, durable selectors). The store stays empty until you record — automatic recall only pays after you have paid into it.

- **Recall (observe):** `browser_observe mode=scan|text` automatically surfaces current URL/intent-matched memory in `envelope.memory` with `verification:"fresh"|"unverified"|"stale"`; same-origin alone is not enough. Inline cards are bounded; collapsed cards carry `browser-memory://...` handles. Use `browser_memory {action:"read", uri}` for a full body, or `browser_memory {action:"recall", url, query}` only for manual cross-scope follow-up.
- **Record (on success — fill this template and send, ~30s):**
  ```
  browser_memory {action:"record", kind:"sop", scopeKind:"origin",
    url: "<page url>",
    title: "<verb-y outcome, e.g. 'Export linux.do topic list as rows'>",
    triggers: ["<keywords you'd search by>"],
    body: "1. <step with exact selector/input/wait>\n2. <…>"}
  ```
  Evidence optional; no secrets in `body`. A `record candidate:` hint = this origin has no SOP yet. Dedup/supersede and self-heal mechanics are in the tool's own description — don't relearn them here.

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
| Click/type/scroll/mutate | `browser_execute` (JS) → read cheap `effect` → `browser_wait` / re-observe |
| Action returned ok but page didn't change; OR JS-typed text the framework ignores (submit stays disabled, controlled input / `contenteditable` reverts to empty) | fresh observed click ref → `browser_execute` `await pi.click(ref)`; otherwise physical input via `browser_command` `input.pointer` / `input.keys` — see Action › Type |
| CDP / native command | `browser_command` with explicit command object |
| Wait nav/selector/load/idle | `browser_wait` (never sleep-loop; on a continuously polling/streaming SPA an `idle` wait never settles and just burns the timeout — wait on a `selector` or navigation instead) |
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
| A long/virtualized/lazy/paginated list | `collections` (`completeness`, `continuation`, evidence refs) | decide semantic need/budget; per-item values → `browser_execute` |
| A big repeated list/table as a group | `outline` / `gist` (fold by AX container) | per-item values → `browser_execute` |
| Visible text/link rows already on screen | `summary.rows` or `browser_artifact jsonPath=data.rows` | site-specific values beyond text/href/geometry → `browser_execute` |
| Visible images/video/audio candidates | `summary.media_candidates` or `browser_artifact jsonPath=data.media_candidates` | associated headline/ranking/source semantics → `browser_execute` |
| What changed after operating a control | scan with a `baseline` → **`treeDiff`** (template-level appeared/disappeared) | raw `diff` churns on dynamic pages — prefer `treeDiff`; per-item content → `browser_execute` |
| Row/column/header relations of a table | `relations` (`summary.tableCells` + cell `relations[]` `cellOf`/`headerFor`) | exact cell values → `browser_execute` |
| Which requests an action fired | **`browser_network {action:"start"}` FIRST**, then scan with `baseline` → `causal.requests` | — |

Component-library selects/dropdowns (Element Plus / Ant Design / MUI style): popup DOM is often lazy and the first visible popper can be stale from the previous control. Identify the popup from the trigger, not visual heuristics: read `aria-controls` plus `aria-expanded`; body-click/close, reopen the target trigger, then query the popup by that id. `browser_observe mode=scan` records page-wide `data.controls_pairs` (including off-screen sources); read it with `browser_artifact mode=json jsonPath=data.controls_pairs`, and re-scan after opening if the first scan had no resolvable pair.

Pass a baseline **by reference**: a prior scan's `snapshotId` (daemon-resolved) or its auto-saved artifact path (`saved.path`) — never inline the prior envelope. `collections`/`treeDiff`/`causal`/`relations` are top-level live AND mirrored into the saved artifact's `envelope.*`; absent ≠ error. The scan points you at them via `nextActions`.

## Read results

Results return a `summary` + `resource_link`(s) + `sections`. Sensitive fields are redacted; a redacted field carries `{redacted:true, raw, jsonPath}` — read that exact path with `browser_artifact mode=json jsonPath` or `pick`. Read large/sensitive payloads on demand — never re-run a capture to re-read it, never paste raw bodies/tokens. Non-obvious bits:

- Most artifacts keep primary results under `data` → start `mode=json jsonPath:"data"`, then `data.<key>` (e.g. `data.items`, `data.links`).
- **Find text** with `mode=search` + `query` — a plain `query` windows a match even inside one very long line (minified JS/HTML, one-line `data.markdown`); `regex:true` only for short-line patterns. `query` errors outside `mode=search`.
- Long scalar (`data.content`) → `offset`/`limit` char windows, follow `nextOffset`. Explicit `jsonPath`/`pick` returns the named local raw value (the way to follow a redaction pointer).
- `read_saved_artifact ...` in `nextActions` = read already-saved evidence without re-capturing.

## Tool visibility

All 22 `browser_*` tools — including web-security — are first-class and exposed by default. There is no capability profile, compact/minimal mode, or discovery step.

## Bounds (before expansive routes)

Bound expansive routes by **explicit scope first** — `url` / captured request / raw request / HAR entry / `paths` / `words` / `templates` / host candidates — then each tool's real knobs (in its schema: e.g. fuzz `matchStatus`/`filter*`, template `maxRequests`/`severities`, sqli `level`/`risk`, OAST `triggerTimeoutMs`/`maxRuntimeMs`). Generic per-run caps (`maxDepth maxPages maxCases maxCandidates timeoutMs rateLimitPerSecond outputPath`) are **deprecated and stripped** — passing them is a no-op.

- Private/link-local/metadata blocked → `allowPrivateTargets:true` only for explicit internal testing. Launcher overrides (`sqlmapPath`/`nucleiPath`) → `allowLauncherOverride:true`. `wordlistPath` limited to CWD or `.pi/`.
- `bindBrowserSession:true` injects browser cookies only (traffic does not route through the tab) and reflects a double-submit CSRF cookie into its header by default (`csrfReflected` reports the names) — so authenticated `browser_http_replay` works without page `fetch`. Override with `csrfCookie`/`csrfHeader`, or `reflectCsrf:false` to test CSRF protection.
- `nextActions` are suggestions, not a mandatory pipeline. A `record candidate:` hint means this origin has no SOP yet; record only after a real success. Do not fabricate request templates when a captured/HAR request is required.

## Action

- Prefer explicit `browser_observe.mode` when you know it (`scan`/`content`/`html`/`text`/`tabs`), but omitting mode is valid for mechanical cases: `selector`/`includeLinks` infer `content`, `htmlMode`/`params` infer `html`, and `url` alone defaults to navigate+scan. No `auto`, no page-shape guessing, no cross-mode selector fallback. For read-only before/after, give the second scan a baseline to get `diff`/`treeDiff`/`snapshotProjection`/`form-dependency`. Pass the baseline **by reference** (`snapshotId` or `saved.path`). `pi-ref://` and baselines are short-lived; on stale/expired/`HANDLE_NOT_FOUND`, re-observe — never retry the old handle. Selector miss → re-observe `scan`/`html` → `browser_frame` → verified retry.
- `browser_execute {script}` = raw JS only; return `{ok, reason, value}`. After any write, read the cheap `effect` block (`mutations`, `settled`, dirty roots/overflow, navigation/recorder deltas) before paying for a full re-observe. If `targetRegionDirty:true`, `BACKEND_NODE_STALE`, `OOPIF_SESSION_UNSUPPORTED`, or `HANDLE_NOT_FOUND` appears after a script used `pi-ref://`, refresh with `browser_observe mode=scan` before reusing that ref. Use normal page JS selectors/DOM APIs first; `pi.click(ref)` is only for physical trusted input against a fresh observed ref and returns dispatch facts (`dispatchOnly:true`), not semantic success.
- `monitor:true` only when a semantic before/after DOM diff helps; it is heavier than the default `effect`. Don't ask for `redact:false`; follow redaction pointers. Track when present: `operationId snapshotId requestId waitId listenerId sessionId browserSessionId selectionVersion sourceMode`.

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

Trusted click from an observed ref:
```js
return await pi.click("pi-ref://control/...");
```
Use this only after a fresh `browser_observe mode=scan` produced the ref and normal `el.click()` was swallowed. Verify with `effect`, `browser_wait`, `browser_observe`, or network/hook evidence; do not double-click just because `pi.click` does not verify intent internally. On stale/ref/session failure, re-observe and retry once with the fresh ref.

Type — *JS-typed-but-the-framework-ignores-it* is the most common silent failure (the submit button never enables):
- React/Vue **controlled `<input>`/`<textarea>`**: a plain `el.value = x` is reverted on re-render. Write through the native setter so the framework sees it, then fire `input`:
```js
(() => {
  const el = document.querySelector('SELECTOR');
  if (!el) return { ok: false, reason: 'not_found' };
  el.focus();
  const P = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(P.prototype, 'value').set.call(el, 'TEXT');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, value: el.value };
})()
```
- **`contenteditable` editors** (comment/rich-text boxes), or any field whose **submit stays disabled / editor still reads empty** after the above: that is the *typing* form of the trusted-event wall. Do NOT keep escalating JS (`textContent=`, repeated `execCommand`, synthetic `InputEvent`) — switch to physical input. Focus the field first (`el.focus()` via `browser_execute`, or `browser_command` `input.pointer {gesture:"press", x, y}` at its box center), then `browser_command` `input.keys {text:"…"}` (CDP `Input.insertText` — a trusted event React/Vue accept); submit with `input.keys {keys:[{key:"Enter"}]}` or click the now-enabled button. `input.keys` types into the **focused** element — focus first or it goes nowhere. Verify by re-observe / `effect` / `browser_network`, **not** by the button's class (it re-renders).

## Native command

`browser_command` for explicit objects: `tabs management cdp persistent_cdp cookies contentSettings input.* intercept.* ws.*`. Use `input.pointer` (`gesture:"press"|"drag"|"wheel"|"hover"`, `x`, `y`) and `input.keys` (`text` or key names) for explicit trusted physical input; `input.ref` is the internal diagnostic equivalent behind `pi.click(ref)`, not a new preferred public workflow. Summaries redact raw inserted text and report char counts. Pass explicit `tabId` + exact `sessionId`/`requestId`/`ruleId`/`url`/`steps`/matchers. `ws.replay` fail → inspect `stepIndex`/`lastSeq`/`partialSteps`/`partialTranscript`, resume from the failing step. Do not invent withdrawn tool names; `/browser-js-ast`, `/browser-wasm`, `/browser-ws` are local-file slash commands, not a public browser tool surface.

## Recovery

| Symptom | Do |
|---|---|
| No bridge/browser/tab | A command briefly waits, then fails `NO_BROWSER_EXTENSION` with `recovery.nextActions` — follow them. Confirm the extension is loaded/enabled and a tab is open. If genuinely not loaded, that is a human action — surface it, don't retry-loop |
| Stale tab | If `recovery.suggestedTargetRef` is present, retry with that `targetRef`; otherwise `browser_tabs {action:"list"}` and use a live `tabHandle` as `targetRef` |
| `targetRegionDirty:true` in execute effect | re-observe `scan` before reusing the same `pi-ref://`; the action was not blocked, but the observed region changed |
| Selector missing | re-observe `scan`/`html`; `browser_frame`; verified retry |
| Timeout | `browser_wait {action:"diagnose", waitId}` (selector-specific `selectorDiagnostics`: match/visible count, iframe clues, recovery); narrow/raise bound |
| Body/request missing | start recorder before action; list exact requests |
| Resource `stale`/`HANDLE_NOT_FOUND`/baseline expired | re-capture with `browser_observe mode=scan` or the original capture tool to mint fresh `browser-result://`/`pi-ref://` evidence; never retry the old handle |
| Context lost / delta baseline forgotten | (1) `browser_observe {mode:"scan", fresh:true}` to re-see the page; (2) `browser_artifact {mode:"search", glob:"**/*.json"}` to rediscover own artifacts (each carries `snapshot.url`/`capturedAt`/`snapshotId`); (3) `browser_memory {action:"recall"}` for durable SOP/facts; do not turn off relevance or memory globally |
| Unexplained `INVALID_RULE` / unsupported action | inspect `browser_tabs {action:"snapshot"}` or list `bridge.extension.extensionStale`; if true or `reportedBuild` is missing, reload the browser extension and retry |
| Tool not found | all 22 `browser_*` tools should be available unless the package/daemon is stale |
| `browser_crawl`/`browser_fuzz`/`browser_http_replay` TLS `unable to verify the first certificate` | TLS-intercepting proxy/AV/corporate CA. The runtime trusts the OS/browser CA store on Node ≥22; if it persists set `NODE_EXTRA_CA_CERTS=<root.pem>` and restart. The error's `remediation` names the fix |

## Index

- Playbooks: `docs/playbooks/` — triage · recon · capture-and-replay · sqli · ssrf-oast · auth-session-jwt · evidence-and-reporting
- Methodology map: `docs/reference/web-security-methodology-map.md`
- Tool contracts: `docs/generated/browser-tool-contract.generated.md` · Native protocol: `docs/generated/native-protocol.generated.md` · Boundaries: `docs/tool-boundaries.md`
- Install/runtime SOP: `AI_INSTALL.md` · Shell `pi-browser` CLI frontend: **pi-browser-cli** skill · `docs/cli.md`

## Output

Answer in Chinese unless asked otherwise. Concise: action, result, evidence, next step + relevant IDs and artifact URIs/paths. Never expose secrets or large raw payloads.
