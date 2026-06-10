# Task-conditioned salience v3 — implicit relevance, single-pass architecture

> Status: **DESIGN v3 — not yet activated.** Activation requires a `CURRENT.md` entry.
> v1 (param-first) was rejected as an attention tax. v2 made relevance implicit via three
> deterministic sources. v3 is the architect pass over v2: it fixes two structural defects
> v2 was about to introduce (scatter-by-design in scoring and collection — the exact disease
> the distill-core/grouping work just cured) and defines the missing arbitration rule with
> the now-default session-delta P-frames. Sources and constitution constraints carry over
> from v2 unchanged; the architecture around them is consolidated.

## 1. Relevance sources (unchanged from v2)

- **A — Behavioral trace:** recency-decayed attention signals from what the agent already
  does through the tool surface (execute string literals, artifact jsonPath drill-downs,
  `pi-ref://` resolutions, wait/network filters, pick selections). Zero mental load.
- **B — Structural propagation:** the page is its own synonym bridge — direct text matches
  spread depth-1 over `labelledBy`/containers/landmarks to actionable neighbors
  (the relation graph flat line-retrieval approaches lack).
- **C — Task-archetype table:** bounded multilingual verb table mapped onto EXISTING
  `inference.ts` detectors (登录→`detectLogin` facts, 搜索→`detectSearch`, …). Growth
  requires a new detector, not a vocab entry — a structural brake, not a dictionary.
- **D — URL cold-start (new in v3):** call 1 of a session has no trace — but the agent
  CHOSE the page. Path segments and query values of the current/just-navigated URL
  (`/login`, `?q=<the user's literal search terms>`) are free, deterministic, available
  immediately. Fixes v2's cold-start blindness.
- **E — Explicit `intent` param:** demoted last-stage override; the feature is at full
  value with the param never used.

## 2. v3 architecture — one pass, one tap, one tuning surface

### R1 — Single-pass RelevanceMap (kills scoring scatter)

Relevance is computed **once per observe** and only looked up afterwards:

```
observeRunners builds RelevanceContext = { traceSnapshot, urlSignals, archetypeHits, intent? }
        │  (runtime adapts entities → RelevanceInput[]: {ref, fields:{name, container,
        │   landmark, value, selectorTokens, hrefTokens}, neighbors:{labelledBySources,
        │   containerKey}} — STRUCTURAL typing, no abml-core→distill-core import; the K4
        │   cross-kernel precedent)
        ▼
distill-core/relevance.ts: computeRelevanceMap(inputs, context) → Map<ref, score>
        │   pure; direct match + depth-1 propagation + archetype + caps, all inside
        ▼
every hook is a LOOKUP: scoreAction bonus · entitySalienceRank bonus (the entity-cap
ranking on the default path) · referencedPiRefs targeted set ·
(later) FactSalience.relevance — no hook computes anything
```

One implementation, one unit-test surface, no drift between hooks. A contract lock mirrors
the anti-scatter pattern: matching/propagation logic may exist only in
`distill-core/relevance.ts`.

**Closure corrections (source-verified 2026-06-10):**
- `scoreAction` operates on page-side scan actionables that carry NO entity refs
  (`summaries/scan.ts:167-175` — label/text/selector fields only), so a ref-keyed map
  cannot serve that hook. `RelevanceContext` therefore exposes TWO read surfaces, both
  implemented inside `relevance.ts`: `byRef: Map<ref, score>` (entity-keyed hooks) and a
  memoized `scoreFields(text): number` matcher (ref-less surfaces). Injection rides the
  EXISTING `summarizeScanData(data, tabs, options)` extension point
  (`options.entityContext`, `scan.ts:8,572`) — no signature breakage.
- `entitySalienceRank` is ORDINAL (0–4 buckets, `observeRunners.ts:83-90`), not additive.
  Relevance integrates as a **secondary sort within rank**:
  `rank(a)-rank(b) || relevance(b)-relevance(a) || index`. No-signal ⇒ relevance all 0 ⇒
  index fallback ⇒ byte-identical order for free. Deliberately conservative: relevance
  reorders within a bucket, never lifts a text leaf above a control.

### R2 — Single declarative collection tap (kills tap scatter)

v2 implied 6 imperative taps across 6 tools. v3: **one tap at the verified universal
chokepoint** (`toolAdapter` — all tools route through it, no bypassers, audited
2026-06-10) driven by a declarative extraction table:

```ts
// src/tools/relevanceTaps.ts (orchestration-layer data; entry NAMES are tool-surface
// knowledge and must NOT live in the kernel — the kernel defines only the TYPES and
// the extraction primitives). Entries illustrative:
{ browser_execute: { params: ["script:stringLiterals"] },
  browser_artifact: { params: ["jsonPath"] }, ... }
```

The adapter applies the table and appends to the ledger ring; tools contain zero
collection code. Adding a signal = one table row (reviewed), not a new imperative tap.
Lock: attention extraction exists only via this table. (v3.1 correction: the concrete
table lives in `src/tools/`, not `distill-core/` — tool names in the economy kernel
would be a layering leak; the kernel owns `TapSpec` types + `extractLiterals` etc.)

### R3 — P-frame arbitration rule (the missing decision)

Session-delta (now default) auto-degrades unchanged facts to `ref`; relevance wants the
agent's working set legible. Without a rule the two now-default systems fight. The rule:

> **Relevance may hold a fact at most ONE granularity rung above its P-frame degradation
> (e.g. `compact` instead of `ref`), and never forces `full` re-render.**

Bounded, budget-friendly (P-frames stay small), and keeps the agent's touched controls
readable across re-observes. Locked by a dedicated two-systems fixture (§5).

### R4 — One tuning surface

All constants (source weights, propagation multipliers 0.5×/0.25×, decay half-life in
per-tab calls, total relevance cap) live in a single `relevanceTuning.ts` const with
documented rationale per knob, plus a contract test asserting the cap and multiplier
bounds. ~8 magic numbers in one reviewed, auditable place — the anti-overfit governance
for the only genuinely tunable part of the design.

### R6 — Trace hygiene + cost budget (v3.1; closes V4's open decisions)

The behavioral trace is the noisiest source; without hygiene rules V4 would invent them
ad hoc. Decided here:

- **Literal extraction discipline** (`browser_execute` scripts can be large and full of
  incidental strings): length window (3–64 chars), per-call cap (first/longest ~8),
  dedupe against ring, **selector-shaped literals weighted higher** (contain `#`/`.`/`[` —
  they name page structure on purpose; console text and URLs mostly don't).
- **Trace keying (closure decision, source-verified):** the trace ring is keyed by
  **`browserSessionId` only** — NOT by the ledger frame key. Two verified reasons:
  (a) `PerceptionLedgerFrame.key` includes `navigationEpoch = url`
  (`observeRunners.ts:384`), so anything stored per-frame dies on navigation, violating
  navigation survival; (b) the toolAdapter tap cannot reliably resolve the EFFECTIVE
  tabId (params.tabId is optional; resolution happens in the driver), so a tab-keyed
  trace would fracture between collection and consumption. Session-keyed traces accept
  cross-tab bleed — harmless under boost-never-gate (another tab's terms rarely match).
  The ring is a sibling structure on the server-owned `PerceptionLedger` instance
  (`BrowserBridgeServer.ts:38,62,116` — created/cleared with the server, accessor
  pattern at `:310-315` extends naturally).
- **Navigation survival:** follows from session keying — tasks span pages
  (search → results → detail); per-call decay + fresh URL signals (D) handle topical
  drift. `detailLevel:"full"` remains the explicit reset.
- **Pre-existing defect folded into V4:** ledger `frames` grow unboundedly — every new
  URL mints a new key (`perceptionLedger.ts:21-23,50-53`), old frames survive until
  server stop. V4 touches the ledger anyway: add LRU retention (≤8 frames per
  session+tab) with a unit test. True general defect, not relevance-specific.
- **Ring + cost caps:** ring ≤ 32 terms per (session, tab); context pre-tokenizes ONCE;
  `computeRelevanceMap` is O(N × T) with both factors capped (≈800 × 32 cheap substring/
  bigram checks) — add its timing to the existing bench harness so the relevance pass
  itself never becomes the next perf finding.

### R5 — Kill switch + privacy-preserving observability

- `PI_BROWSER_RELEVANCE=0` disables all sources (one-line revert posture, consistent with
  the flip plan's escape-hatch culture). Envelope carries `summary.relevance:{signals,
  boosted}` only when boosted > 0.
- Diagnosis without leaking: saved observe artifacts carry per-boosted-fact **source tags**
  (A/B/C/D, no terms) by default; raw trace terms appear in artifacts ONLY under
  `PI_BROWSER_RELEVANCE_DEBUG=1` and pass the existing redaction pipe. Envelopes never
  carry trace content (v2 constraint, sharpened: artifacts get tags by default, terms only
  under the debug flag).

## 3. Hard constraints (v2 set, restated tight)

1. Boost, never gate; floors untouched; no source down-ranks anything.
2. No-signal ⇒ byte-identical on both renderer paths (contract-locked).
3. No model in the loop; no open synonym tables; no conversation access.
4. Trace is in-process ledger state; envelopes never serialize it (R5 governs artifacts).
5. Kernel purity: computation pure in distill-core via structural inputs; collection is
   orchestration side-effect via the R2 table only.
6. Feedback-loop containment: per-tab call-seq decay + novelty counterweight +
   `detailLevel:"full"` clears the trace.

## 4. Stages (resequenced for earliest value + risk isolation)

- [ ] **V1 — relevance kernel.** `relevance.ts` (matcher: NFKC + CJK bigrams + field
  weights; `computeRelevanceMap` with depth-1 propagation; caps) + `relevanceTuning.ts` +
  `relevanceTaps.ts` types. Unit tests: CJK/mixed/empty/garbage, propagation graphs, caps.
- [ ] **V2 — wiring skeleton + URL cold-start (first user-visible value).**
  RelevanceContext built once in observeRunners; scoreAction + targeted-set hooks become
  lookups; source D live; kill switch; feedback field. Contract: no-signal byte-identity.
- [ ] **V3 — archetype table** (source C onto inference detectors) + completeness test vs
  detector list.
- [ ] **V4 — behavioral trace** (source A): toolAdapter tap + ledger ring + decay +
  **R3 arbitration rule** + two-systems fixture + feedback-loop fixture.
- [ ] **V5 — explicit `intent` override + one skill sentence.**
- [ ] **V6 — fact-level integration** when `allocateFacts` gains production callers
  (FactSalience.relevance as 5th component; unchanged plan).
- **Out of scope:** unchanged v2 list, plus **rejected in v3 — runtime A/B self-guard**
  (computing with/without relevance per observe to pick the smaller, like
  `acceptedCandidate`): doubles allocation work per call for a guarantee the bench
  assertions + kill switch already provide statically. Also out of scope (v3.1):
  **relevance-conditioning non-observe distillers** (network/hook summaries filtering by
  trace terms) — plausible follow-up, but scope-locked out until the sentinel shows
  observe-side relevance is actually consumed; one workstream at a time.

## 5. Verification

- Unit per stage; matcher fuzz (bounded cost on garbage/huge inputs).
- **Contracts:** no-signal byte-identity (both paths); single-home locks (matching only in
  `relevance.ts`, extraction only via tap table); trace-never-in-envelope grep lock;
  tuning caps.
- **Bench (`bench:distill` relevance mode):** fixture corpus × scripted call sequences
  (traces derived from eval workflows' Expected-tool-sequence sections; URLs/Goals as D/E
  inputs). Assertions: boosted facts' granularity ≥ baseline; total chars ≤ baseline;
  truncation markers ≤ baseline; task-switch fixture decays within K calls.
- **Two-systems fixture (R3):** P-frame + touched-fact sequence asserts the one-rung-hold
  and that P-frame size stays bounded.
- **Feedback-loop fixture:** repeated identical observes do not monotonically narrow the
  rendered set.
- **Sentinel (post-landing):** triage lens adds "boosted facts consumed? narrowing
  complaints? trace terms ever visible?".

## 6. Closure verification record (2026-06-10 — all load-bearing assumptions source-checked)

| # | Assumption | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | PerceptionLedger can host the trace ring | ✅ with correction | server-owned instance (`BrowserBridgeServer.ts:38,62`), accessor pattern `:310-315`; BUT frame key includes url ⇒ ring must be a session-keyed sibling, not frame data |
| 2 | toolAdapter tap can key the trace | ✅ with correction | params visible at adapter; effective tabId NOT resolvable there ⇒ session-only keying (§2 R6) |
| 3 | Hook signatures accept lookups non-invasively | ✅ with correction | `scoreAction` is ref-less ⇒ dual read surface; `entitySalienceRank` is ordinal ⇒ within-rank secondary sort; `summarizeScanData` has `options.entityContext` precedent (`scan.ts:8,572`) |
| 4 | URL available for source D at context build | ✅ | same plumbing as `ledgerKey` (`observeRunners.ts:473,696` — pre-bridge tab url + post `data.url`) |
| 5 | inference outputs precede relevance consumption | ✅ | abmlRead/attribution completes before summary construction in `runScanObservation` (audited flow :496→:577); archetype hits built into RelevanceContext before `summarizeScanData` runs |

Defect discovered during closure: unbounded ledger `frames` growth (§2 R6) — folded into V4.

## 7. Relations

- Hooks live in the now-default salience path; coordinate only on `salienceEnvelope.ts`
  with any flip-plan follow-ups.
- R1's structural-input pattern reuses the K4 cross-kernel precedent; R2's chokepoint
  reuses the audited toolAdapter universality; source C reuses inference detectors;
  source A's home reuses PerceptionLedger. No new stores, no new kernels, no new params
  required for full value.
