# Browser Pilot

Browser Pilot lets AI agents control real Chrome or Edge tabs through MCP, a local Node daemon, and a Manifest V3 extension.

It provides structured page observation, JavaScript and trusted input execution, tab and frame control, network capture, hooks, screenshots, uploads, downloads, evidence, and bounded artifact reads.

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

## Core Workflow

1. Call `browser_tabs` with `action: "list"` and keep the returned `targetRef`.
2. Call `browser_observe` for the structured page model.
3. Use `browser_execute` for page JavaScript or `browser_command` for native browser operations.
4. Read large saved results incrementally with `browser_artifact`.

## Tools

The MCP `tools/list` response is the public syntax authority. Browser tools come from `src/commands/commandCatalog.ts`; `browser_pair` provides the local pairing flow.

## Architecture

```text
Agent -> MCP stdio -> local daemon -> WebSocket bridge -> offscreen transport -> MV3 service worker -> Chrome/Edge tab
```

Source is organized under:

- `src/apps`: MCP server and daemon
- `src/bridge`: server, protocol, and extension
- `src/commands`: public tool implementations
- `src/browser-runtime`: browser I/O adapters
- `src/kernels`: pure logic
- `src/scan` and `capture-src`: page observation code

## Development

```bash
mise run test
mise run smoke-browser
```

`dist/` and `bridge/browser_pilot_bridge/` are generated outputs.

## License

Apache-2.0
