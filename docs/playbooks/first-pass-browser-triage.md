# First-Pass Browser Triage

## Trigger

Use when the user gives a live page, URL, vague web task, suspected bug, or asks to inspect/debug/verify browser behavior before the exact route is known.

## Inputs

- Target tab or URL.
- User goal: inspect, automate, extract data, capture requests, test security behavior, or produce evidence.
- Scope limits: allowed host/origin/path/account and any actions that must not be performed.

## Route

1. `browser_tabs action=list`; choose the live target and keep `tabId`.
2. If a URL must be opened, use `browser_tabs action=create` or browser navigation, then `browser_wait` for load/selector.
3. `browser_observe {mode:"scan", tabId}` for structure, text signals, actionables, forms, frames, and artifact hints.
4. If content matters, use `browser_observe {mode:"content"}`; if selector/DOM details matter, use `browser_observe {mode:"html"}`.
5. If requests matter, start `browser_network` before the user action, then perform the action and list/get relevant requests.
6. Classify the next route:
   - page operation -> `browser_execute` + `browser_wait` + re-observe
   - API/request behavior -> request capture and replay playbook
   - discovery -> recon and discovery playbook
   - SQLi -> SQLi verification playbook
   - cookie/session/JWT -> auth/session playbook
   - SSRF/blind callback -> SSRF/OAST playbook
   - reportable evidence -> evidence and reporting playbook

## Evidence to keep

- `tabId`, URL, selectors, frame IDs.
- `operationId`, `snapshotId`, `requestId`, `waitId`, `listenerId`, `sessionId` when returned.
- Artifact paths from observe/network/hook/evidence/replay tools.

## Pivot

- Selector missing: re-observe with `scan` or `html`, then inspect `browser_frame list`.
- State not changing: use `browser_wait action=diagnose`, then re-observe.
- Request not captured: restart `browser_network` before repeating the action.
- Large/sensitive output: use `outputPath` and `browser_artifact`; do not paste raw payloads.

## Stop

Stop triage and ask for scope clarification when the task requires authentication, destructive action, purchase/submission, file upload, or testing outside the provided target scope.
