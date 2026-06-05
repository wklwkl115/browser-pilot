---
name: pi-browser-tools
description: "Use when operating, inspecting, debugging, automating, or verifying live browser pages through browser_* tools: open/list/switch tabs, scan/read DOM/text/HTML/content, click/type via JavaScript or CDP, wait for page state, capture network/hook/screenshot evidence, read result artifacts or browser-result:// resources, download/upload files, replay or fuzz HTTP requests, crawl endpoints/source maps, analyze cookies/JWT/JWE/PASETO/session, check SQLi/template/nuclei/OAST findings. Runtime browser-use only; not for extension source development or repo tests."
license: MIT
compatibility: Pi browser-tools extension 0.3.0+, Native Browser Bridge connected. Works on any skill-supporting platform. Invoke as Pi-native `browser_*` tools, or via the `pi-browser` CLI (any shell-capable agent).
---

# Pi Browser Tools

Live browser operation via `browser_*` tools. HOW only — methodology and route index. For depth, follow the Index.

Surface decision: public callable surface remains the existing `browser_*` tools. ABML `read/click/type/scroll/pierce/frame` is internal/runtime vocabulary and may appear in result hints as `read(pi-ref://...)` or `click(pi-ref://...)`, but these are not extra Pi tool names.
Coverage reality: ABML's **read** path is wired in — `browser_observe` runs through it (AX merge, entities, relations/inference/diff/templates), so perception is genuinely strengthened. On the **action** path: raw `browser_execute {script}` runs your JavaScript **verbatim** — you own the method choice and retry/verify. **For a click that must actually take effect, prefer `browser_execute {action:{click:"<pi-ref|css selector>"}}`** — it routes through the ABML **degradation ladder** (actionability wait → synthetic → verify → **auto CDP trusted-event fallback** → re-verify, `src/abml/verbs/runtime.ts`), so a synthetic-event-only failure is recovered for you instead of silently lost (raw `el.click()` reports ok but the effect never fires on such sites). `action` is **one optional param on the same tool**, not a parallel verb — the narrow surface holds (public verb *tools* were tried and proved worse). `action.type` ({target,text,clear?}) does the same for typing (focus + CDP `Input.insertText` trusted events + verify) — prefer it when a field ignores synthetic input. `action.scroll` ({target?,to,steps?}) scrolls the window (or a container) via the ladder — `to`: top/bottom/next/previous. So `action` covers click/type/scroll; raw `{script}` is for everything else. Full map: `docs/abml-tool-coverage-map.md`.

## Invocation

- **Pi-native** → call the tools directly, e.g. `browser_tabs {action:"list"}`, `browser_observe {mode:"scan"}`, `browser_execute {script}`.
- **`pi-browser` CLI** (any shell agent) → the same tools as subcommands: `pi-browser tabs --action list`, `pi-browser observe --mode scan`, `pi-browser execute --script "…"`. The bridge daemon auto-starts on first call; output is human on a TTY and JSON otherwise (`--json`/`--text` to force). `pi-browser --help` / `pi-browser <cmd> --help` lists every command and its flags — there is no discovery step.

## Loop

1. `browser_tabs list` → note the target `tabId`. A `tabId` is **not stable** — it changes when the tab navigates/reloads — so don't cache it across navigations: omit `tabId` to act on the active tab, or re-read it from `browser_tabs` after navigating. Pass an explicit `tabId` mainly to disambiguate several open tabs. `TAB_NOT_FOUND` returns the live/current tab id in `recovery`.
2. Pick the route by intent (Routes).
3. Run **one bounded step**.
4. Verify: `browser_wait` / re-observe / network|hook evidence / read artifact.
5. Report: `tabId`, URL, selector/request/session IDs, artifact URI/path, next step.

`browser_tabs create` opens a tab; `switch` only to intentionally change the active one. Omit `browserSessionId` unless juggling concurrent sessions. Default `detailLevel:"summary"`.

Memory is a Loop bookend: on a known/repeat origin `browser_memory recall` before step 2 and apply any SOP; on task success with durable evidence `browser_memory record` at step 5. See Memory.

## Memory

Local store under `.pi/browser-memory/` (`origin|task|project` scope) so you stop re-deriving action sequences. Two kinds: `sop` = a reusable **procedure** (HOW); `fact` = stable **knowledge** about a site (endpoints, auth shape, durable selectors). Recall and record are default habits — the store stays empty until you record.

- **Recall (task start):** before acting on a repeat/known origin — or whenever a result's `nextActions` shows a `relevant memory: … top:"…"` hint (it names the top entry, so judge relevance first) — `browser_memory {action:"recall", url|scopeKey}`, or `query="keywords"` to route across scopes via the L1 token index. Cards come ranked and carry `updatedAt` (judge staleness); when one clearly dominates its **body is inlined** — apply it directly, no extra read. Following a `relevant memory:` hint is not optional. Device/variant subdomains (`m.`/`mobile.`/`app.`) share the apex site's memory.
- **Read** other cards' bodies on demand: `browser_memory {action:"read", id|uri}` (bounded; `offset`/`limit`/`jsonPath`).
- **Record (crystallize on success):** the moment a multi-step task succeeds, crystallize it — `browser_memory {action:"record", kind:"sop"|"fact", scopeKind:"origin", url, title, triggers, body}`. You hold the trajectory; distill it yourself. Make it reusable: a verb-y `title`; `triggers` = the keywords you'd search by (site name, task, key UI words — these drive recall); a HOW-only `body` of numbered steps with **exact selectors / inputs / waits**, no secrets. **Evidence is optional** (`evidenceRefs` is provenance — add a saved artifact path if handy, never withhold a good SOP for lack of one). Prefer `origin` scope. A `record candidate:` hint means the origin has no SOP yet — act on it when the task was reusable. Recording auto-dedups near-identical SOPs and returns `duplicateCandidates` for merely-similar ones — supersede those, don't pile up copies.
- **Self-heal:** if a recalled SOP no longer works (page changed), just re-`record` a corrected version — it supersedes the old one. No upkeep, no scoring.

## Routes

| Intent | Call |
|---|---|
| Page structure | `browser_observe {mode:"scan"}` |
| Main article text | `browser_observe {mode:"content"}` |
| Exact DOM/HTML for selector | `browser_observe {mode:"html", selector, htmlMode}` |
| Visible text fast | `browser_observe {mode:"text"}` |
| Visual layout | `browser_screenshot` |
| Inside iframe | `browser_frame list` → `browser_frame evaluate` |
| Reliable click (must take effect) | `browser_execute {action:{click:"<pi-ref\|selector>"}}` (laddered: actionability + auto CDP fallback + verify) |
| Reliable type into a field | `browser_execute {action:{type:{target:"<pi-ref\|selector>",text}}}` (laddered: focus + CDP insertText + verify) |
| Mutate / custom DOM | `browser_execute` (JS) → `browser_wait` → re-observe |
| CDP / native command | `browser_command` with explicit command object |
| Wait nav/selector/load/idle | `browser_wait` (never sleep-loop) |
| User points to element | `browser_pick` |
| Download file | `browser_download` (no hand-scripted clicks) |
| Upload file | `browser_upload` {absolute path, `confirm:true`} |
| Record requests/HAR/body | `browser_network start` → act → `list\|get\|body\|exportHar` |
| Capture console/error/storage/ws/crypto/DOM-sink/listener | `browser_hook installTargets\|install` → act → `collect` or `browser_evidence` |
| Status/title/headers/redirect/TLS/tech | `browser_crawl {action:"fingerprint"}` + `url`/`urls`/`paths` |
| Links/forms/API/source-maps/SW | `browser_crawl` (scope+bounds; `activeGraphqlIntrospection` for active GraphQL) |
| Replay/mutate one request | `browser_http_replay` (never page `fetch`) |
| Path/file/route discovery | `browser_fuzz {mode:"path"}` + wordlist/bounds/baseline |
| Virtual hosts | `browser_fuzz {mode:"vhost"}` + host candidates/bounds |
| Query/JSON/form/multipart/header params | `browser_fuzz {mode:"param"}` + captured/raw request |
| SQLi | `browser_sqli` (`engine:"builtin"` default; `"sqlmap"` only for bounded deep) |
| Exposure/config/custom templates | `browser_template` (`builtin` default; omitted templates = baseline) |
| Mature nuclei | `browser_template {engine:"nuclei"}` + targets/templates/bounds |
| OAST callback proof | `browser_callback_oast start` → inject/`trigger` (`triggerTimeoutMs`) → `collect` → `stop` |
| Cookie/JWT/JWE/PASETO/Rails session | `browser_cookie_analyze` (Rails AES-GCM/CBC/direct-key; bounded claim replay) |
| Local browser memory | `browser_memory {action:"recall"}` → `browser_memory {action:"read"}` |

## Read results

Tool results return a `summary` + `resource_link`(s) + `sections`. Read large/sensitive payloads on demand — never re-run a capture to re-read it, never paste raw bodies/tokens.

- **Artifacts** → `browser_artifact` with `jsonPath`/`pick`/`offset`/`search` (CLI: `pi-browser artifact …`). For minified JS or long single-line artifacts, use `search contextChars` or `text columnOffset/columnLimit`. Take the path/handle from `summary.saved`, `sections`, or `nextActions`.
- **Browser memory** → `browser_memory {action:"read", id|uri}` for bounded SOP/fact bodies.
- `read_saved_artifact ...` in `nextActions` means “read the already-saved evidence without re-running capture” → `browser_artifact`.

## Tool visibility

All `browser_*` tools — including web-security — are first-class and exposed by default. The only gate is `PI_BROWSER_TOOL_PROFILE=core`, which unregisters the web-security group. There is no compact/minimal mode and no discovery step; `pi-browser --help` lists every command.

- `browser_memory {action:"record"|"recall"|"read"|"validate"}` — local-only browser memory under `.pi/browser-memory/`; `record/validate` require durable evidence such as a saved artifact path or a non-stale snapshot-backed artifact. Local scopes `origin|task|project` are supported; repo export/promote is not.

## Bounds (set before expansive routes)

`maxDepth maxPages maxCases maxCandidates maxRequests timeoutMs rateLimitPerSecond` + match/filter + `outputPath` when output grows. OAST: `triggerTimeoutMs` (wait), `maxRuntimeMs` (long listener).

- Obtain explicit scope first: `url` / captured request / raw request / HAR entry / `paths` / `words` / `templates` / param names.
- Private/link-local/metadata blocked → `allowPrivateTargets:true` only for explicit internal testing.
- Launcher overrides (`sqlmapPath`/`nucleiPath`/`PI_*_PATH`) → `allowLauncherOverride:true`.
- `wordlistPath` limited to CWD or `.pi/`.
- `bindBrowserSession:true` injects browser cookies only (traffic does not route through the tab).
- `nextActions` are suggestions, not a mandatory pipeline — except a `relevant memory:` hint, which you should recall before continuing. Do not fabricate request templates when a captured/HAR request is required.

## Action

- Always set `browser_observe.mode` (`scan`/`content`/`html`/`text`/`tabs`). No `auto`, no cross-mode selector fallback. For read-only before/after state, pass scan `baseline` from a prior entity list / scan summary/envelope / snapshotId to get envelope `diff` (`appeared/disappeared/changed/focusedRef`), structure-level `treeDiff` for repeated lists/tables, `snapshotProjection` for persisted template+delta structure, and possible `form-dependency` intent.
- Selector miss → re-observe `scan`/`html` → inspect `browser_frame` → retry verified selector/frame.
- `browser_execute` = JS only; return `{ok, reason, value}`. Input: focus → native setter or CDP `Input.insertText` via `browser_command` → dispatch `input`/`change` → read back.
- `monitor:true` only when a before/after DOM diff helps. `redact:false` only for explicit local raw evidence.
- Track when present: `operationId snapshotId requestId waitId listenerId sessionId browserSessionId selectionVersion* sourceMode`.

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

`browser_command` for explicit objects: `tabs management cdp persistent_cdp cookies contentSettings intercept.* ws.*`. Pass explicit `tabId` + exact `sessionId`/`requestId`/`ruleId`/`url`/`steps`/matchers. `ws.replay` fail → inspect `stepIndex`/`lastSeq`/`partialSteps`/`partialTranscript`, resume from failing step.

Do not invent withdrawn or non-public browser tool names. `/browser-js-ast`, `/browser-wasm`, `/browser-ws` are local-file/transcript slash commands, not a public browser tool surface. `/browser-js-ast` accepts explicit local files/editor text, supports `--slice offset:length`, and may return lexical inventory for large bundles instead of AST.

## Recovery

| Symptom | Do |
|---|---|
| No bridge/browser/tab | `browser_tabs list`; ask user: `/browser-status`, install, reload, open tab |
| Stale tab | `browser_tabs list`; use live `tabId` |
| Selector missing | re-observe `scan`/`html`; `browser_frame`; verified retry |
| Timeout | re-observe; `browser_wait action=diagnose`; narrow/raise bound |
| Body/request missing | start recorder before action; list exact requests |
| Resource `stale`/`etag mismatch` on read | artifact changed under the handle — re-capture to mint a fresh `browser-result://`/`pi-ref://` URI; never retry the old one |
| Tool/command not found | `pi-browser --help`; web-security needs `PI_BROWSER_TOOL_PROFILE` unset (not `core`) |
| Mature bridge fail | explicit target/template/path; inspect stdout/stderr artifacts |
| Upload/download blocked | dedicated transfer tool + valid selector/path/mode + confirmation |

## Index

- Playbooks: `D:/Pi/agent/extensions/pi-browser-tools/docs/playbooks/` — `first-pass-browser-triage` · `recon-and-discovery` · `request-capture-and-replay` · `sqli-verification` · `ssrf-oast` · `auth-session-jwt` · `evidence-and-reporting`
- Methodology map: `docs/reference/web-security-methodology-map.md`
- Tool contracts: `docs/generated/browser-tool-contract.generated.md` · Native protocol: `docs/generated/native-protocol.generated.md` · Boundaries: `docs/tool-boundaries.md`
- Install/runtime SOP: `AI_INSTALL.md` · CLI usage: `docs/cli.md`

## Output

Answer in Chinese unless asked otherwise. Concise: action, result, evidence, next step + relevant IDs and artifact URIs/paths. Never expose secrets or large raw payloads.
