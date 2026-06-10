# JS AST & Deobfuscation Primitives Plan

> Status: completed (phase 1 archived). This document served as the execution contract for the JavaScript AST / deobfuscation workstream from `docs/next-phase-web-reversing-and-security-primitives-plan.md`.

## Goal

Add bounded, artifact-first JavaScript analysis primitives for front-end reversing and security research without creating a broad public `browser_*` source-analysis tool first.

## Governing constraints

- Do not start by registering a new broad public tool name.
- Start with internal helpers, local analysis contracts, artifact-first evidence, evals, and bounded smoke/fixtures where applicable.
- Keep parser/transform work local to saved artifacts or explicit script text; do not hide fetch/crawl/discovery strategy inside the analysis layer.
- Outputs must stay compact, token-bounded, and diagnostically structured.
- No black-box deobfuscation workflow, exploit judgement, or orchestration layer.
- Reuse mature parser ecosystem where it lowers risk and code size.

## Phase 1 scope

### In scope

1. local JS parse primitive for explicit script text / saved artifact text
2. bounded module facts summary: imports, exports, top-level declarations, function inventory
3. bounded suspicious-pattern summary: string-array hints, decoder-call hints, eval/new Function/atob/unescape usage, flattening signals
4. artifact-first reduced outputs for selected narrow transforms only when deterministic
5. contracts + unit tests for parse/summary normalization

### Out of scope

- public canonical `browser_*` AST/deobfuscation tool registration
- whole-site recursive source analysis workflow
- source-map solving orchestration
- dynamic runtime tracing / breakpoint strategy
- aggressive deobfuscation packs for many obfuscator families in one batch
- Wasm / DOM flow / sink-flow work in this phase

## Candidate implementation shape

### Internal layers first

- `src/tools/webSecurity/shared/*` or a new internal analysis module for bounded parse/summary helpers
- optional artifact-oriented helper path that consumes explicit JS text or local saved artifacts
- unit/contracts before any runtime/browser integration
- eval/fixture docs for representative packed/minified cases

### Phase-1 primitive outputs

- parse success/failure facts
- syntax kind / module kind / top-level counts
- imports / exports summary
- function inventory with bounded names/arity/async/generator flags
- suspicious primitive usage summary (`eval`, `Function`, `atob`, `unescape`, string-array access patterns)
- optional reduced readable snippet artifact for deterministic transforms

## Public surface decision for phase 1

Do not promise a new public tool name yet.

Acceptable first-step path:

1. internal helper modules + contracts/tests/evals only
2. if needed later, a narrow existing-surface integration that consumes explicit artifact text rather than adding a new broad browser-facing tool

A new public canonical tool is allowed only after:

- eval proof shows `browser_artifact` + current command surfaces cannot carry the capability cleanly
- non-overlap proof against `docs/tool-boundaries.md`
- stable artifact/diagnostic contracts exist

## Design requirements

- explicit input only: raw JS text or explicit local artifact path
- no implicit crawl/discovery/fetch inside the analysis primitive
- parse errors must be stable, structured, and bounded
- summaries must degrade compactly on huge files
- transforms must be deterministic, narrow, and evidence-preserving
- all reduced outputs must remain artifact-first when large

## Eval and fixture requirements

Before any public-surface promotion, add local deterministic evals/fixtures for:

1. minified-but-readable bundle facts extraction
2. string-array / decoder-candidate detection
3. eval/new Function/atob/unescape suspicious usage detection
4. bounded failure diagnostics on malformed JS
5. one deterministic readable-reduction case

## Verification plan

Minimum required before calling phase 1 complete:

- unit tests for parse/summary normalization and bounded output
- contracts for docs/package/tool-boundary drift where affected
- local eval/fixture docs
- `npm run check`

## Exit criteria

Phase 1 is complete when:

- bounded JS parse/summary primitives exist and are covered by unit/contracts
- representative local fixtures prove useful artifact-first facts extraction
- docs clearly keep the capability internal-first and do not over-promise a public browser tool
