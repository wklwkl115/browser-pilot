<div align="center">

# Browser Pilot

**Give your AI agent a real browser — not a screenshot.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-browser__*-blueviolet.svg)](#tools)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)

</div>

Browser Pilot gives AI agents direct control over real Chrome/Edge tabs — DOM structure,
JavaScript execution, CDP commands, network traffic, cookie jars, and file transfers.
Everything a human can do in DevTools, your agent can do through composable
`browser_*` tools.

> **Not a simulator. Not a proxy. Not a screenshot parser.**
> Your agent reads the DOM as a semantic model and writes JavaScript like a developer in DevTools.

```
# browser-pilot-executable
$ browser-pilot observe --json | jq '.gist'
"Forum topic list with 14 visible rows, navigation sidebar, user menu.
 3 forms (search, login, compose), 47 actionable elements."

# browser-pilot-executable
$ browser-pilot execute --script "document.querySelector('.topic-list .main-link a').href" --read-only --json
{ "schema": "browser-operation/v2", "status": "completed", "classification": "success", "completionVerified": true, "ok": true, "completion": { "source": "script-resolved", "evidence": { "result": "https://linux.do/t/welcome/1" } }, "business": { "status": "inconclusive", "source": "abml", "reason": "no_semantic_effect" }, "semantic": { "provider": "abml", "stability": "stable", "effect": { "summary": { "hasSemanticEffect": false } } }, "continuation": null }

# browser-pilot-executable
$ browser-pilot network capture-reload --json
# browser-pilot-executable
$ browser-pilot artifact paths --path <saved.path-from-network-result> --json
```

## Why Browser Pilot

Most browser automation tools give agents a **screenshot and a click coordinate**.
Browser Pilot gives agents what they actually need:

- **Structured perception** — canonical ABML page observations with entity extraction, accessibility tree
  fusion, structural diff, content/text digests, evidence artifacts, and template compression. Your agent sees one semantic page model, not pixels or competing modes.
- **Direct execution with semantic settlement** — run arbitrary JavaScript or trusted physical input, then receive dispatch evidence and a fenced ABML business/effect model in the same transaction.
  Agents write the same DOM code a developer would write in DevTools.
- **Physical input escape** — when trusted-event-gated controls ignore synthetic clicks,
  CDP physical input (`input.pointer` / `input.keys`) gets through. No more "button doesn't
  respond" dead ends.
- **Full network visibility** — record/replay/mutate HTTP traffic, export HAR, capture
  request bodies. See exactly what the page sends and receives.
- **Built-in security testing** — scoped web security tools (crawl, fuzz, SQLi, template
  checks, cookie/session analysis, HTTP replay, OAST) share the browser session. No
  separate proxy setup.
- **Token-efficient output** — salience-based rendering, session delta compression, and
  task-conditioned relevance keep tool outputs compact. Repeated scans of the same page
  send only what changed.

## How It Compares

| Capability | Browser Pilot | Playwright / Puppeteer | browser-use | Selenium |
|---|:---:|:---:|:---:|:---:|
| Semantic DOM model (not raw HTML/pixels) | **Yes** | No | No | No |
| Arbitrary JS execution in page | **Yes** | Eval only | No | Limited |
| CDP physical input (trusted events) | **Yes** | Partial | No | No |
| Full network record/replay/mutate | **Yes** | HAR only | No | Proxy needed |
| Built-in web security tools | **Yes** | No | No | No |
| Token-efficient output (salience + delta) | **Yes** | N/A | No | N/A |
| Survives MV3 SW restart / tab replace | **Yes** | N/A | No | Partial |
| Designed for AI agents | **First** | Adapted | Yes | Adapted |

## How It Works

```
┌─ Chrome Extension (Manifest V3) ─────────────────────────────────┐
│  Service worker (esm-import-graph) + offscreen + content/hook     │
└────────────────────────┬──────────────────────────────────────────┘
                         │ WebSocket (127.0.0.1:18765-18784)
┌────────────────────────▼──────────────────────────────────────────┐
│  Node.js Bridge Server                                            │
│  HTTP/WS facade → client registry → tab/session router → pending  │
└────────────────────────┬──────────────────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────────────────┐
│  Tool Layer (browser_* tools)                                     │
│  Core: tabs, observe, execute, command, screenshot,              │
│        network, hook, evidence, frame, artifact,                  │
│        download, upload                                           │
│  Security: crawl, fuzz, sqli, template, cookie-analyze,           │
│            http-replay, callback-oast                             │
└───────────────────────────────────────────────────────────────────┘
```

The Chrome extension runs in the browser and bridges to a Node.js server over a local
WebSocket. The tool layer on top exposes composable `browser_*` tools through the
`browser-pilot` CLI, backed by a user-local daemon that owns the live browser session.

| Frontend | Best for | Guide |
|---|---|---|
| **CLI** (`browser-pilot` command) | Shell-capable agents, CI, cron, humans | built-in help |

## Quick Start

### Prerequisites

- Node.js 22+
- Chrome or Edge

### Install

```bash
git clone https://github.com/wklwkl115/browser-pilot.git
cd browser-pilot
npm install
```

`npm install` runs the `prepare` script, which builds both the CLI (`npm run build`)
and the Chrome extension bundles (`npm run build:bridge`) automatically. These are install/rebuild scripts, not contributor validation gates; use the `mise` gates documented in [REPO_GOVERNANCE.md](REPO_GOVERNANCE.md) for development completion claims.

### Load the Browser Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** → select `bridge/browser_pilot_bridge`.
4. Confirm the extension name is **Browser Pilot Bridge**.

### Use via CLI

The `browser-pilot` CLI exposes the `browser_*` tool surface as shell subcommands. A
user-local daemon manages the bridge server — it auto-starts on first use.
The repository-maintained Codex skill lives at `skills/browser-pilot-cli`; link that
directory to `$CODEX_HOME/skills/browser-pilot-cli` to make `$browser-pilot-cli`
discoverable while keeping the repository copy as the single source of truth.

```bash
# Readiness gate (recommended for multi-step work)
npx browser-pilot connect --wait --json

# Observe the page
# browser-pilot-executable
npx browser-pilot observe --json

# Execute JavaScript
# browser-pilot-executable
npx browser-pilot execute --script "document.title" --read-only --json

# Non-idempotent script mutation: the same call proves the business postcondition
npx browser-pilot execute --script "document.querySelector('[data-like]').click()" --postcondition "document.querySelector('[data-like]').getAttribute('aria-pressed') === 'true'" --intent-id like-note-42 --json

# Use the same --script flag for file-backed JavaScript; @file is read in memory
npx browser-pilot execute --program @program.json --json
npx browser-pilot execute --script @snippet.js --json

# Capture page-load network traffic; capture-reload starts before reload/navigation
# browser-pilot-executable
npx browser-pilot network capture-reload --session-id net-1 --json
# browser-pilot-executable
npx browser-pilot artifact paths --path <saved.path-from-network-result> --json

# Inspect saved artifact metadata and available JSON paths
npx browser-pilot artifact inspect --path <saved.path-from-previous-tool> --json

# Take a screenshot
# browser-pilot-executable
npx browser-pilot screenshot --json

# Discover commands and flags
npx browser-pilot --help
npx browser-pilot schema observe --json
```

`connect --wait` requires both a connected extension and the expected unpacked extension build. If several browser instances share the bridge, a stale peer cannot complete readiness or displace an already selected current build. When no current instance arrives before the deadline, `CLI_EXTENSION_STALE` includes an exact self-reload recovery command; after that full extension reload, run `tabs list` again before reusing a handle.

Core tools include tabs, observe, execute, command, screenshot, network, hook,
evidence, frame, artifact, download, and upload. Security tools include crawl, fuzz,
sqli, template, cookie-analyze, http-replay, and callback-oast. Use
`browser-pilot --help` and `browser-pilot schema <command> --json` for the live command surface. For native bridge escape-hatch calls, `browser-pilot command --command` accepts inline JSON only; do not use `--command @file`. `browser-pilot execute --script` uniformly accepts inline source, `@file`, or stdin (`-`). Temporary JavaScript must stay in memory: use inline source only for short shell-safe code, pipe multiline/complex/generated source to `--script -`, and never create a transient local script file merely to execute it. Reserve `--script @file` for durable source that already exists or that the user explicitly wants to preserve; use `--program @file` for large structured input programs.

On PowerShell, an in-memory here-string avoids both shell quote escaping and a temporary file:

```powershell
@'
const headings = [...document.querySelectorAll('h1, h2')]
  .map(({ textContent }) => textContent?.trim())
  .filter(Boolean);
return { title: document.title, headings };
'@ | npx browser-pilot execute --script - --read-only --json
```

Machine discovery uses the compact command contract v3. `browser-pilot commands --json` returns one root artifact rule plus 19 canonical command entries, action schema references, and bounded command-owned subcommand references; it does not repeat flags, schemas, routing prose, or legacy aliases per command. `browser-pilot schema <command> <kebab-subcommand> --json` expands the route-specific schema: action routes include the raw action `const`, shared target/session/output fields, and the only allowed nested `params`, while routes such as `tabs list` / `tabs create` and `artifact inspect` narrow an existing top-level parameter. Help, offline validation, daemon validation, execution routing, and contract identity all derive from the same command metadata.

## Typical Workflow

```
1. tabs list          → find the target tab
2. observe            → read the canonical ABML page model
3. execute transaction → click/type/scroll and synchronously receive browser-operation/v2
4. consume outcome     → distinguish dispatch, business, semantic, and terminal status
5. observe / network / evidence → read the next facts only when the workflow needs them
6. artifact            → read detailed saved evidence
```

State-changing commands arm event listeners before dispatch and remain open until a terminal `browser-operation/v2` status. `browser_execute` and raw `browser_command` CDP/input page writes additionally capture a fenced ABML before/after model inside the same target transaction. A renderer-chain pre-dispatch fence is revalidated against an actual handler-side dispatch marker before the JavaScript/CDP/input handler runs; full validation and reliable marker delivery precede the action ACK and CSP bypass, while marker, socket, target, or generation failure prevents the action with `dispatch.started:false`. There is no public `wait` command and agents should not add sleep loops. Only `completed` means root success: it returns `classification:"success"`, `completionVerified:true`, `ok:true`, and CLI exit 0. `effect_observed`, `ambiguous`, `target_lost`, and `deadline` are inconclusive; `no_effect`, `stalled`, and `failed` are failures. Every non-completed terminal status returns `completionVerified:false`, `ok:false`, a stable `OPERATION_*` code, and CLI exit 1. Execution outcomes expose `dispatch`, bounded `semantic`, and `business` separately: a successful JavaScript/CDP dispatch cannot masquerade as business success. A compact, domain-aware `continuation` field chooses the safe next decision: `observe` for page-state uncertainty, `reacquire_target` when the current target is no longer reliable, `inspect_diagnostics` only when diagnostics exist, `verify_command_state` for non-page uncertainty, and `inspect_artifact` for a compacted successful result. It explicitly prevents blind replay.

`completionVerified` proves the declared command completion source, not an undeclared product-specific outcome. Use `--read-only` only as an explicit caller guarantee that every supplied script/eval frame is a query; arbitrary JavaScript defaults to an unverified mutation. Plain `script-resolved` means JavaScript evaluation returned and may complete such a declared query; if ABML observes a page-semantic effect without a declared expectation, the root status is `effect_observed` and `business.status` remains `inconclusive`. The first stable no-effect model for an unverified mutation keeps waiting for a later page revision until its hard deadline instead of failing immediately. For a non-idempotent script mutation, provide both a stable `intentId` and a read-only `postcondition` predicate in the same call; scripted intents without a postcondition are rejected. Browser Pilot evaluates the predicate immediately and again on DOM, input/change, focus, scroll, and resize signals, and returns `completed/script-postcondition-verified` only when it resolves to `true` or `{verified:true}`. A false, lost, or timed-out predicate is `ambiguous`, so a like or comment action cannot be mistaken for business success or replayed automatically. Physical programs use the equivalent sole final `eval` frame with `verify:true`.

Mutations on one owner/session/stable target are serialized by an alias-aware transaction lease from replay guard/observer arm through dispatch, asynchronous ABML settlement, exact end-fence revision CAS, and extension finish. Any post-capture event makes CAS stale and forces a recapture. Extension cleanup uses a fresh target-independent finish/cancel budget plus an active-operation TTL, so a closed tab or lost caller cannot leave observers indefinitely. An acknowledged uncertain write blocks later writes across `execute` and native command routes until a fresh canonical observation starts after settlement and confirms the same page identity. The `intentId` plus script/program/postcondition payload hashes are retained for the daemon-process lifetime: completed same-payload intents return their prior outcome without dispatch, uncertain intents stay blocked, and a different payload is rejected. Caller disconnect and hard-deadline signals propagate through daemon invocation, target queue, bridge pending request, program frames, fingerprints, and semantic capture. A queued mutation canceled before dispatch is removed without later execution; an already dispatched or acknowledged action remains explicitly inconclusive and retains at-most-once evidence. When completion/effect evidence exceeds the response budget, Browser Pilot preserves the root terminal contract plus business/semantic summary, saves the full redacted outcome once, and returns `saved.path` with verified `artifact_hints`; inspect it instead of replaying the mutation. There are no standalone `click` or `type` commands; ordinary page actions go through `browser_execute`, with `browser_command` reserved for the validated native escape hatch.

For page-load request capture, prefer raw `browser_network action=captureReload` or the canonical CLI `network capture-reload` subcommand over a manual `network start` followed by reload; the one-shot flow starts capture before reload/navigation and returns recovery guidance plus a saved artifact path. CLI action tokens are always kebab-case; raw JSON action values retain the schema spelling, so `network captureReload` is not a CLI alias. Use canonical CLI `artifact inspect` or `artifact paths` on the returned `saved.path` to see available JSON paths before targeted reads, instead of guessing paths that may not exist. Bridge responses may include bounded `diagnostics.latency` / temporal telemetry such as elapsed time, deadline, ack state, and queue/runtime timing; these fields are operational diagnostics and do not include command payloads, headers, bodies, or URL query contents.

## Key Features

### Structured DOM Perception

`browser_observe` returns the canonical ABML page model, identified by `browser-page-observation/v3` — not raw HTML, not a screenshot, and not a caller-selected extraction strategy. The observation itself is the JSON root; there is no nested observation mirror or second artifact envelope copy.
It fuses accessibility/DOM structure with compact ref-based actionables, relations, identity, collections, snapshot/diff planes, provider execution reports, a verified expansion frontier, and artifact hints. Omit `mode` for canonical semantics; any explicit `mode` value is a legacy/debug/projection override. The existing `mode=content/html/text/tabs` values remain isolated compatibility projections and never replace the canonical v3 root. Core scan/structure work is reserved before optional I/O; causal, axe, and Readability use a deterministic 2:1:1 optional deadline split, run concurrently when eligible, and fail open. Each provider reports planned/executed/skipped status, reason, reserved/actual milliseconds, bridge round trips, and a shared `{chars,bytes,estimatedTokens}` cost vector.

### Session Delta

Repeated `browser_observe` on the same tab produces compact delta frames
(`delta:"session"`) containing only what changed. Multi-step workflows stay
token-efficient without sacrificing completeness. Default `nextActions` represent an actual recovery or continuation frontier; they do not guess an action from the first entity or duplicate optional artifact reads already described by `artifact_hints`.

Folded template instances, collection windows, large content, and truncated diagnostics are represented once in `frontier.items`. Every item either contains a persisted, post-write-verified `browser_artifact` JSON read through `saved.path`, or an explicit `unavailableReason`; Browser Pilot never silently truncates a block or guesses a collection JSON path. Inline and saved observations use the same v3 schema, and `limits.cost` is the exact cost of the final rendered JSON.

Delta and render-cache reuse require the same `browserSessionId + tabId + targetGeneration + pageEpoch`. A top-level document commit or target replacement changes that identity; SPA history updates within the same document do not. If Browser Pilot cannot prove continuity—such as after an extension restart—it discards the old baseline, performs a full observation, and returns a short `reanchorReason` instead of an incorrect delta. URL is reported as a fact but is never used as document identity.

### Living Tab Sessions

Stable `browserId` values derive from the extension instance, while extension-owned
`tabHandle`/`targetRef` identities live in `chrome.storage.session` and transfer through
`tabs.onReplaced`. They survive daemon replacement, MV3 service-worker restarts, and
socket reconnects within the current browser runtime. Closing the tab, fully reloading the
extension, or restarting the browser runtime intentionally invalidates the handle and
requires a fresh `tabs list`. A stale loaded extension is never considered ready.

CLI offline validation and daemon invocation share the same strict validation pipeline. Unknown, internal, removed, and action-incompatible parameters are rejected before normalization; cross-field rules include execute's exactly-one `script`/`program` input, program-only verifier boundary, and required `postcondition` for scripted intents. No invalid parameter is silently stripped.

### Main Pure-Logic Perception Stages

The core perception pipeline is organized around three pure-logic stages with zero
browser/Node dependencies:

| Kernel | Purpose |
|---|---|
| **Capture** (sense) | Page-world JS templates injected into the browser |
| **ABML** (perceive) | Entity extraction, diffing, templating, relations, causal |
| **Distill** (express) | Token economy, salience renderer, fact allocator |

The repository also contains additional pure kernels for refs, session, security, and temporal logic; see [CODE_WIKI.md](CODE_WIKI.md) for the code-level map.

## Security Testing

The security tools follow a scoped workflow: observe first, then probe.

```bash
# Fingerprint a target
npx browser-pilot crawl --action fingerprint --url https://example.com --json

# Crawl for endpoints
npx browser-pilot crawl --url https://example.com --json

# Fuzz paths
npx browser-pilot fuzz --mode path --url https://example.com/FUZZ --json

# Replay a captured request with mutations
npx browser-pilot http-replay --raw-request @request.txt --json

# Check for SQL injection
npx browser-pilot sqli --url "https://example.com/search?q=test" --json
```

## Development

Use `mise` for project validation gates:

```bash
mise run dev          # Local developer gate
mise run affected     # Changed-file validation
mise run verify       # Release-readiness gate
mise run package-smoke # Pack/install the exact npm tarball in an isolated project
mise run smoke-browser # Real Chrome/Edge MV3 acceptance gate
mise run dev-governance # Governance/workflow/documentation changes
```

`mise run package-smoke` runs `npm pack --json`, enforces the package allowlist and hard size/file ceilings, installs the generated `.tgz` into a clean temporary project, and tests the root ESM export, CLI/help, compact catalog, action schema, offline validation, no-daemon status behavior, extension assets, and JavaScript native-kernel fallback. `mise run verify` runs this smoke after the build.

`mise run smoke-browser` rebuilds the unpacked extension, launches an installed Chrome/Edge/Chromium in an isolated profile, and verifies the real extension handshake, operation completion-event wakeup, full/delta/re-anchor observations, provider budgets, network/hook behavior, BFCache back/forward lineage, frontier artifact reads, Prerender2 target replacement, target close/new-target recovery, and extension reload/reconnect. Set `BROWSER_PILOT_SMOKE_BROWSER` when the browser is outside the standard install locations.

The observe regression benchmark is maintained as offline fixtures in `tests/observe/observeRegressionBenchmark.test.ts`, with an immutable v2 baseline extracted directly from Git object `1573380`. The gate requires at least 25% median byte and estimated-token reduction, no fixture above 105% of its baseline, exact final costs, complete required facts/refs/relations/collection properties, and verified frontier ownership. Only the explicit `mise run update-observe-benchmark` maintenance command rewrites the baseline; ordinary builds and tests never do.

Version tags are the only npm publishing entrypoint. `.github/workflows/release.yml` first requires the tag to equal `v${package.json.version}`, runs `verify` and tarball smoke on Ubuntu and Windows plus the full Windows browser smoke, retains one SHA-256-verified tarball, and publishes that exact download with npm 11 trusted publishing and provenance. The publish job does not repack and uses OIDC rather than a long-lived npm token.

Lower-level npm scripts still exist for focused maintenance tasks, but they are not the completion gate. See [REPO_GOVERNANCE.md](REPO_GOVERNANCE.md) for the canonical workflow and [CODE_WIKI.md](CODE_WIKI.md) for the architecture/development map.

## Documentation

Use `browser-pilot --help` and `browser-pilot schema <command> --json` for the live command surface.
For contributor workflow, canonical gates, and repo-specific guardrails, start with
[REPO_GOVERNANCE.md](REPO_GOVERNANCE.md).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BROWSER_PILOT_BRIDGE_HOST` | `127.0.0.1` | Bridge listen address |
| `BROWSER_PILOT_BRIDGE_PORT` | `18765` | Bridge port range start |
| `BROWSER_PILOT_BRIDGE_PORT_RANGE_END` | `18784` | Bridge port range end |
| `BROWSER_PILOT_RENDERER` | `salience` | Observation renderer (`salience` or `ladder`) |
| `BROWSER_PILOT_SESSION_DELTA` | `1` | Session-delta for repeated scans (`0` to disable) |
| `BROWSER_PILOT_RELEVANCE` | `1` | Task-conditioned relevance (`0` to disable) |

## Star History

If Browser Pilot is useful, consider giving it a star — it helps others discover the project.

## License

[Apache-2.0](LICENSE)
