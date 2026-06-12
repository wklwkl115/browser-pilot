---
name: pi-browser-cli
description: "Shell/CLI frontend for operating live browser pages — use when a shell-capable agent drives the `pi-browser` command-line tool (subcommands, `--json`) to: gate readiness via connect/status/doctor, list/switch tabs, scan/read DOM/text/HTML/content, click/type via JavaScript or CDP, wait for page state, capture network/hook/screenshot evidence, read result artifacts or browser-result:// resources, download/upload files, replay or fuzz HTTP requests, crawl endpoints/source maps, analyze cookies/JWT/JWE/PASETO/session, check SQLi/template/nuclei/OAST findings. A Pi-native agent that instead calls the browser_* tools directly: use the pi-browser-tools skill. Runtime browser-use only; not for extension source development or repo tests."
license: MIT
compatibility: pi-browser CLI 0.3.0+ on any shell-capable platform, Native Browser Bridge connected. Drives the same tool core as the Pi-native frontend over a user-local daemon. For in-process Pi-native `browser_*` calls, see the sibling **pi-browser-tools** skill.
---

# Pi Browser CLI

Drive live browser pages with the `pi-browser` shell CLI — the same tool core as Pi-native, exposed as subcommands over a user-local singleton daemon.

**This skill complements the CLI; it does not restate it.** The CLI is self-describing: `pi-browser commands --json` lists every command + its `agentCli` routing, and `pi-browser schema <cmd> --json` (or `schema <cmd> <natural-subcommand> --json`) gives exact flags/params. That is the single source of truth and it never drifts — **read it for flags instead of trusting any hard-coded flag list.** What follows is how to *drive* the CLI and *sequence* the tools: the loop, the routing, the boundaries, the gotchas.

Three facts shape everything below:
- **Perception is `pi-browser observe`.** ABML (AX merge, entities, relations, diff) is wired into it and observes only; verbs like `read(pi-ref://...)` appearing in result hints are vocabulary, not extra subcommands.
- **Action is the JavaScript you pass to `pi-browser execute`** (prefer `--script-file`). There is no click/type subcommand and none is planned — a structured action arm was tried and removed because agents reverted to JS.
- **The escape for synthetic-event-blind targets is physical input.** When a trusted-event-gated control, canvas, WebGL, or cross-origin iframe silently ignores `el.click()`, send `pi-browser command --command @file` with `input.pointer` (`gesture:"press"|"drag"|"wheel"|"hover"`, `x`, `y`) or `input.keys` (`text` or key names) at measured coordinates.

On long lists/tables prefer the reading products (`outline`/`gist`) and `causal` (which APIs an action hit); raw `diff` churns on dynamic pages — read `diff.summary` first and prefer `treeDiff`. Full map: `docs/abml-tool-coverage-map.md`.

## Driving the CLI

- **Output**: human on a TTY, JSON otherwise; force with `--json` / `--text`. Use the installed `pi-browser` binary for machine JSON; for `npm`-wrapped debugging use `npm --silent run cli -- ...` (plain `npm run cli` prepends a banner to stdout).
- **Connect first for multi-step work**: `pi-browser connect --wait --json` idempotently starts/reuses the daemon, starts the bridge, and **waits** for the extension — covering the ~1-2s window where the extension dials into a fresh bridge. Prefer `--wait`; the non-waiting form can return `ready:false` before the extension has migrated. `pi-browser status --json` is read-only (never starts anything); `doctor --json` is broader diagnostics. Don't use `daemon stop` as routine cleanup.
- **Discover, don't memorize**: `pi-browser commands --json` → pick the command; `pi-browser schema <cmd> --json` → exact flags. When `agentCli.mode:"natural"` exists, the **natural subcommand** is the preferred path (e.g. `wait selector`, `network start`, `frame evaluate`, `hook install-targets`) — inspect it via `schema <cmd> <natural-subcommand> --json`. The root `<cmd> --action <a> --params <json>` interface remains for advanced/low-frequency native actions; natural subcommands reject mixing `--params`. `pi-browser command --command @file` is the full native-bridge escape hatch.
- **Files beat shell quoting** for any non-trivial JS / JSON / raw request / template / params: `--script-file`, `--command @file`, `http-replay --raw-request @req.txt` / `--request @req.json` / `--har-path cap.har`, `template --template-path t.yaml`, and `pi-browser validate <cmd> --params @params.json --json` to check params without daemon/browser.

## Loop

1. `pi-browser connect --wait --json` once for multi-step work → `pi-browser tabs --action list --json` → note the target `tabId`. A `tabId` is **not stable** (changes on navigation/reload) — omit `--tab-id` to act on the active tab, or re-read after navigating; pass it explicitly mainly to disambiguate open tabs. `TAB_NOT_FOUND` returns the live id in `recovery`.
2. Pick the route by intent (Routes).
3. Run **one bounded step**.
4. Verify: `pi-browser wait ...` / re-observe / network|hook evidence / read artifact.
5. Report: `tabId`, URL, selector/request/session IDs, artifact URI/path, next step.

Sessions are managed via `tabs` session subcommands, not a per-command flag. Outputs default to a compact, redacted summary; size reads with `--limit`/`--offset`/`--json-path` (`detailLevel`/`maxChars` are internal, not flags).

Memory is a Loop bookend: `observe --mode scan|text` may surface current URL/intent-matched SOPs in `envelope.memory`; on success `pi-browser memory --action record` at step 5. See Memory.

## Memory

Local store under `.pi/browser-memory/` (`origin|task|project` scope) so you stop re-deriving action sequences. `sop` = reusable **procedure** (HOW); `fact` = stable **knowledge** about a site (endpoints, auth shape, durable selectors). The store stays empty until you record — recall only pays after you have paid into it. Exact flags: `schema memory --json`.

- **Recall (observe):** `observe --mode scan|text` automatically surfaces current URL/intent-matched memory in `envelope.memory` with verification status; same-origin alone is not enough. Inline cards are bounded; collapsed cards carry `browser-memory://...` handles. Use `memory --action read --uri <browser-memory://...>` for a surfaced handle, or `memory --action recall --url <url> --query "<keywords>"` for manual cross-scope follow-up.
- **Record (on success — fill and send, ~30s):**
  `pi-browser memory --action record --kind sop --scope-kind origin --url <url> --title "<verb-y outcome>" --triggers "<keywords you'd search by>" --body "1. <step with exact selector/input/wait>\n2. <…>"`.
  **Evidence refs are optional** — cite a `saved.path` when you have one; any ref you do cite must resolve. No secrets in `--body`. A `record candidate:` hint = this origin has no SOP yet. Recording auto-dedups and returns `duplicateCandidates` — supersede, don't pile up.
- **Self-heal:** a recalled SOP that no longer works → `record` the corrected version; it supersedes the old one.

## Routes (intent → subcommand)

Pick the subcommand by intent; get its flags from `schema <cmd> --json`.

| Intent | Subcommand |
|---|---|
| Page structure / model | `observe --mode scan` |
| Main article text | `observe --mode content` |
| Exact DOM/HTML for a selector | `observe --mode html --selector <sel>` (`--html-mode` per schema) |
| Visible text fast | `observe --mode text` |
| Visual layout | `screenshot` |
| Inside iframe | `frame list` (read child `frameId`) → `frame evaluate --frame-id <id> --expression <js>`. A top-level scan does NOT cover child frames structurally |
| Click/type/scroll/mutate | `execute --script-file act.js` → read cheap `effect` in the result → `wait ...` / re-observe |
| Action returned ok but page didn't change | trusted-event-gated/canvas → `command --command @file` with `input.pointer` / `input.keys` |
| CDP / native command | `command --command @native-command.json` |
| Wait nav/selector/load/idle | `wait selector --selector "#id"` / `wait navigate --url ...` / `wait network-idle` (never sleep-loop) |
| User points to element | `pick` |
| Download / upload | `download` / `upload --files <absolute> --confirm` (no hand-scripted clicks) |
| Record requests/HAR/body | `network start` → act → `network list`/`get`/`body`/`export-har` (by `--session-id`) |
| Capture console/error/storage/ws/crypto/DOM-sink/listener | `hook install-targets --targets ...` → act → `hook collect --session-id ...` or `evidence` |
| Status/title/headers/redirect/TLS/tech | `crawl --action fingerprint` + scope |
| Links/forms/API/source-maps/SW | `crawl` (scope+bounds; `--active-graphql-introspection` for active GraphQL) |
| Replay/mutate one request | `http-replay` (never page `fetch`) |
| Path/file/route discovery | `fuzz --mode path` + wordlist/baseline |
| Virtual hosts | `fuzz --mode vhost` + host candidates |
| Query/JSON/form/multipart/header params | `fuzz --mode param` + captured/raw request |
| SQLi | `sqli` (`--engine builtin` default; `sqlmap` only for bounded deep) |
| Exposure/config/custom templates | `template` (`builtin` default) |
| Mature nuclei | `template --engine nuclei` |
| OAST callback proof | `callback-oast --action start` → inject/`--action trigger` → `--action collect` → `--action stop` (no natural subcommands) |
| Cookie/JWT/JWE/PASETO/Rails session | `cookie-analyze` |
| Local browser memory | `memory --action recall` → `memory --action read` |

## Observe products (scan envelope)

`observe --mode scan` returns an envelope whose **top-level fields are where the page MODEL lives** — reach for them before hand-writing extraction JS. Boundary: observe gives **structure / relations / change / causality**; **per-item data VALUES (prices, ratings, cell text, titles) are JS** — once the structure tells you *where* a value is, extract it with `execute`.

| You need | Read this envelope field | Then |
|---|---|---|
| A big repeated list/table as a group | `outline` / `gist` (fold by AX container) | per-item values → `execute` |
| Visible text/link rows already on screen | `summary.rows` or `artifact --mode json --json-path data.rows` | site-specific values beyond text/href/geometry → `execute` |
| Visible images/video/audio candidates | `summary.media_candidates` or `artifact --mode json --json-path data.media_candidates` | associated headline/ranking/source semantics → `execute` |
| What changed after operating a control | scan with a baseline → **`treeDiff`** | raw `diff` churns on dynamic pages — prefer `treeDiff`; per-item content → `execute` |
| Row/column/header relations of a table | `relations` (`summary.tableCells` + cell `relations[]` `cellOf`/`headerFor`) | exact values → `execute` |
| Which requests an action fired | **`network start` FIRST**, then scan with baseline → `causal.requests` | — |

Component-library selects/dropdowns (Element Plus / Ant Design / MUI style): popup DOM is often lazy and the first visible popper can be stale from the previous control. Identify the popup from the trigger, not visual heuristics: read `aria-controls` plus `aria-expanded`; body-click/close, reopen the target trigger, then query the popup by that id. `observe --mode scan` records page-wide `data.controls_pairs` (including off-screen sources); read it with `artifact --mode json --json-path data.controls_pairs`, and re-scan after opening if the first scan had no resolvable pair.

Pass a baseline **by reference**: `--baseline-snapshot-id <id>` (a prior scan's snapshotId) or `--baseline-path <file>` (the prior scan's auto-saved artifact — its path is the result's `saved.path`; there is no `--output-path`). Never inline the prior envelope (argv limit). `treeDiff`/`causal`/`relations` are top-level live AND mirrored into the saved artifact's `envelope.*`; absent ≠ error. The scan points you at them via `nextActions`.

## Read results

Results return a `summary` + `resource_link`(s) + `sections`. Sensitive fields are redacted; a redacted field carries `{redacted:true, raw, jsonPath}` — read that exact path with `artifact --mode json --json-path <p>` or `--pick`. Read large/sensitive payloads on demand — never re-run a capture to re-read it, never paste raw bodies/tokens. (`artifact` flags: `schema artifact --json`.) Non-obvious bits:

- Most artifacts keep primary results under `data` → start `--mode json --json-path data`, then `data.<key>`.
- **Find text** with `--mode search --query "…"` (not `--search`) — windows a match even inside one very long line (minified JS/HTML); `--regex` only for short-line patterns. `--query` errors outside search mode.
- `--pick` repeats once per path — **not** a JSON-array string. Long scalar (`data.content`) → `--offset`/`--limit` char windows, follow `nextOffset`.
- `read_saved_artifact ...` in `nextActions` = read already-saved evidence without re-capturing.

## Bounds (before expansive routes)

Bound expansive routes by **explicit scope first** — `--url` / captured request / raw request / HAR entry / `--paths` / `--words` / `--templates` / host candidates — then each command's real knobs (read them from `schema <cmd> --json`: e.g. fuzz `--match-status`/`--filter-*`, template `--max-requests`/`--severities`, sqli `--level`/`--risk`, OAST `--trigger-timeout-ms`/`--max-runtime-ms`). Generic per-run caps (`--max-depth`/`--max-pages`/`--timeout-ms`/`--rate-limit-per-second`/`--output-path`) are **internal** — the CLI rejects them and points you at the right knob.

- Private/link-local/metadata blocked → `--allow-private-targets` only for explicit internal testing. Launcher overrides (`--sqlmap-path`/`--nuclei-path`) → `--allow-launcher-override`. `--wordlist-path` limited to CWD or `.pi/`.
- `--bind-browser-session` injects browser cookies only (traffic does not route through the tab) and reflects a double-submit CSRF cookie into its header by default (`csrfReflected` reports the names) — so authenticated `http-replay` works without page `fetch`. Override with `--csrf-cookie`/`--csrf-header`, or `--reflect-csrf false` to test CSRF protection.
- `nextActions` are suggestions, not a mandatory pipeline. Do not fabricate request templates when a captured/HAR request is required.

## Action

- Always set `observe --mode` (`scan`/`content`/`html`/`text`/`tabs`). No `auto`, no cross-mode selector fallback. Selector miss → re-observe `scan`/`html` → `frame` → verified retry. `pi-ref://` and observe baselines are short-lived; on stale/expired/`HANDLE_NOT_FOUND`, re-observe — never retry the old handle.
- `execute --script-file <f>` = raw JS only; return `{ok, reason, value}`. After any write, read the cheap `effect` block in the result (`mutations`, `settled`, navigation/recorder deltas) before paying for a full re-observe. Input: focus → native setter → dispatch `input`/`change` → read back. If a synthetic `el.click()`/input returns `ok` but nothing changed (trusted-event-gated), escalate via `command --command @file` with `input.pointer`/`input.keys` at the rect center.
- Don't ask for `--redact false`; follow redaction pointers. Track when present: `operationId snapshotId requestId waitId listenerId sessionId selectionVersion sourceMode`.

Click (`act.js` for `--script-file`):
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

`command --command @native-command.json` for explicit objects: `tabs management cdp persistent_cdp cookies contentSettings input.* intercept.* ws.*`. Use `input.pointer` (`gesture:"press"|"drag"|"wheel"|"hover"`, `x`, `y`) and `input.keys` (`text` or key names) for trusted physical input; summaries redact raw inserted text and report char counts. Pass explicit `tabId` + exact `sessionId`/`requestId`/`ruleId`/`url`/`steps`/matchers. `ws.replay` fail → inspect `stepIndex`/`lastSeq`/`partialSteps`/`partialTranscript`, resume from the failing step. Do not invent withdrawn subcommands; `/browser-js-ast`, `/browser-wasm`, `/browser-ws` are local-file slash commands, not a public browser tool surface.

## Recovery

| Symptom | Do |
|---|---|
| No bridge/browser/tab | `connect --wait --json`, then `status --json` / `doctor --json`. `--wait` covers the fresh-bridge dial-in window; the non-waiting form can falsely report `ready:false`. If the extension is genuinely not loaded, that is a human action — surface it, don't retry-loop |
| `CLI_EXTENSION_NOT_CONNECTED` (exit 3) | daemon/bridge up, extension not connected before timeout — load/enable it, open a tab, re-`connect --wait` |
| `CLI_BRIDGE_START_FAILED` | bridge failed to start (category `bridge`) — `doctor --json` before waiting on the extension |
| Stale tab | `tabs --action list`; use live `tabId` |
| Selector missing | re-observe `scan`/`html`; `frame`; verified retry |
| Timeout | `wait diagnose --params '{"waitId":"<id>"}'` (selector-specific `selectorDiagnostics`); narrow/raise bound |
| Body/request missing | start recorder before action; list exact requests |
| Resource `stale`/`HANDLE_NOT_FOUND`/baseline expired | re-capture with `observe --mode scan` or the original command to mint fresh evidence; never retry the old handle |
| Context lost / delta baseline forgotten | run `pi-browser observe --mode scan --fresh --json` once to re-anchor the page; do not turn off relevance or memory globally |
| Unexplained `INVALID_RULE` / unsupported action | inspect `pi-browser status --json` / `tabs --action snapshot --json` for `extension.extensionStale`; if true or `reportedBuild` is missing, reload the browser extension and retry |
| Command not found | `pi-browser --help`; all 22 commands listed unless package/daemon is stale |
| `crawl`/`fuzz`/`http-replay` TLS `unable to verify the first certificate` | TLS-intercepting proxy/AV/corporate CA. Daemon trusts the OS/browser CA store on Node ≥22; if it persists set `NODE_EXTRA_CA_CERTS=<root.pem>` and restart. The error's `remediation` names the fix |

## Index

- Playbooks: `docs/playbooks/` — triage · recon · capture-and-replay · sqli · ssrf-oast · auth-session-jwt · evidence-and-reporting
- Methodology map: `docs/reference/web-security-methodology-map.md` · CLI usage: `docs/cli.md`
- Tool contracts: `docs/generated/browser-tool-contract.generated.md` · Native protocol: `docs/generated/native-protocol.generated.md` · Boundaries: `docs/tool-boundaries.md`
- In-process Pi-native frontend: **pi-browser-tools** skill

## Output

Answer in Chinese unless asked otherwise. Concise: action, result, evidence, next step + relevant IDs and artifact URIs/paths. Never expose secrets or large raw payloads.
