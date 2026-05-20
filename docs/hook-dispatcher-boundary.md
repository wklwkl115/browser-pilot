# Bridge Hook Dispatcher Boundary

This document freezes the page-injection boundary for `bridge/pi_browser_bridge/hook_dispatcher.js` before the ESM/TypeScript bundler migration in TODO 187-193.

## Current injection graph

- `runtime.js` owns `PI_BROWSER_HOOK_DISPATCHER_FILE = 'hook_dispatcher.js'` and page calls through `window.__PI_BROWSER_HOOKS__.dispatch(...)`.
- `hook.js` first injects the dispatcher with `chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PI_BROWSER_HOOK_DISPATCHER_FILE] })`.
- If Chrome scripting injection fails, `hook.js` fetches the same extension file with `chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE)` and evaluates that exact source through CDP `Runtime.evaluate`.
- The page script installs one page-global API: `window.__PI_BROWSER_HOOKS__`.
- Service worker listener state remains outside the page dispatcher in the tab-scoped wait/event subscription registry.

## Decision

Short term, keep `hook_dispatcher.js` as a single self-contained page bundle. Do not split it into page-side runtime imports while the extension still uses hand-written MV3 scripts.

The dispatcher cannot be split like service worker helpers because both supported injection paths consume one file:

- `chrome.scripting.executeScript({ files })` injects the declared extension resource as a file entry.
- The CDP fallback fetches and evaluates one source string.
- MAIN-world page execution must not depend on service worker `importScripts`, extension module state, or a multi-file page import graph.

The long-term split point is TODO 190: convert the dispatcher into an independently built page bundle with a stable output filename. Until then, internal changes inside `hook_dispatcher.js` must preserve the single-file IIFE boundary.

## Locked invariants

- The dispatcher remains a self-contained IIFE and does not use `import`, dynamic `import()`, `export`, `importScripts`, `chrome.*`, or service-worker-only APIs.
- `window.__PI_BROWSER_HOOKS__` remains the only public page global for command dispatch.
- `hook.install`, `hook.collect`, `hook.status`, `hook.uninstall`, `hook.clear_buffer`, `hook.pause`, `hook.resume`, and `hook.evaluate` keep their response envelope and error-code semantics.
- Explicit session mismatch keeps returning `INVALID_SESSION` and must not uninstall or clean the active session.
- `hook.collect` stays read-only and must not add lifecycle self-noise.
- `hook.clear_buffer` keeps `seq` monotonic; it clears buffered events without resetting the global event sequence.
- `hook.uninstall` keeps wrapper/listener cleanup diagnostics.
- `options.redact_patterns` keeps count/length budgets and unsafe-regex literal fallback.

## Contract gates

- `tests/contracts/check-bridge-files.mjs` locks the injection filename, service worker exclusion, self-contained page-bundle form, and this boundary document.
- `tests/contracts/check-page-scripts.mjs` locks page-script self-containment and absence of background-only APIs.
- `tests/contracts/check-pi-browser-bridge.mjs` keeps VM behavior coverage for session strict-match, collect no self-noise, monotonic sequence, listener cleanup, and redact pattern budgets.
