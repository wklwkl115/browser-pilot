# Bridge wait.js split plan

This document freezes the current `bridge/pi_browser_bridge/wait.js` dependency map before the staged split in TODO 181-183. The runtime remains MV3 `importScripts`; no behavior changes are allowed in TODO 180.

## Current loader and test boundary

- Service worker loader after TODO 183: `config.js -> protocol.js -> patterns.js -> cdp.js -> runtime.js -> wait_cdp.js -> wait_coordinator.js -> wait_navigation.js -> wait_network_idle.js -> wait_selector.js -> wait.js -> network_model.js -> network.js -> ... -> transport.js`.
- `tests/contracts/check-pi-browser-bridge.mjs` executes wait code through `waitBridgeFiles`. That bundle now contains `wait_cdp.js -> wait_coordinator.js -> wait_navigation.js -> wait_network_idle.js -> wait_selector.js -> wait.js`; future wait subfiles must be prepended there in the same order as `background.js`.
- `tests/contracts/check-bridge-files.mjs` owns the service worker script order contract and keeps `wait.js` as the final wait facade/dispatch script.

## Current staged split status

- TODO 180 completed the read-only map and contract preparation.
- TODO 181 migrated CDP domain refs, event subscriptions, tab cleanup and CDP diagnostics into `wait_cdp.js`; `wait.js` no longer owns `piBrowserCdp*` maps or `piBrowserCdpSubSeq`.
- TODO 182 migrated `WaitCoordinator`, `piBrowserWaits`, wait id/timeout helpers, orphan cleanup, tab-scoped event subscription registry and common wait cleanup into `wait_coordinator.js`; `wait.js` no longer owns the wait registry.
- TODO 183 migrated navigation/load-state into `wait_navigation.js`, networkIdle into `wait_network_idle.js`, selector probe/polling into `wait_selector.js`, and reduced `wait.js` to the final facade/dispatch/diagnose glue.

## Top-level state and responsibility map

| Target file | Current symbols / ranges | Responsibility |
| --- | --- | --- |
| `wait_cdp.js` | `piBrowserCdpSubscriptions`, `piBrowserCdpTabRefs`, `piBrowserCdpDomainRefs`, `piBrowserCdpCleanupHistory`, `piBrowserCdpSubSeq`, `piBrowserCdpDomainKey`, `piBrowserCdpHolderId`, `rememberPiBrowserCdpCleanup`, `sendPiBrowserCdpDomainCommand`, `acquirePiBrowserCdpDomain`, `schedulePiBrowserCdpDomainDisable`, `releasePiBrowserCdpDomains`, `forceReleasePiBrowserCdpDomainsForTab`, `enablePiBrowserCdpDomains`, `attachDebuggerForWait`, `subscribePiBrowserCdp`, `unsubscribePiBrowserCdp`, `cleanupPiBrowserCdpTab`, `diagnosePiBrowserCdpSubscriptions`, `diagnosePiBrowserCdpDomainRefs`, `diagnosePiBrowserCdpCleanupHistory` | CDP domain refcount, event subscription, detach cleanup, diagnostics. |
| `wait_coordinator.js` | `WaitCoordinator`, `piBrowserWaits`, `PI_BROWSER_ORPHAN_WAIT_MAX_AGE_MS`, `cleanupPiBrowserOrphanWaits`, `piBrowserWaitSeq`, `PI_BROWSER_DEFAULT_WAIT_TIMEOUT_MS`, `normalizePiBrowserTimeoutMs`, `makeWaitId`, `waitKey`, `eventSubscriptionKey`, `isAbortError`, `waitAbortMessage`, `normalizeWaitState`, `registerWait`, `recordWaitEvent`, `shouldAbortWaitCleanupReason`, `clearWait`, `cleanupPiBrowserWait`, `isWaitRecordForTab`, `cleanupTabWaits`, `cancelWaitsForTab`, `waitWithTimeout`, `finishPiBrowserWait`, `rejectIfAborted`, `cleanupEventSubscriptionsForTab` | Wait registry, ids, abort/cleanup, orphan GC, tab-scoped listener registry. |
| `wait_navigation.js` | `navigatePiBrowser`, `navigateAndWait`, `waitForNavigation`, `loadStateSatisfied`, `queryLoadMetrics`, `waitForLoadState` | Navigation, load-state, current-state immediate probe, webNavigation/CDP Page events. |
| `wait_network_idle.js` | `compileNetworkIdleFilter`, `waitForNetworkIdle` | Network idle filters, inflight tracking, quiet-window calculation. |
| `wait_selector.js` if needed | `PI_BROWSER_SELECTOR_PROBE_SOURCE`, `buildSelectorProbe`, `waitForSelector` | Selector polling, Runtime binding, visibility/stability checks. |
| `wait.js` facade | `waitForAny`, `waitForAll`, `waitForComposite`, `normalizePiBrowserWaitKind`, `dispatchPiBrowserWait`, `cancelWait`, `cancelPiBrowserWait`, `extractPiBrowserRuntimeValue`, `cleanupPiBrowserPageListenersForTab`, `addEventListener`, `removeEventListener`, `getPerformanceEntries`, `diagnosePiBrowser` | Native wait dispatch, composite waits, hook helper commands, diagnostics glue. |

## External global consumers to preserve

- `runtime.js`: `cleanupTabWaits`, `cancelWaitsForTab`, `waitForNavigation`, `waitForLoadState`, `waitForNetworkIdle`, `waitForSelector`, `diagnosePiBrowser`.
- `network.js` / `network_model.js`: `enablePiBrowserCdpDomains`, `subscribePiBrowserCdp`, `releasePiBrowserCdpDomains`, `diagnosePiBrowserCdpDomainRefs`.
- `transfer.js`: `subscribePiBrowserCdp` for download and file chooser events.
- `hook.js` / `evidence.js`: `addEventListener`, `removeEventListener`, `getPerformanceEntries`, `cleanupPiBrowserPageListenersForTab`.
- Contract tests directly expose: `getPerformanceEntries`, `diagnosePiBrowser`, `waitForNavigation`, `waitForAll`, `waitForAny`, `acquirePiBrowserCdpDomain`, `releasePiBrowserCdpDomains`, `forceReleasePiBrowserCdpDomainsForTab`, `diagnosePiBrowserCdpDomainRefs`.

## Behavior invariants

- `timeoutMs:0` remains a real immediate probe and must not install async listeners on miss.
- TS `BrowserWaitSupervisor` lease metadata, `WAIT_TIMEOUT` / `WAIT_STATE_LOST`, and delayed-success rejection semantics do not change.
- CDP domain disable failure keeps refs for retry; tab removal force cleanup does not retain stale refs.
- Event listener registry remains tab-scoped; uninstall/tab cleanup still removes page listeners.
- `wait.any` / `wait.all` reject empty waits and accept full native command names.
- `networkIdle` uses shared bounded `matchNetworkPattern`; no direct unsafe `new RegExp` returns.
- Diagnose remains read-only: no hook auto-install, iframe probe uses `querySelectorAll('iframe')` plus `window.frames.length`.
