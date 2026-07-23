# Browser Pilot

Browser Pilot lets AI agents control real Chrome or Edge tabs through MCP, a local Node daemon, and a Manifest V3 extension.

It provides structured page observation, JavaScript and trusted input execution, tab and frame control, network capture, hooks, screenshots, uploads, downloads, and evidence resources.

## Requirements

- Node.js 22+
- Chrome or Edge
- `mise` for development tasks

## Install

```bash
npm install
npm run build:bridge
```

Load `bridge/browser_pilot_bridge` as an unpacked extension from `chrome://extensions` or `edge://extensions` with Developer mode enabled.

## Configure MCP

```toml
[mcp_servers.browser-pilot]
command = "npx"
args = ["--yes", "--package", "browser-pilot", "browser-pilot-mcp"]
```

For a source checkout, build once and point the MCP client at `dist/src/apps/mcp/bin.js`. The MCP process starts or reuses the local daemon automatically. Set `BROWSER_PILOT_PROJECT_ROOT` when a global MCP configuration must write artifacts into a specific project.

## Pair the Agent

Browser control is denied until the agent is approved in the extension:

1. Call `browser_pair` with `{ "action": "start", "label": "your agent" }`.
2. Approve the matching code in the Browser Pilot extension.
3. Call `browser_pair` with `{ "action": "wait", "pairingId": "..." }`.

The resulting token is stored owner-locally and scoped to the MCP client and project root.

## Core Workflow

1. Omit `targetRef` to use the selected active tab; call `browser_tabs` only to create, switch, close, or disambiguate tabs.
2. Call `browser_observe` when the task needs a structured page model. Its `bp-ref` values route later actions back to their owning tab.
3. Use `browser_execute` for page JavaScript or `browser_command` for native browser operations. For writes, pass `expect` only when a business postcondition matters; Browser Pilot owns waiting and reports `effect.verification`.
4. Read additional semantic page regions from the MCP resources returned by `browser_observe` only when the task needs them.

## Tools

The MCP `tools/list` response is the public syntax authority. Browser tools come from `src/commands/commandCatalog.ts`; `browser_pair` provides the local pairing flow.
`browser_command` publishes canonical command names in its schema. Read `browser-pilot://native-command/<cmd>` for the closed business fields of one command; `browser-pilot://native-commands` is the compact routing index. Targeting stays at the tool-level `targetRef`; runtime session, physical tab/target, timeout, attach, and cleanup state is not part of the public contract. Raw CDP is `command: { cmd: "cdp", method: "Domain.method", params: {...} }`.

`browser_execute` keeps JavaScript as the general page language. Its injected `browserPilot` namespace provides `refs`, `resolve(ref)`, `box(ref)`, and `setValue(target, value)`; writes are target-serialized and automatically use the extension/CDP fallback path.

## Architecture

```text
Agent -> MCP stdio -> local daemon -> WebSocket bridge -> offscreen transport -> MV3 service worker -> Chrome/Edge tab
```

State has one owner at each boundary:

| State | Owner |
| --- | --- |
| MCP protocol and project root | Per-agent MCP process |
| Authentication and daemon lifecycle | User-local daemon |
| Connections, pending requests, and target write queues | `BrowserBridgeServer` |
| Selected browser and tab session | Session registry |
| Chrome APIs and CDP sessions | MV3 service worker |
| Captured evidence | Request-scoped project artifact root |

Trust boundaries are fail-closed: daemon calls require pairing, WebSocket upgrades require the packaged extension origin, and page content is always untrusted. Browser Pilot does not suppress page dialogs or remove page CSP headers.

Source is organized under:

- `src/apps`: MCP server and daemon
- `src/bridge`: server, protocol, and extension
- `src/commands`: public tool implementations
- `src/browser-runtime`: browser I/O adapters
- `src/kernels`: pure logic
- `src/scan` and `capture-src`: page observation code

## Development

```bash
mise run verify
mise run smoke-browser
```

`dist/` and `bridge/browser_pilot_bridge/` are generated outputs.

## License

Apache-2.0
