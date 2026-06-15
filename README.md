# Browser Pilot

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/tools-22%20browser__*-blueviolet.svg)](#tools)
[![Tests](https://img.shields.io/badge/tests-860%2B%20contracts-green.svg)](#development)

[中文文档](README.zh-CN.md)

**Real browser automation for AI agents** — not a simulator, not a proxy, not a screenshot parser.
Browser Pilot gives your agent direct access to a real Chrome/Edge tab: DOM structure, JavaScript
execution, CDP commands, network traffic, cookie jars, and file transfers. Everything a human
can do in DevTools, your agent can do through 22 composable `browser_*` tools.

```
$ browser-pilot observe --mode scan --json | jq '.summary.gist'
"Forum topic list with 14 visible rows, navigation sidebar, user menu.
 3 forms (search, login, compose), 47 actionable elements."

$ browser-pilot execute --script "document.querySelector('.topic-list .main-link a').href" --json
{ "data": "https://linux.do/t/welcome/1" }

$ browser-pilot network start --json && browser-pilot execute --script "fetch('/api/status')" --json
$ browser-pilot network list --session-id net-1 --json | jq '.data.requests[0].url'
"https://linux.do/api/status"
```

## Why Browser Pilot

Most browser automation tools give agents a **screenshot and a click coordinate**.
Browser Pilot gives agents what they actually need:

- **Structured perception** — DOM scanning with entity extraction, accessibility tree
  fusion, structural diff, and template compression. Your agent sees the page as a semantic
  model, not pixels.
- **Direct execution** — run arbitrary JavaScript in the page, not just click/type macros.
  Agents write the same DOM code a developer would write in DevTools.
- **Physical input escape** — when trusted-event-gated controls ignore synthetic clicks,
  CDP physical input (`input.pointer` / `input.keys`) gets through. No more "button doesn't
  respond" dead ends.
- **Full network visibility** — record/replay/mutate HTTP traffic, export HAR, capture
  request bodies. See exactly what the page sends and receives.
- **Built-in security testing** — 7 web security tools (crawl, fuzz, SQLi, template
  checks, cookie/session analysis, HTTP replay, OAST) share the browser session. No
  separate proxy setup.
- **Token-efficient output** — salience-based rendering, session delta compression, and
  task-conditioned relevance keep tool outputs compact. Repeated scans of the same page
  send only what changed.
- **860+ contract tests** — protocol, tools, boundaries, runtime fixtures, lifecycle, and
  governance gates. The tool surface is locked by CI.

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
│  Tool Layer (22 browser_* tools)                                  │
│  Core: tabs, observe, execute, command, wait, pick, screenshot,   │
│        network, hook, evidence, frame, artifact, memory,          │
│        download, upload                                           │
│  Security: crawl, fuzz, sqli, template, cookie-analyze,           │
│            http-replay, callback-oast                             │
└───────────────────────────────────────────────────────────────────┘
```

The Chrome extension runs in the browser and bridges to a Node.js server over a local
WebSocket. The tool layer on top exposes 22 composable tools through a unified adapter
(`runBrowserTool()` for core tools, `runWebSecurityTool()` for the security domain).
Two frontends connect to the same tool core:

| Frontend | Best for | Guide |
|---|---|---|
| **CLI** (`browser-pilot` command) | Shell-capable agents, CI, cron, humans | [CLI Usage Guide](docs/guide-cli.md) |
| **Pi Native** (in-process `browser_*` calls) | Pi runtime agents (zero-overhead) | [Pi Native Guide](docs/guide-pi-native.md) |

## Quick Start

### Prerequisites

- Node.js 22+
- Chrome or Edge

### Install

```bash
git clone <repository-url> browser-pilot
cd browser-pilot
npm install
npm run build
npm run build:bridge
```

### Load the Browser Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** → select `bridge/pi_browser_bridge`.
4. Confirm the extension name is **Pi Native Browser Bridge**.

### Use via CLI

The `browser-pilot` CLI exposes all 22 tools as shell subcommands. A user-local daemon
manages the bridge server — it auto-starts on first use.

```bash
# Readiness gate (recommended for multi-step work)
npx browser-pilot connect --wait --json

# Observe the page
npx browser-pilot observe --mode scan --json

# Execute JavaScript
npx browser-pilot execute --script "document.title" --json

# Wait for a selector
npx browser-pilot wait selector --selector "#result" --json

# Capture network traffic
npx browser-pilot network start --json
npx browser-pilot network list --session-id net-1 --json

# Take a screenshot
npx browser-pilot screenshot --json

# Discover commands and flags
npx browser-pilot --help
npx browser-pilot schema observe --json
```

See the **[CLI Usage Guide](docs/guide-cli.md)** for workflows, file inputs, security
testing, and daemon management.

### Use via Pi Native

When loaded as a Pi extension, the tools register as `browser_*` tool calls with no
connection setup. Just call them:

```
browser_tabs    { action: "list" }
browser_observe { mode: "scan" }
browser_execute { script: "document.title" }
browser_wait    { action: "selector", params: { selector: "#result" } }
```

See the **[Pi Native Usage Guide](docs/guide-pi-native.md)** for the observe-execute-wait
loop, memory, and recovery patterns.

Pi-native slash commands: `/browser-install`, `/browser-status`, `/browser-reload`, plus the
internal-only inspection paths `/browser-js-ast`, `/browser-wasm`, `/browser-ws` (these are not
public browser tools — they route to internal AST/Wasm/WebSocket shells).

> The Pi runtime packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are
> optional peer dependencies. The CLI works independently without them.

## Tools

<!-- BEGIN GENERATED: readme-tool-index (npm run docs:sync) -->
| Tool | Group | Source |
| --- | --- | --- |
| `browser_artifact` | core | `src/tools/registerArtifactTool.ts` |
| `browser_callback_oast` | security | `src/tools/webSecurity/register/registerCallbackOast.ts` |
| `browser_command` | core | `src/tools/registerCommandTool.ts` |
| `browser_cookie_analyze` | security | `src/tools/webSecurity/register/registerCookieAnalyze.ts` |
| `browser_crawl` | security | `src/tools/webSecurity/register/registerCrawl.ts` |
| `browser_download` | core | `src/tools/registerTransferTools.ts` |
| `browser_evidence` | core | `src/tools/registerEvidenceTool.ts` |
| `browser_execute` | core | `src/tools/registerExecuteTool.ts` |
| `browser_frame` | core | `src/tools/registerNativeActionTools.ts` |
| `browser_fuzz` | security | `src/tools/webSecurity/register/registerFuzz.ts` |
| `browser_hook` | core | `src/tools/registerNativeActionTools.ts` |
| `browser_http_replay` | security | `src/tools/webSecurity/register/registerHttpReplay.ts` |
| `browser_memory` | core | `src/tools/registerMemoryTool.ts` |
| `browser_network` | core | `src/tools/registerNativeActionTools.ts` |
| `browser_observe` | core | `src/tools/registerObserveTool.ts` |
| `browser_pick` | core | `src/tools/registerPickTool.ts` |
| `browser_screenshot` | core | `src/tools/registerScreenshotTool.ts` |
| `browser_sqli` | security | `src/tools/webSecurity/register/registerSqli.ts` |
| `browser_tabs` | core | `src/tools/registerTabsTool.ts` |
| `browser_template` | security | `src/tools/webSecurity/register/registerTemplate.ts` |
| `browser_upload` | core | `src/tools/registerTransferTools.ts` |
| `browser_wait` | core | `src/tools/registerNativeActionTools.ts` |
<!-- END GENERATED: readme-tool-index -->

15 core tools (tabs, observe, execute, command, wait, pick, screenshot, network, hook,
evidence, frame, artifact, memory, download, upload) and 7 security tools (crawl, fuzz,
sqli, template, cookie-analyze, http-replay, callback-oast). See the
[tool contract reference](docs/generated/browser-tool-contract.generated.md) for full
schemas and parameters.

## Typical Workflow

```
1. tabs list          → find the target tab
2. observe --mode scan → understand the page structure
3. execute            → click, type, scroll (JavaScript)
4. wait               → wait for navigation / selector / network idle
5. observe / network / evidence → verify the result
6. artifact           → read detailed saved evidence
```

There are no `click` or `type` commands — page actions go through `browser_execute`
(JavaScript). For trusted-event-gated controls, use `browser_command` with `input.pointer`
or `input.keys` (CDP physical input).

## Key Features

### Structured DOM Perception

`browser_observe` returns a semantic model of the page — not raw HTML, not a screenshot.
It fuses the accessibility tree with DOM structure, extracts entities and relations,
compresses repeated patterns (lists, tables), and tracks changes across scans.

### Session Delta

Repeated `browser_observe mode=scan` on the same tab produces compact delta frames
(`delta:"session"`) containing only what changed. Multi-step workflows stay
token-efficient without sacrificing completeness.

### Browser Memory

A local store (`.pi/browser-memory/`) lets agents record and recall per-site procedures
(SOPs) and facts. Once recorded, `browser_observe` automatically surfaces relevant memory
for the current URL — so the agent doesn't re-derive the same action sequence twice.

### Living Tab Sessions

Stable `tabHandle`/`targetRef` identifiers survive tab replacements, MV3 service worker
restarts, and extension reconnects. Your agent doesn't lose track of tabs.

### Four Pure-Logic Kernels

The core perception pipeline runs in four CI-boundary-locked kernels with zero
browser/Node dependencies:

| Kernel | Purpose |
|---|---|
| **Capture** (sense) | Page-world JS templates injected into the browser |
| **ABML** (perceive) | Entity extraction, diffing, templating, relations, causal |
| **Distill** (express) | Token economy, salience renderer, fact allocator |
| **Memory** (retain) | Profile distillation, recall scoring, staleness verification |

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

See [docs/playbooks/](docs/playbooks/) for step-by-step security testing guides.

## Development

```bash
npm run build:bridge      # Build the Chrome extension
npm run build             # Compile Node.js source to dist/
npm run lint              # ESLint
npm run check             # Run all contract/unit/boundary tests
npm run quality:local     # Full local gate: build + lint + check + npm pack --dry-run --ignore-scripts --json
npm run release:portable  # Clean public-file tree + npm tarball consumer-install smoke
```

Narrow gates for faster iteration:

```bash
npm run check:all:src         # Source type checks + registry drift
npm run check:all:bridge      # Bridge + unit tests
npm run check:all:package     # Package + docs checks
npm run check:all:contracts   # Contract tests
```

Browser smoke tests (require extension connected):

```bash
npm run smoke:browser:isolated                 # Isolated Chrome profile (start here)
npm run smoke:browser:scan-summary             # Observation/scan summary shape
npm run smoke:browser:debugger-evidence        # CDP debugger evidence capture
npm run smoke:browser:correlation-chain        # Cross-tool correlation chaining
npm run smoke:browser:intercept-response       # Response interception
npm run smoke:browser:intercept-replace-script # Script replacement interception
npm run smoke:browser:intercept-uninstall-fail-closed  # Intercept uninstall fail-closed
npm run smoke:browser:intercept-request-mutate # Request mutation before send
npm run smoke:browser:intercept-tab-close-cleanup      # Tab-close cleanup diagnostics
npm run smoke:browser:intercept-lease-conflict # Cross-session write conflict
npm run smoke:browser:websocket-session        # WebSocket open/replay/failure
npm run smoke:browser:memory                   # Task-scope memory record/recall
```

Smoke results and port diagnostics are written to `.pi/browser-artifacts/smoke-browser-results.json`. When a smoke run reports a port conflict, the reason is one of `agent_occupies` (another process owns the port), `orphan_socket` (leftover socket with no owner), or `unknown_owner` — stop the occupying process and retry.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution workflow.

## Documentation

| Doc | Description |
|---|---|
| [docs/guide-cli.md](docs/guide-cli.md) | CLI usage guide — workflows, patterns, examples |
| [docs/guide-pi-native.md](docs/guide-pi-native.md) | Pi native usage guide — tool calls, loop, memory |
| [skills/browser-pilot/SKILL.md](skills/browser-pilot/SKILL.md) | In-repo Pi-native operating skill (SOP for `browser_*` tools) |
| [docs/cli.md](docs/cli.md) | CLI reference — full command/flag/output specification |
| [docs/playbooks/](docs/playbooks/) | Security testing playbooks |
| [docs/tool-boundaries.md](docs/tool-boundaries.md) | Tool selection boundaries |
| [docs/browser-memory.md](docs/browser-memory.md) | Local browser memory system |
| [docs/browser-usage.md](docs/browser-usage.md) | Installation, extension loading, troubleshooting |
| [docs/generated/browser-tool-contract.generated.md](docs/generated/browser-tool-contract.generated.md) | Generated tool contract reference |
| [docs/generated/native-protocol.generated.md](docs/generated/native-protocol.generated.md) | Generated native protocol reference |

## Notes

`.pi/public-export/` is a local export/archive directory — not a second source tree.
It is `.gitignore`d and should never be committed.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PI_BROWSER_BRIDGE_HOST` | `127.0.0.1` | Bridge listen address |
| `PI_BROWSER_BRIDGE_PORT` | `18765` | Bridge port range start |
| `PI_BROWSER_BRIDGE_PORT_RANGE_END` | `18784` | Bridge port range end |
| `PI_BROWSER_RENDERER` | `salience` | Observation renderer (`salience` or `ladder`) |
| `PI_BROWSER_SESSION_DELTA` | `1` | Session-delta for repeated scans (`0` to disable) |
| `PI_BROWSER_RELEVANCE` | `1` | Task-conditioned relevance (`0` to disable) |
| `PI_BROWSER_MEMORY` | `1` | Auto-recall browser memory (`0` to disable) |

## License

[Apache-2.0](LICENSE)
