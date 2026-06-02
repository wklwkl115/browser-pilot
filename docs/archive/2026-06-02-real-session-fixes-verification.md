# Real-session fixes — verification (2026-06-02)

Six fixes were derived from mining a real 912-minute agent session
(`sessions/…019e8409….jsonl`, 560 tool calls, 8.9% error rate) and implemented
across the bridge, driver, tool, and MCP layers. This records how each was
verified.

## Source signal (what the session showed)

- `browser_observe → "too many persistent CDP sessions"` ×2, only after ~call #386 (accumulating leak).
- `additionalProperties:false` rejections of reasonable params (`redact` on `browser_execute`/`browser_command`).
- `browser_cookie_analyze → INVALID_RULE` ×3 (50% of its calls) on `{url, bindBrowserSession, tabId}`.
- `TAB_NOT_FOUND` ×10 (7 from `browser_wait loadState`) — 14 monotonically-changing tabIds across 19 navigations; agent cached stale ids.
- Thin diagnostics: `http_replay "fetch failed"` (no cause), `BODY_UNAVAILABLE` (reason buried), navigate non-URL → raw CDP `-32000`.

## Result summary

| # | Fix | Layer | Status | Evidence |
|---|---|---|---|---|
| 1 | CDP persistent-session leak (P0) | bridge | ✅ live-verified | Opened 15+ tabs (each `observe scan`), closed 10 — no `too many persistent CDP sessions` for the whole run. |
| 2 | Stale `tabId` recovery + guidance (P2) | driver/docs | ✅ live-verified | Omitting `tabId` routed to the active tab; a stale (closed) tabId returned `TAB_NOT_FOUND` with `recovery.hint` ("Omit tabId to target the active tab, or use the current tab id 1310485623") and `recovery.liveTabIds` (9 live ids); retry with `tabId` omitted succeeded. |
| 3 | `redact:false` uniform output control (P1a) | tool | ✅ live-verified | `browser_execute({redact:false})` accepted and returned the raw cookie inline; without it the model-facing value stayed `[redacted]`. |
| 4 | `cookie_analyze` auto-collect (P1c) | tool | ✅ live-verified | `browser_cookie_analyze({url, bindBrowserSession:true})` auto-collected 14 cookies (`source=browser-session`); empty case reports "found no cookies for … bound session". |
| 5 | Error diagnostics (P3) | bridge/tool | ✅ live-verified | navigate `"search_keyword"` → `INVALID_RULE` "requires a valid absolute URL …"; `http_replay` to a dead host → error carries cause `ECONNREFUSED`, not bare "fetch failed". |
| 6 | Unknown-param message (P1b) | mcp | ⚠️ MCP path only — by design | See note below. |

Repo gate at implementation: `tsc` clean (both projects), **`npm run test:unit` 338/338** (+13 new), **`npm run check` → `[check-all] ok`**.

## Note on #6 (P1b) — path boundary, not a defect

The validator a **Pi-host agent** hits is `validateToolArguments`, which lives in the
installed `@earendil-works/pi-ai` package — it runs **before** any of our code and
owns the `"must not have additional properties" / "Received arguments: {…}"`
wording. Our P1b enrichment ("name the unknown key + list accepted params") lands
on the **MCP server path** (what ships to Claude Code) and is covered by
`tests/unit/mcp/validation.test.ts`.

This is acceptable because:

- The unknown param tested (`bogus_field`) is genuinely invalid and **should** be
  rejected; strict rejection there is the intended contract
  (`tests/contracts/drift/check-tool-parameter-framework-validation.mjs`).
- The params that actually blocked the real agent (`redact`, and the
  already-shared `maxChars`/`tabId`) are now **accepted** via P1a — that is the
  real-friction fix.

Going further on the Pi-host message would require forking `pi-ai` or relaxing
`additionalProperties:false` (which breaks the strict-schema contract and intent).
The data-driven path instead: let the usage log surface which **real** params
agents commonly mis-pass, then accept those specifically (as we did for `redact`).

## Usage-log caveat

`PI_BROWSER_USAGE_LOG` must be exported **before the Pi extension starts** (setting
it at runtime has no effect). Set it in the environment and restart Pi to capture
`.pi/usage/*.jsonl` for the next round.
