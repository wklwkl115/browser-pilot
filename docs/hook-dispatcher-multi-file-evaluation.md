# Hook Dispatcher Multi-file Injection Evaluation

## Status

RFC-only evaluation note for TODO 255. No runtime behavior changes are implemented by this document.

## Current boundary

- Current dispatcher runtime contract is documented in `docs/hook-dispatcher-boundary.md`.
- The dispatcher is built as one self-contained page bundle: `bridge/pi_browser_bridge/dist/hook_dispatcher.js`.
- Injection paths today:
  1. `chrome.scripting.executeScript({ files: [PI_BROWSER_HOOK_DISPATCHER_FILE] })`
  2. CDP fallback: fetch the same extension file and `Runtime.evaluate` the exact source text

## Why split is not automatic

A multi-file page graph must preserve both injection paths with the same semantics:

- Chrome scripting can inject multiple files, but ordering and failure surfaces must stay explicit.
- The CDP fallback currently fetches one source file and evaluates one source string. A multi-file design would need a deterministic concatenation/loader strategy or multiple ordered `Runtime.evaluate` calls.
- MAIN-world execution must remain self-contained and must not depend on service-worker state or background-only APIs.
- Current contracts lock self-containment, page-global surface, and cleanup semantics.

## What is already solved

- Source maps are already present for the current single-file build.
- Independent page-script bundling already exists.
- The unresolved issue is module/injection topology, not debuggability basics.

## Evaluation matrix

### Option A: Keep single-file bundle

Pros:
- Preserves both injection paths unchanged
- No new loader/runtime edge cases
- Keeps current contracts stable

Cons:
- Hook-side growth remains concentrated in one file
- No page-side tree-shaking across separately injected feature bundles

### Option B: Multi-file `executeScript({ files: [...] })` + CDP ordered eval

Pros:
- Could split core vs optional extensions
- Could reduce incremental maintenance pressure inside one file

Risks:
- Must define and test deterministic file ordering
- CDP fallback must exactly match Chrome scripting behavior
- Cleanup/session mismatch invariants must remain stable across file boundaries
- Error attribution and artifact evidence become more complex

### Option C: Build-time composition into one emitted injection file from multiple sources

Pros:
- Keeps runtime single-file injection boundary
- Allows source-level modularization
- Keeps CDP fallback simple

Risks:
- Still ships one runtime payload
- Tree-shaking benefit depends on composition strategy and module boundaries
- Must not reintroduce opaque ordered-concat behavior without explicit metadata/diagnostics

## Recommended direction

Prefer Option C before Option B if page-side modularization becomes necessary:

- keep one emitted injection artifact
- allow source-level internal modules
- preserve one-file Chrome scripting and one-source CDP fallback
- retain current contracts and evidence model

Only pursue Option B after explicit proof for:

1. file ordering contract
2. CDP fallback parity
3. session/cleanup parity
4. artifact/debug diagnostics parity
5. bounded local-fixture smoke coverage

## Required proof before implementation

- update `TODO.md` / `CURRENT.md` with the chosen design
- extend `tests/contracts/check-bridge-files.mjs`
- extend `tests/contracts/check-page-scripts.mjs`
- add bounded local fixture smoke that exercises both injection paths
- document artifact/evidence implications in README/AI_INSTALL if behavior changes
