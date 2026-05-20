# Bridge ESM + TypeScript Bundler Plan

This document freezes the target architecture and gates for TODO 187-193. It is a migration design, not a runtime switch.

## Decision

Adopt an ESM TypeScript source graph for the Chrome Bridge and generate MV3-compatible JavaScript bundles. Prefer `esbuild` for the first implementation because this project needs fast local builds, explicit entry points, reproducible output, and minimal configuration. Rollup remains a fallback only if esbuild cannot preserve a required MV3/page-script behavior.

Do not use tree-shaking or “lower resident memory” as the justification. The benefits that matter here are explicit imports, type-checked cross-file calls, deterministic generated files, and a clean path to delete the current ambient global graph.

## Final state

- Source lives under `bridge_src/` unless TODO 188 chooses an equivalent name before code migration.
- Service worker source is TypeScript ESM with explicit `import/export`.
- Page/content entries are separate bundles, not mixed into the service worker bundle.
- Generated output lives under `bridge/pi_browser_bridge/dist/`.
- `bridge/pi_browser_bridge/manifest.json` points to dist output after TODO 191.
- Old hand-written `background.js importScripts(...)` and unused global bridge files are deleted in TODO 192, not kept as a second production path.
- `bridge-globals.d.ts` is removed or reduced to third-party ambient shims after the ESM graph owns all internal types.

## Bundle entries

- `service-worker`: background/runtime/protocol/CDP/wait/network/hook/frame/html/screenshot/transfer/router/tab_sync/transport/bridge_info/core commands.
- `content`: current `content.js` behavior.
- `hook-dispatcher`: current `hook_dispatcher.js` page MAIN-world dispatcher; output filename must stay compatible with `PI_BROWSER_HOOK_DISPATCHER_FILE` or provide an explicit one-step migration.
- `disable-dialogs`: current `disable_dialogs.js` page script.
- Optional UI entry: popup scripts can remain static until they need module imports.

## Generated-file and package boundary

- `dist/` is generated. It must not be edited by hand.
- Source maps are allowed for development artifacts; release packaging must decide whether to include or exclude maps explicitly.
- `npm run check` must fail when dist is missing or stale after TODO 191.
- Package/include rules must keep source, generated runtime files, manifest, native schema, docs, and contracts portable; no private absolute paths.

## Runtime and verification boundary

- TODO 188 adds the build pipeline without changing manifest runtime.
- TODO 189 migrates service-worker code while preserving command names, schemas, error codes, artifact behavior, summaries, network body/postData capture, and wait supervisor metadata.
- TODO 190 migrates page/content scripts as independent bundles and keeps `chrome.scripting.executeScript({ files })` plus CDP fallback semantics stable.
- TODO 191 switches manifest/package/check/smoke to dist and requires runtime callable verification.
- TODO 192 removes old importScripts/global entrypoints; no long-term fallback path remains.
- TODO 193 proves the final state with `npm run check`, runtime callable artifacts, and behavior drift audit.

## Gate

Code migration may start only after TODO 180-186 are complete:

- wait split and file-size boundaries complete;
- hook dispatcher page-injection boundary frozen;
- smoke port diagnosis documented;
- bridge ambient/global types tightened.

If any prerequisite regresses, pause ESM migration and repair the prerequisite first.
