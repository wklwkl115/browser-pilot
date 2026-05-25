# Eval 10: Multi-Session Lease Conflict

## Goal

Recover from a browser session/tab lease conflict with explicit session and tab handling.

## Fixture

- Local target: `fixtures/interactive.html` or any deterministic local page.
- Required files: page where a write action can be safely repeated.
- Setup notes: setup should create two browser sessions sharing or targeting the same tab, then attempt conflicting writes.

## Allowed starting tools

- `browser_tabs`
- `browser_execute`
- `browser_scan`
- `browser_evidence`

## Expected tool sequence

1. List or create browser sessions explicitly.
2. Attach/select the intended tab and record `browserSessionId` and `tabId`.
3. Attempt or observe a conflicting write lease.
4. Recover by releasing the lease, choosing the correct session, or retrying with explicit target.
5. Verify final state after the recovered write.

## Success criteria

- Lease conflict is identified as a target/session issue.
- Recovery uses explicit `browserSessionId` and `tabId`.
- No hidden active-tab fallback is relied upon after conflict.

## Required evidence

- Summary evidence: session-id, tab-id, conflict code, or lease-diagnostics.
- Artifact evidence: evidence artifact when conflict diagnostics are long.
- Diagnostics evidence: lease owner/conflict metadata if available.

## Recovery checks

- Expected failure mode: retrying with omitted tab/session and hitting the same conflict.
- Required recovery path: use explicit session/tab or release/reattach before writing.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after lease conflict
- artifact sufficiency
- explicit target discipline
