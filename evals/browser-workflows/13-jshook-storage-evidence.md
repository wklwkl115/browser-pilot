# Eval 13: jshook Storage Evidence

## Goal

Read and verify browser storage evidence from a local fixture using existing primitives, then decide whether any storage need is already closed or requires a separate RFC.

## Fixture

- Local target: `fixtures/jshook-storage.html`
- Required files: page that writes deterministic localStorage, sessionStorage, and IndexedDB records with synthetic values.
- Setup notes: values must be small, synthetic, and include token-like strings only when explicitly marked as fixtures for redaction checks.

## Allowed starting tools

- `browser_tabs`
- `browser_execute`
- `browser_hook`
- `browser_evidence`
- `browser_artifact`

## Expected tool sequence

1. Start from explicit tab/session state with `browser_tabs`.
2. Trigger deterministic storage writes with `browser_execute`.
3. Read focused storage state with `browser_execute` JS, using bounded record limits and value previews/hashes for large or sensitive values.
4. If storage API call evidence is required, install explicit `browser_hook` storage hooks and aggregate with `browser_evidence`.
5. Save or inspect larger storage evidence through `browser_artifact` instead of inlining values.

## Success criteria

- localStorage and sessionStorage keys are listed with safe previews or hashes.
- IndexedDB database/store/record evidence is bounded and deterministic.
- Token-like fixture values are redacted or summarized without raw leakage.
- The result classifies whether existing primitives are sufficient for storage evidence.

## Required evidence

- Summary evidence: storage-summary with key/store counts, selected key names, safe previews or hashes.
- Artifact evidence: bounded storage dump `artifact` path when records exceed summary budget.
- Diagnostics evidence: origin, limits used, redaction state, and hook session ids if storage hooks were installed.

## Recovery checks

- Expected failure mode: unbounded IndexedDB dump, raw token leakage, or storage event evidence confused with storage state.
- Required recovery path: narrow database/store/key filters, keep redaction enabled, and separate `browser_hook` event evidence from `browser_execute` state reads.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after redaction or unbounded dump risk
- artifact sufficiency
- privacy preservation

## Capability closure classification

- Classification: existing `browser_execute` focused JS plus `browser_hook` storage events is sufficient unless eval proves repeated bounded CRUD/state inspection failures.
- Canonical surface: `browser_execute`, `browser_hook`, `browser_evidence`, and `browser_artifact`.
- Closure result: this eval must not introduce `browser_storage`; any CRUD tool proposal requires a separate RFC.
