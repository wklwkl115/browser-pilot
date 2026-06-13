# DOM Event Chain & Sink-Flow Analysis Plan

> Status: completed (phase 1 archived). This document served as the execution contract for the DOM event chain / sink-flow analysis workstream from `docs/archive/next-phase-web-reversing-and-security-primitives-plan.md`.

## Goal

Add bounded, diagnosable DOM event-listener chain and sink-flow evidence assistance for front-end reversing and Web security research without creating a broad public exploit-decider or fake full taint engine.

## Why this workstream is active now

After interception/hot-patching and JS AST phase 1, the next highest-leverage gap is compact DOM flow evidence for:

- DOM XSS investigation
- SPA click/submit/auth flow mapping
- front-end validation and auth-bypass triage
- handler/source/sink correlation before heavier runtime/manual analysis

This remains a true foundation capability, but it should start as bounded evidence assistance rather than a black-box strategy tool.

## Governing constraints

- Do not start by registering a broad new public tool.
- Prefer to extend existing `browser_hook` / `browser_evidence` / `browser_artifact` evidence paths first.
- Inputs must stay explicit and bounded: node, selector, scope, listener target, or saved evidence.
- No hidden strategy presets, exploit judgement, or automatic sink severity ranking.
- Source→sink hints must stay heuristic and factual; do not pretend to provide full dynamic taint tracking.
- Outputs must stay compact, artifact-first, and stable under redaction.
- This workstream must not weaken existing `browser_hook`, `browser_evidence`, `browser_execute`, or `browser_artifact` contracts.

## Phase 1 goal

Close the highest-value evidence gaps while preserving brain-hand separation:

1. listener extraction facts for selected node/scope
2. handler source metadata (`url`, `line`, `column`, key flags)
3. compact event-chain evidence from interacted node to handler facts
4. bounded heuristic source→sink hints for DOM-XSS-style investigation

## Initial scope

### In scope

1. explicit event-listener extraction for selected nodes/scopes
2. handler source location and options metadata (`capture`, `once`, `passive`, etc.)
3. compact listener-chain evidence summaries
4. heuristic sink-flow hints for selected sinks already observable in the page/runtime
5. contracts, fixtures, eval docs, and bounded internal artifacts

### Out of scope

- public canonical `browser_*` DOM-flow tool registration
- full dynamic taint engine
- exploitability ranking or one-click XSS solver
- whole-site listener graph crawler/orchestrator
- hidden DOM strategy presets
- source-map solving / JS AST deep transforms in this phase

## Candidate implementation shape

### Internal layers first

- `bridge_src/service_worker/*`: extend listener/source evidence where bridge/runtime facts are required
- `src/tools/*`: extend existing hook/evidence/artifact paths before considering any new public surface
- `tests/contracts/*`: listener/source/sink metadata drift contracts
- `tests/unit/*`: pure listener/summary normalization logic
- `evals/browser-workflows/*`: local deterministic fixture/eval specs

### Phase-1 primitive outputs

- selected node listener facts
- handler source URL/line/column
- listener flags and event type summaries
- compact chain evidence from node interaction target to handlers
- heuristic suspicious source/sink hints
- artifact-first saved evidence for larger listener graphs

## Public surface decision for phase 1

Do not promise a new public tool name yet.

Preferred first-step path:

1. internal bridge/runtime/helper extensions
2. bounded evidence through existing `browser_hook` / `browser_evidence` / `browser_artifact`

A new public canonical tool is allowed only after:

- eval proof shows the existing surfaces cannot carry DOM-flow evidence cleanly
- non-overlap proof against `docs/tool-boundaries.md`
- stable artifact/diagnostic contracts exist

## Design requirements

- explicit node/scope input only
- no implicit crawl/discovery over the full DOM
- listener/source metadata must be factual and source-backed
- sink-flow hints must stay heuristic and bounded
- large chain evidence must remain artifact-first
- recovery must point to narrower selectors/scopes/artifact reads rather than hidden retries

## Eval and fixture requirements

Before any public-surface promotion, add local deterministic evals/fixtures for:

1. explicit node listener extraction
2. handler source location correlation
3. compact click/submit chain evidence
4. heuristic source→sink hinting on synthetic sink fixtures
5. bounded stale/miss diagnostics for absent selector/node scope

## Verification plan

Minimum required before calling phase 1 complete:

- unit tests for listener/source/sink summary normalization
- contracts for docs/package/tool-boundary drift where affected
- local eval/fixture docs
- `npm run check`

## Exit criteria

Phase 1 is complete when:

- bounded listener/source/sink evidence primitives exist and are covered by unit/contracts
- representative local fixtures prove useful node→handler→sink evidence extraction
- docs clearly keep the capability as evidence assistance and do not over-promise a public DOM-flow tool
