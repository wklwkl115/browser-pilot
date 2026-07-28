<div align="center">

# Browser Pilot

**Give AI agents structured control of real Chrome and Edge tabs.**

Browser Pilot connects MCP clients to a local Node daemon and a Manifest V3 extension for observation, execution, native browser commands, screenshots, and evidence capture.

[![CI](https://github.com/wklwkl115/browser-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/wklwkl115/browser-pilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/browser-pilot-mcp?logo=npm&color=CB3837)](https://www.npmjs.com/package/browser-pilot-mcp)
[![License](https://img.shields.io/github/license/wklwkl115/browser-pilot?color=2563EB)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-compatible-22D3EE)
![Chrome and Edge](https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-F59E0B?logo=googlechrome&logoColor=white)

[English](README.md) | [简体中文](README.zh-CN.md)

[Demos](#real-workflows) | [Quick start](#quick-start) | [Tools](#tools) | [Workflow](#agent-workflow) | [Architecture](#architecture) | [Security](#security-model) | [Development](#development)

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/browser-pilot-flow.svg" alt="Browser Pilot routes MCP requests through a local daemon and Manifest V3 extension to a real browser tab" width="100%">

</div>

## Why Browser Pilot

| Observe before acting | Use the browser's real capabilities | Verify the result |
| --- | --- | --- |
| Structured page models expose actionable controls, semantic regions, frames, and deterministic continuation frontiers. | Run page JavaScript, trusted input, Chrome APIs, CDP commands, tab operations, uploads, and downloads. | Writes return bounded effects; explicit expectations return target-scoped verification and diffs. |

Browser Pilot works with the tabs and authenticated sessions already open in Chrome or Edge. Each protocol boundary has one state owner, while page content remains untrusted.

## Real workflows

Each GIF shows one complete browser task: the goal, the visible action, and the verified result. They are captured from an isolated Edge session by [`scripts/capture-readme-demos.mjs`](scripts/capture-readme-demos.mjs), with every state change coming from the public Browser Pilot tools.

### Create and verify a support case

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/demo-form-verification.gif" alt="Browser Pilot observes a support form, fills its fields, submits with trusted input, and verifies the result" width="100%">

### Find and open an overdue invoice

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/demo-structured-research.gif" alt="Browser Pilot filters an invoice table through an observed ref and opens the matching record" width="100%">

### Sync inventory and verify the result

<img src="https://raw.githubusercontent.com/wklwkl115/browser-pilot/main/docs/assets/demo-network-evidence.gif" alt="Browser Pilot synchronizes west warehouse inventory and verifies the updated totals" width="100%">

## Quick start

### 1. Install the extension

```bash
npx --yes browser-pilot-mcp@latest install
```

The installer copies the packaged extension to `~/.browser-pilot/extension` and opens the matching Chrome or Edge extensions page. On first install, enable **Developer mode**, choose **Load unpacked**, and select the directory printed by the command. This confirmation cannot be bypassed for an unpacked extension by browser security policy.

Use `--browser edge` or `--browser chrome` when both browsers are installed. After an npm upgrade, run the installer again and click **Reload** on the page it opens.

### 2. Configure your MCP client

```toml
[mcp_servers.browser-pilot]
command = "npx"
args = ["--yes", "--package", "browser-pilot-mcp@latest", "browser-pilot-mcp"]
```

On the first tool call, the MCP process starts or reuses the local daemon automatically. It scopes artifact resources to the MCP client's first filesystem root; clients that do not expose roots fall back to `BROWSER_PILOT_PROJECT_ROOT`, then the process working directory.

<details>
<summary><strong>Build from source</strong></summary>

```bash
git clone https://github.com/wklwkl115/browser-pilot.git
cd browser-pilot
npm ci
npm run build
npm run build:bridge
npm run mcp -- install
```

Then point the MCP client at `dist/src/apps/mcp/bin.js` with `command = "node"`.

</details>

## Tools

Browser Pilot exposes five composable MCP tools:

| Tool | Purpose |
| --- | --- |
| `browser_observe` | Return compact page content, actions, changes, and expandable semantic resources. |
| `browser_execute` | Run page JavaScript in the selected or ref-owning tab. |
| `browser_command` | Run trusted input and validated native browser or CDP operations. |
| `browser_tabs` | List, switch, create, or close connected browser tabs. |
| `browser_screenshot` | Return a viewport or full-page screenshot as an MCP image resource. |

The MCP `tools/list` response is the public syntax authority. [`src/commands/commandCatalog.ts`](src/commands/commandCatalog.ts) owns the public tool list, while each corresponding `*Command.ts` module owns its schema and handler. Native command schemas are available through the `browser-pilot://native-command/<cmd>` resources.

`browser_observe` accepts `mode: "auto" | "full" | "diff"` and `visual: "auto" | "always" | "never"`. Its inline result contains decision-facing data; any irreducible overflow is exposed through typed observation resources. `browser_tabs` always returns `{ "tabs": [...] }`, while `browser_screenshot` returns capture metadata plus the image resource.

## Agent workflow

1. Omit `targetRef` to use the selected active tab. List tabs only to disambiguate them; create, switch, or close one only when the task requires it.
2. Call `browser_observe` only when the task needs page understanding. Its `bp-ref` values route later actions back to the owning tab automatically.
3. Use `browser_execute` for page JavaScript or `browser_command` for native browser operations. Combine deterministic same-page JavaScript in one call.
4. Add `expect` when a write must be verified, and observe again only when the next decision depends on new page state. Read extra semantic resources only when needed.

```text
observe -> choose a bp-ref -> execute or command -> verify -> collect evidence
```

<details>
<summary><strong>Execution and verification contract</strong></summary>

`browser_execute` provides `browserPilot.refs`, `resolve(ref)`, `box(ref)`, and `setValue(target, value)`. Writes are serialized by target and use the extension/CDP fallback path automatically.

Successful `browser_execute` and `browser_command` calls return `{ "result": ..., "effect"?: ..., "verification"?: ... }`; writes may add `effect` and `verification`. An `expect` can be a JavaScript truth expression or a structured ref/state postcondition such as `{ "ref": "bp-ref://control/...", "state": { "pressed": true } }`. Structured verification reads the same ref before and after dispatch, fuses DOM and targeted accessibility state, and returns a target-scoped diff.

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

Source is organized by responsibility: `src/apps` contains the MCP server and daemon; `src/bridge` owns transport and extension code; `src/commands` owns public tool schemas and orchestration; `src/browser-command-runtime` prepares command execution; `src/browser-page-runtime` evaluates page scripts; `src/browser-runtime` adapts browser I/O; and `src/kernels` stays pure. Page scanning lives in `src/scan` and `capture-src`, with observation assembly under `src/commands/observe`.

## Security model

- The WebSocket bridge accepts upgrades only from the configured Browser Pilot extension origin, and command dispatch rejects a stale reported extension build.
- Page content is always untrusted.
- Browser Pilot does not remove page security headers or suppress page dialogs.
- Report vulnerabilities through GitHub private vulnerability reporting. If it is unavailable, open a minimal public issue requesting a private contact path; never include secrets or private evidence.

## Development

Requirements: Node.js 22+, Chrome or Edge, and [`mise`](https://mise.jdx.dev/) for repository tasks.

```bash
mise run verify
mise run smoke-browser
```

`mise run verify` is the canonical gate. Browser integration changes should also pass `mise run smoke-browser`. Runtime source lives under `src/` and `capture-src/`; `dist/` and `bridge/browser_pilot_bridge/` are generated outputs. The bridge host and port range are owned by `bridge/browser_bridge_config.json`; run `npm run sync:config` after changing it.

## License

Licensed under [Apache-2.0](LICENSE).
