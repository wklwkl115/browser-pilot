---
name: pi-browser-tools
description: "Use when operating, inspecting, debugging, automating, or verifying live browser pages through browser_* tools: open/list/switch tabs, scan/read DOM/text/HTML/content, click/type via JavaScript or CDP, wait for page state, capture network/hook/screenshot evidence, read result artifacts or browser-result:// resources, download/upload files, replay or fuzz HTTP requests, crawl endpoints/source maps, analyze cookies/JWT/JWE/PASETO/session, check SQLi/template/nuclei/OAST findings, and discover hidden tool groups. Runtime browser-use only; not for extension source development or repo tests."
license: MIT
compatibility: Pi browser-tools extension 0.3.0+, Native Browser Bridge connected. Works on any skill-supporting platform; transport-agnostic (MCP or direct tool calls).
---

# Pi Browser Tools

Live browser operation via `browser_*` tools. HOW only — methodology and route index. For depth, follow the Index.

## Loop

1. `browser_tabs list` → keep `tabId`; pass it to every tab-scoped call.
2. Pick the route by intent (Routes).
3. Run **one bounded step**.
4. Verify: `browser_wait` / re-observe / network|hook evidence / read artifact.
5. Report: `tabId`, URL, selector/request/session IDs, artifact URI/path, next step.

`browser_tabs create` opens a tab; `switch` only to intentionally change the active one. Omit `browserSessionId` unless juggling concurrent sessions. Default `detailLevel:"summary"`.

## Routes

| Intent | Call |
|---|---|
| Page structure | `browser_observe {mode:"scan"}` |
| Main article text | `browser_observe {mode:"content"}` |
| Exact DOM/HTML for selector | `browser_observe {mode:"html", selector, htmlMode}` |
| Visible text fast | `browser_observe {mode:"text"}` |
| Visual layout | `browser_screenshot` |
| Inside iframe | `browser_frame list` → `browser_frame evaluate` |
| Click/type/mutate state | `browser_execute` (JS) → `browser_wait` → re-observe |
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
| Reveal hidden tool group | `browser_tool_discovery {revealGroup}` |

## Read results

Tool results return a `summary` + `resource_link`(s) + `sections`. Read large/sensitive payloads on demand — never re-run a capture to re-read it, never paste raw bodies/tokens.

- **MCP client** → `resources/read uri=browser-result://…` with `mode=text|json|search|sample` + `offset`/`limit`/`jsonPath`/`search`. Take URIs from `resource_link`/`sections`/`nextActions`.
- **Direct / non-MCP** (or `PI_BROWSER_MCP_KEEP_ARTIFACT=1`) → `browser_artifact` with `jsonPath`/`pick`/`offset`/`search`.

## Tool visibility

Web-security tools are hidden by default under compact/minimal profiles.

- `browser_tool_discovery {group?, revealGroup?, includeDescriptions?}` — groups: `core state observe action evidence artifact web-security`. `revealGroup` exposes a group in later `tools/list`.
- Env: `PI_BROWSER_MCP_TOOL_VISIBILITY=full|compact|minimal` · `PI_BROWSER_MCP_DISCOVERY=0` disables the helper · `PI_BROWSER_MCP_KEEP_ARTIFACT=1` keeps `browser_artifact`.

## Bounds (set before expansive routes)

`maxDepth maxPages maxCases maxCandidates maxRequests timeoutMs rateLimitPerSecond` + match/filter + `outputPath` when output grows. OAST: `triggerTimeoutMs` (wait), `maxRuntimeMs` (long listener).

- Obtain explicit scope first: `url` / captured request / raw request / HAR entry / `paths` / `words` / `templates` / param names.
- Private/link-local/metadata blocked → `allowPrivateTargets:true` only for explicit internal testing.
- Launcher overrides (`sqlmapPath`/`nucleiPath`/`PI_*_PATH`) → `allowLauncherOverride:true`.
- `wordlistPath` limited to CWD or `.pi/`.
- `bindBrowserSession:true` injects browser cookies only (traffic does not route through the tab).
- `nextActions` are suggestions, not a mandatory pipeline. Do not fabricate request templates when a captured/HAR request is required.

## Action

- Always set `browser_observe.mode` (`scan`/`content`/`html`/`text`/`tabs`). No `auto`, no cross-mode selector fallback.
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

Do not invent tools `browser_intercept`/`browser_ws`/`browser_sources`/`browser_debugger`/`browser_storage`/`browser_canvas`. `/browser-js-ast`, `/browser-wasm`, `/browser-ws` are local-file/transcript slash commands, not public tools.

## Recovery

| Symptom | Do |
|---|---|
| No bridge/browser/tab | `browser_tabs list`; ask user: `/browser-status`, install, reload, open tab |
| Stale tab | `browser_tabs list`; use live `tabId` |
| Selector missing | re-observe `scan`/`html`; `browser_frame`; verified retry |
| Timeout | re-observe; `browser_wait action=diagnose`; narrow/raise bound |
| Body/request missing | start recorder before action; list exact requests |
| Tool not in list | `browser_tool_discovery {revealGroup}` |
| Mature bridge fail | explicit target/template/path; inspect stdout/stderr artifacts |
| Upload/download blocked | dedicated transfer tool + valid selector/path/mode + confirmation |

## Index

- Playbooks: `D:/Pi/agent/extensions/pi-browser-tools/docs/playbooks/` — `first-pass-browser-triage` · `recon-and-discovery` · `request-capture-and-replay` · `sqli-verification` · `ssrf-oast` · `auth-session-jwt` · `evidence-and-reporting`
- Methodology map: `docs/reference/web-security-methodology-map.md`
- Tool contracts: `docs/generated/browser-tool-contract.generated.md` · Native protocol: `docs/generated/native-protocol.generated.md` · Boundaries: `docs/tool-boundaries.md`
- Install/runtime SOP: `AI_INSTALL.md`
- MCP clients: `prompts/get` → `browser-first-observe` · `browser-evidence-capture` · `browser-web-security-scope` · `browser-artifact-read`

## Output

Answer in Chinese unless asked otherwise. Concise: action, result, evidence, next step + relevant IDs and artifact URIs/paths. Never expose secrets or large raw payloads.
