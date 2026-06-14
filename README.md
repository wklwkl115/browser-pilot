# Pi Browser Tools

[![CI](https://github.com/anthropics/pi-browser-tools/actions/workflows/check.yml/badge.svg)](https://github.com/anthropics/pi-browser-tools/actions/workflows/check.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

[中文文档](README.zh-CN.md)

Real browser automation for AI agents — tab control, DOM scanning, JavaScript/CDP execution,
network capture, screenshot & evidence collection, file transfer, and a web security testing layer.

Built as a Chrome extension + Node.js bridge. Works with any agent that can call tools (Pi native)
or run shell commands (`pi-browser` CLI).

```
$ pi-browser observe --mode scan --json | jq '.summary.gist'
"Forum topic list with 14 visible rows, navigation sidebar, user menu.
 3 forms (search, login, compose), 47 actionable elements."

$ pi-browser execute --script "document.querySelector('.topic-list .main-link a').href" --json
{ "data": "https://linux.do/t/welcome/1" }

$ pi-browser network start --json && pi-browser execute --script "fetch('/api/status')" --json
$ pi-browser network list --session-id net-1 --json | jq '.data.requests[0].url'
"https://linux.do/api/status"
```

## How It Works

```
┌─ Chrome Extension (Manifest V3) ─────────────────────────────────┐
│  Service worker + offscreen transport + content/hook scripts      │
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

## Quick Start

### Prerequisites

- Node.js 22+
- Chrome or Edge

### Install

```bash
git clone https://github.com/anthropics/pi-browser-tools.git
cd pi-browser-tools
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

The `pi-browser` CLI exposes all 22 tools as shell subcommands. A user-local daemon manages the
bridge server — it auto-starts on first use.

```bash
# Readiness gate (recommended for multi-step work)
npx pi-browser connect --wait --json

# Observe the page
npx pi-browser observe --mode scan --json

# Execute JavaScript
npx pi-browser execute --script "document.title" --json

# Wait for a selector
npx pi-browser wait selector --selector "#result" --json

# Capture network traffic
npx pi-browser network start --json
# ... interact with the page ...
npx pi-browser network list --session-id net-1 --json

# Take a screenshot
npx pi-browser screenshot --json

# Discover commands and flags
npx pi-browser --help
npx pi-browser schema observe --json
```

Every `browser_*` tool maps to a subcommand: drop `browser_`, replace `_` with `-`.
Flags are the kebab-cased tool parameters. `pi-browser commands --json` is the single
source of truth for available commands and their routing.

For longer scripts and request bodies, prefer files over shell quoting:

```bash
npx pi-browser execute --script-file ./my-script.js --json
npx pi-browser command --command @native-command.json --json
npx pi-browser http-replay --raw-request @request.txt --json
```

### Use via Pi Native

When loaded as a Pi extension, the tools register as `browser_*` tool calls with no
connection setup. See [skills/pi-browser-tools/SKILL.md](skills/pi-browser-tools/SKILL.md).

> The Pi runtime packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are
> optional peer dependencies. The CLI works independently without them.

## Tools

| Tool | Description |
|---|---|
| `browser_tabs` | List, switch, create, close tabs; manage sessions and leases |
| `browser_observe` | Scan DOM structure, extract content/HTML/text, diff baselines |
| `browser_execute` | Run JavaScript in the page (with optional effect monitoring) |
| `browser_command` | Send native bridge commands (CDP, input, etc.) |
| `browser_wait` | Wait for navigation, selectors, load state, network idle |
| `browser_pick` | Interactive element picker |
| `browser_screenshot` | Capture visible tab screenshot |
| `browser_network` | Record/list/export HTTP traffic and HAR |
| `browser_hook` | Install page event hooks (console, errors, storage, etc.) |
| `browser_evidence` | Aggregate hook + network + performance evidence |
| `browser_frame` | List frames, evaluate in child frames, inject scripts |
| `browser_artifact` | Read saved evidence by line, JSON path, search, or sample |
| `browser_memory` | Local browser memory — record and recall per-site SOPs |
| `browser_download` | Download files via click, media selector, or URL |
| `browser_upload` | Upload local files via file input |
| `browser_crawl` | Crawl links/forms/APIs/source maps; fingerprint URLs |
| `browser_fuzz` | Path, vhost, and parameter fuzzing |
| `browser_sqli` | SQL injection detection (builtin oracle + sqlmap bridge) |
| `browser_template` | HTTP template checks (builtin + nuclei bridge) |
| `browser_cookie_analyze` | Cookie/JWT/JWE/PASETO/session analysis |
| `browser_http_replay` | Replay and mutate HTTP requests with diff clustering |
| `browser_callback_oast` | Local HTTP/HTTPS/DNS callback listener for OAST |

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

## Security Testing

The security tools follow a scoped workflow: observe first, then probe.

```bash
# Fingerprint a target
npx pi-browser crawl --action fingerprint --url https://example.com --json

# Crawl for endpoints
npx pi-browser crawl --url https://example.com --json

# Fuzz paths
npx pi-browser fuzz --mode path --url https://example.com/FUZZ --json

# Replay a captured request with mutations
npx pi-browser http-replay --raw-request @request.txt --json

# Check for SQL injection
npx pi-browser sqli --url "https://example.com/search?q=test" --json
```

See [docs/playbooks/](docs/playbooks/) for step-by-step security testing guides.

## Development

```bash
npm run build:bridge      # Build the Chrome extension
npm run build             # Compile Node.js source to dist/
npm run lint              # ESLint
npm run check             # Run all contract/unit/boundary tests
npm run quality:local     # Full local gate: build + lint + check + pack
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
npm run smoke:browser:isolated    # Isolated Chrome profile
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution workflow.

## Documentation

| Doc | Description |
|---|---|
| [docs/cli.md](docs/cli.md) | CLI reference and usage patterns |
| [docs/playbooks/](docs/playbooks/) | Security testing playbooks |
| [docs/tool-boundaries.md](docs/tool-boundaries.md) | Tool selection boundaries |
| [docs/browser-memory.md](docs/browser-memory.md) | Local browser memory system |
| [docs/generated/browser-tool-contract.generated.md](docs/generated/browser-tool-contract.generated.md) | Generated tool contract reference |
| [docs/generated/native-protocol.generated.md](docs/generated/native-protocol.generated.md) | Generated native protocol reference |

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
