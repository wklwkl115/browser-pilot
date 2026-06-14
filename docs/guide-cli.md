# CLI Usage Guide

The `browser-pilot` CLI exposes all 22 browser tools as shell subcommands. Any program
that can run shell commands — AI agents, CI pipelines, cron jobs, or a human terminal — can
drive a real browser through it.

A user-local singleton daemon manages the bridge server and auto-starts on first use.
You do not need to start anything manually.

## Prerequisites

- Node.js 22+
- Chrome or Edge with the [Browser Pilot extension loaded](../AI_INSTALL.md)

## First Steps

### 1. Connect

For multi-step workflows, start with a readiness gate:

```bash
browser-pilot connect --wait --json
```

This starts (or reuses) the daemon, waits for the browser extension to connect, and
reports readiness status. Single one-off commands auto-start the daemon for you.

### 2. Observe the Page

```bash
# Structured DOM scan — page structure, actionable elements, forms, collections
browser-pilot observe --mode scan --json

# Main article / content text
browser-pilot observe --mode content --json

# Raw visible text
browser-pilot observe --mode text --json

# Exact HTML of a selector
browser-pilot observe --mode html --selector "#main-content" --json
```

### 3. Execute JavaScript

```bash
# Inline script
browser-pilot execute --script "document.title" --json

# Click an element
browser-pilot execute --script "document.querySelector('.btn-submit').click()" --json

# Longer script from a file (avoids shell quoting)
browser-pilot execute --script-file ./extract.js --json
```

### 4. Wait for Page State

```bash
# Wait for a selector to appear
browser-pilot wait selector --selector "#result" --json

# Wait for navigation to complete
browser-pilot wait navigate --url "https://example.com/dashboard" --json

# Wait for network to settle
browser-pilot wait network-idle --json
```

## Common Workflows

### Page Inspection

```bash
browser-pilot connect --wait --json
browser-pilot tabs --action list --json            # find the target tab
browser-pilot observe --mode scan --json           # understand the page
browser-pilot screenshot --json                    # visual capture
```

### Form Interaction

```bash
# Type into a React/Vue controlled input (native setter + input event)
browser-pilot execute --script-file ./type-input.js --json

# Wait for the result
browser-pilot wait selector --selector ".success-message" --json

# Verify the outcome
browser-pilot observe --mode scan --json
```

Example `type-input.js`:
```javascript
(() => {
  const el = document.querySelector('#search-input');
  if (!el) return { ok: false, reason: 'not_found' };
  el.focus();
  const P = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(P.prototype, 'value').set.call(el, 'search query');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, value: el.value };
})()
```

### Network Capture

```bash
# Start recording
browser-pilot network start --json

# Trigger some action
browser-pilot execute --script "fetch('/api/data').then(r => r.json())" --json

# List captured requests
browser-pilot network list --session-id net-1 --json

# Export as HAR
browser-pilot network export-har --session-id net-1 --json
```

### Multi-Tab Work

```bash
# List all tabs
browser-pilot tabs --action list --json

# Create a new tab
browser-pilot tabs --action create --url "https://example.com" --json

# Switch to a specific tab (use targetRef from tabs list)
browser-pilot tabs --action switch --target-ref "tab-handle-abc" --json
```

### Download & Upload

```bash
# Download a file by clicking
browser-pilot download --selector "a.download-link" --json

# Download by URL
browser-pilot download --url "https://example.com/report.pdf" --json

# Upload a file
browser-pilot upload --file-path "/absolute/path/to/file.txt" --confirm --json
```

## Security Testing

The security tools follow a scoped workflow: observe first, then probe.

```bash
# Fingerprint a target
browser-pilot crawl --action fingerprint --url https://target.example --json

# Crawl for endpoints, links, forms, APIs
browser-pilot crawl --url https://target.example --json

# Path fuzzing
browser-pilot fuzz --mode path --url "https://target.example/FUZZ" --json

# SQL injection detection
browser-pilot sqli --url "https://target.example/search?q=test" --json

# Replay a captured request with mutations
browser-pilot http-replay --raw-request @request.txt --json

# Cookie and session analysis
browser-pilot cookie-analyze --url https://target.example --bind-browser-session --json

# Template-based checks
browser-pilot template --template-path ./check.yaml --url https://target.example --json

# OAST callback listener
browser-pilot callback-oast --action start --json
# ... trigger payloads referencing the callback URL ...
browser-pilot callback-oast --action collect --json
browser-pilot callback-oast --action stop --json
```

See [playbooks/](playbooks/) for step-by-step security testing guides.

## Output Modes

| Context | Format | Force |
|---|---|---|
| TTY (human terminal) | Compact human summary | `--text` |
| Non-TTY (pipes, agents, CI) | Raw JSON envelope | `--json` |

Exit codes: `0` ok, `1` tool error, `2` usage/param error, `3` daemon/bridge unavailable,
`4` local file/input error.

## File Inputs

Prefer files over shell quoting for anything with quotes, braces, or newlines:

```bash
browser-pilot execute --script-file ./script.js --json
browser-pilot command --command @native-command.json --json
browser-pilot http-replay --raw-request @request.txt --json
browser-pilot template --template-path ./template.yaml --url https://target.example --json
```

The `@file` syntax reads the file into the parameter value. `--script-file` is a
CLI-specific shortcut for the `execute` command.

## Daemon Management

The daemon is mostly invisible — it auto-starts and auto-replaces stale versions.
For the rare cases where you need to manage it:

```bash
browser-pilot status --json              # read-only state check (never starts anything)
browser-pilot doctor --json              # broader diagnostics
browser-pilot daemon status              # detailed daemon info
browser-pilot daemon stop                # stop the singleton daemon
```

Do not use `daemon stop` as routine cleanup. The daemon is designed to stay running.

## Self-Discovery

The CLI is fully self-describing:

```bash
browser-pilot --help                     # list all commands
browser-pilot observe --help             # flags for one command
browser-pilot commands --json            # machine-readable command list
browser-pilot schema observe --json      # full schema for a command
browser-pilot schema wait selector --json  # schema for a natural subcommand
browser-pilot validate execute --params @params.json --json  # dry-run validation
```

## Reference

- Full CLI reference: [cli.md](cli.md)
- Tool contracts: [generated/browser-tool-contract.generated.md](generated/browser-tool-contract.generated.md)
- Native protocol: [generated/native-protocol.generated.md](generated/native-protocol.generated.md)
