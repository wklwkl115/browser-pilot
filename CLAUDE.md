# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**pi-browser-tools** is a native Pi browser automation extension that provides real browser tab control, simplified DOM scanning (GA-style), JavaScript/CDP execution, evidence capture, network recording, file transfer, and a Web security testing tool layer — all backed by a Chrome extension service worker and a Node.js bridge server.

## Active Execution Contract

- Migration contract (now landed): `docs/cli-skill-frontend-migration-plan.md`
- Current shipping external frontends are **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**. The MCP shell has been removed; CLI usage is documented in `docs/cli.md`.
- `pi-browser` CLI is shipped: code, contracts, current-facing docs, skill text, and live-browser smoke (`npm run smoke:cli`) all landed. Remaining migration items are doc/archive cleanup only.
- `docs/abml-execution-plan.md` is no longer the active queue; ABML remains an internal substrate / historical execution contract.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension (bridge_src/)                                 │
│  service-worker.ts → ESM bundle → bridge/dist/service-worker.js │
│  page_scripts/ → content.ts, hook_dispatcher.ts, disable_dialogs.ts
│  Commands: wait, network, hook, frame, screenshot, transfer...  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ WebSocket (127.0.0.1:18765-18784)
┌─────────────────────────▼───────────────────────────────────────┐
│  Node.js Bridge Server (src/driver/)                            │
│  BrowserBridgeServer (facade)                                   │
│  ├─ BrowserBridgeHttpServer (HTTP/upgrade)                      │
│  ├─ BrowserBridgeClientRegistry (client connections)            │
│  ├─ BrowserTabSessionRouter (tabs/sessions)                     │
│  ├─ BrowserBridgePendingRequests (ACK/timeout)                  │
│  └─ BrowserBridgeDiagnostics (timeout snapshots)                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│  Tool Layer (src/tools/)                                        │
│  toolRegistry.ts → declarative registration order               │
│  toolAdapter.ts → shared params, timeout, error wrapping        │
│  register*Tool.ts → schema + domain logic per tool              │
│  Core: tabs, execute, command, observe, pick, wait, network,    │
│        hook, evidence, frame, screenshot, artifact, download,   │
│        upload                                                    │
│  WebSecurity: recon, crawl, fuzz, sqli, nuclei, template,      │
│               oast, cookie, http_replay                         │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend Migration Boundary

The migration kept one tool core and swapped the external frontend layer (now complete):

- reusable non-protocol frontend helpers live in `src/frontend/` (were in `mcp/`)
- shared ref/resource infra used by core lives in `src/resources/` (was in `mcp/`)
- request-scoped artifacts/memory/wordlists/temp roots use explicit caller `cwd`
- the CLI daemon is a **user-local singleton** (`~/.pi/browser-daemon.json`), not a per-project daemon
- `mcp/` was removed after CLI parity + replacement checks went green and the live-browser `smoke:cli` passed

### Protocol Single Source

`bridge/native_command_schema.json` is the single source of truth for the native command protocol. After modifying it:

```bash
npm run sync:protocol    # generates bridge dist, types, metadata, docs
npm run check:protocol   # verify no drift
```

Generated files (do NOT edit manually):
- `bridge/pi_browser_bridge/native_command_schema.json`
- `bridge_src/service_worker/protocol.ts`
- `src/protocol/nativeProtocol.ts`, `nativeActionMetadata.ts`, `nativeErrorCodes.ts`
- `docs/generated/native-protocol.generated.md`

## Common Commands

### Build
```bash
npm run build:bridge          # build extension dist from bridge_src/
```

### Type Check
```bash
tsc -p tsconfig.json             # check src/ (Node.js code)
tsc -p tsconfig.bridge-src.json  # check bridge_src/ (extension code)
```

### Checks & Quality
```bash
npm run check                 # run all checks (bridge, unit, package, contracts)
npm run check:all:bridge      # bridge + unit tests only
npm run check:all:package     # package + docs checks only
npm run check:all:contracts   # contract tests only
npm run quality:local         # build + check + pack dry-run (no browser)
```

### Tests
```bash
npm run test:unit              # run all unit tests
npm run check:bridge           # bridge types + build + files + protocol + tools
npm run check:web-security     # web security layer boundaries
npm run check:lifecycle        # multi-browser/tab/MV3 fixtures
npm run check:runtime-fixtures # network/hook/wait/transfer fixtures
```

### Smoke Tests (require browser)
```bash
npm run smoke:browser                # full smoke against running browser
npm run smoke:browser:isolated       # isolated Chrome profile smoke
npm run smoke:browser:scan-summary   # scan summary smoke
npm run smoke:browser:transfer       # download/upload smoke
```

### Docs & Protocol
```bash
npm run docs:generate         # regenerate tool contract docs
npm run sync:protocol         # regenerate protocol from native_command_schema.json
npm run docs:sync-indexes     # sync archive/roadmap/todo index blocks
```

## Key Files & Directories

- `src/tools/toolRegistry.ts` — declarative tool registration order + capability profile groups
- `src/tools/toolAdapter.ts` — shared param handling, timeout, error wrapping, artifact fallback
- `src/driver/BrowserBridgeServer.ts` — facade delegating to sub-registries
- `bridge_src/service-worker.ts` — Chrome extension entry point (ESM import graph)
- `bridge/native_command_schema.json` — native command protocol source of truth
- `tests/contracts/` — contract tests (protocol, tools, boundaries)
- `tests/smoke/` — browser smoke tests
- `docs/generated/` — auto-generated protocol and tool contract docs
- `docs/cli-skill-frontend-migration-plan.md` — active frontend migration execution contract

## Development Workflow

1. **Changing bridge_src/**: Edit TypeScript in `bridge_src/`, then `npm run build:bridge`, then reload extension
2. **Changing src/**: Edit TypeScript in `src/`, types check with `tsc -p tsconfig.json`
3. **Changing protocol**: Edit `bridge/native_command_schema.json`, then `npm run sync:protocol`
4. **Adding a tool**: Add registrar in `src/tools/toolRegistry.ts`, create `register*Tool.ts`, update tests
5. **Before merging**: `npm run quality:local` (build + all checks + pack dry-run)
6. **During the active frontend migration**: update `CURRENT.md` + `docs/cli-skill-frontend-migration-plan.md` before large frontend/package/contract moves

## TypeScript Configuration

- `tsconfig.json` — Node.js source (`src/`, `index.ts`), strict, ES2022, ESNext modules
- `tsconfig.bridge-src.json` — Extension source (`bridge_src/`), strict, ES2022, ESNext, WebWorker lib

Both use `moduleResolution: "Bundler"` and `noImplicitAny: true`.

## Conventions

- Tool outputs default to `detailLevel:"summary"` — compact, token-efficient, cookie/token redacted
- Sensitive evidence goes to local artifacts in `.pi/browser-artifacts/`, not in tool output
- Bridge port range: `127.0.0.1:18765-18784` — first free port is used
- `browserSessionId` parameter isolates tab selection across concurrent sessions
- Write operations require lease; concurrent write to same tab returns `TAB_LEASE_CONFLICT`
