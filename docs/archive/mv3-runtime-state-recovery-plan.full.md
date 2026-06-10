# MV3 Runtime State Recovery Plan

> Status: COMPLETE — archived. Service-worker runtime state recovery is implemented (`bridge_src/service_worker/state_store.ts`; `RUNTIME_STATE_RECOVERED` / `_WITH_HISTORY_LOSS` / `_LOST` error codes in `src/protocol/nativeErrorCodes.ts`) and moved out of the active queue (see `CURRENT.md` / `ARCHIVE.md`). It did not add a public `browser_*` tool and did not revive orchestration / target resolver / desired-state coordination.

## Goal

Make MV3 service-worker restarts diagnosable and recoverable where the state is configuration-only, while failing closed for state that cannot be safely reconstructed.

Current accurate problem statement:

> SW-side long-lived runtime state such as network buffers, intercept paused requests, WebSocket transcripts, CDP subscriptions, and hook session metadata has architectural loss risk. Existing diagnostics and wait retry mechanisms reduce the blast radius, but they do not provide complete recovery.

## Non-goals

- Do not treat `chrome.alarms` keepalive as a state durability strategy.
- Do not persist evidence payloads in `chrome.storage.session`.
- Do not persist raw body, postData, cookies, authorization headers, tokens, WebSocket payloads, or arbitrary script text.
- Do not automatically reinstall hooks after restart.
- Do not automatically reconnect WebSocket sessions after restart.
- Do not serialize Promise chains, active JS execution, or tab command queue tails.
- Do not add `browser_orchestrate`, logical target resolver, hidden planner, or black-box recovery workflow.

## State inventory and persistence boundary

| State class | Typical size | Persist in `chrome.storage.session` | Strategy |
|---|---:|---|---|
| hook sessions | ~1KB/tab | yes | Persist install args and session metadata; recover only if page `hook.status` still reports the dispatcher. |
| intercept rules | ~2KB/session | yes | Persist rules/config; recover `Fetch` domain and rules; mark paused history lost. |
| network recorder config | ~1KB/recorder | yes | Persist recorder config; recover CDP domains; mark buffers/body history lost. |
| CDP subscriptions | ~500B/subscription | yes | Persist subscription definitions that are safe to recreate; do not persist callbacks or closures. |
| CDP domain refs | ~200B/tab:domain | yes | Persist domain ref metadata; rebuild from active recoverers. |
| network bodyStore | 10KB-10MB/entry | no | Evidence path only; use Node artifact, bounded body reads, and `historyLost`. |
| network request entries | variable / high frequency | no | Node artifact/evidence path; SW Map is hot cache only. |
| ws transcript | 10KB-1MB/session | no | Node artifact/evidence path in later phase; default restart result is state-lost. |
| intercept paused requests | 1KB-100KB/paused | no, except bounded summary | Release on recover; report `pausedLost:true`. |
| tab queues | ~200B/tab | metadata only | Do not persist `tail: Promise`; pending work fails/retries from Node side. |
| csp bypass tabs | tiny TTL | optional metadata | Prefer ephemeral TTL; no recovery guarantee. |

Storage rules:

- Write only on structural changes: session create/delete, recorder start/stop, rule change, subscription/domain ownership change.
- Do not write per-request, per-frame, transcript, body, or high-frequency event data.
- Storage write failures must be recorded in diagnostics but must not block the primary user action.
- State keys expire when `updatedAt > 24h`, when the tab no longer exists, or when a per-kind cap is exceeded.
- Each kind keeps at most 50 records; overflow evicts oldest entries.

## Runtime state store contract

Add a shared service-worker module:

- `bridge_src/service_worker/state_store.ts`

Canonical record shape:

```ts
type RuntimeStateRecord<TConfig = unknown> = {
  schemaVersion: "pi.browser.runtime.state/v1";
  kind: "network" | "intercept" | "hook" | "ws" | "cdp" | "wait" | "queue" | "cspBypass";
  key: string;
  tabId?: number;
  sessionId?: string;
  generation: number;
  workerBootId: string;
  updatedAt: number;
  recoveredAt?: number;
  recoveryPolicy: "auto" | "manual" | "diagnosticOnly";
  config: TConfig;
  diagnostics?: Array<Record<string, unknown>>;
};
```

Store behavior:

- Use one logical state namespace under `chrome.storage.session`.
- Persist/forget must be idempotent.
- Persist applies TTL and per-kind cap pruning.
- Returned diagnostics redact sensitive fields by key and known payload locations.

## Recoverer interface

Each recoverable module exposes only three operations:

```ts
interface StateRecoverer<TConfig> {
  persist(config: TConfig): Promise<void>;
  forget(key: string): Promise<void>;
  recover(bootId: string): Promise<RecoveryResult>;
}

type RecoveryResult = {
  kind: string;
  recovered: Array<{ key: string; config?: unknown; code: "RUNTIME_STATE_RECOVERED" | "RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS" }>;
  lost: Array<{ key: string; reason: string; code: "RUNTIME_STATE_LOST" }>;
  diagnostics?: Array<Record<string, unknown>>;
};
```

Startup order:

1. Service worker boots and creates a fresh `workerBootId`.
2. Recoverers run before the first `ext_ready` message.
3. `ext_ready.bridge.runtimeRecovery` reports `recovered`, `lost`, and `historyLost` summaries.
4. Node bridge records recovery metadata in snapshots and diagnostics.

## Error codes

Add these runtime recovery codes to the native error taxonomy:

| Code | Meaning | Retryable |
|---|---|---|
| `RUNTIME_STATE_RECOVERED` | Configuration/session metadata was restored without evidence loss. | yes |
| `RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS` | Configuration/rules were restored, but volatile runtime evidence was lost. | yes |
| `RUNTIME_STATE_LOST` | Runtime state cannot be safely reconstructed; caller must rebuild explicitly. | yes |

Existing wait-level `WAIT_STATE_LOST` remains the durable wait supervisor's higher-level failure code.

## Operation classes

| Class | Strategy | Examples |
|---|---|---|
| Idempotent wait/probe | Short lease and retry across `workerBootId` changes | `wait.selector`, `wait.navigation`, `wait.loadState`, `network.wait` |
| Non-idempotent command | Fail explicitly after worker restart; do not replay blindly | `hook.install`, `intercept.install`, `network.start`, `ws.send` |
| Pure configuration | Persist metadata and auto-recover | intercept rules, recorder config, safe CDP subscription/domain definitions |

## Module recovery contracts

### Network

- Persist recorder config only.
- Recover by recreating recorder state, enabling CDP `Network`/`Page`, and re-subscribing events.
- Set `recoveredAt` and `historyLost:true` because previous request entries/body refs are gone.
- `network.status/list/get/body/exportHar` must expose `recoveredAt/historyLost` and not imply continuity across the restart.
- `network.wait` can use short-lease retry if the condition is idempotent; it must preserve `waitId`.

Required boundary cases:

- SW killed after `network.start` and before the first request: recovered recorder exists with empty entries and no error.
- SW killed after entries exist: recovered recorder works for new requests and marks old buffer history lost.

### Intercept

- Persist install config, stages, and rules.
- Recover by first attempting `Fetch.disable` to release any stale paused request, then `Fetch.enable` and re-installing rules/subscriptions.
- Do not persist paused request payloads. Report `pausedLost:true` when recovery crosses a worker restart.
- Manual `continue/fail/fulfill` for old paused request ids must return `REQUEST_NOT_FOUND` or `RUNTIME_STATE_LOST` with `pausedLost:true`.

Required boundary cases:

- SW killed after `intercept.install` with rules and no paused request: rules recover and new requests are handled.
- SW killed with paused requests: old paused requests are released or marked lost, and diagnostics expose `pausedLost:true`.

### Hook

- Persist hook install args/session metadata.
- Recover by calling page `hook.status` only.
- If dispatcher still exists and session matches, rebuild `piBrowserSessions` metadata and return `RUNTIME_STATE_RECOVERED`.
- If page reports `NO_SESSION`/`NOT_INSTALLED`, mark session lost. Do not auto-reinstall.
- Explicit reinstall remains a user/Node-side action.

### WebSocket

- Persist session config: url, protocols, bounded header summary, max transcript config.
- Do not persist transcript or message payloads.
- Do not auto reconnect by default.
- `ws.status` after restart returns `stateLost:true`, config summary, and next action to explicitly `ws.open` if the caller chooses.
- Optional explicit `recover:true` may be added later; it must create a new session with `historyLost:true`.

### CDP

- Persist safe domain/subscription definitions when they can be recreated from module-owned metadata.
- Do not persist callback closures or arbitrary script source.
- `Page.addScriptToEvaluateOnNewDocument` can only be recovered for registry-backed script identities; raw source identifiers are marked lost.
- Session maps are rebuilt from recoverers, not treated as authoritative after restart.

### Queues and pending work

- Do not serialize `Promise` chains or queue tails.
- Node-side `BrowserBridgePendingRequests` remains responsible for rejecting disconnected pending requests.
- After worker restart, pending non-idempotent operations must fail with explicit state-loss diagnostics rather than silently continuing.

## Node artifact evidence path

Phase order:

1. First implement state store and recoverers for network/intercept.
2. Add Node artifact incremental schema for network/intercept evidence.
3. Move WebSocket transcript artifact streaming to a later dedicated phase.

Evidence boundary:

- SW Maps are hot caches.
- Node artifacts are durable local evidence.
- Events not sent before SW death may be lost; recovered state must mark `historyLost:true`.
- Structural events such as session create/delete and rule changes should be persisted immediately and emitted to Node diagnostics.

## Implementation phases

### Phase 0: documentation and baseline tests

- Freeze this plan and link it from `TODO.md` / `CURRENT.md`.
- Extend lifecycle fixtures to simulate worker restart during network/intercept/ws/hook/CDP states.
- Add assertions for explicit lost/recovered diagnostics before changing runtime code.

### Phase 1: state store foundation

- Add `state_store.ts` with TTL, per-kind cap, redaction, diagnostics, and idempotent persist/forget.
- Wire startup recovery before `ext_ready`.
- Add recovery summaries to `piBridgeInfo()` / `ext_ready.bridge.runtimeRecovery` without changing public tool names.

### Phase 2: network recoverer

- Persist recorder config at start/reconfigure/stop.
- Recover recorder config and CDP subscriptions.
- Mark `recoveredAt/historyLost` in status/list/export diagnostics.
- Extend `network.wait` toward durable short-lease semantics.

### Phase 3: intercept recoverer

- Persist install config/stages/rules.
- Recover with `Fetch.disable` then `Fetch.enable` and rule reinstall.
- Report `pausedLost:true` after restart.
- Add restart fixtures for no-paused and paused-request cases.

### Phase 4: hook/ws/cdp diagnostics hardening

- Hook: status-only recovery; no auto reinstall.
- WS: config-only lost diagnostics; no auto reconnect.
- CDP: safe metadata recovery and raw-script lost diagnostics.

### Phase 5: Node artifact incremental evidence

- Add network/intercept event artifact schema and writer path.
- Keep high-frequency storage out of `chrome.storage.session`.
- Add artifact correlation fields: `workerBootId`, `generation`, `recoveredAt`, `historyLost`.

## Verification gates

Minimum gates per phase:

- `npm run check:all:bridge`
- `npm run check:lifecycle`
- `npm run check:all:contracts`
- `npm run check:doc-structure`

Before runtime closure:

- `npm run build:bridge`
- `npm run check`
- `npm run smoke:browser:isolated`

New restart smoke target should cover:

- `network.start` then worker restart before first request.
- `network.start` then worker restart after captured requests.
- `intercept.install` + rules then worker restart with no paused request.
- `intercept.install` + rules then worker restart with paused requests.
- `hook.install` then worker restart with dispatcher still present and with dispatcher gone.
- `ws.open` then worker restart, default no reconnect and explicit lost diagnostics.

## Exit criteria

This workstream is complete when:

- MV3 worker restart never causes silent state loss for covered state classes.
- Recoverable config state is automatically restored and marked with `RUNTIME_STATE_RECOVERED` or `RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS`.
- Non-recoverable state returns `RUNTIME_STATE_LOST` with concrete next actions.
- `chrome.storage.session` contains only bounded redacted metadata.
- Network/intercept evidence can be continued after restart with explicit `historyLost` boundaries.
- Documentation, protocol/generated docs, contracts, README/skill text, and verification artifacts are synchronized where runtime behavior changes.
