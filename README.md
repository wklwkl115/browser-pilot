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
$ browser-pilot observe --json | jq '.summary.pageObservation.gist'
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

- **Structured perception** — canonical ABML page observations with entity extraction, accessibility tree
  fusion, structural diff, content/text digests, evidence artifacts, and template compression. Your agent sees one semantic page model, not pixels or competing modes.
- **Direct execution** — run arbitrary JavaScript in the page, not just click/type macros.
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
| Session memory (per-site fact recall) | **Yes** | No | No | No |
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
│  Core: tabs, observe, execute, command, wait, screenshot,         │
│        network, hook, evidence, frame, artifact, memory,          │
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

```bash
# Readiness gate (recommended for multi-step work)
npx browser-pilot connect --wait --json

# Observe the page
npx browser-pilot observe --json

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

Core tools include tabs, observe, execute, command, wait, screenshot, network, hook,
evidence, frame, artifact, memory, download, and upload. Security tools include crawl, fuzz,
sqli, template, cookie-analyze, http-replay, and callback-oast. Use
`browser-pilot --help` and `browser-pilot schema <command> --json` for the live command surface.

## Typical Workflow

```
1. tabs list          → find the target tab
2. observe            → read the canonical ABML page model
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

`browser_observe` returns the canonical ABML page model — not raw HTML, not a screenshot, and not a caller-selected extraction strategy.
It fuses accessibility/DOM structure with actionables, refs, relations, collections, scan-backed content/text digests, tab context, evidence artifacts, and diagnostics in one stable observation envelope. Omit `mode` for canonical semantics; any explicit `mode` value is marked as legacy/debug/projection, with `mode=content/html/text/tabs` kept only for compatibility projections. Provider diagnostics report truthful execution states such as `executed`, `scan-backed`, `skipped`, `failed`, or `degraded` rather than implying a provider ran successfully when it was only derived from scan evidence or skipped.

### Session Delta

Repeated `browser_observe` on the same tab produces compact delta frames
(`delta:"session"`) containing only what changed. Multi-step workflows stay
token-efficient without sacrificing completeness.

### Browser Memory

A local store (`.browser-pilot/memory/`) lets agents record and recall per-site facts.
Memory records are facts only: `kind=fact` entries may capture durable observations, but
SOPs, workflows, playbooks, checklists, procedural steps, and agent instructions are rejected.
Once recorded, `browser_observe` automatically surfaces relevant fact memory for the current
URL — so the agent doesn't re-derive stable context twice.

### Living Tab Sessions

Stable `tabHandle`/`targetRef` identifiers survive tab replacements, MV3 service worker
restarts, and extension reconnects. Your agent doesn't lose track of tabs.

### Main Pure-Logic Perception Stages

The core perception pipeline is organized around four pure-logic stages with zero
browser/Node dependencies:

| Kernel | Purpose |
|---|---|
| **Capture** (sense) | Page-world JS templates injected into the browser |
| **ABML** (perceive) | Entity extraction, diffing, templating, relations, causal |
| **Distill** (express) | Token economy, salience renderer, fact allocator |
| **Memory** (retain) | Profile distillation, recall scoring, staleness verification |

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
```

Lower-level npm scripts still exist for focused maintenance tasks, but they are not the completion gate. See [REPO_GOVERNANCE.md](REPO_GOVERNANCE.md) for the canonical workflow and [CODE_WIKI.md](CODE_WIKI.md) for the architecture/development map.

## Documentation

Use `browser-pilot --help` and `browser-pilot schema <command> --json` for the live command surface.
For contributor workflow, canonical gates, and repo-specific guardrails, start with
[REPO_GOVERNANCE.md](REPO_GOVERNANCE.md).

## Notes

`.browser-pilot/public-export/` is a local export/archive directory — not a second source tree.
It is `.gitignore`d and should never be committed.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BROWSER_PILOT_BRIDGE_HOST` | `127.0.0.1` | Bridge listen address |
| `BROWSER_PILOT_BRIDGE_PORT` | `18765` | Bridge port range start |
| `BROWSER_PILOT_BRIDGE_PORT_RANGE_END` | `18784` | Bridge port range end |
| `BROWSER_PILOT_RENDERER` | `salience` | Observation renderer (`salience` or `ladder`) |
| `BROWSER_PILOT_SESSION_DELTA` | `1` | Session-delta for repeated scans (`0` to disable) |
| `BROWSER_PILOT_RELEVANCE` | `1` | Task-conditioned relevance (`0` to disable) |
| `BROWSER_PILOT_MEMORY` | `1` | Auto-recall browser memory (`0` to disable) |

## Star History

If Browser Pilot is useful, consider giving it a star — it helps others discover the project.

## License

[Apache-2.0](LICENSE)
