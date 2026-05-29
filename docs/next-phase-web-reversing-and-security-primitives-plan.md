# Next-Phase Web Reversing & Security Primitives Plan

> Status: planning-only. This document defines accepted next-phase problem areas and execution constraints. It does **not** make any new callable `browser_*` capability current. Implementation may start only after `CURRENT.md` moves one of these items into an active queue with bounded contracts and validation.

## Decision source

This plan is derived from a repo-state review against the current callable surface, bridge/runtime code, evals, and project rules in:

- `D:/Pi/agent/AGENTS.md`
- `AGENTS.md`
- `README.md`
- `docs/tool-boundaries.md`
- `docs/jshookmcp-native-absorption.md`
- `ROADMAP.md`
- `CURRENT.md`

The core judgment is:

- These domains are valuable for Web security testing, vulnerability research, and Web reversing.
- Several of them are true **foundation capabilities**.
- They must still obey this package's rules: brain-hand separation, semantic singularity, atomic composability, recoverable diagnostics, evidence-first outputs, and no black-box strategy tools.

## Governing constraints

- No implementation batch may start by registering a broad new public tool name just because the problem area is real.
- Start with internal primitives, bridge/native commands, artifact-first evidence, evals, and contracts.
- Promote to a public canonical tool only when existing surfaces cannot carry the capability without overlap, ambiguity, or repeated agent burden.
- Prefer mature libraries or CLI bridges for generic parsing/decompilation/format conversion work.
- Prefer Pi-native implementation for browser-session state, interception, artifacts, lease/session routing, diagnostics, and page/CDP lifecycle.
- Do not copy AGPL/GPL tool code, MCP runtime, schemas, payloads, fixtures, or docs into this package.
- Do not add one-click workflow tools that deobfuscate, exploit, or decide strategy for the agent.
- Any new public surface still needs RFC + eval + non-overlap proof against `docs/tool-boundaries.md`.

## Priority summary

### P0

1. Request/response interception and hot patching
2. JavaScript AST / deobfuscation analysis
3. DOM event chain and sink-flow analysis

### P1

4. WebAssembly reversing bridge
5. Stateful WebSocket replay/fuzz primitives

Rationale:

- P0 items unlock more existing deep tasks across many sites.
- P1 items are valuable but narrower or more expensive to implement well.
- None of these should begin as a high-level orchestrator.

## Domain 1: JavaScript deobfuscation & AST analysis

### Is it a foundation capability?

Yes.

This is a real Web reversing foundation capability because large-model reasoning alone is too expensive when front-end code is packed, minified, flattened, or string-array obfuscated.

### Current repo state

What exists now:

- `browser_crawl` can discover source maps and archive source-map-related evidence.
- `browser_artifact` can read bounded saved evidence.
- `browser_execute` / `browser_command` can run focused runtime checks.

What is missing:

- no JS AST parser tool surface
- no deobfuscation transform engine
- no expression or function trace helper tied to saved script artifacts
- no structure-aware reduction pipeline for packed bundles

### How to add it

Phase order:

1. Add **artifact-first JS analysis primitives**.
2. Add bounded summaries for imports/exports/constants/call graph/string tables/suspect patterns.
3. Add narrow transformation recipes for common obfuscation families.
4. Only after eval proof, decide whether any public tool is needed.

Expected primitive outputs:

- parsed module facts
- function inventory
- string-array / decoder candidates
- constant folding results
- control-flow flattening signals
- reduced readable artifact outputs
- narrow trace records for a selected function/expression

### Implementation strategy

- Use mature parser ecosystem rather than building a parser:
  - `@babel/parser`
  - `@babel/traverse`
  - `@babel/generator`
  - `recast`
  - `acorn` or `meriyah` where lighter parse paths help
- Implement project-specific reduction / transform passes in-package.
- Keep outputs artifact-first and token-bounded.

### Public surface rule

Do **not** immediately register a new broad source/deobfuscation public tool. Follow the existing rejected-name and non-overlap boundary already recorded in `docs/tool-boundaries.md` and `docs/jshookmcp-native-absorption.md`.

First candidate path:

- internal helper modules
- optional future bridge or analysis command
- maybe a narrow canonical public surface only after evals prove existing `browser_artifact` + `browser_command` + `browser_crawl` are insufficient

## Domain 2: active interception & hot patching

### Is it a foundation capability?

Yes, and high priority.

For deep vulnerability work, being able to alter requests, responses, and script loads is often more valuable than only observing them.

### Current repo state

What exists now:

- request/response capture: `browser_network`
- replay/mutation after capture: `browser_http_replay`
- document-start script injection lifecycle: `browser_frame` / persistent CDP `Page.addScriptToEvaluateOnNewDocument`

What is missing:

- no CDP Fetch interception surface
- no response fulfill/edit primitive
- no script-request replacement primitive
- no WebSocket send-time interception primitive
- no bounded rule engine for request/response hot patching

### How to add it

Phase order:

1. Add **internal/native interception primitives** using CDP Fetch domain.
2. Add explicit pause/continue/fail/fulfill operations with scoped matching.
3. Add script replacement and document-start patch workflows for deterministic fixtures.
4. Add evidence artifacts and replayable transcripts.
5. Only later evaluate a canonical public surface if needed.

Expected primitive actions:

- pause request by matcher
- continue with modified headers/body/url/method
- fulfill response with modified status/headers/body
- fail request deliberately
- swap a specific `.js` resource with an injected local payload
- capture transcript + before/after evidence artifacts

### Implementation strategy

- Implement browser/session/interception lifecycle **in this package**.
- Reuse current bridge/session/lease/target/artifact/diagnostic systems.
- Borrow design ideas from Playwright route, Burp, Fiddler, mitmproxy — not code.

### Public surface rule

Do **not** immediately restore or create a Swiss-army live-interception public tool. Follow the existing rejected-name and non-overlap boundary already recorded in `docs/tool-boundaries.md` and `docs/jshookmcp-native-absorption.md`.

Start with internal command-level primitives and fixture-backed evals.

## Domain 3: DOM event chain & sink-flow analysis

### Is it a foundation capability?

Yes.

This is a foundation capability for DOM XSS, SPA flow mapping, and front-end auth bypass analysis.

### Current repo state

What exists now:

- `browser_hook` supports explicit hook targets and event collection.
- page dispatcher already tracks `dom`, `dom_sinks`, `storage`, `crypto`, `cookies`, websocket-like events.
- sink hooks already cover `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` style writes.

What is missing:

- no structured extraction of existing page event listener chains via CDP DOM debugger interfaces
- no compact event-flow graph from clicked DOM node to handler source location
- no taint-style source→sink guidance layer for DOM XSS paths

### How to add it

Phase order:

1. Extend `browser_hook`/CDP diagnostics internally with listener extraction and handler metadata.
2. Add bounded source-location facts for handlers.
3. Add lightweight source→sink suspicious-path heuristics.
4. Keep it as evidence assistance, not a full exploit-decider.

Expected outputs:

- event listeners for selected nodes or scopes
- handler source URL / line / column / flags
- compact listener chain evidence
- suspicious source/sink path hints for DOM XSS investigation

### Implementation strategy

- Extend existing hook/CDP/page-dispatcher design.
- Use CDP-level listener inspection where practical.
- Keep taint features heuristic and bounded first; avoid pretending to provide complete dynamic taint tracking before evidence supports it.

### Public surface rule

Prefer to grow existing `browser_hook` / `browser_evidence` / `browser_artifact` capabilities before considering any new public tool.

## Domain 4: WebAssembly reversing bridge

### Is it a foundation capability?

Yes, but this is an advanced reversing foundation rather than a mainstream browser primitive.

### Current repo state

What exists now:

- Wasm can be discovered as a resource through current browser/network/crawl surfaces.

What is missing:

- no Wasm extraction/translation/decompile primitive
- no linear memory dump primitive
- no Wasm import/export overview artifact flow

### How to add it

Phase order:

1. Add Wasm module extraction and metadata summary.
2. Add `.wasm -> .wat` or pseudocode bridge outputs.
3. Add explicit linear memory snapshot/dump helpers.
4. Add fixture-backed evals for Wasm-backed signature logic.

Expected outputs:

- module hashes
- imports/exports/table/memory metadata
- WAT or pseudocode artifact
- memory dump artifacts with bounded summary

### Implementation strategy

Prefer mature tool bridges:

- `wabt` / `wasm2wat`
- `wasm-tools`
- `binaryen`
- `wasm-decompile` where portable and stable

Do not build a Wasm decompiler in this repo.

### Public surface rule

Start as a mature bridge / artifact-first analysis path. Decide later whether a canonical public tool is warranted.

## Domain 5: stateful WebSocket replay/fuzz primitives

### Is it a foundation capability?

Yes, for modern realtime app testing — but it belongs to advanced WebSecurity follow-up, not the always-on browser core.

### Current repo state

What exists now:

- websocket evidence can be observed through hook/network paths
- HTTP replay exists, but it is not a stateful WebSocket session tool

What is missing:

- no active maintained WebSocket session primitive
- no ordered message send/receive matcher pipeline
- no stateful binary/text message mutation/fuzz loop

### How to add it

Phase order:

1. Add explicit active WebSocket session handling primitives.
2. Add ordered send/wait/match transcript artifacts.
3. Add bounded mutation/fuzz layers only after session control is stable.
4. Add deterministic fixture evals before broader promotion.

Expected outputs:

- session transcript
- sent/received message sequence
- matcher success/failure facts
- bounded mutation corpus outcomes

### Implementation strategy

- Implement session lifecycle and browser-state integration in-package.
- Borrow mutation/fuzz strategy ideas from `websocat`, Burp WebSocket tooling, and fuzz frameworks — not code.

### Public surface rule

Do not start with a broad “WS exploit tool”. Start with explicit replay/session primitives and transcript artifacts.

## Recommended execution order

### Workstream F0: planning & evidence gates

Before code:

- create bounded eval/fixture docs for all five domains
- freeze which parts are internal-only vs public-surface candidates
- define success metrics and artifact evidence shape

### Workstream F1: interception & hot patching primitives

Deliver first because it has the highest leverage for both security testing and reversing.

### Workstream F2: JS AST / deobfuscation primitives

Deliver second because it reduces model cost across many reversing tasks.

### Workstream F3: DOM event chain & sink-flow assistance

Deliver third by extending existing hook/evidence foundations.

### Workstream F4: Wasm bridge

Deliver after core interception/JS analysis are stable.

### Workstream F5: stateful WebSocket replay/fuzz

Deliver last among this set unless a concrete target workload forces it earlier.

## Required doc sync when a workstream activates

When any one of these items moves from plan to active work:

- update `CURRENT.md`
- update `ROADMAP.md`
- update `TODO.md` if navigation changes
- update `README.md`
- update `docs/tool-boundaries.md` if public-surface boundaries change
- update eval specs / fixtures / manifests
- add or update contracts and runtime smoke where applicable

## Explicit non-goals for this plan

- No one-click reverse-engineering workflow tool
- No automatic exploit judgement tool
- No reintroduction of orchestration / target resolver / hidden strategy layer
- No promise that every domain becomes a public callable tool
- No weakening of existing bounded/scoped/artifact-first rules
