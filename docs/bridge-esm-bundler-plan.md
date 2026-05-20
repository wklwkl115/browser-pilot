# Bridge ESM + TypeScript Bundler Plan

This document freezes the target architecture and gates for the Bridge ESM migration. TODO 188-193 completed the first-phase dist runtime migration; TODO 197 has migrated the shared/runtime/CDP/wait foundation into real ESM imports; TODO 198-202 are the remaining final-state work. TODO 191 switched the active MV3 runtime to generated dist output; TODO 192 removed the old `background.js importScripts(...)` path instead of keeping it as a second production entry.

## Decision

Adopt an ESM TypeScript source graph for the Chrome Bridge and generate MV3-compatible JavaScript bundles. Prefer `esbuild` for the first implementation because this project needs fast local builds, explicit entry points, reproducible output, and minimal configuration. Rollup remains a fallback only if esbuild cannot preserve a required MV3/page-script behavior.

Do not use tree-shaking or “lower resident memory” as the justification. The benefits that matter here are explicit imports, type-checked cross-file calls, deterministic generated files, and a clean path to delete the current ambient global graph.

## Current phase vs target final state

Current service worker build mode is `ordered-concat-compat`: `scripts/build-bridge.mjs` imports the TODO 197 foundation modules (`config/protocol/patterns/cdp/runtime/wait_*`) through the ESM graph, then appends the unmigrated legacy command/startup tail in old bootstrap order. This is a compatibility bridge, not the final ESM topology.

Target service worker build mode is `esm-import-graph`: `bridge_src/service-worker.ts` directly imports real module exports, esbuild follows the dependency graph, and `scripts/build-bridge.mjs` no longer reads service worker source text or carries a `serviceWorkerModules` ordered-concat list.

The generated `dist/build-manifest.json` records both `serviceWorkerBuildMode:"ordered-concat-compat"`, `targetServiceWorkerBuildMode:"esm-import-graph"`, `foundationImported:true`, and the foundation/legacy module lists until TODO 199 removes ordered concatenation.

## Target final state

- Source lives under `bridge_src/` unless TODO 188 chooses an equivalent name before code migration.
- Service worker source is TypeScript ESM with explicit `import/export`.
- Page/content entries are separate bundles, not mixed into the service worker bundle.
- Generated output lives under `bridge/pi_browser_bridge/dist/`.
- `bridge/pi_browser_bridge/manifest.json` points to dist output after TODO 191.
- Old hand-written `background.js importScripts(...)` and unused global bridge files were deleted in TODO 192, not kept as a second production path.
- `bridge-globals.d.ts` was removed after the ESM graph took ownership of internal bridge boundaries.

## Service worker dependency layers

The final import direction is:

1. `shared/types`, `config`, `protocol`, `patterns`
2. `runtime`, `cdp`, wait/network state modules
3. command handlers: network, hook, evidence, frame, html, screenshot, transfer, core commands, exec
4. startup and routing: router, transport, tab_sync, `service-worker.ts`

Business modules must not depend on router, transport, popup UI, or startup side effects. Loose external inputs must be normalized at module boundaries before entering typed internal structures.

## Bundle entries

- `service-worker`: background/runtime/protocol/CDP/wait/network/hook/frame/html/screenshot/transfer/router/tab_sync/transport/bridge_info/core commands.
- `content`: current `content.js` behavior.
- `hook-dispatcher`: current `hook_dispatcher.js` page MAIN-world dispatcher; output filename must stay compatible with `PI_BROWSER_HOOK_DISPATCHER_FILE` or provide an explicit one-step migration.
- `disable-dialogs`: current `disable_dialogs.js` page script.
- Optional UI entry: popup scripts can remain static until they need module imports.

## Generated-file and package boundary

- `dist/` is generated. It must not be edited by hand.
- `npm run build:bridge` regenerates all dist entries used by `manifest.json`.
- Source maps are allowed for development artifacts; release packaging must decide whether to include or exclude maps explicitly.
- `npm run check` regenerates dist before manifest/file contracts validate it after TODO 191.
- Package/include rules must keep source, generated runtime files, manifest, native schema, docs, and contracts portable; no private absolute paths.
- `prepack` regenerates dist in quiet mode. `package.json.files` and generated `bridge/pi_browser_bridge/dist/.npmignore` make `npm pack --dry-run --json` include the generated runtime files even though dist remains git-ignored.

## Runtime and verification boundary

- TODO 188 added the build pipeline without changing manifest runtime.
- TODO 189 migrates service-worker code while preserving command names, schemas, error codes, artifact behavior, summaries, network body/postData capture, and wait supervisor metadata.
- TODO 190 migrates page/content scripts as independent bundles and keeps `chrome.scripting.executeScript({ files })` plus CDP fallback semantics stable.
- TODO 191 switches manifest/package/check/smoke to dist and requires runtime callable verification.
- TODO 192 removes old importScripts/global entrypoints; no long-term fallback path remains.
- TODO 193 proves the first-phase dist runtime state with `npm run check`, runtime callable artifacts, and behavior drift audit.
- TODO 195 closes the package portability gate by proving `npm pack --dry-run --json` includes every dist file referenced by `manifest.json`.
- TODO 197 completed the foundation layer: shared config/protocol/patterns, persistent CDP, runtime core, and wait subsystems now use real import/export and no longer carry `@ts-nocheck`.
- TODO 198-202 remain the true final-state work: migrate command/startup tail to real import/export, remove ordered source concatenation, clear remaining `@ts-nocheck`, and enable strict bridge TypeScript.

## Gate

Code migration may start only after TODO 180-186 are complete:

- wait split and file-size boundaries complete;
- hook dispatcher page-injection boundary frozen;
- smoke port diagnosis documented;
- bridge ambient/global types tightened.

If any prerequisite regresses, pause ESM migration and repair the prerequisite first.
