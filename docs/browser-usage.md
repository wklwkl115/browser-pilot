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
3. Click Load unpacked and select `bridge/browser_pilot_bridge`.
4. Confirm the extension name is Browser Pilot Bridge.
5. Reload the extension after running `npm run build:bridge`.
   The loaded extension uses the generated `dist` runtime declared by
   `bridge/browser_pilot_bridge/manifest.json`.
6. Enable Allow access to file URLs if you need `browser_upload` with local files.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BROWSER_PILOT_BRIDGE_HOST` | `127.0.0.1` | Bridge listen address |
| `BROWSER_PILOT_BRIDGE_PORT` | `18765` | Bridge port range start |
| `BROWSER_PILOT_BRIDGE_PORT_RANGE_END` | `18784` | Bridge port range end |
| `BROWSER_PILOT_RENDERER` | `salience` | Observation renderer |
| `BROWSER_PILOT_MEMORY` | `1` | Browser memory auto-surface |

When changing bridge ports, set `BROWSER_PILOT_BRIDGE_PORT`, run
`npm run build:bridge`, and reload the extension.

## Verify

```bash
npm run check
npm run quality:local
npm run verify:package
```

`npm run check` typechecks, lints, builds Node output, builds the extension, and
then runs `verify:package`. Package verification creates an npm tarball, installs
it into a clean throwaway consumer project, and runs the shipped
`browser-pilot` CLI help/schema/status commands. Artifacts are written under
`.browser-pilot/artifacts/public-package/`.

## Troubleshooting

1. Extension not connected: confirm the extension is enabled, the configured port
   matches, and the extension was reloaded after updates.
2. Tab not found: run `browser-pilot tabs --action list` and retry with a current
   target.
3. Command timeout: check whether the page is blocked by modal dialogs or heavy
   scripts.
4. Empty scan result: make the target tab visible and retry `browser-pilot observe --mode scan`.
5. Artifact not found: artifact paths are relative to `.browser-pilot/artifacts/`.
6. Download returns no path: reload the extension and confirm `downloads`
   permission is granted.
7. Upload file access error: enable Allow access to file URLs in extension
   details.
8. Port range exhausted: stop the process using the configured bridge port range
   and retry.

## Security

Never commit API keys, cookies, passwords, tokens, browser profiles, or raw
artifacts. Tool outputs redact sensitive fields by default.
