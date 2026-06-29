---
name: browser-pilot-cli
description: "Operate live browser pages through the browser-pilot CLI. Invoke when a shell-capable agent must observe, act, wait, capture evidence, or inspect artifacts."
license: Apache-2.0
compatibility: browser-pilot CLI 0.3.0+ on any shell-capable platform, Native Browser Bridge connected. Drives the same tool core as the Pi-native frontend over a user-local daemon. For in-process Pi-native `browser_*` calls, see the sibling **browser-pilot** skill.
---

# Browser Pilot CLI

Drive live browser pages with the `browser-pilot` shell CLI — the same tool core as Pi-native, exposed as subcommands over a user-local singleton daemon.

**This skill complements the CLI; it does not restate it.** The CLI is self-describing: `browser-pilot commands --json` lists every command + its `agentCli` routing, and `browser-pilot schema <cmd> --json` gives exact flags/params. Read schema for flags instead of trusting hard-coded lists. What follows is how to drive the CLI, sequence tools, and avoid stale workflows.

Three facts shape everything below:

- **Perception is no-mode `browser-pilot observe --json`.** It returns the canonical ABML `PageObservation`: target context, gist/outline, entities, actionables/refs, readable content digest, visible text index, evidence/artifact refs, snapshot/diff/causal/memory/diagnostics when available. Do not choose `--mode` for normal page understanding. Explicit `--mode scan|content|html|text|tabs` is legacy/debug/projection compatibility only.
- **Action is `browser-pilot execute` with exactly one of `--script`/`--script-file` or `--program`.** Use `--program @program.json` for user-like page interaction through trusted physical input frames (`mouse` with move/press/release/wheel/drag, `key`, `text`, `wait`, `eval`). Use `--script-file` for pure JavaScript reads, computations, page APIs, and compact extraction.
- **Verification is mandatory after action.** Run one bounded step, then use `wait`, no-mode `observe --json`, network/hook evidence, or artifact reads to verify. Do not assume a dispatch result means semantic success.

On long lists/tables prefer the canonical observation products (`gist`, `outline`, `collections`, `relations`, `treeDiff`, `causal`) before hand-writing extraction JS. Raw dynamic diffs can churn; read summaries first and prefer `treeDiff` for structural change.

## Driving the CLI

- **Output**: human on a TTY, JSON otherwise; force with `--json` / `--text`. Use the installed `browser-pilot` binary for machine JSON; for `npm`-wrapped debugging use `npm --silent run cli -- ...` because plain `npm run cli` prepends a banner to stdout.
- **Connect first for multi-step work**: `browser-pilot connect --wait --json` idempotently starts/reuses the daemon, starts the bridge, and waits for the extension. Prefer `--wait`; the non-waiting form can return `ready:false` before the extension has migrated. `browser-pilot status --json` is read-only; `doctor --json` is broader diagnostics. Do not use `daemon stop` as routine cleanup.
- **Discover, do not memorize**: `browser-pilot commands --json` → pick the command; `browser-pilot schema <cmd> --json` → exact flags. When `agentCli.mode:"natural"` exists, the natural subcommand is the preferred path, for example `wait selector`, `network start`, `frame evaluate`, or `hook install-targets`. Inspect it with `schema <cmd> <natural-subcommand> --json`.
- **Files beat shell quoting** for non-trivial JS / program frames / JSON / raw request / template / params: `--script-file`, `--program @program.json`, `--command @file`, `http-replay --raw-request @req.txt`, `--request @req.json`, `--har-path cap.har`, `template --template-path t.yaml`, and `browser-pilot validate <cmd> --params @params.json --json`.

## Loop

1. `browser-pilot connect --wait --json` once for multi-step work.
2. `browser-pilot tabs --action list --json` and note `tabHandle`; pass it as `--target-ref` when disambiguation is needed. Numeric `tabId` remains compatibility-only.
3. `browser-pilot observe --json` to read the canonical page model.
4. Pick the route by intent.
5. Run one bounded action or capture step.
6. Verify with `wait`, no-mode `observe --json`, network/hook evidence, or artifact reads.
7. Report target ref/tab, URL, relevant IDs, artifact URI/path, result, and next step.

Sessions are managed via `tabs` session subcommands, not a per-command flag. Outputs default to compact, redacted summaries; size reads with `--limit`/`--offset`/`--json-path` where commands expose them. `detailLevel`/`maxChars` are internal unless schema says otherwise.

## Memory

Local store under `.pi/browser-memory/` is fact-only. Record stable facts about a site: endpoints, durable selectors, auth shape, invariant UI behavior, or other reusable knowledge. Do not record SOP/procedure/how-to sequences.

- **Recall through observe:** no-mode `browser-pilot observe --json` may surface current URL / query-relevant facts in the observation memory plane. Inline cards are bounded; collapsed cards carry `browser-memory://...` handles.
- **Manual recall/read:** use `browser-pilot memory --action recall --url <url> --query "<keywords>" --json`, then `browser-pilot memory --action read --uri <browser-memory://...> --json` for surfaced handles.
- **Record on success:** `browser-pilot memory --action record --kind fact --scope-kind origin --url <url> --title "<stable fact>" --body "<concise factual detail>" --json`. Cite evidence refs only when they resolve. No secrets in memory.

## Routes

Pick the subcommand by intent; get exact flags from `schema <cmd> --json`.

| Intent | Subcommand |
|---|---|
| Page structure/model/readable content/visible text/evidence refs | `observe --json` |
| Page delta after an action | `observe --json` with diff/baseline flags from `schema observe --json` |
| Exact DOM/HTML debug projection | explicit legacy/debug `observe --mode html ...` only when canonical observation + artifacts are insufficient |
| Legacy content/text projection | explicit legacy/debug `observe --mode content|text ...` only for compatibility |
| Visual layout | `screenshot` |
| Inside iframe | `frame list` → `frame evaluate --frame-id <id> --expression <js>` |
| Click/type/scroll/drag/user-like interaction | `execute --program @program.json` |
| Pure JavaScript read/compute/page API/compact extraction | `execute --script-file act.js` |
| JS action returned ok but page did not semantically change | try `execute --program @program.json` with trusted physical input; verify with wait/observe/evidence |
| CDP / native bridge command | `command --command @native-command.json` |
| Wait navigation/selector/load/idle | `wait selector --selector "#id"` / `wait navigate --url ...` / `wait network-idle`; never sleep-loop |
| User points to element | `pick` |
| Download / upload | `download` / `upload --files <absolute> --confirm`; do not hand-script clicks |
| Record requests/HAR/body | `network start` → act → `network list`/`get`/`body`/`export-har` |
| Capture console/error/storage/ws/crypto/DOM-sink/listener | `hook install-targets --targets ...` → act → `hook collect --session-id ...` or `evidence` |
| Status/title/headers/redirect/TLS/tech | `crawl --action fingerprint` with explicit scope |
| Links/forms/API/source-maps/SW | `crawl` with explicit scope and bounds |
| Replay/mutate one request | `http-replay`; never page `fetch` when replay is the goal |
| Path/file/route discovery | `fuzz --mode path` + wordlist/baseline |
| Virtual hosts | `fuzz --mode vhost` + host candidates |
| Query/JSON/form/multipart/header params | `fuzz --mode param` + captured/raw request |
| SQLi | `sqli`; builtin default, sqlmap only for bounded deep checks |
| Exposure/config/custom templates | `template`; builtin default |
| Mature nuclei | `template --engine nuclei` |
| OAST callback proof | `callback-oast --action start` → inject/trigger → collect → stop |
| Cookie/JWT/JWE/PASETO/Rails session | `cookie-analyze` |
| Local browser memory | `memory --action recall` → `memory --action read` |

## Observe products: canonical PageObservation

`browser-pilot observe --json` returns the canonical ABML `PageObservation`. Reach for the model before writing extraction JS. Observe gives structure, relations, change, causality, text/content digests, and evidence pointers; per-item data values such as prices, ratings, cell text, or titles may still need `execute --script-file` once the model tells you where to look.

| You need | Read from observation | Then |
|---|---|---|
| Page summary and likely task entry points | `summary.pageObservation.gist`, `outline`, `actionables`, `refs` | act with `execute --program` or extract values with JS |
| A long/virtualized/lazy/paginated list | `collections`, completeness/continuation, evidence refs | decide budget; per-item values → `execute --script-file` |
| Big repeated list/table as a group | `outline`, `gist`, `relations` | exact cell/item values → `execute --script-file` |
| Readable article/document content | `content` digest/preview and artifact hints | read artifact when full text is needed |
| Visible text search | text digest/index and artifact hints | read artifact/search when inline preview is insufficient |
| What changed after operating a control | no-mode observe with diff/baseline flags → `treeDiff` / `causal` | prefer `treeDiff`; use causal requests for network proof |
| Which requests an action fired | `network start` first, act, then observe with baseline → `causal.requests` | inspect network request/body as needed |
| Exact DOM/HTML evidence | canonical evidence/artifact hints first | use explicit legacy `--mode html` only as debug fallback |

Pass baselines by reference when schema exposes them, for example snapshot id or saved artifact path. Never inline a prior envelope into argv. Absent fields are not automatically errors; follow `nextActions`, `artifact_hints`, and saved artifact descriptors.

## Action

Do not set `observe --mode` for normal page understanding. Use no-mode `browser-pilot observe --json`. Explicit `--mode scan|content|html|text|tabs` is legacy/debug/projection compatibility and should not be the default workflow.

### Use execute program for user-like interaction

Use `browser-pilot execute --program @program.json --json` for clicks, typing, key presses, scroll/wheel, drag, and trusted-event-gated UI. A program is a JSON array; each frame has exactly one discriminator such as `mouse`, `key`, `text`, `wait`, or `eval`; `mouse` uses values like `move`, `press`, `release`, `wheel`, or `drag`. Optional `delay` is a universal modifier according to schema. Always validate non-trivial programs first:

```bash
browser-pilot validate execute --params @params.json --json
```

Example params file:

```json
{
  "targetRef": "<tabHandle>",
  "program": [
    { "mouse": "press", "x": 420, "y": 260 },
    { "wait": 100 },
    { "text": "example" },
    { "key": "down", "code": "Enter" },
    { "key": "up", "code": "Enter" }
  ]
}
```

Then run with either `--program @program.json` if schema/help exposes it directly, or `--params @params.json` through the standard CLI route. Prefer files to inline JSON.

### Use execute script for pure JavaScript

Use `browser-pilot execute --script-file act.js --json` for compact DOM reads, page API calls, pure computation, and value extraction after observe has identified structure. Return small structured objects, for example `{ok, reason, value}`. Large/sensitive results are summarized and saved as artifacts; read them with `artifact` rather than re-running.

After any write, read the cheap `effect` block in the result (`mutations`, settled state, dirty roots/overflow, navigation/recorder deltas). If `targetRegionDirty:true`, `BACKEND_NODE_STALE`, `OOPIF_SESSION_UNSUPPORTED`, or `HANDLE_NOT_FOUND` appears after using a `bp-ref://`, refresh with no-mode `observe --json` before reusing that ref.

### Trusted refs and fallback

Observed refs are short-lived. Prefer `execute --program` for trusted physical interaction. If using a runtime helper such as `pi.click(ref)` remains available in the current schema/runtime, treat it as a narrow compatibility helper for fresh observed refs, not as the primary workflow. Verify with effect, wait, observe, or network/hook evidence; do not double-click just because a dispatch helper does not verify intent internally.

Do not pass native bridge commands to `browser-pilot execute --script` or `--script-file`. Use `browser-pilot command --command @native-command.json` for explicit native bridge/CDP/tabs/management commands.

## Native command

`command --command @native-command.json` is the escape hatch for explicit bridge objects: tabs management, CDP, persistent CDP, cookies, content settings, intercept, ws, and low-level input. Prefer `execute --program` for ordinary page interaction; use `command --command @file` when you need exact native protocol control or an action not represented by `execute program`. Pass explicit `tabId`/`targetRef` plus exact `sessionId`/`requestId`/`ruleId`/`url`/`steps`/matchers. Do not invent withdrawn subcommands; `/browser-js-ast`, `/browser-wasm`, and `/browser-ws` are local-file slash commands, not public browser tools.

## Read results

Results return a compact `summary`, resource links, sections, and often `saved.path`/artifacts. Sensitive fields are redacted; a redacted field carries a pointer. Read exact paths with `artifact --mode json --json-path <p>` or `--pick`. Read large/sensitive payloads on demand — never re-run a capture just to re-read it, and never paste raw bodies/tokens.

Non-obvious bits:

- Most artifacts keep primary results under `data`, but canonical observe artifacts may expose `pageObservation` and related paths. Follow the result's own artifact hints rather than assuming one fixed root.
- Use `artifact --mode search --query "..."` to find text; `--regex` is only for short-line patterns.
- `--pick` repeats once per path; it is not a JSON-array string.
- `read_saved_artifact ...` in `nextActions` means read already-saved evidence without re-capturing.

## Bounds before expansive routes

Bound expansive routes by explicit scope first: URL, captured request, raw request, HAR entry, paths, words, templates, or host candidates. Then use each command's real knobs from `schema <cmd> --json`. Generic caps such as `--max-depth`, `--max-pages`, `--timeout-ms`, or `--output-path` may be internal; trust schema and CLI errors.

- Private/link-local/metadata blocked → `--allow-private-targets` only for explicit internal testing.
- Launcher overrides → `--allow-launcher-override` only when intentionally using external tools.
- `--bind-browser-session` injects browser cookies only; traffic does not route through the tab.
- `nextActions` are suggestions, not a mandatory pipeline. Do not fabricate request templates when a captured/HAR request is required.

## Recovery

| Symptom | Do |
|---|---|
| No bridge/browser/tab | `connect --wait --json`, then `status --json` / `doctor --json`. If the extension is not loaded, surface it as human action; do not retry-loop |
| `CLI_EXTENSION_NOT_CONNECTED` | daemon/bridge up, extension not connected before timeout — load/enable it, open a tab, re-run `connect --wait` |
| `CLI_BRIDGE_START_FAILED` | bridge failed to start — `doctor --json` before waiting on the extension |
| Stale tab | If `recovery.suggestedTargetRef` is present, retry with `--target-ref`; otherwise list tabs and use a live `tabHandle` |
| `targetRegionDirty:true` in execute effect | no-mode `browser-pilot observe --json` before reusing the same ref |
| Selector/ref missing | no-mode observe, inspect evidence/artifact refs, frame list if iframe placement is suspected, then verified retry |
| Timeout | `wait diagnose` for the wait id; narrow or raise the relevant bound from schema |
| Body/request missing | start recorder before action; list exact requests |
| Resource stale / `HANDLE_NOT_FOUND` / baseline expired | re-capture with no-mode `observe --json` or the original command to mint fresh evidence; never retry the old handle |
| Context lost / delta baseline forgotten | no-mode `browser-pilot observe --json`; search artifacts; recall durable facts with memory; do not disable relevance/memory globally |
| Unexplained `INVALID_RULE` / unsupported action | inspect `status --json` / `tabs --action snapshot --json` for stale extension; reload the extension if needed |
| Command not found | `browser-pilot --help`; if commands are missing, package/daemon may be stale |
| TLS certificate failure in crawl/fuzz/http-replay | corporate proxy/AV/root CA issue; use the error remediation and restart daemon if adding CA roots |

## Index

- CLI discovery: `browser-pilot commands --json`, `browser-pilot schema <cmd> --json`, `browser-pilot <cmd> --help`
- Playbooks: `docs/playbooks/`
- Methodology map: `docs/reference/web-security-methodology-map.md`
- CLI usage: `docs/cli.md`
- Tool contracts: `docs/generated/browser-tool-contract.generated.md`
- Native protocol: `docs/generated/native-protocol.generated.md`
- Boundaries: `docs/tool-boundaries.md`
- In-process Pi-native frontend: **browser-pilot** skill

## Output

Answer in Chinese unless asked otherwise. Be concise: action, result, evidence, next step, and relevant IDs/artifact URIs/paths. Never expose secrets or large raw payloads.
