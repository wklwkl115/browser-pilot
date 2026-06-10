# Perception Layer Optimization Plan — Round 2

## Status: Draft (2026-06-11)

Covers economic kernel completions (Track A), extension coordination layer (Track B), and content script perception layer (Track C). Track D entries are closed designs kept for reference — not active plan items.

Executability rule applies: every item is immediately executable with files, functions, and verification gates known from the current codebase.

---

## Baseline

Completed before this plan:

| Item | Files | Status |
|------|-------|--------|
| P0 fitSummaryBudget hot path | `distill-core/ladder.ts` | done |
| P0 fitSalienceEnvelopeBudget lazy | `distill-core/salienceEnvelope.ts` | done |
| P1 RelevanceAccumulator lazy dedup | `distill-core/relevance.ts` | done |
| P1 countRenderedTruncationMarkers structural | `distill-core/render.ts` | done |
| P2a token cost model in allocator | `distill-core/allocate.ts` | done |
| P3a cross-plane dynamic reallocation | `distill-core/allocate.ts` | done |
| P3b relevance-protected redundancy | `distill-core/allocate.ts` | done, eval passed (d2a77df) |

---

## Track A — Economic Kernel Completions

### A1 — P3c: Budget Utilization Feedback Loop

**Problem:** The allocator has no mechanism to feed utilization back into the next observe cycle. When budget is nearly exhausted (`budgetUsedRatio > 0.95`), the next call should constrain granularity to `"compact"` rather than re-attempting `"full"` and failing again.

**Files:**

- `src/distill-core/fact.ts`
  - `AllocationOptions` already has `granularityCeiling?` — no change needed here
  - `allocateFacts` return type: change from `RenderPlan` to `{ plan: RenderPlan; budgetUsedRatio: number; omittedCount: number }`

- `src/distill-core/allocate.ts`
  - Compute `budgetUsedRatio = spent / budget` and `omittedCount` after the main loop
  - Return `{ plan, budgetUsedRatio, omittedCount }` instead of plain `plan`

- `src/abml/perceptionLedger.ts`
  - `PerceptionLedgerFrame`: add `allocation?: { budgetUsedRatio: number; omittedCount: number }`

- `src/abml/observeRunners.ts`
  - After `allocateFacts`, write `allocation` into the current ledger frame
  - At next observe: read `ledger.getFrame(...)?.allocation`; if `budgetUsedRatio > 0.95`, pass `granularityCeiling: "compact"` in `AllocationOptions`

**Verification:**
```bash
npm run check:all:contracts   # allocate.test.ts + task-conditioned-salience
npm run check:task-conditioned-salience
```

---

### A2 — P3d: `mini` Granularity for Entity Factify

**Problem:** Current granularity jump from `compact` (~200 bytes, full fields) to `ref` (~30 bytes, ref string only) is too coarse. Budget pressure causes hard information loss. A `mini` tier (ref + kind + role + name + hints.selector, ~80-120 bytes) fills the gap.

**Files:**

- `src/distill-core/fact.ts`
  - `FactGranularity`: add `"mini"` to the union
  - `GRANULARITY_ORDER` in `allocate.ts`: insert `"mini"` between `"compact"` and `"line"` → `["full", "compact", "mini", "line", "ref"]`

- `src/distill-core/allocate.ts`
  - Update `GRANULARITY_ORDER` constant

- `src/abml/factify.ts` (or per-plane factify entry points — grep for `renderings:` construction)
  - Add `mini` rendering: `{ ref, kind, role, name, "hints.selector": selector }`, compute cost via `jsonCost`

**Verification:**
```bash
npm run check:all:contracts
node evals/browser-workflows/redundancy-allocator-eval.mjs   # P3b gates must not regress
```

---

### A3 — P2b: stableRefs Incremental Allocation

**Problem:** Every observe allocates independently. Even when 90% of entities are unchanged, refs are unstable and diff noise is high. Entities carried over from the prior frame should receive a continuity bonus to stabilize what the agent sees.

**Dependency:** A1 must land first (shares the ledger frame extension).

**Files:**

- `src/distill-core/fact.ts`
  - `AllocationOptions`: add `stableRefs?: Set<string>`

- `src/distill-core/allocate.ts`
  - In the `ranked` map step: if `stableRefs?.has(fact.ref)`, multiply salience by `1.2` (continuity weight, not a lock)

- `src/abml/perceptionLedger.ts`
  - `entityVersionStamp()` already exists; compare current stamp to prior frame stamp to build `stableRefs`
  - Add `buildStableRefs(current: PerceptionLedgerFrame, prior: PerceptionLedgerFrame): Set<string>`

- `src/abml/observeRunners.ts`
  - Derive `stableRefs` from ledger before calling `allocateFacts`; pass as `options.stableRefs`

**Verification:**
```bash
npm run test:unit   # perceptionLedger.test.ts + allocate.test.ts
npm run check:all:contracts
```

---

## Track B — Extension Coordination Layer

### B1 — Offscreen Persistent Port: SW Keep-Alive ⭐ Highest ROI

**Problem:** MV3 service worker is killed after ~30s idle. Every tool call on a cold SW pays 50-400ms restart cost. This is the single largest fixed overhead in the call stack — larger than any kernel optimization.

**Files:**

- `bridge_src/offscreen/transport.ts`
  - After WebSocket connection is established, call `chrome.runtime.connect({ name: "pi-keepalive" })` and store the port reference
  - On `port.onDisconnect`: schedule reconnect (SW restarted)

- `bridge_src/service-worker.ts` (or the SW entry that handles `chrome.runtime.onConnect`)
  - `chrome.runtime.onConnect.addListener(port => { if (port.name === "pi-keepalive") { /* hold port, no-op body */ } })`

**Change size:** ~15 lines total.

**Verification:**
```bash
npm run check:all:bridge
npm run smoke:browser   # requires browser; verify cold-start latency gone
```

---

### B2 — CDP Session Unification: Route Transient → Persistent

**Problem:** `src/tools/pageScriptEvaluation.ts` uses `cmd: "cdp"` (transient attach/detach per call). This races against `cmd: "persistent_cdp"` sessions and is the root cause of "debugger already attached" instability.

**Files:**

- `src/tools/pageScriptEvaluation.ts`
  - Replace `cmd: "cdp"` with `cmd: "persistent_cdp"`; use session name `"pi-script-eval"` (consistent with other persistent session names)

- `bridge_src/service_worker/cdp.ts`
  - Review `lockedUntil` logic for concurrent execution correctness — may require no change, confirm only

**Verification:**
```bash
npm run check:all:bridge
npm run check:runtime-fixtures
```

---

### B3 — scan + AX Concurrent Fetch

**Problem:** Scan script (JS eval) and AX tree fetch (CDP) are currently serial. They are fully independent and can run in parallel, saving 20-60ms per observe.

**Dependency:** B2 must land first to eliminate the CDP attach race before concurrent CDP calls are safe.

**Files:**

- `src/abml/observeRunners.ts` (locate the sequential `evaluatePageScript` + `readAxEntities` calls)
  ```ts
  const [scanResult, axEntities] = await Promise.all([
    evaluatePageScript(...),
    readAxEntities(server, { ... })
  ]);
  ```

**Change size:** ~5 lines.

**Verification:**
```bash
npm run check:runtime-fixtures
npm run smoke:browser:scan-summary   # requires browser
```

---

### B4 — Script Precompilation + DOM.documentUpdated AX Cache

**Problem:** (1) Every `Runtime.evaluate` recompiles the JS bundle. (2) AX tree is re-fetched even when the page DOM has not changed.

**Dependency:** B1 (SW keep-alive makes the per-session cache survive; without it, cache is lost on every SW restart).

**Files:**

- `bridge_src/service_worker/cdp.ts`
  - `PiCdpSession` type: add `compiledScripts: Map<string, string>` (script content hash → scriptId)
  - On `persistent_cdp` command with `precompile: true`: call `Runtime.compileScript`, cache scriptId; subsequent calls with same hash use cached scriptId via `Runtime.runScript`
  - On session attach: subscribe to `DOM.documentUpdated` event; set per-tab `axTreeDirty = true` flag

- `src/abml/verbs/axRuntime.ts`
  - Before `Accessibility.getFullAXTree`: check `axTreeDirty` flag; if `false` and cached tree exists, return cached tree without CDP call
  - After fetch: clear `axTreeDirty`, update cache

**Verification:**
```bash
npm run check:all:bridge
npm run check:runtime-fixtures
```

---

## Track C — Content Script Perception Layer (New Work)

### C1 — Page Fingerprint in Content Script

**Problem:** Content script is currently near-empty (bridge_wake + TID cleanup only). It has the unique property of not being killed by MV3 timeouts and having synchronous DOM access — making it the ideal place for lightweight page change detection.

**Files:**

- `bridge_src/page_scripts/content.ts`
  - Add `PageFingerprint` interface:
    ```ts
    interface PageFingerprint {
      changeSeq: number;
      interactiveCount: number;
      visibleCount: number;
      focused: string | null;
    }
    ```
  - Maintain fingerprint via `MutationObserver` (reuse existing observer, extend its callback); increment `changeSeq` on any structural DOM mutation
  - Handle message `{ type: "pi_get_fingerprint" }` → reply with current fingerprint

**Verification:**
```bash
npm run check:all:bridge   # content.ts compiles
npm run check:bridge       # bridge file check passes
```

---

### C2 — Change Gate in Observe Path

**Problem:** Every `browser_observe` call runs the full AX fetch + ABML pipeline (~100-200ms) regardless of whether the page changed. The fingerprint from C1 can short-circuit this.

**Dependency:** C1 must land first.

**Files:**

- `src/abml/perceptionLedger.ts`
  - `PerceptionLedgerFrame`: add `lastFingerprintChangeSeq?: number`

- `src/tools/registerObserveTool.ts` or `src/abml/observeRunners.ts`
  - At observe entry: inject and call `pi_get_fingerprint()` via a lightweight `browser_execute` call (or direct message to content script)
  - If `fingerprint.changeSeq === ledger.lastFingerprintChangeSeq`: return the prior frame's rendered result with `fromCache: true` metadata
  - On full pipeline completion: write `changeSeq` into ledger frame

**Verification:**
```bash
npm run check:all:contracts
npm run check:lifecycle   # multi-tab fixture must not regress
```

---

## Track D — Closed Designs (Not Active Plan Items)

These designs are complete. They become active plan items only when the stated trigger condition is met and confirmed by eval evidence.

| Item | Core files | Design summary | Trigger condition |
|------|-----------|----------------|-------------------|
| D1 Speculative pre-observation | `registerExecuteTool.ts` + observe cache | After `browser_execute`, async observe starts in background; result cached for next call | C2 complete + blind eval shows observe still on critical path |
| D2 Tiered perception API | `registerObserveTool.ts`, new `tier` param | `fast` (fingerprint) / `viewport` (partial AX) / `full` (current) / `precise` (+geometry) | Blind eval evidence that current tier causes agent decision quality loss |
| D3 Atomic snapshot coherent mode | `src/abml/verbs/axRuntime.ts` | `Debugger.pause` → concurrent scan+AX → `Debugger.resume`, guarantees T1=T2 | Diff consistency eval failures traceable to T1≠T2 merge artifacts |

---

## Execution Order

```
Parallel first wave:
  B1 (offscreen Port, ~15 lines)     ← highest ROI, smallest change
  A1 (P3c feedback loop)             ← pure kernel, no browser dep
  A2 (P3d mini granularity)          ← pure kernel, independent of A1

Sequential after B1 + B2:
  B2 (CDP unify) → B3 (concurrent scan+AX) → B4 (precompile + AX cache)

After A1:
  A3 (P2b stableRefs)

Independent track:
  C1 (fingerprint) → C2 (change gate)
```

B1 is the recommended first item: smallest change, no dependencies, eliminates the largest fixed overhead in the system.
