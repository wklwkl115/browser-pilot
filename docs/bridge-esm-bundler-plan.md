# Bridge ESM + TypeScript Bundler Plan

This document freezes the target architecture and gates for the Bridge ESM migration. TODO 188-193 completed the first-phase dist runtime migration; TODO 197 migrated the shared/runtime/CDP/wait foundation into real ESM imports; TODO 198 migrated the command layer; TODO 199 migrated the router/transport/tab_sync startup layer and removed ordered service-worker concatenation. TODO 200 completed strict bridge TypeScript and page-script typing; TODO 202 completed the final build/check/pack/isolated-smoke gate. TODO 191 switched the active MV3 runtime to generated dist output; TODO 192 removed the old `background.js importScripts(...)` path instead of keeping it as a second production entry.

## Decision

Adopt an ESM TypeScript source graph for the Chrome Bridge and generate MV3-compatible JavaScript bundles. Prefer `esbuild` for the first implementation because this project needs fast local builds, explicit entry points, reproducible output, and minimal configuration. Rollup remains a fallback only if esbuild cannot preserve a required MV3/page-script behavior.

Do not use tree-shaking or “lower resident memory” as the justification. The benefits that matter here are explicit imports, type-checked cross-file calls, deterministic generated files, and a clean path to delete the current ambient global graph.

## Current phase vs target final state

Current service worker build mode is `esm-import-graph`: `bridge_src/service-worker.ts` directly imports real module exports, calls explicit router/transport startup functions, and esbuild follows the dependency graph from that single entry. B5 adds a separate offscreen transport entry: `bridge_src/offscreen/transport.ts` builds to `dist/offscreen.js`, loaded by `offscreen.html`, and owns the real local bridge WebSocket lifecycle.

The previous `ordered-concat-compat` bridge has been removed: `scripts/build-bridge.mjs` no longer reads service worker source text, no longer creates `bridge_src/.generated/service-worker.generated.ts`, and no longer carries a `serviceWorkerModules` ordered-concat list.

The generated `dist/build-manifest.json` records `serviceWorkerBuildMode:"esm-import-graph"`, `targetServiceWorkerBuildMode:"esm-import-graph"`, `orderedConcatenation:false`, `foundationImported:true`, `commandImported:true`, `startupImported:true`, `offscreenEntry`, and metadata-only module lists (`metadataOnlyServiceWorkerFoundationModules`, `metadataOnlyServiceWorkerCommandModules`, `metadataOnlyServiceWorkerStartupModules`, `metadataOnlyLegacyServiceWorkerModules`).

## Target final state

- Source lives under `bridge_src/` unless TODO 188 chooses an equivalent name before code migration.
- Service worker source is TypeScript ESM with explicit `import/export`.
- Offscreen and page/content entries are separate bundles, not mixed into the service worker bundle.
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
- `npm run check` validates the current dist through `check:bridge:build`; dist regeneration is an explicit `npm run build:bridge` step.
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
- TODO 198 completed the command layer: command modules moved into the ESM import graph, direct runtime imports replaced legacy command globals, command-layer `@ts-nocheck` was removed, and batch/router dispatch now uses a listener-free command helper.
- TODO 199 completed the startup layer: router/transport/tab_sync now use real ESM imports, explicit install functions bind listeners, transport injects tab-sync dependencies, and ordered source concatenation was removed from the build.
- TODO 200 completed the type finalization layer: `tsconfig.bridge-src.json` now has `strict:true` and `noImplicitAny:true`, service-worker and page-script `@ts-nocheck` comments are gone, and type hygiene contracts reject broad `any` regressions.
- TODO 202 completed the final-state gate: `npm run build:bridge`, `npm run check`, `npm pack --dry-run --json`, and isolated runtime smoke passed; final closure is documented in README, AI_INSTALL, CHANGELOG, TODO, and this plan.


## Final gate evidence

TODO 202 final gate evidence:

- `bridge/pi_browser_bridge/manifest.json` points to `dist/service-worker.js` with `type:"module"` and declares the `offscreen` permission for `offscreen.html`.
- `dist/build-manifest.json` records `serviceWorkerBuildMode:"esm-import-graph"`, `offscreenEntry`, `orderedConcatenation:false`, and `metadataOnlyLegacyServiceWorkerModules:[]`.
- `tsconfig.bridge-src.json` has `strict:true` and `noImplicitAny:true`; bridge/page source `@ts-nocheck` comments are forbidden by contract.
- Verification commands passed: `npm run build:bridge`, `npm run check`, `npm pack --dry-run --json`, and `PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run smoke:browser:isolated`.
- Isolated smoke artifact: `.pi/browser-artifacts/smoke-browser-isolated-results.json`; recorded service worker sha256 `b4bc10872b5b9b8e13ba239ff3eed398bc9f7b7d9118473a1807889228e937c7`.

## Gate

Code migration may start only after TODO 180-186 are complete:

- wait split and file-size boundaries complete;
- hook dispatcher page-injection boundary frozen;
- smoke port diagnosis documented;
- bridge ambient/global types tightened.

If any prerequisite regresses, pause ESM migration and repair the prerequisite first.
