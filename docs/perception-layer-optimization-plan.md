# Perception Layer Optimization Plan - Round 2

## Status: Completed Implementation (2026-06-11)

This document is the execution record for Round 2 perception-layer optimization. It has no active backlog items. Future ABML structural refactors require a separate plan and execution record.

## Completed Work

| Track | Item | Main files | Status |
|------|------|------------|--------|
| A | Shared granularity order | `src/distill-core/fact.ts`, `src/distill-core/allocate.ts`, `src/distill-core/salienceEnvelope.ts` | done |
| A | stableRefs continuity bonus | `src/abml/perceptionLedger.ts`, `src/tools/observeRunners.ts`, `src/tools/resultMiddleware.ts`, `src/tools/toolAdapter.ts` | done |
| B | Offscreen keepalive port | `bridge_src/offscreen/transport.ts`, `bridge_src/service_worker/keepalive.ts`, `bridge_src/service-worker.ts` | done |
| B | Persistent CDP script evaluation | `src/tools/pageScriptEvaluation.ts`, `bridge_src/service_worker/cdp.ts` | done |
| B | Runtime-level scan/AX overlap | `src/abml/verbs/runtime.ts` | done |
| B | Script precompile + AX raw cache | `bridge_src/service_worker/cdp.ts`, `src/abml/verbs/axRuntime.ts`, `src/tools/pageScriptEvaluation.ts`, `src/tools/observeRunners.ts` | done |
| C | Content-script page fingerprint | `bridge_src/page_scripts/content.ts`, `bridge_src/service_worker/core_commands.ts`, `bridge_src/service_worker/types.ts` | done |
| C | Observe change gate | `src/abml/perceptionLedger.ts`, `src/tools/observeRunners.ts` | done |

## Implementation Notes

- `FACT_GRANULARITY_ORDER` is exported from `src/distill-core/fact.ts` and used by allocator and salience envelope fitting.
- `stableRefsFromFrames()` compares relation-free stable stamps, so AX relation churn does not falsely mark an unchanged entity unstable.
- Stable refs get a bounded salience multiplier of `1.2`; this is continuity, not pinning.
- The offscreen document initiates `chrome.runtime.connect({ name: "pi-keepalive" })`; the service worker receives it in `bridge_src/service_worker/keepalive.ts`.
- Existing alarm probes remain as fallback.
- `evaluatePageScriptDirect()` now uses `persistent_cdp` with logical session name `pi-script-eval`, separate from AX's default persistent CDP session.
- ABML read starts AX fetch before CPU-only scan shaping and still degrades AX failures to an empty AX read.
- Persistent CDP supports `precompile: true` for `Runtime.evaluate`; it caches `Runtime.compileScript` script IDs and runs them with `Runtime.runScript`, falling back to normal evaluate on compile failure.
- AX cache stores raw AX nodes and backend box geometry by explicit cache key; it does not cache constructed entities.
- Content fingerprint is exposed through internal bridge command `content.fingerprint`.
- Observe cache hits require matching ledger key, observe mode, detail level, maxChars, and `changeSeq`.
- Cache hits still create an operation, write an artifact, record a fresh ledger frame, and expose `summary.fromCache: true`.
- `PI_BROWSER_SESSION_DELTA=0` disables the change gate because the gate is ledger-backed.

## Verification Run

Focused gates:

```bash
npx tsx --test tests/unit/distill-core/allocate-render.test.ts
npx tsx --test tests/unit/abml/perceptionLedger.test.ts
npx tsx --test tests/unit/abml/ax-runtime.test.ts
npx tsx --test tests/unit/abml/verbs-runtime.test.ts
npx tsx --test tests/unit/tools/observe-abml-integration.test.ts
npx tsx tests/contracts/runtime/check-content-pick.mjs
npx tsx tests/contracts/tools/check-session-delta-long-conversation.mjs
node tests/contracts/tools/check-abml-ax-runtime.mjs
npm run check:bridge:types
npm run check:bridge:files
npm run check:bridge:build
```

Final gate:

```bash
npm run check
```

Result: passed.

Generated verification artifacts from the final gate:

- `.pi/browser-artifacts/token-economy-summary.json`
- `.pi/browser-artifacts/distill-bench-summary.json`

## Closed Designs

These are closed decisions, not active work:

| Item | Decision |
|------|----------|
| Speculative pre-observation | Closed. Reopen only with blind eval showing observe remains on the critical path after the change gate. |
| Tiered perception API | Closed. Reopen only with blind eval showing the current single observe tier harms task success. |
| Atomic snapshot coherent mode | Closed. Reopen only with evidence that T1/T2 merge artifacts cause real eval failures and debugger side effects are accepted. |
| PerceptionLedger stage layer | Closed. Current inference plus session delta is lower cost. |
| ASCII wireframe renderer | Closed. Reopen only with repeated spatial reasoning failures not addressable by geometry fields. |
| Intent knowledge base | Closed. Requires durable storage not present in this repo. |
| Action risk assessment | Closed. Strategic safety judgment remains outside this tool layer. |
| Configurable inference registry | Closed until deterministic rules become unmaintainable by concrete duplication evidence. |
