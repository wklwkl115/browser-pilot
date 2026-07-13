---
name: browser-pilot-cli
description: Drive a real Chrome/Edge tab for AI agents through the Browser Pilot CLI. Prefer the agent loop view → act → read with contextRef; use schema/validate for closed params; escalate to expert tools only when the façade is blocked.
---

# Browser Pilot (Agent skill + CLI)

Browser Pilot is an **agent-first** browser control surface. Primary usage is this skill plus the `browser-pilot` CLI (`--json`). Do not invent click/type tools; do not sleep/wait after mutations.

## Resolve the CLI

- Installed: `browser-pilot`
- Package-local: `npx browser-pilot`
- Source without build: `npx tsx src/apps/cli/bin.ts`

Authoritative discovery:

```text
browser-pilot commands --profile agent --json
browser-pilot schema view --json
browser-pilot schema act --json
browser-pilot schema read --json
browser-pilot validate <view|act|read> --params @params.json --json
```

Public catalog v3 lists **22** tools (core + security + façade). **Agents use only three by default:** `view`, `act`, `read` (`browser_view` / `browser_act` / `browser_read`). Live schema is authoritative over remembered flags.

## Agent loop (default)

1. **view** — readiness + compact decision surface + `contextRef`.
2. **act** — one semantic mutation; settle in the same call; only mechanical `completed` is success.
3. **read** — expand a server-issued `readRef` when the decision needs more content.

```text
# browser-pilot-executable
browser-pilot view --json
```

```text
# browser-pilot-executable
browser-pilot act --context-ref ctx --action '{"kind":"activate","ref":"a_01"}' --json
```

```text
# browser-pilot-executable
browser-pilot read --context-ref ctx --read-ref r_01 --json
```

Carry only **`contextRef`** plus semantic **`ref` / `tabRef` / `readRef` / `confirmationRef`**. Never require `tabId`, `pageEpoch`, baseline ids, or raw `saved.path` on the agent envelope. Identity continuity still uses `browserSessionId + tabId + targetGeneration + pageEpoch` internally; when a returned `reanchorReason` says `document_changed`, `target_replaced`, `session_changed`, `identity_unproven`, or `baseline_missing`, take a fresh `view` and do not reuse old refs.

### Semantic actions

Published `action.kind` values: `activate`, `fill`, `press`, `scroll`, `navigate`, `history`, `select`, `drag`, `submit`.

- Prefer candidates from the latest `view` / post-act `view`.
- Sensitive kinds (submit / navigate / irreversible) need a one-shot **`confirmationRef`** from the decision surface; mismatch/expired/consumed rejects without dispatch.
- Do not auto-replay after ACK. If outcome is not `completed`, follow `decision` / typed error codes; re-`view` or reacquire instead of replaying the same mutation.
- Do not post-action `sleep` / public wait. Settlement is inside `act`.
- Temporary JavaScript is **not** part of the default agent loop. Raw JS is expert-only via `execute`.

### Outcomes

- `browser_view` → `browser-agent-view/v1` (`contextRef`, candidates, decision).
- `browser_act` → `browser-agent-turn/v1` (maps an internal `browser-operation/v2` 1:1; outcome-first; post-view is fail-open and must not rewrite a settled outcome).
- `browser_read` → `browser-agent-read/v1`.
- Only mechanical **`completed`** is success. Primitive expert writes return `browser-operation/v2` with the same rule: `no_effect`, `effect_observed`, `stalled`, `ambiguous`, `target_lost`, `failed`, and `deadline` are never success.

### Readiness and failures

- Happy path: first `view` ensures daemon/bridge/extension readiness; no manual connect/schema ritual required.
- On readiness failure: `browser-pilot connect --wait --json`, then `status --json` / `doctor --json` (admin/local commands; not part of the agent tool profile).

- Stable façade codes include `CONTEXT_*`, `TARGET_AMBIGUOUS`, `READ_UNAVAILABLE`, `RUNTIME_NOT_READY`, confirmation mismatch, and busy/revision conflicts.
- Daemon restart expires contexts: create a new context with `view`.

## Profile filter

Use `browser-pilot commands --profile agent --json` for the three-tool agent surface (`agent` and `agent-preview` are aliases). Full catalog (`commands --json`) remains available for discovery of expert/security tools.

## Expert escalation (only when blocked)

Use when `decision=blocked` / inconclusive with an explicit capability boundary, or when the user explicitly authorizes security/network deep work.

```text
# browser-pilot-executable
browser-pilot observe --json
```

```text
# browser-pilot-executable
browser-pilot execute --script "document.title" --json
```

```text
# browser-pilot-executable
browser-pilot network capture-reload --json
```

Prefer the one-shot page-load flow. Use canonical CLI action `capture-reload` instead of manually starting capture after navigation; it translates to raw `{"action":"captureReload"}`, arms the recorder before reload/navigation, and avoids missing early requests. CLI action tokens are kebab-case and camelCase tokens are not aliases. Use lower-level `start`, `list`, `export-har`, and `stop` only when persistent recorder control is required.

```text
# browser-pilot-executable
browser-pilot artifact --mode inspect --path <saved.path> --json
```

Inspect metadata or list available JSON paths before targeted reads. Do not guess JSON paths.

Re-enter the agent loop with a fresh `view` after expert steps.

## Enforce In-Memory Temporary JavaScript

This is a mandatory operating rule, not a preference:

- Temporary, generated, multiline, complex, or quote-sensitive JavaScript MUST be piped directly to `browser-pilot execute --script -` over stdin.
- Agents MUST NOT create a temporary `.js`, `.mjs`, text, or other local file and then pass it through `--script @file` merely to execute transient JavaScript.
- Short shell-safe JavaScript MAY remain inline because it is also memory-only.
- `--script @file` MAY be used only for durable source that already exists or that the user explicitly requested as a persistent artifact.
- If the calling environment cannot pipe stdin directly, use its process stdin API or repair the invocation path; do not fall back to a temporary script file.

## Hard rules

- Add `--json` and parse structured results.
- One semantic mutation per `act`; never blind-replay after ACK.
- Keep secrets out of logs; confirmation digests never include passwords/tokens.
- Contributor rules (`AGENTS.md`, `REPO_GOVERNANCE.md`, `CODE_WIKI.md`) apply only when editing this repository; live CLI schema owns operational syntax.
