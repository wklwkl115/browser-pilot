# GA/TMWD Browser Pro D2 bridge API contract

This contract is the stable boundary between `memory.ga_browser_pro` and the TMWD extension bridge.

## Command envelope

Every command is a JSON object sent through `window.__ga_tmwd_bridge(...)` with:

- `cmd`: canonical dotted `browser_pro.*` command.
- `tabId`: integer Chrome tab id selected by TMWD/CDP.
- `session_id`: logical Browser Pro session id when applicable.
- command-specific arguments (`targets`, `rules`, `options`, `force`, `expected_version`, `install_fingerprint`, `expression`, `frameId`, `source`, `identifier`, `since_seq`, `limit`, `event_types`, `url`, `waitUntil`, `state`, `selector`, `timeoutMs`, `idleMs`, `pollMs`, `visible`, `waitId`, `waits`, `requestId`, `sameDocument`, `eventType`, `listenerId`, `entryType`, `nameContains`, `maxInflight`, plus `browser_pro.network.*` recorder filters such as `sessionId`, `maxEntries`, `maxBodyBytes`, `captureBodies`, `includeUrls`, `excludeUrls`, `resourceTypes`, `methods`, `statuses`, `mime`, `bodyContains`, `wsFrame`, and `sseEvent`).

The authoritative machine-readable schema is `D2_bridge_command_schema.json`.

## Supported commands

Canonical Browser Pro/session commands: `browser_pro.install`, `browser_pro.collect`, `browser_pro.status`, `browser_pro.uninstall`, `browser_pro.clear_buffer`, `browser_pro.pause`, `browser_pro.resume`, `browser_pro.evaluate`, `browser_pro.html`, `browser_pro.screenshot`, `browser_pro.frames`, `browser_pro.evaluate_frame`, `browser_pro.add_new_document_script`, `browser_pro.remove_new_document_script`.

Canonical wait/event commands: `browser_pro.navigate`, `browser_pro.navigateAndWait`, `browser_pro.waitForNavigation`, `browser_pro.waitForLoadState`, `browser_pro.waitForNetworkIdle`, `browser_pro.waitForSelector`, `browser_pro.waitForAny`, `browser_pro.waitForAll`, `browser_pro.cancelWait`, `browser_pro.addEventListener`, `browser_pro.removeEventListener`, `browser_pro.getPerformanceEntries`, `browser_pro.diagnose`.

Canonical Network recorder commands: `browser_pro.network.start`, `browser_pro.network.stop`, `browser_pro.network.status`, `browser_pro.network.clear`, `browser_pro.network.list`, `browser_pro.network.get`, `browser_pro.network.body`, `browser_pro.network.exportHar`, `browser_pro.network.wait`.

Phase3 CDP-backed commands use the persistent CDP bridge: `browser_pro.frames` returns a frame list; `browser_pro.evaluate_frame` requires `frameId` and `expression`; `browser_pro.add_new_document_script` requires `source`; `browser_pro.remove_new_document_script` requires `identifier`. Background normalizes persistent-CDP failures into the D2 error response shape.

`browser_pro.navigate` is intentionally atomic: it starts navigation and does not imply lifecycle completion. Use `browser_pro.navigateAndWait` for the combined operation, or compose `browser_pro.navigate` with `browser_pro.waitForNavigation`/`browser_pro.waitForLoadState`/`browser_pro.waitForNetworkIdle`/`browser_pro.waitForSelector` in Python.

`browser_pro.install` distinguishes safe idempotency from stale Browser Pro reuse with `install_fingerprint`. A matching active session may return idempotent success; a different active fingerprint returns `ALREADY_INSTALLED` unless `force=true` is supplied. Status and diagnostics expose `dispatcher_version`, `install_epoch`, `owner_session_id`, `install_fingerprint`, `installed_marker`, `cleanup_warnings`, and `residue_signatures`.

`browser_pro.waitForAny` and `browser_pro.waitForAll` are bridge-managed wait orchestrators. They accept the same D2 wait-condition objects used by the individual wait commands, resolve with child diagnostics, and must cancel/cleanup non-winning or completed children. The background helper named `diagnoseBrowserPro` is not a public command; it backs the public `browser_pro.diagnose` command and returns observable state for active waits, subscriptions, queues, and CDP/session availability.

`browser_pro.network.start` enables CDP `Network`/`Page` observation for a recorder session and aggregates `requestWillBeSent`, extraInfo, response, data, loading finished/failed, WebSocket frames, SSE events, and Page lifecycle events by `tabId + requestId`. `browser_pro.network.body` returns stored body refs captured through `Network.getResponseBody`; `browser_pro.network.exportHar` returns HAR 1.2 by default or structured JSON when `format="json"`. `browser_pro.network.wait` supports `url`, `method`, `status`, `mime`, `bodyContains`, `wsFrame`, `sseEvent`, `count`, and `idle` criteria and returns timeout diagnostics instead of a naked timeout.

## Wait/event command arguments

- `browser_pro.navigate`: `url`.
- `browser_pro.navigateAndWait`: `url`, `waitUntil`, `timeoutMs`, optional `selector`.
- `browser_pro.waitForNavigation`: `waitUntil`, `timeoutMs`, optional `url`, `sameDocument`, `requestId`.
- `browser_pro.waitForLoadState`: `state`, `timeoutMs`.
- `browser_pro.waitForNetworkIdle`: `idleMs`, `timeoutMs`, `maxInflight`.
- `browser_pro.waitForSelector`: `selector`, `visible`, `timeoutMs`, `pollMs`.
- `browser_pro.waitForAny` / `browser_pro.waitForAll`: `waits` array plus `timeoutMs`; children are D2 wait condition objects and must be cancelled/cleaned by the bridge when no longer active.
- `browser_pro.cancelWait`: optional `waitId`; omitting it cancels pending waits for the tab/session scope.
- `browser_pro.addEventListener`: `eventType`, optional `selector`, `requestId`.
- `browser_pro.removeEventListener`: `listenerId`, optional `requestId`.
- `browser_pro.getPerformanceEntries`: optional `entryType`, `nameContains`, `requestId`.
- `browser_pro.diagnose`: no command-specific argument; returns bridge state for sessions, queues, waits, and CDP availability.
- `browser_pro.network.start`: optional `sessionId`, `maxEntries`, `maxAgeMs`, `maxBodyBytes`, `captureBodies`, `captureRequestPostData`, `includeUrls`, `excludeUrls`, `resourceTypes`, `methods`, `statuses`, `includeWebSocketFrames`, `includeSse`, and `clear`.
- `browser_pro.network.stop`: optional `sessionId`, `keepBuffer`, `clear`, and `remove`.
- `browser_pro.network.status` / `browser_pro.network.clear`: optional `sessionId`.
- `browser_pro.network.list`: optional `sessionId`, `limit`, `offset`, `sinceSeq`, `requestId`, `url`, `method`, `type`, `status`, `mime`, `includeUrls`, `excludeUrls`, `includeDetails`, and `includeBody`.
- `browser_pro.network.get`: `requestId` or `id`; optional `includeBody`.
- `browser_pro.network.body`: `bodyRef` or `requestId`; optional `maxBytes`.
- `browser_pro.network.exportHar`: optional list/export filters, `includeBody`, and `format`.
- `browser_pro.network.wait`: `condition`/`event` plus optional `url`, `method`, `status`, `mime`, `bodyContains`, `wsFrame`, `sseEvent`, `count`, `idleMs`, and `timeoutMs`.

## Success response

```json
{"ok": true, "data": {}}
```

`browser_pro.collect` data includes `events`, `next_seq`, `total_available`, `overflow`, and `dropped_events`. Dispatcher events use `type`, `seq`, `timestamp`, and `data`; the Python evidence layer maps `data` into canonical JSONL `payload`.

## Error response

```json
{"ok": false, "error_code": "INVALID_RULE", "error": "message", "details": {}}
```

Known error codes: `NO_SESSION`, `ALREADY_INSTALLED`, `NOT_INSTALLED`, `INVALID_RULE`, `UNSUPPORTED_TARGET`, `INJECTION_FAILED`, `SAFETY_BLOCKED`, `TIMEOUT`, `BUFFER_OVERFLOW`, `NAVIGATION_TIMEOUT`, `SELECTOR_TIMEOUT`, `NETWORK_IDLE_TIMEOUT`, `NETWORK_RECORDER_NOT_STARTED`, `NETWORK_RECORDER_TIMEOUT`, `BODY_UNAVAILABLE`, `FRAME_DETACHED`, `CROSS_ORIGIN_IFRAME`, `TAB_CRASHED`, `BACKGROUND_THROTTLED`, `EVENT_SUBSCRIPTION_FAILED`, `CANCELLED`, `INTERNAL_ERROR`. Python adapters raise `BrowserProError` for bridge `ok:false` responses and expose D2-style payloads via `error_response`.

The same failure envelope is required for bridge-adjacent commands routed through the extension (`tabs`, `management`, `cdp`, `persistent_cdp`, `batch`, and the content-script unknown-command path). Legacy Chromium/debugger error objects are preserved under `details` instead of being returned as non-D2 `{error: {message: ...}}` payloads.

## Browser execution notes

Use same-origin local HTTP pages for real acceptance. When calling CDP bridge commands through `web_execute_js`, pass the JSON command string directly rather than returning a JavaScript string. After uninstall, assert dispatcher truthiness/original function restoration rather than reading `.installed`.
