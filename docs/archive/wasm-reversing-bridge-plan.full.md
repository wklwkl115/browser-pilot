# Wasm Reversing Bridge Plan

> Status: completed (phase 1 archived). This document served as the execution contract for the WebAssembly reversing bridge workstream from `docs/archive/next-phase-web-reversing-and-security-primitives-plan.md`.

## Goal

Add bounded, artifact-first WebAssembly extraction and metadata-analysis primitives for front-end reversing without creating a broad public reverse-engineering tool first.

## Why this workstream is active now

After interception/hot-patching, JS AST phase 1, and DOM flow phase 1, the next highest-leverage gap is structured Wasm evidence for:

- Wasm-backed signature/auth logic triage
- import/export/table/memory inventory
- `.wasm -> .wat` readable bridge output
- preparing later memory-dump or runtime-assisted Wasm work

This is an advanced reversing foundation, but it should begin as a mature-bridge, artifact-first path rather than a broad public tool.

## Governing constraints

- Do not start by registering a broad new public tool.
- Prefer mature portable bridges (`wabt`, `wasm2wat`, `wasm-tools`, `binaryen`) over in-repo decompiler implementation.
- Inputs must stay explicit and bounded: explicit local Wasm file path or explicit saved artifact path.
- No hidden site discovery, fetch/crawl strategy, or exploit judgement in this layer.
- Outputs must stay compact, artifact-first, and diagnostically structured.
- This workstream must not weaken existing `browser_crawl`, `browser_network`, `browser_artifact`, or WebSecurity bridge contracts.

## Phase 1 goal

Close the highest-value static Wasm evidence gaps:

1. explicit Wasm module extraction input path
2. module hashes and byte-size metadata
3. imports/exports/table/memory/global summaries
4. optional `.wasm -> .wat` bridge artifact when a local launcher is available

## Initial scope

### In scope

1. explicit local Wasm artifact analysis input
2. Wasm header/version/size/hash facts
3. imports/exports/table/memory/global metadata summary
4. optional WAT artifact generation via mature local bridge/launcher
5. contracts, fixtures, eval docs, bounded internal artifacts

### Out of scope

- public canonical `browser_*` Wasm reversing tool registration
- in-repo Wasm decompiler implementation
- runtime linear-memory dump in this phase
- whole-site Wasm discovery/orchestration
- exploitability ranking or auto-reverse workflow

## Candidate implementation shape

### Internal layers first

- `src/tools/webSecurity/shared/*`: bounded Wasm artifact and bridge helpers
- existing WebSecurity mature-bridge/shared helper patterns for launcher diagnostics and artifact output
- `tests/unit/*`: pure metadata normalization logic
- `tests/contracts/*`: docs/package/boundary drift contracts
- `evals/browser-workflows/*`: local deterministic fixture/eval specs

### Phase-1 primitive outputs

- module byte length and hashes
- Wasm version/header facts
- imports/exports summaries
- table/memory/global counts and signatures
- optional WAT artifact path + compact preview
- stable launcher-unavailable diagnostics

## Public surface decision for phase 1

Do not promise a new public tool name yet.

Preferred first-step path:

1. internal artifact-first helper + mature local bridge
2. saved artifact output and compact summaries

A new public canonical tool is allowed only after:

- eval proof shows existing artifact-first surfaces cannot carry Wasm evidence cleanly
- non-overlap proof against `docs/tool-boundaries.md`
- stable artifact/diagnostic contracts exist

## Design requirements

- explicit local Wasm input only
- no implicit crawl/discovery/fetch inside the Wasm analysis primitive
- launcher/tool absence must return stable structured diagnostics
- summaries must stay compact on large modules
- full text-like WAT output must remain artifact-first when large
- recovery must point to narrower explicit input or bridge availability, not hidden retries

## Eval and fixture requirements

Before any public-surface promotion, add local deterministic evals/fixtures for:

1. simple Wasm import/export metadata extraction
2. hash/version/module-size facts
3. optional WAT bridge artifact generation
4. stable launcher-unavailable diagnostics
5. bounded malformed/non-Wasm input diagnostics

## Verification plan

Minimum required before calling phase 1 complete:

- unit tests for metadata normalization and launcher diagnostics
- contracts for docs/package/tool-boundary drift where affected
- local eval/fixture docs
- `npm run check`

## Exit criteria

Phase 1 is complete when:

- bounded Wasm metadata primitives exist and are covered by unit/contracts
- representative local fixtures prove useful artifact-first Wasm facts extraction
- docs clearly keep the capability internal/mature-bridge-first and do not over-promise a public Wasm tool
