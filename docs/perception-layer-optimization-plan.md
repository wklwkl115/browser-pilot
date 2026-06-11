# Perception Layer Optimization Plan - Round 2

## Status: Completed Implementation + Hardening Complete (2026-06-11)

This document is the execution record for Round 2 perception-layer optimization and the cache-gate hardening slice identified during review. Future ABML structural refactors still require a separate plan and execution record.

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
| C | renderCache params signature | `src/abml/perceptionLedger.ts`, `src/tools/observeRunners.ts`, `tests/unit/tools/observe-abml-integration.test.ts` | done |
| C | Change-gate stale boundary + TTL | `bridge_src/page_scripts/content.ts`, `src/tools/observeRunners.ts`, `tests/unit/tools/observe-abml-integration.test.ts` | done |

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
- Observe cache hits require matching ledger key, observe mode, detail level, maxChars, params signature, full cheap fingerprint tuple, and TTL.
- The params signature includes output-affecting request shape: mode, detail level, maxChars, captureMaxChars, includeIframes, maxNodes, normalized top-level intent, and actionRef.
- Cache hits strip stale top-level observe metadata from reused artifacts before adding the new operation, snapshot, saved, cache, and fromCache metadata.
- The content-script fingerprint observer watches child-list, attribute, and text-node mutations. Extra mutation noise is fail-safe because it causes cache misses.
- Observe cache TTL is anchored to `renderCache.renderedAt`, the Node-side fresh render time, not to `pageFingerprint.capturedAt` because the latter is the page's last-change timestamp.
- Cache-hit ledger frames preserve the original `renderCache.renderedAt`; repeated hits cannot extend stale output indefinitely.
- Default observe cache TTL is 2 seconds. `PI_BROWSER_OBSERVE_CACHE_TTL_MS=0` disables the observe cache gate without disabling broader session-delta machinery.
- The cache is an opportunistic fast path, not a coherence guarantee. Relevance trace terms are session-level and can evolve even when DOM and request params do not; TTL bounds that residual time variance.
- Cache hits still create an operation, write an artifact, record a fresh ledger frame, and expose `summary.fromCache: true`.
- `PI_BROWSER_SESSION_DELTA=0` disables the change gate because the gate is ledger-backed.

## Hardening Completion

The completed implementation was accepted, and the cache gate hardening pass has been applied. This was not a new feature track; it tightened correctness boundaries around the existing C2 change gate.

### H1 - renderCache Params Signature

**Problem:** `renderCacheMatches()` checked `changeSeq`, observe mode, detail level, and maxChars. That was not enough to distinguish requests whose output can differ despite an unchanged DOM.

**Resolved behavior:** Cache reuse now requires a `paramsSignature` match. The signature covers scan-affecting params such as `includeIframes`, `maxNodes`, normalized top-level `intent`, and outputPath-driven capture breadth through `captureMaxChars`. `actionRef` remains in the signature as defensive metadata, although causal attribution only matters when a baseline is present and explicit baselines disable the gate.

**Implemented:**

- `PerceptionLedgerFrame.renderCache` now stores `paramsSignature`.
- `src/tools/observeRunners.ts` computes the signature from stable JSON over only output-affecting fields:
  - `mode`
  - `detailLevel`
  - `maxChars`
  - `includeIframes`
  - `maxNodes`
  - `captureMaxChars` or the normalized `hasOutputPath` bit, because `outputPath` changes scan capture breadth via `captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000)`
  - normalized top-level `intent`
  - `actionRef`
  - `baseline` presence is excluded because the change gate is disabled when an explicit baseline is passed.
- `renderCacheMatches()` requires exact `paramsSignature` equality.
- Non-output fields such as `timeoutMs` and `browserSessionId` are excluded; session/tab/navigation are already handled by the ledger key and command routing.
- Cached artifact reuse strips stale top-level meta keys before spreading into the new response value: `operation`, `snapshot`, `cache`, `fromCache`, and `saved`. This prevents chained cache hits from accumulating stale metadata inside saved artifacts.

**Files:**

- `src/abml/perceptionLedger.ts`
  - `renderCache` stores `paramsSignature: string`.
- `src/tools/observeRunners.ts`
  - `observeRenderParamsSignature(params, mode, detailLevel, maxChars, captureMaxChars)` computes the cache signature.
  - Fresh frames and cached frames store the signature.
  - `renderCacheMatches()` requires signature equality.
  - `cachedEnvelopeFromArtifact()` sanitizes cached envelope reuse.
- `tests/unit/tools/observe-abml-integration.test.ts`
  - Covers same `changeSeq` with changed top-level `intent` causing a fresh scan.
  - Covers outputPath presence changing `captureMaxChars` under the same `maxChars`.

**Verification:**

```bash
npx tsx --test tests/unit/tools/observe-abml-integration.test.ts
npx tsx tests/contracts/tools/check-session-delta-long-conversation.mjs
npm run check
```

### H2 - Change Gate Stale Boundary and TTL

**Problem:** The content-script fingerprint is DOM-mutation based and under-observed common DOM changes. The observer was initially installed with `childList` and `subtree` only, so attribute changes (`aria-expanded`, `aria-checked`, `disabled`, `class`) and text-node updates could miss `changeSeq` even though they are DOM mutations. It also cannot reliably cover CSS-only changes, canvas/WebGL redraws, animation state, hover-driven layout, or relevance trace changes that occur outside the DOM.

**Decision:** Keep the DOM fingerprint gate, but bound its reuse window and document the stale boundary explicitly.

**Implemented:**

- The content-script `MutationObserver` now includes `attributes: true` and `characterData: true`. Extra noise is fail-safe because it produces cache misses rather than stale hits.
- `renderCacheMatches()` compares the full cheap fingerprint tuple, not only `changeSeq`: `changeSeq`, `url`, `title`, `readyState`, `visibleCount`, and `interactiveCount`. This protects against content-script reinjection or page reload cases where `changeSeq` can reset to the same small value.
- Cache reuse has a small TTL measured from `PerceptionLedgerFrame.renderCache.renderedAt`, not from `pageFingerprint.capturedAt`.
- `pageFingerprint.capturedAt` remains the content script's last-change timestamp and does not anchor the TTL.
- Cache-hit frames copy the prior `renderCache.renderedAt` unchanged, so repeated hits under the TTL do not extend stale output indefinitely.
- Default TTL is 2 seconds.
- Escape hatch env: `PI_BROWSER_OBSERVE_CACHE_TTL_MS`; `0` disables the change gate without disabling the broader session-delta machinery.
- `renderCacheMatches()` rejects cache hits when `Date.now() - renderCache.renderedAt` exceeds the TTL.
- `PI_BROWSER_SESSION_DELTA=0` remains the stronger kill switch for all ledger-backed session behavior.
- The plan notes now state that the cache is an opportunistic fast path, not a coherence guarantee. Relevance trace terms are session-level and can change even when the DOM and params signature do not; TTL is the bounded protection for that residual time variance.

**Files:**

- `bridge_src/page_scripts/content.ts`
  - Existing `MutationObserver` options are `{ childList: true, subtree: true, attributes: true, characterData: true }`.
- `src/tools/observeRunners.ts`
  - `observeCacheTtlMs()` normalizes the TTL escape hatch.
  - `renderCacheMatches()` receives `paramsSignature` and safely computes `now` and `ttlMs`.
  - `renderCache` stores `renderedAt`.
  - Fresh renders store `renderedAt = snapshotMeta.capturedAt`.
  - Cache-hit frames preserve prior `renderedAt`.
  - Full fingerprint tuple comparison is enforced.
  - Stale or disabled cache hits are rejected.
- `src/abml/perceptionLedger.ts`
  - `renderCache` stores `renderedAt: number`.
- `tests/unit/tools/observe-abml-integration.test.ts`
  - Covers expired TTL.
  - Covers `PI_BROWSER_OBSERVE_CACHE_TTL_MS=0`.
  - Covers same `changeSeq` with changed `interactiveCount`.

**Verification:**

```bash
npx tsx --test tests/unit/tools/observe-abml-integration.test.ts
npx tsx tests/contracts/tools/check-session-delta-long-conversation.mjs
npm run check:bridge:types
npm run check:bridge:files
npm run check:bridge:build
npm run check
```

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
