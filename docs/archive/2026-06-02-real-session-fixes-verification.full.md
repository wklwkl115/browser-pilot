# Real-session fixes — detailed verification log (2026-06-02)

> Pair file for `docs/archive/2026-06-02-real-session-fixes-verification.md`.
> This stream was already summary-complete in the original archive note; this
> detail file preserves the same verified facts in long-form archive layout so
> document-structure contracts keep the summary/full pairing invariant.

## Context

Six fixes were derived from mining a real 912-minute agent session
(`sessions/…019e8409….jsonl`, 560 tool calls, 8.9% error rate) and implemented
across the bridge, driver, tool, and MCP layers.

## Source signal

Observed during the real session:

- `browser_observe → "too many persistent CDP sessions"` after long-running use.
- `additionalProperties:false` rejected reasonable top-level params like `redact`.
- `browser_cookie_analyze → INVALID_RULE` on `{url, bindBrowserSession, tabId}`.
- repeated stale-`tabId` failures across navigation churn.
- thin diagnostics on replay/body-unavailable/navigation-invalid cases.

## Verified fixes

### 1. CDP persistent-session leak

Status: ✅ live-verified

Evidence:

- opened 15+ tabs with repeated `observe scan`
- closed 10 tabs
- no recurrence of `too many persistent CDP sessions`

### 2. Stale `tabId` recovery + guidance

Status: ✅ live-verified

Evidence:

- omitting `tabId` targeted the active tab successfully
- stale/closed `tabId` returned `TAB_NOT_FOUND`
- recovery payload included a hint and live tab ids
- retry without `tabId` succeeded

### 3. Uniform `redact:false` output control

Status: ✅ live-verified

Evidence:

- `browser_execute({ redact:false })` accepted and returned raw cookie inline
- default behavior still redacted model-facing values

### 4. `browser_cookie_analyze` auto-collect

Status: ✅ live-verified

Evidence:

- `browser_cookie_analyze({ url, bindBrowserSession:true })` auto-collected browser cookies
- empty-cookie case returned explicit “found no cookies” style diagnostics

### 5. Error diagnostics improvement

Status: ✅ live-verified

Evidence:

- invalid navigation target reported `INVALID_RULE` with explicit absolute-URL requirement
- dead-host replay surfaced concrete transport cause like `ECONNREFUSED`

### 6. Unknown-param enrichment boundary

Status: ⚠️ MCP-path only by design

Detail:

- the richer unknown-param message landed on the MCP validation path
- Pi-host validation still belongs to installed `@earendil-works/pi-ai`
- this was accepted because the real friction path was fixed by admitting the intended params rather than weakening strict validation

## Repo-level verification at implementation time

- `tsc` clean for both projects
- `npm run test:unit` passed
- `npm run check` passed

## Operational caveat

`PI_BROWSER_USAGE_LOG` must be exported before the Pi extension starts; setting it
mid-session does not enable capture for the already-running extension process.

## Relation to current queue

This archive stream is historical only. It is not part of the current active
execution queue.
