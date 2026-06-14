# Installation & Setup

This guide covers installation, browser extension loading, configuration, verification,
and troubleshooting. For tool usage and workflows, see the
[CLI skill](skills/browser-pilot-cli/SKILL.md) or
[Pi native skill](skills/browser-pilot/SKILL.md).

## Install

```bash
git clone <repository-url> browser-pilot
cd browser-pilot
npm install
npm run build
npm run build:bridge
```

## Load the Browser Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** → select the `bridge/pi_browser_bridge` directory.
4. Confirm the extension name is **Pi Native Browser Bridge**.
5. Confirm permissions include `downloads`, `webNavigation`, and `offscreen`.
   After updating the extension, reload it to enable download path reporting,
   navigation event monitoring, and durable WebSocket transport.
6. To use `browser_upload` with local file paths, enable **Allow access to file URLs**
   in the extension details.

## Configuration

Default settings work out of the box:

| Variable | Default | Description |
|---|---|---|
| `PI_BROWSER_BRIDGE_HOST` | `127.0.0.1` | Bridge listen address |
| `PI_BROWSER_BRIDGE_PORT` | `18765` | Bridge port range start |
| `PI_BROWSER_BRIDGE_PORT_RANGE_END` | `18784` | Bridge port range end |

To change the bridge port:

1. Set `PI_BROWSER_BRIDGE_PORT` (and optionally `PI_BROWSER_BRIDGE_PORT_RANGE_END`).
2. Run `npm run build:bridge` to sync the extension config.
3. Reload the browser extension.

## Reload After Changes

- **Node.js source (`src/`)**: restart the host process or Pi session.
- **Browser extension (`bridge_src/`)**: run `npm run build:bridge` to rebuild the
  dist bundle and Manifest V3 runtime, then reload the extension in
  `chrome://extensions`.
- **Skill files**: edit directly — changes take effect on next session.

## Verify

Quick check:

```bash
npm run check          # all contract/unit/boundary tests (no browser needed)
```

Full local gate (build + lint + check + `npm pack --dry-run --ignore-scripts --json`):

```bash
npm run quality:local
```

Narrow gates for faster iteration:

```bash
npm run check:all:src         # source type checks + registry drift
npm run check:all:bridge      # bridge + unit tests
npm run check:all:package     # package + docs checks
npm run check:all:contracts   # contract tests
```

Browser smoke tests (require extension connected):

```bash
npm run smoke:browser                          # against running browser
npm run smoke:browser:isolated                 # isolated Chrome/Edge profile
npm run smoke:browser:scan-summary             # observation/scan summary shape
npm run smoke:browser:debugger-evidence        # CDP debugger evidence capture
npm run smoke:browser:correlation-chain        # cross-tool correlation chaining
npm run smoke:browser:intercept-response       # response interception
npm run smoke:browser:intercept-replace-script # script replacement interception
npm run smoke:browser:intercept-uninstall-fail-closed  # intercept uninstall fail-closed
npm run smoke:browser:intercept-request-mutate # request mutation before send
npm run smoke:browser:intercept-tab-close-cleanup      # tab-close cleanup diagnostics
npm run smoke:browser:intercept-lease-conflict # cross-session write conflict
npm run smoke:browser:websocket-session        # websocket open/replay/failure
npm run smoke:browser:memory                   # task-scope memory record/recall
```

## Pi-Native Commands

When running as a Pi extension, these slash commands are available:

- `/browser-install` — setup and environment check
- `/browser-status` — bridge diagnostics (also `http://127.0.0.1:<port>/browser-status`)
- `/browser-reload` — reload bridge connection
- `/browser-js-ast` — parse page JS AST (internal-only path, not a public browser tool)
- `/browser-wasm` — inspect/parse page Wasm, with optional local Wasm path and `--wat` mode (internal-only path)
- `/browser-ws` — inspect page WebSocket traffic and save transcripts (internal-only path)

## Troubleshooting

1. **Extension not connected** — check that the extension is enabled, the port
   matches, and the extension was reloaded after updates.
2. **Tab not found** — run `browser_tabs list` (or `browser-pilot tabs --action list`)
   to confirm available tabs. Stale `tabHandle` errors include
   `recovery.suggestedTargetRef` when a replacement exists.
3. **Command timeout** — check pending requests and whether the target page is
   blocking (modal dialogs, heavy scripts).
4. **Empty scan result** — switch to the target tab first and confirm the page is
   visible, then retry `browser_observe mode=scan`.
5. **Artifact not found** — artifact paths are relative to `.pi/browser-artifacts/`.
   Use `browser_artifact` with `jsonPath` for targeted reads.
6. **Download returns no path** — reload the extension and confirm `downloads`
   permission is granted.
7. **Upload file access error** — enable **Allow access to file URLs** in
   extension details.
8. **Port range exhausted** — smoke tests report diagnostic info in
   `.pi/browser-artifacts/smoke-browser-results.json` with PID and reason
   (`agent_occupies`, `orphan_socket`, or `unknown_owner`). Stop the occupying
   process manually.

## Security Notes

- Never commit API keys, cookies, passwords, tokens, or browser profiles.
- Artifacts in `.pi/browser-artifacts/` are local raw evidence — do not upload
  or commit them. Clean up with `rm -rf .pi/browser-artifacts/*`.
- Tool outputs redact sensitive fields (cookies, tokens, authorization headers)
  by default. Use `browser_artifact` with `jsonPath` for targeted raw reads.
