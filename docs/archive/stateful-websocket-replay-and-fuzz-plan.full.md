# Stateful WebSocket Replay & Fuzz Plan

> Status: completed (phase 1 archived). This document served as the execution contract for the stateful WebSocket replay/fuzz workstream from `docs/next-phase-web-reversing-and-security-primitives-plan.md`.

## Goal

Add bounded, explicit WebSocket session control and transcript evidence primitives for modern realtime app testing without turning the browser package into a broad exploit/fuzz orchestrator.

## Why this workstream is active now

After interception, JS AST, DOM flow, and Wasm phase 1, the next highest-value gap is active stateful WebSocket handling for:

- explicit session open/send/receive/close testing
- ordered message transcript validation
- replaying captured websocket interactions deterministically
- preparing later bounded fuzz/mutation on top of stable session control

## Governing constraints

- Do not start by registering a broad public WebSocket exploit/fuzz tool.
- Prefer explicit session lifecycle, ordered messages, and transcript evidence first.
- Inputs must stay explicit and bounded: url, headers, opener script, message sequence, matchers.
- No hidden fuzz strategy bundles, exploit judgement, or unbounded mutation loops.
- Outputs must stay compact, artifact-first, and diagnosable.
- This workstream must not weaken existing `browser_hook`, `browser_network`, `browser_execute`, or `browser_artifact` contracts.

## Phase 1 goal

Close the highest-value stateful WebSocket evidence gaps:

1. explicit active session open/close primitive
2. ordered send/receive transcript evidence
3. bounded matcher success/failure facts
4. compact saved transcript artifacts

## Initial scope

### In scope

1. explicit session open/close with explicit URL and optional headers
2. ordered send message primitive
3. explicit bounded message-sequence replay primitive
4. receive/wait primitive with bounded matchers and transcript capture
5. transcript artifacts and compact summaries
6. contracts, fixtures, eval docs, bounded internal artifacts

### Out of scope

- public canonical `browser_*` WebSocket fuzz tool registration
- unbounded mutation/fuzz loops
- automatic state machine inference
- exploitability ranking or black-box realtime workflow orchestration
- whole-site websocket discovery in this phase

## Candidate implementation shape

### Internal layers first

- `src/tools/webSecurity/shared/*`: websocket session/transcript helpers
- existing hook/network/artifact paths for evidence correlation where possible
- `tests/unit/*`: pure transcript/matcher normalization logic
- `tests/contracts/*`: docs/package/boundary drift contracts
- `evals/browser-workflows/*`: local deterministic fixture/eval specs

### Phase-1 primitive outputs

- session id / url / state facts
- ordered sent/received message sequence
- explicit replay step results
- matcher success/failure diagnostics
- compact transcript summary
- saved transcript artifact path when large

## Public surface decision for phase 1

Do not promise a new public tool name yet.

Preferred first-step path:

1. internal session/transcript helpers
2. artifact-first saved evidence and compact summaries

A new public canonical tool is allowed only after:

- eval proof shows existing explicit surfaces cannot carry session evidence cleanly
- non-overlap proof against `docs/tool-boundaries.md`
- stable artifact/diagnostic contracts exist

## Design requirements

- explicit websocket URL/session input only
- no hidden page/site discovery inside the websocket primitive
- matchers must be bounded and deterministic
- transcripts must remain artifact-first when large
- recovery must point to narrower explicit input or matcher corrections, not hidden retries

## Eval and fixture requirements

Before any public-surface promotion, add local deterministic evals/fixtures for:

1. explicit websocket open/send/receive transcript
2. bounded matcher success/failure cases
3. close/reconnect/session-end diagnostics
4. compact artifact-first transcript summary
5. malformed URL/session input diagnostics

## Verification plan

Minimum required before calling phase 1 complete:

- unit tests for transcript/matcher/session normalization
- contracts for docs/package/tool-boundary drift where affected
- local eval/fixture docs
- `npm run check`

## Exit criteria

Phase 1 is complete when:

- bounded websocket session/transcript primitives exist and are covered by unit/contracts
- representative local fixtures prove useful ordered send/receive evidence extraction
- docs clearly keep the capability internal-first and do not over-promise a public websocket fuzz tool
