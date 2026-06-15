# Browser Usage

This is the public installation, extension loading, verification, and
troubleshooting guide for Browser Pilot.

## Install

```bash
git clone <repository-url> browser-pilot
cd browser-pilot
npm install
npm run build
npm run build:bridge
```

## Load The Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click Load unpacked and select `bridge/pi_browser_bridge`.
4. Confirm the extension name is Pi Native Browser Bridge.
5. Reload the extension after running `npm run build:bridge`.
   The loaded extension uses the generated `dist` runtime declared by
   `bridge/pi_browser_bridge/manifest.json`.
6. Enable Allow access to file URLs if you need `browser_upload` with local files.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PI_BROWSER_BRIDGE_HOST` | `127.0.0.1` | Bridge listen address |
| `PI_BROWSER_BRIDGE_PORT` | `18765` | Bridge port range start |
| `PI_BROWSER_BRIDGE_PORT_RANGE_END` | `18784` | Bridge port range end |
| `PI_BROWSER_RENDERER` | `salience` | Observation renderer |
| `PI_BROWSER_MEMORY` | `1` | Browser memory auto-surface |

When changing bridge ports, set `PI_BROWSER_BRIDGE_PORT`, run
`npm run build:bridge`, and reload the extension.

## Verify

```bash
npm run check
npm run quality:local
npm run release:portable
```

Browser smoke tests require a connected extension:

```bash
npm run smoke:browser
npm run smoke:browser:isolated
npm run smoke:browser:scan-summary
npm run smoke:browser:debugger-evidence
npm run smoke:browser:correlation-chain
npm run smoke:browser:intercept-response
npm run smoke:browser:intercept-replace-script
npm run smoke:browser:intercept-uninstall-fail-closed
npm run smoke:browser:intercept-request-mutate
npm run smoke:browser:intercept-tab-close-cleanup
npm run smoke:browser:intercept-lease-conflict
npm run smoke:browser:websocket-session
npm run smoke:browser:memory
```

Package verification uses `npm pack --dry-run --ignore-scripts --json` inside
`npm run check:package` so checking the package surface does not rebuild dist.

## Pi Commands

When running as a Pi extension, these slash commands are available:

- `/browser-install` checks setup and environment state.
- `/browser-status` reports bridge diagnostics. The same status is available at
  `http://127.0.0.1:<port>/browser-status`.
- `/browser-reload` reloads the bridge connection.
- `/browser-js-ast` parses page JavaScript AST through an internal-only path, not
  a public browser tool.
- `/browser-wasm` inspects page Wasm or a local Wasm path, including `--wat`
  mode, through an internal-only path.
- `/browser-ws` inspects page WebSocket traffic and saves transcripts through an
  internal-only path.

## Troubleshooting

1. Extension not connected: confirm the extension is enabled, the configured port
   matches, and the extension was reloaded after updates.
2. Tab not found: run `browser-pilot tabs --action list` and retry with a current
   target.
3. Command timeout: check whether the page is blocked by modal dialogs or heavy
   scripts.
4. Empty scan result: make the target tab visible and retry `browser_observe`.
5. Artifact not found: artifact paths are relative to `.pi/browser-artifacts/`.
6. Download returns no path: reload the extension and confirm `downloads`
   permission is granted.
7. Upload file access error: enable Allow access to file URLs in extension
   details.
8. Port range exhausted: smoke tests report the reason in
   `.pi/browser-artifacts/smoke-browser-results.json` as `agent_occupies`,
   `orphan_socket`, or `unknown_owner`; stop the occupying process and retry.

## Security

Never commit API keys, cookies, passwords, tokens, browser profiles, or raw
artifacts. Tool outputs redact sensitive fields by default.
