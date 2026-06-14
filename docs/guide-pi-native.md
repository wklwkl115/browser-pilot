# Pi Native Usage Guide

When loaded as a Pi extension, Browser Pilot registers all 22 tools as `browser_*` tool
calls. The agent calls them directly in-process — no CLI, no daemon, no shell.

This is the zero-overhead path: tool invocations go straight from the agent runtime to the
bridge server with no serialization or subprocess overhead.

## Prerequisites

- Pi runtime (`@earendil-works/pi-ai` or `@earendil-works/pi-coding-agent`)
- Node.js 22+
- Chrome or Edge with the [Browser Pilot extension loaded](../AI_INSTALL.md)

## Setup

Add Browser Pilot as a Pi extension in your config:

```json
{
  "pi.extensions": ["./path-to/browser-pilot/index.ts"]
}
```

The Pi runtime loads the extension directly from TypeScript source. All 22 `browser_*`
tools register automatically — no additional configuration needed.

## The Observe-Execute-Wait Loop

The core workflow is a three-step loop:

### 1. Observe

```
browser_observe { mode: "scan" }
```

Returns a structured envelope with:
- `summary` — gist, row count, actionable elements
- `outline` — section/container hierarchy
- `collections` — lists, tables, grids with completeness info
- `relations` — table cell/header relationships
- `identity` — backendNodeId coverage

Other observation modes:
- `mode: "content"` — main article text
- `mode: "text"` — raw visible text
- `mode: "html"` — exact DOM/HTML for a selector

### 2. Execute

```
browser_execute { script: "document.querySelector('.btn').click()" }
```

Returns the script's return value plus an `effect` block showing what changed
(mutations, navigation, dirty regions). There are no separate click/type tools — page
actions are JavaScript you write in `browser_execute`.

For trusted-event-gated controls where `el.click()` is silently ignored:

```
browser_execute { script: "return await pi.click('pi-ref://control/...')" }
```

Or use CDP physical input:

```
browser_command { command: { group: "input", action: "pointer", params: { gesture: "press", x: 150, y: 300 } } }
```

### 3. Wait & Verify

```
browser_wait { action: "selector", params: { selector: "#result" } }
```

Then re-observe or check evidence:

```
browser_observe { mode: "scan" }
browser_network { action: "list", sessionId: "net-1" }
browser_evidence {}
```

## Common Workflows

### Page Inspection

```
browser_tabs    { action: "list" }                    // find the target tab
browser_observe { mode: "scan" }                      // understand page structure
browser_observe { mode: "content", selector: "#main" } // extract article text
browser_screenshot {}                                  // visual capture
```

### Form Interaction

```javascript
// browser_execute with this script:
(() => {
  const el = document.querySelector('#email');
  if (!el) return { ok: false, reason: 'not_found' };
  el.focus();
  const P = HTMLInputElement;
  Object.getOwnPropertyDescriptor(P.prototype, 'value').set.call(el, 'user@example.com');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, value: el.value };
})()
```

Then wait and verify:

```
browser_wait    { action: "selector", params: { selector: ".success" } }
browser_observe { mode: "scan" }
```

### Network Capture

```
browser_network { action: "start" }
browser_execute { script: "document.querySelector('.load-more').click()" }
browser_network { action: "list", sessionId: "net-1" }
browser_network { action: "exportHar", sessionId: "net-1" }
```

### Iframe Content

Top-level scans do not cover child frames. Use `browser_frame` explicitly:

```
browser_frame { action: "list" }
browser_frame { action: "evaluate", frameId: "frame-1", expression: "document.body.innerText" }
```

### Download & Upload

```
browser_download { selector: "a.download-link" }
browser_download { url: "https://example.com/report.pdf" }
browser_upload   { filePath: "/absolute/path/to/file.txt", confirm: true }
```

### Browser Memory

The local memory store (`.pi/browser-memory/`) lets the agent stop re-deriving
action sequences for sites it has visited before.

**Recall** happens automatically: `browser_observe mode=scan|text` surfaces matched
SOPs/facts in `envelope.memory` when available.

**Record** after a successful workflow:

```
browser_memory {
  action: "record",
  kind: "sop",
  scopeKind: "origin",
  url: "https://example.com/dashboard",
  title: "Export dashboard as CSV",
  triggers: ["export", "csv", "dashboard"],
  body: "1. Click #export-btn\n2. Wait for .download-ready\n3. Click .download-link"
}
```

## Security Testing

All 7 security tools are available as first-class `browser_*` calls:

| Tool | Purpose |
|---|---|
| `browser_crawl` | Endpoint/link/form/API/source-map discovery, fingerprinting |
| `browser_fuzz` | Path, vhost, and parameter fuzzing |
| `browser_sqli` | SQL injection detection (builtin + sqlmap bridge) |
| `browser_template` | HTTP template checks (builtin + nuclei bridge) |
| `browser_cookie_analyze` | Cookie/JWT/JWE/PASETO/session analysis |
| `browser_http_replay` | Replay and mutate HTTP requests with diff clustering |
| `browser_callback_oast` | Local OAST callback listener (HTTP/HTTPS/DNS) |

Typical flow: `crawl` (fingerprint + discover) -> `fuzz` (explore) -> targeted probes
(`sqli` / `template` / `http_replay`).

## No Connect Step

Readiness is ambient in Pi-native mode. Just call a tool — if the extension is not yet
connected, the bridge waits briefly (configurable via `PI_BROWSER_EXTENSION_WAIT_MS`,
default 5000ms). If the extension is genuinely not loaded, the command fails with
`NO_BROWSER_EXTENSION` and actionable recovery steps.

## Reading Results

Tool results return a compact `summary` plus `resource_link`s and `sections`. Sensitive
fields are redacted; follow redaction pointers with `browser_artifact`:

```
browser_artifact { path: "<saved.path>", mode: "json", jsonPath: "data" }
browser_artifact { path: "<saved.path>", mode: "json", jsonPath: "data.actionables" }
browser_artifact { mode: "search", query: "keyword", glob: "**/*.json" }
```

## Recovery

| Symptom | Action |
|---|---|
| `NO_BROWSER_EXTENSION` | Follow `recovery.nextActions` — load/enable the extension |
| `TAB_NOT_FOUND` | Use `recovery.suggestedTargetRef` or re-list tabs |
| Stale `pi-ref://` | Re-observe with `browser_observe mode=scan` for fresh refs |
| Selector not found | Re-observe, check `browser_frame`, then retry |
| Timeout | `browser_wait { action: "diagnose", waitId }` for diagnostics |

## Reference

- Full Pi-native skill: [skills/browser-pilot/SKILL.md](../skills/browser-pilot/SKILL.md)
- Tool contracts: [generated/browser-tool-contract.generated.md](generated/browser-tool-contract.generated.md)
- Tool boundaries: [tool-boundaries.md](tool-boundaries.md)
