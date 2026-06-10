# Perception renderer + distill-core — unified token-economy architecture contract

> Status: **IMPLEMENTED — opt-in salience/session-delta substrate landed 2026-06-10.** Activation
> was recorded in `CURRENT.md`; implementation passed `npm run check`. Default agent-facing output
> still uses the compatible ladder path. `PI_BROWSER_RENDERER=salience` and
> `PI_BROWSER_SESSION_DELTA=1` are explicit opt-in/eval surfaces. Fixture + one real-site blind A/B
> did not justify a default flip, so the default remains `ladder`.
>
> This document is now both the architecture contract and execution record for the token-economy
> work: it unifies page-model compression (ABML perception planes) and result distillation behind a
> budgeted perception renderer, and consolidates scattered distillation mechanics into the pure
> `src/distill-core/` kernel. It is the successor track to the **closed** performance audit
> (`docs/performance-overhead-audit.md`) and the concrete resolution of the in-process
> kernelization question (distillation/ref/comms research, 2026-06-08).

## 1. Problem — compression is scattered across disjoint, mutually-blind mechanisms

What this project compresses **is** the page model shown to the agent, so token compression and
ABML perception are one problem. Today they are solved by three layers that never talk, plus a
long tail of per-tool hand-rolled truncation:

| Layer | Where | Semantics-aware? | Budget-aware? |
| --- | --- | --- | --- |
| **L1 kernel fixed caps** | `src/abml-core/` products and observe adapters still carry fixed caps (causal 12, outline/member refs 12, primary entities 10/12, diff/template samples); some older comments still say "budget-immune" even where planes are now engine-only | yes | **no** — a 4 KB and a 12 KB budget get near-identical plane caps |
| **L2 distiller salience** | `src/tools/summaries/scan.ts` `scoreAction` (editable +260, action-intent +350, above-fold +80, …), `scoreTextSignal`; `src/tools/observeRunners.ts` `entitySalienceRank` | yes | **no** — used only for ordering inside fixed caps |
| **L3 envelope byte ladder** | `src/tools/resultMiddleware.ts` `ENVELOPE_LIFTED_KEYS`/`ENVELOPE_REMOVABLE_KEYS` fixed order; `fitEnvelopeBudget()` squeeze phases; `responseEnvelope()` pre-fit budget | **no** — drops/compacts whole planes in a fixed order regardless of which carries the page's value | yes |

In information-theoretic terms: the token budget is the channel, the page model is the source,
and the current encoder does fixed-rate per-plane quantization plus semantics-blind hard
truncation. The salience signal (L2) and the rate control (L3) never meet.

Additional scatter and structural problems, reconciled against current source:

- **31 summary/distiller files and ~137 truncation/cap sites** under `src/tools/summaries/` by the
  current source scan (`slice(0, N)`, `truncateText`, `textPreview`, `summaryTable`, local caps).
  This supersedes the original 17/67 estimate. The registry contract
  (`src/tools/distillerRegistry.ts` `Distiller = (value, command) => summary`) is still a black box:
  `summarySchema` locks shape, nothing locks economy. Only a small subset of tools use
  `DistillerDefinition`; `factify` now exists as an optional contract and has first migrated users,
- **Side effects still live inside distillation:** `resultMiddleware.ts` imports both
  `saveTextArtifact` and `appendMemoryAutoSurface`. The distillation core is therefore not a pure,
  benchmarkable function. Source study shows this seam should be split after the mechanical helper
  move, not mixed into it, because artifact timing, privacy raw pointers, and memory auto-surface
  ordering are contract-sensitive.
- **The budget still does not reach the semantic layer:** `maxChars` → pre-fit summary budget lives
  in `responseEnvelope()` / `fitSummaryBudget()`. `summarizeScanData()` has its own budget rungs,
  but entity/plane survival remains mostly fixed caps (`envelopeEntities(...).slice(0, 12)`,
  `buildEntityOutline(...).slice(0, 12)`, causal/request caps, diff/template caps).
- **Session memory exists but the agent is still the courier:** the server keeps per-tab observation
  snapshots (`BrowserBridgeServer.createObservationSnapshot/getObservationSnapshot`, saved artifact +
  `networkSeq`/`hookSeq` high-water marks, TTL), yet deltas require an explicit `baseline`,
  `baselineSnapshotId`, or `baselinePath` resolved by `resolveBaselineEntities()`.
  Re-observing the same page without that parameter re-pays the full model.
- **The squeeze ladder is no longer the old 30–50-pass sink, but remains the wrong abstraction.**
  The performance audit's 2.3 safe subset landed; current `resultMiddleware.ts` still contains ~20
  `stableJson(` call sites and semantics-blind lifted-key compaction/removal. The new renderer should
  replace this as the normal path; `fitEnvelopeBudget` remains the safety net.

## 2. What already exists (reuse, do not rebuild)

- **Salience signal sources** — actionability (`src/tools/summaries/scan.ts` `scoreAction`,
  plus `src/tools/observeRunners.ts` `entitySalienceRank`), novelty (`src/abml-core/diff.ts`,
  `treeDiff.ts` vs a baseline), consequence (`src/abml-core/causal.ts` control→request/event
  attribution; P1 initiator/passive filtering and P2 hook events are now landed), structure
  (landmarks/headings, `src/abml-core/templating.ts` `templateRank`). All four components of the
  unified salience score already have engines; the K2 work is to export/adapt them, not perceive new
  facts.
- **Stable refs across snapshots** — M2b `semanticRefAnchor.ts` (container+role+name+posInSet
  anchor, survives list reorder). The precondition for ref-only re-rendering.
- **Living snapshot** — M2c `snapshotProjection.ts` (current templates + attached deltas). Becomes
  the orientation skeleton every delta envelope carries.
- **Identity substrate** — `src/abml-core/identityGraph.ts` now builds `byRef → anchorKey /
  triggeredRequests` and `observeRunners.ts` persists it into saved observe artifacts. This must feed
  future version stamps and ledger diagnostics.
- **Server-side observation snapshots** — `server.getObservationSnapshot(snapshotId)` with saved
  artifact + `networkSeq`/`hookSeq` high-water marks. `PerceptionLedger` now records the latest
  per-tab/url frame and last-shown granularity for opt-in session deltas; a stronger explicit
  navigation epoch remains the default-flip gate.
- **Registry dual-path precedent** — `distillerRegistry.ts` keeps the legacy `distill` registry in
  sync when a `DistillerDefinition` is registered. The same pattern now carries the gradual
  `factify` migration through the optional `factify` field.
- **Recovery surfaces** — `pi-ref://` resolution, `browser_artifact` jsonPath/pick reads, saved
  observe artifacts. Everything the renderer demotes below the budget line stays one read away.
- **Contract guards** — `check-token-contract.mjs` (CJK `String.length` fixture),
  `check:summaries`, `check:token-economy` (±10% layer0), `resultMiddleware-advanced.test.ts`,
  `envelope-disclosure.test.ts`, and `check:abml-core-boundary` (the boundary-lock pattern to
  mirror), plus the landed `check:distill-core-boundary`, staged `check:summary-boundary` lock, and
  `bench:distill`.
- **Envelope version-marker precedent** — `focus.entityShape:"refs-v1"` (landed 3.3). The renderer
  uses the same pattern: `envelope.renderer:"salience-v1"` only when the salience renderer is active.

## 3. Core abstraction — one concept absorbs every mechanism

Every existing mechanism — plane caps, action scoring, byte ladder, template folding, the dense
line-encoding idea — is a fragment of one question: **given N perception facts and an M-char
budget, at what granularity does each fact render?** Making that explicit:

```ts
type Fact = {
  ref: string;                       // pi-ref; M2b anchor keeps it stable across snapshots
  plane: "entity" | "outline" | "relation" | "causal" | "diff" | "treeDiff" | "snapshot" | "identity";
  salience: {
    actionability: number;           // ← scoreAction/entitySalienceRank signals, promoted/adapted into pure code
    novelty: number;                 // ← diff/treeDiff vs baseline AND vs the session shown-set
    consequence: number;             // ← causal attribution (this fact triggered requests/events)
    structure: number;               // ← landmark / heading / templateRank
  };
  renderings: {                      // granularity ladder = variable-rate quantization
    full:    { value: unknown; cost: number };  // cost = stableJson(value).length (String.length)
    compact: { value: unknown; cost: number };
    line:    { text: string;   cost: number };  // dense line encoding — just another rung,
                                                // eval-gated per plane, not a big-bang bet
    ref:     { text: string;   cost: number };
  };
};

type RenderPlan = Map<string /* fact ref */, "full" | "compact" | "line" | "ref" | "omit">;
```

**Rendering = greedy fill by value density (`salience / cost`) under the budget, with per-plane
floors** (the envelope keeps a predictable shape — an agent-first constitution requirement).
Cost accounting is incremental: per-fact costs accumulate against the budget plus a fixed
skeleton overhead; the whole envelope is serialized **once** at the end to confirm, and on
estimation error the lowest-density facts are evicted and re-confirmed (bounded, ~2 passes).

What each old mechanism becomes:

| Old mechanism | New home |
| --- | --- |
| L1 hardcoded plane caps | budget-derived plane floors/ceilings in the allocator — output scales with budget |
| L2 `scoreAction` ordering-only | the unified salience currency — decides survival **and** granularity |
| L3 ladder's remaining repeated `stableJson` budget probes | incremental accounting + single final confirm; the old serialize-once future gate dissolves into renderer accounting |
| fixed `ENVELOPE_LIFTED_KEYS` / `ENVELOPE_REMOVABLE_KEYS` drop order | value-density eviction — what survives is decided semantically per page |
| dense-notation idea (pillar 3) | the `line` granularity rung — A/B-testable per plane |
| ~137 current summary truncation/cap sites | staged migration to a single `granularity.ts` primitive module (see §4/§7) |

## 4. Architecture — two pure kernels, runtime glue, side effects lifted

```
┌─ src/abml-core/            PERCEPTION kernel (existing; boundary lock unchanged)
│    entity/ax/diff/treeDiff/causal/templating/identityGraph engines — unchanged
│    + exports numeric salience COMPONENTS (actionability/novelty/consequence/structure)
│      (scoreAction/entitySalienceRank knowledge is promoted or adapted into pure perception code)
│
├─ src/distill-core/         ECONOMY kernel (new; pure — no browser/Node/driver/tools imports;
│                            leaf src/utils helpers allowed, same tolerance as abml-core)
│    cost.ts                 the ONE cost model — String.length, CJK semantics locked here
│    granularity.ts          the ONLY place truncation primitives live: compactValue (moved
│                            compactSummaryValue), table folding, string truncation, line encoding
│    fact.ts                 Fact / Plane / Salience / RenderPlan contract types
│    artifactPlan.ts         K1c side-effect intent type only — no I/O implementation
│    allocate.ts             knapsack allocator: (facts, budget, shownSet, floors) → RenderPlan
│    render.ts               RenderPlan → envelope planes (pure object assembly)
│    ladder.ts               fitSummaryBudget/fitEnvelopeBudget moved here — demoted to the
│                            fallback safety net; the normal path never triggers it
│    recovery.ts             (K4) the ONE recovery vocabulary + mechanism: error code → category →
│                            factual-remediation template, mergeRecoveries/dedupe/nextActions
│                            assembly — remediation is agent-facing expression, so it lives in
│                            the expression kernel
│
├─ src/abml/ (runtime)       PerceptionLedger (stateful) + entity→Fact adaptation
│
└─ src/tools/                orchestration + side effects (outside the kernels):
     K1a keeps current resultMiddleware behavior while importing distill-core helpers;
     K1c executes ArtifactPlan intents (saveTextArtifact), memory auto-surface,
     redaction application, correlation/nextActions assembly. summaries/* shrink to
     declarative factify mappings over time.
```

**Key decision — the two kernels do not depend on each other.** `abml-core` stays
perception-only and exports numeric salience components; `distill-core` owns the Fact vocabulary
and the economics; `src/abml` runtime glues entity→Fact. Two independent boundary locks, no
cross-kernel import, no new coupling problem.

**Factifier contract.** Per-tool distillers degrade from black-box compressors to declarative
mappings:

```ts
// today:  distill:  (value, command) => summary   // many private truncation/cap decisions inside
// target: factify:  (value, command) => Fact[]    // declares facts + planes + salience hints;
//                                                 // truncation/caps/budget run in the kernel
```

`DistillerDefinition` gains an optional `factify` field; tools migrate one at a time on the
existing dual-path precedent. Non-migrated tools keep working through `distill` + the fallback
ladder indefinitely.

**Side effects lifted in two steps, not as part of the first helper move.** Source reconciliation
shows artifact saving and memory auto-surface are contract-sensitive: saved timing affects raw
privacy pointers, `saved` diagnostics, fallback artifact creation, and memory hints. Therefore K1
first moves only pure budget helpers byte-identically. A follow-up K1c introduces an `ArtifactPlan`
seam and keeps `toolAdapter`/`resultMiddleware` responsible for executing `saveTextArtifact` and
`appendMemoryAutoSurface`. Only after K1c does the distillation core become fully pure,
unit-testable, benchmarkable (token ratio + serialization count), and replayable.

**The ladder survives as a guarantee, not a mechanism.** `fitEnvelopeBudget` (moved to
`ladder.ts`) still hard-caps the envelope if the renderer's estimate drifts. Migration is
therefore safe-by-construction: the renderer aims under budget; the ladder is the contract.

## 5. Session-level incremental encoding — PerceptionLedger (I/P frames)

The agent runs 5–20 observes against the same page family per task; re-rendering the same model
each time is the single largest remaining token waste. Video-codec model:

- **I-frame:** first observe of a (session, tab, navigation-epoch) renders the full model.
- **P-frame (default only after C4 eval):** subsequent observes render against the Ledger's last
  snapshot automatically — no agent-supplied `baseline` needed. Facts already shown at
  ≥granularity and unchanged (version stamp equal) auto-degrade to `ref`; changed facts get a high
  novelty component and re-compete for granularity.
- **Ledger:** per (session, tab, navigation epoch):
  `ref → { versionStamp, lastShownGranularity }`, layered on the existing observation-snapshot
  store. Version stamps should use the landed identity substrate first (`identityGraph.byRef` /
  semantic anchor key + relation/trigger summary + relevant state hash), then fall back to structural
  hashes. Refs adopt **LSP-style version stamps validated at resolve**: `REF_STALE` upgrades from
  TTL-backstop to correctness check.
- **Precondition for C3:** define a reliable navigation epoch source. Current snapshots carry tab,
  URL, selectionVersion, sourceMode, and seq high-water marks, but no explicit navigation epoch.
  C3 must add or derive this before enabling automatic baselines.
- **Auto I-frame triggers:** navigation-epoch change, REF_STALE rate above threshold, large
  treeDiff, missing/expired ledger, context-age threshold, or explicit `refresh:true` /
  `detailLevel:"full"`.
- **Envelope self-description:** P-frames carry `delta:"session"` + the I-frame `snapshotId`, and
  **always** carry the `snapshotProjection` orientation skeleton (M2c finds its real role here).

**Known risk — the decompression-dictionary assumption.** P-frames assume the agent's context
window still holds the earlier I-frame. Harness-side context compaction can evict it, turning
ref-only P-frames into unreadable noise. Mitigations: (1) the always-carried projection skeleton;
(2) every ref recoverable via `pi-ref://`/`browser_artifact` (existing paths); (3) the explicit
refresh escape; (4) the blind-eval plan (§9) includes a long-conversation scenario specifically
to test this. If the long-conversation eval shows degradation, the fallback posture is
"P-frame only when the prior observe is ≤K turns back", tuned from transcripts.

## 6. Hard constraints (inherited; non-negotiable)

1. **`String.length` (UTF-16) is THE budget metric** — CJK/mainland pages are the target; byte
   accounting trips budgets 3× early on Chinese pages. Locked in `distill-core/cost.ts` and by the
   existing CJK fixture in `check-token-contract.mjs`.
2. **Envelope plane shape stays stable.** Same top-level keys for currently agent-facing planes;
   what changes is what fills each plane and how much. Do not silently restore removed agent-facing
   planes: `templates` and `inference` are currently engine-only after eval-backed removal, while
   `treeDiff`, `snapshotProjection`, `diff`, `causal`, `relations` (when non-empty), `gist`,
   `outline`, and `entities` remain the relevant observe envelope planes. The renderer marks itself
   `envelope.renderer:"salience-v1"` only when active (precedent: `entityShape:"refs-v1"`).
3. **Contract changes are eval-gated.** The default stays `ladder` behind a flag
   (`PI_BROWSER_RENDERER=ladder|salience`) until blind-eval A/B evidence flips it (§9). Per
   `eval-fixes-true-defect-no-overfit`: cross-run, no overfit to one site/task/DOM shape.
4. **Perception, not execution.** The renderer changes how the page model is *shown*, never adds
   action verbs/params. North star unchanged.
5. **Lightweight boundary guards, no package ceremony, no shims.** Lesson from the abml-core
   decoupling (23 re-export shims, dual manifests, indefinitely-deferred package): moves update
   imports directly; the lock is a CI check, not a workspace package.
6. **Nothing is lost, only demoted.** Every fact below the budget line remains reachable via
   `pi-ref://` or the saved artifact. Compression is lossless at the handle level (same invariant
   the templating arm established).
7. **Recoverable diagnostics.** A budget-starved envelope must say so (`omitted` markers /
   nextActions hint naming the recovery read), never silently truncate.

## 7. Boundary locks (the "stay-unified" enforcement)

- **`check:distill-core-boundary`** (new, mirrors `check:abml-core-boundary`):
  `src/distill-core/` must not import from `src/abml`, `src/abml-core`, `src/tools`,
  `src/driver`, Node I/O modules, or any browser API. Allow only reviewed pure cross-cutting
  helpers such as `src/utils/json.ts`, `src/utils/records.ts`, and redaction helpers when needed.
- **Anti-scatter reverse lock** (new contract test, staged): `src/tools/summaries/**` should not
  add new raw truncation primitives (`slice(0,`, manual `…` appends, private char caps) outside
  reviewed grandfathered files. Enforce as a baseline/allowlist from K1b, then burn exemptions down
  during K3 migrations. A day-one blanket ban is not viable against the current 31-file summary
  tree.
- **Purity lock:** `distill-core` exports must not perform I/O; after K1c the `ArtifactPlan` type is
  the only sanctioned side-effect channel, executed in runtime/tool orchestration.
- **Recovery anti-scatter lock** (staged, from K4): new/edited code outside `distill-core/recovery.ts`
  must not hand-build recovery/nextActions TEMPLATE text — it composes entries from the vocabulary
  (call-site context like ids/paths stays at the call site). Same baseline/allowlist mechanics as
  the truncation lock; the ~70-site/30-file baseline burns down opportunistically with K3 and tool
  edits.

## 8. Rejected alternatives (recorded so they are not re-litigated)

- **A. Thread the budget down but keep the three layers independent.** Minimal diff, but salience
  and rate control remain two value systems; "drop entities vs squeeze outline" stays
  semantics-blind. Treats the symptom.
- **B. One merged kernel (fold economics into abml-core).** Network/hook/webSecurity/transfer
  distillation is not page perception; merging makes abml-core's boundary lie. Two kernels with
  no cross-dependency is strictly cleaner.
- **C. Minimal envelope + agent pulls planes on demand.** Converts token cost into round-trip
  cost (a full tool call each) and agent attention. Progressive disclosure already exists via
  artifacts/pi-ref. Blind-eval evidence is against it: agents did not even read the focus
  entities that were pushed to them (the refs-v1 finding) — they will not issue extra pulls.
- **D. Big-bang dense line-encoding of the whole envelope.** Highest upside, highest
  comprehension risk (agents parse JSON reliably). In this architecture it is unnecessary as a
  bet: `line` is a granularity rung, adoptable per plane with per-plane eval evidence.
  Supporting signal, not proof: in the linux.do blind runs agents preferentially consumed the
  densest existing planes (outline, `data.list_hints`).

## 9. Execution queue

This queue is now the execution record. The implementation landed the compatibility-preserving
kernel/substrate slices and kept default behavior unchanged. The default flip remains a separate
blind-eval decision, not an implementation side effect.

- [x] **K0 — activation record.** `CURRENT.md` recorded activation before code changes; default
  renderer stayed `ladder`; no public `browser_*` surface changed.
- [x] **K1a — carve distill-core helpers.** `src/distill-core/cost.ts`, `granularity.ts`, and
  `ladder.ts` now own `String.length` cost, compact primitives, and `fitSummaryBudget` /
  `fitEnvelopeBudget`; `resultMiddleware.ts` imports them directly without shims.
- [x] **K1b — boundary + anti-scatter locks.** `check:distill-core-boundary` is wired into package
  checks; `check:summary-boundary` now blocks new summary truncation/cap scatter while preserving
  the reviewed baseline.
- [x] **K1c — side-effect seam / ArtifactPlan.** `distill-core/artifactPlan.ts` emits pure save
  intents; `resultMiddleware.ts` still executes `saveTextArtifact` and memory auto-surface side
  effects in tool/runtime orchestration, preserving privacy pointers and fallback saves.
- [x] **K1d — bench:distill.** `bench:distill` runs `tests/contracts/tools/check-distill-bench.mjs`
  over a fixed fixture corpus and records token/char-ratio evidence.
- [x] **K2a — Fact contract + opt-in renderer substrate.** `fact.ts`, `allocate.ts`, `render.ts`,
  and `salienceEnvelope.ts` landed in `distill-core`; `PI_BROWSER_RENDERER=salience` marks
  `envelope.renderer:"salience-v1"` while default output remains ladder-compatible.
- [x] **K2b — opt-in budget takeover substrate.** Salience rendering can allocate lifted planes by
  salience/cost density behind the flag; ladder remains the default and fallback safety net.
- [x] **K3 — migrate current DistillerDefinitions to factify.** Every currently registered
  `DistillerDefinition` now provides `factify`; coverage is locked by `check:distiller-coverage`.
  Legacy inline/command distillers continue through `distill` + ladder until they are promoted to
  `DistillerDefinition` with schema goldens.
- [x] **K4 — recovery vocabulary consolidation into `distill-core/recovery.ts`.** The generic
  recovery generation/merge/action-dedup mechanism now lives in `distill-core/recovery.ts`;
  `utils/errors.ts` composes through it, while `abml-core/errors.ts` keeps domain recovery data and
  does not import `distill-core`. `check:recovery-boundary` locks the mechanism home and stages the
  existing recovery/nextActions template baseline.
- [x] **C3a — PerceptionLedger substrate.** `src/abml/perceptionLedger.ts` and server accessors now
  record per-session/tab/url frames, snapshot ids, version stamps, and last-shown granularity without
  changing default observe output.
- [x] **C3b — opt-in auto I/P frames.** `PI_BROWSER_SESSION_DELTA=1` reuses the previous ledger
  snapshot and emits `delta:"session"` / `baselineSnapshotId`; `detailLevel:"full"` remains the
  refresh/I-frame escape hatch. Default output is unchanged before C4.
- [x] **C4 — blind-eval A/B, flip decision.** Fixture blind A/B passed with no usability regression;
  one real-site linux.do blind A/B showed salience/session opt-in improves page understanding but
  increases artifact/token pressure and truncation. Decision: **do not flip defaults**; keep
  `PI_BROWSER_RENDERER=salience` and `PI_BROWSER_SESSION_DELTA=1` opt-in pending broader multi-site
  evidence.
- [x] **C5 — first `line` granularity primitive.** `lineEncodeEntity()` landed as the entity-plane
  primitive; broader per-plane line rendering still requires per-plane eval evidence.
- [x] **Continuous — eval-instrumented salience weights decision.** Initial blind evidence is now
  recorded as a default-flip gate result, not enough for weight/default changes. Future salience
  tuning remains a new eval workstream driven by multi-site transcripts, not an active item in this
  implementation contract.

## 10. Verification & benchmarks

- **K1 focused gates:** `npm run check:token`, `npm run check:summaries`,
  `npm run check:token-economy`, `tsx --test tests/unit/tools/resultMiddleware-advanced.test.ts`,
  `tsx --test tests/unit/tools/envelope-disclosure.test.ts`, plus new boundary checks.
- **`bench:distill`** (landed): fixed fixture corpus (large CJK list page, form-heavy page, table
  page, small page, network/hook-style results, WebSecurity-style result family) → token/char ratio
  evidence and ladder/salience regression signal. Run before/after every K/C step; regressions block
  landing unless explained by a verified quality gain.
- **Parity & goldens:** K2a observe parity golden (renderer == ladder output under floor-mode); the
  multi-rung budget golden; existing `check:summaries`; CJK fixture in `check-token-contract.mjs`.
- **ABML/observe gates:** `npm run test:observe-abml-integration`, `npm run check:abml-causal`,
  `npm run check:abml-tree-diff`, `npm run check:abml-snapshot-projection`,
  `npm run check:abml-scan-envelope`.
- **Live smoke:** `smoke:browser:scan-summary` passed on 2026-06-10 and remains the required live
  gate for future default-flip work.
- **Deterministic workflow eval:** `npm run eval:browser-workflows -- --fixture-server --eval
  16-scan-high-entropy-summary` passed on 2026-06-10.
- **Blind eval:** fixture implementation-blind A/B and one real-site linux.do A/B passed as read-only
  runs. Result: salience/session opt-in usable, but real-site token/artifact pressure prevents a
  default flip without broader multi-site evidence.
- **Final implementation verification:** `npm run check` passed on 2026-06-10, including token,
  summaries, token economy, distill bench, distill/recovery/summary boundaries, output schema, ABML
  observe/causal/diff, and full unit/contract suites.
- **Honesty rule:** default-flip capability/efficiency claims for the renderer must come from C4
  transcripts, not from `bench:distill` numbers alone (`real-agent-eval-over-self-justification`).

## 11. Current source reconciliation notes

- `src/distill-core/` now exists and is protected by `check:distill-core-boundary`.
- `PI_BROWSER_RENDERER=salience`, optional `factify`, `ArtifactPlan`, `PerceptionLedger`,
  `delta:"session"`, and `envelope.renderer:"salience-v1"` now exist as opt-in/substrate features;
  none changes default output.
- `src/tools/resultMiddleware.ts` remains the orchestration chokepoint for artifact save execution,
  privacy pointer production, memory auto-surface, and final model-facing JSON; pure budget and
  artifact intent logic live in `distill-core`.
- `src/tools/observeRunners.ts` builds `identityGraph`, computes causal P1/P2, treeDiff,
  snapshotProjection, relations, inference, gist, outline, entity refs, and now writes/reads the
  opt-in ledger frame. Duplicate `snapshotProjection` compute remains covered by the separate ABML
  compute plan, not this token-economy contract.
- `templates` and `inference` remain engine-only until a new eval proves agent-facing value; the
  salience renderer must not reintroduce them by accident during future default-flip work.

## 12. Related tracks & documents

- `docs/performance-overhead-audit.md` — **closed** point-fix queue; this contract is the
  successor for token-economy work. The audit's serialize-once safe subset already landed; K2
  replaces the ladder as the normal path via incremental accounting while keeping the ladder as a
  fallback safety net.
- `docs/abml-kernel-optimization-plan.md` — orthogonal compute track for byte-identical ABML
  kernel/runtime optimizations (duplicate snapshotProjection per observe, lazy
  `isInterestingAxNode` property scans, O(N×M) merge pre-extraction, unified grouping engine,
  page-side `selectorFor` quadratic, …). Not part of this contract; if both are active, land or
  rebase the grouping/snapshotProjection compute fixes before K2 parity goldens.
- `docs/abml-mechanism-arm-execution-plan.md` — M1/M2a/M2b/M2c, the substrate this design builds
  on (templates, treeDiff, semantic anchors, snapshot projection).
- Kernelization research (2026-06-08, memory: `kernelization-architecture-research`) — this
  contract is its concrete resolution: perception stays in abml-core, economics becomes
  distill-core, side effects lift to runtime/tool orchestration, comms/ref tracks remain separate.
- Causal P1/P2 attribution is no longer in-flight: `passive`/`initiatorType` request fields and
  event-sourced `triggered` relations are landed and should feed the consequence salience component.
