<div align="center">

# Browser Pilot

**Give AI agents structured control of real Chrome and Edge tabs.**

Browser Pilot connects MCP clients to a local Node daemon and a Manifest V3 extension for observation, execution, native browser commands, screenshots, and evidence capture.

[![CI](https://github.com/wklwkl115/browser-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/wklwkl115/browser-pilot/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wklwkl115/browser-pilot?color=2563EB)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-22D3EE)
![Chrome and Edge](https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-F59E0B?logo=googlechrome&logoColor=white)

[Quick start](#quick-start) | [Tools](#tools) | [Workflow](#agent-workflow) | [Architecture](#architecture) | [Security](#security-model) | [Contributing](CONTRIBUTING.md)

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/browser-pilot-flow.svg" alt="Browser Pilot routes MCP requests through a local daemon and Manifest V3 extension to a real browser tab" width="100%">

</div>

## Why Browser Pilot

| Observe before acting | Use the browser's real capabilities | Verify the result |
| --- | --- | --- |
| Structured page models expose actionable controls, semantic regions, frames, and deterministic continuation frontiers. | Run page JavaScript, trusted input, Chrome APIs, CDP commands, tab operations, uploads, and downloads. | Writes return bounded effects; explicit expectations return target-scoped verification and diffs. |

Browser Pilot works with the tabs and authenticated sessions already open in Chrome or Edge. Each protocol boundary has one state owner, while page content remains untrusted.

## Quick start

### 1. Build from source

```bash
git clone https://github.com/wklwkl115/browser-pilot.git
cd browser-pilot
npm ci
npm run build:bridge
```

### 2. Load the extension

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `bridge/browser_pilot_bridge`.

### 3. Configure your MCP client

Build the MCP server once:

```bash
npm run build
```

Then point your MCP client at the generated entry file:

```toml
[mcp_servers.browser-pilot]
command = "node"
args = ["/absolute/path/to/browser-pilot/dist/src/apps/mcp/bin.js"]
```

The MCP process starts or reuses the local daemon automatically. Set `BROWSER_PILOT_PROJECT_ROOT` when a global MCP configuration must write artifacts into a specific project.

> The npm package is not published yet; use a source checkout for now.

## Tools

Browser Pilot exposes five composable MCP tools:

| Tool | Purpose |
| --- | --- |
| `browser_observe` | Capture a structured page model, action space, semantic regions, and continuation resources. |
| `browser_execute` | Run page JavaScript through the injected `browserPilot` helper namespace. |
| `browser_command` | Dispatch trusted input and native browser or CDP operations. |
| `browser_tabs` | List, create, switch, or close connected browser tabs. |
| `browser_screenshot` | Capture viewport or full-page screenshots as artifact files. |

The MCP `tools/list` response is the public syntax authority. Tool definitions live in [`src/commands/commandCatalog.ts`](src/commands/commandCatalog.ts); native command schemas are available through the `browser-pilot://native-command/<cmd>` resources.

## Agent workflow

1. Omit `targetRef` to use the selected active tab. Use `browser_tabs` only to create, switch, close, or disambiguate tabs.
2. Call `browser_observe` when the task needs a structured page model. Its `bp-ref` values route later actions back to the owning tab.
3. Use `browser_execute` for page JavaScript or `browser_command` for native browser operations.
4. Add an explicit `expect` when the outcome must be verified. Read extra semantic resources only when the task needs them.

```text
observe -> choose a bp-ref -> execute or command -> verify -> collect evidence
```

<details>
<summary><strong>Execution and verification contract</strong></summary>

`browser_execute` provides `browserPilot.refs`, `resolve(ref)`, `box(ref)`, and `setValue(target, value)`. Writes are serialized by target and use the extension/CDP fallback path automatically.

Successful actions return `{ "result": ..., "effect"?: ..., "verification"?: ... }`. An `expect` can be a JavaScript truth expression or a structured ABML postcondition such as `{ "ref": "bp-ref://control/...", "state": { "pressed": true } }`. Structured verification reads the same ref before and after dispatch, fuses DOM and targeted accessibility state, and returns a target-scoped diff.

Raw CDP uses `command: { cmd: "cdp", method: "Domain.method", params: {...} }`. Targeting remains at the tool-level `targetRef`; runtime session, physical target, timeout, attach, and cleanup state are not public contract fields.

</details>

## Architecture

```text
AI agent
   | MCP stdio
   v
MCP process -- local IPC --> Node daemon
                                | WebSocket bridge
                                v
                         offscreen transport
                                |
                                v
                       MV3 service worker
                                | Chrome APIs / CDP
                                v
                        Chrome or Edge tab
```

| State | Owner |
| --- | --- |
| MCP protocol and project root | Per-agent MCP process |
| Daemon lifecycle | User-local daemon |
| Connections, pending requests, and target write queues | `BrowserBridgeServer` |
| Selected browser and tab session | Session registry |
| Chrome APIs and CDP sessions | MV3 service worker |
| Captured evidence | Request-scoped project artifact root |

Source is organized by responsibility: `src/apps` contains the MCP server and daemon, `src/bridge` owns transport and extension code, `src/commands` implements public tools, `src/browser-runtime` adapts browser I/O, and `src/kernels` stays pure. Page observation lives in `src/scan` and `capture-src`.

## Security model

- The WebSocket bridge accepts upgrades only from the packaged extension.
- Page content is always untrusted.
- Browser Pilot does not remove page security headers or suppress page dialogs.
- Security reports follow [SECURITY.md](SECURITY.md), not public issues.

## Development

Requirements: Node.js 22+, Chrome or Edge, and [`mise`](https://mise.jdx.dev/) for repository tasks.

```bash
mise run verify
mise run smoke-browser
```

`mise run verify` is the canonical gate. Browser integration changes should also pass `mise run smoke-browser`. Edit source under `src/` and `capture-src/`; `dist/` and `bridge/browser_pilot_bridge/` are generated outputs.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

Licensed under [Apache-2.0](LICENSE).
