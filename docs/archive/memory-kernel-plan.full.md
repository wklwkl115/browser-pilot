# Memory Kernel Plan — retain as the fourth kernel

Status: Completed and archived (2026-06-11). Activated in `CURRENT.md`, implemented through M0-M5,
accepted by paired blind eval plus negative controls, then archived. The active runtime contract is
now summarized in `docs/browser-memory.md`, `CURRENT.md`, and generated tool contracts.
v4 = external audit adjudicated 6/6 accepted (with two architect nuances recorded inline): M3c moved
out of generic middleware into an observe-runner `MemoryAugmentationPlan` (distill-core stays
memory-agnostic); the no-displacement rule mechanized as `livePlaneSignature()` with an
inline→handle→omit ladder; privacy rebuilt around a `PersistableMemoryTerm` whitelist type +
local-secret HMAC stamps; profile persistence upgraded from last-writer-wins to serialized
read-merge-write (strikes/sessionCount are accumulated state, NOT reconstructible — the v3 LWW claim
was wrong for them); F warm-start isolated from the live term cap (append-last + own sub-cap); the
eval redesigned from three arms to within-task cold/warm pairs + negative controls + a structured
adoption schema. New M0 hardening track precedes M1 (one item fixes a LIVE defect: the automatic
read path can today trigger an index repair-write).
v3 = owner architect review 7/7; v2 = adversarial self-review (task-bias pollution,
conversation-continuity, verification repurposing, IDF, strikes).

Owner decision basis: real-agent eval history (envelope.templates/inference removed as unread,
B2 action arm reverted as unused) proves advisory-text mechanisms do not change agent behavior;
`browser_memory` recall/record adoption requires explicit prompting, which is the same failure class.

## 0. Problem statement (one paragraph)

The project has two memory layers with opposite health. `PerceptionLedger` (`src/abml/perceptionLedger.ts`)
is kernel-shaped — on the data path, automatic, invisible, deterministic — but in-memory only: it
forgets everything at process exit. `browser_memory` (`src/tools/memory/`) persists, but sits OFF the
data path: both record and recall demand explicit agent decisions whose cost is immediate and whose
benefit accrues to a future session, so agents rationally ignore it; the `autoSurface` hint strings in
`nextActions` are the mechanism class this project has already disproven twice. The fix is not better
hints — it is topology: move memory onto the default path, as a fourth kernel completing
**sense (capture) → perceive (abml) → express (distill) → retain (memory)**.

## 1. Design principles (load-bearing)

- **P1 — Conversation-continuity rule.** Session-scoped perception mechanisms (granularity ceilings,
  stableRefs compaction, session-delta, render cache, entity/tree diff) are sound ONLY because the
  agent saw the prior render in its own conversation context. A new conversation has an empty
  context: "unchanged since last session" must never compact or diff its first view. Therefore
  **cross-session memory may only ADD information or VERIFY claims — it must never subtract
  perception the current conversation has not earned.** Corollary: any "show once, then collapse"
  economy must be keyed to a REAL conversation identity, never to `browserSessionId` (which a
  long-lived daemon reuses across conversations).
- **P2 — Memory is a hypothesis, not a fact.** Everything recalled across sessions is potentially
  stale. Injection must carry verification status (`fresh | unverified | stale`) computed against
  live anchors, and verification failures must feed back into the store (strikes → deprecation).
  Never assert remembered state as current state.
- **P3 — Boost-never-gate is necessary but NOT sufficient.** Under a fixed budget, boosting wrong
  things demotes right things (allocation is zero-sum). So warm-start signals must additionally be
  (a) recurrence-filtered (site vocabulary, not last task's vocabulary) and (b) agreement-gated
  (activate only when live signals overlap). And the memory PLANE itself is budget-subordinate:
  it must never displace live page perception — mechanized as `livePlaneSignature()` equality
  (D3-M3c), not prose. "No profile ⇒ byte-identical" is the floor; "wrong profile ⇒ no measurable
  harm" is the bar, eval-checked by the T2 within-task pair and negative controls (D6).
- **P4 — Brain-Hand split of the write path.** Mechanical memory (stamps, vocabulary, verification
  outcomes) is deterministic and auto-persisted. Strategic memory (SOPs, judgments) stays explicit
  agent authorship. The kernel never auto-crystallizes judgment.
- **P5 — Read-side injection must not feed the write side.** Warm-start terms are ephemeral
  per-observe inputs assembled at relevance time; they never enter the trace ring, never get
  re-persisted, never inflate recurrence counts, and never displace live terms from the relevance
  cap (append-last + own sub-cap).
- **P6 — Kernel auto-paths never write outside their own lane (v4).** The automatic read path
  (recall, verification, profile load, index load) is no-repair / no-write / no-throw: it must never
  create, repair, or rewrite store files as a side effect of an observe. Writes happen only in the
  explicit tool path and the serialized profile flush. (Today's `readMemoryIndex` self-heals a
  corrupt index by WRITING — `indexStore.ts:134-140` — and the autoSurface auto path can reach it:
  a live defect, fixed in M0.)

## 2. Closed decisions

- **D1 — independent fourth kernel.** New pure-logic kernel `src/memory-core/` (profile distillation,
  recall scoring, staleness verification) + runtime layer `src/memory/` (fs persistence, in-process
  cache), CI-boundary-locked like the other three. Not merged into distill-core: lifetime management
  is a distinct concern from expression. Kernel takes structural-typed inputs only (K4 precedent) —
  zero imports from abml-core/distill-core runtime or Node fs. **distill-core stays memory-agnostic
  (v4): no memory-specific logic enters `salienceEnvelope.ts` or any distill-core module.**
- **D2 — v1 mechanical profile = existing ledger data only, whitelist-typed, HMAC-hashed.** Per origin:
  `{ schemaVersion, origin, sessions: ≤8 recent session digests,
  termStats: {term → {sessionCount, lastSeenAt, weight}} (≤48, PersistableMemoryTerm only),
  urls: LRU≤8 of { canonicalUrl, factStamps(ref→HMAC), fingerprintSummary, capturedAt },
  strikes: {entryId → count} }`. No new collection. Hardening:
  - **`PersistableMemoryTerm` whitelist type (v4, replaces the prose kind rule):** persistence
    eligibility is a TYPE, not a filter — only `selectorLiteral | ref | urlPathToken` are
    constructible. URL term extraction is split into `urlPathToken` / `urlQueryToken` at the tap
    layer; `urlQueryToken`, `query`, `intent`, script string literals, message/prose scalars are
    unrepresentable in the profile schema. `containsSensitiveEvidence` still runs as defense in
    depth. (Live relevance keeps using ALL kinds including query/intent — the restriction is
    persistence-only.)
  - **Canonical URLs only**: `origin + path`, query string and fragment stripped (query/fragment are
    the PII carriers). If path-level keying proves too coarse, a hashed query may be added later;
    never raw.
  - **Stamps are local-secret HMACs (v4, replaces FNV):** `versionStamp`/`stableStamp`
    (`src/abml/perceptionLedger.ts:70-91`) embed entity `value` (page content); FNV-64 of low-entropy
    values is dictionary-invertible. Persisted stamps use HMAC-SHA256 (truncated 128-bit) keyed by a
    per-store random secret at `.pi/browser-memory/.secret` (created lazily only when kernel
    persistence is enabled; never logged; excluded from exports/artifacts). Threat-model honesty:
    the secret sits beside the data, so this does not defend against full-directory read access —
    it defends single-file exfiltration/accidental commit (no offline dictionary inversion without
    the secret, no cross-machine rainbow tables). Equality comparison still works: both sides are
    computed under the same store secret. **Architect nuance: the profile FILENAME suffix stays
    FNV-64** — it is collision avoidance over the non-secret origin (the slug already names the
    origin); HMAC there adds zero privacy and makes files unaddressable without the secret.
  - **Adversarial privacy fixture** (gate, M0+M2): fixture session with emails / Chinese names /
    search queries / tokens in params and page content ⇒ assert none of those strings appear
    anywhere in written profile files (the `.secret` file is excluded from the assertion sweep).
  - Caps: ≤64 KB/origin file, ≤64 origins LRU global, atomic writes. Profile filename =
    `<origin-slug>-<fnv64(origin)>.json` (`safeSlug` caps at 80 chars — suffix kills truncation
    collisions).
- **D3 — read path = three injection points, shipped in this order:**
  - **M3a trace warm-start (relevance source F): ephemeral, recurrence-filtered, agreement-gated,
    cap-isolated.** Injection point is `buildObserveRelevance()` (`src/tools/observeRunners.ts:169`):
    warm-start terms are spliced into the `terms` array passed to `computeRelevanceMap` with
    `source: "F"`, age offset, and halved weight — **never** via `server.recordTraceTerms` (the ring
    tags everything `source: "A"` on read-back at `observeRunners.ts:116`; ring entries get
    re-persisted, violating P5). Cap isolation (v4): `prepareTerms` early-breaks at
    `RELEVANCE_TUNING.maxTerms` (`relevance.ts:93`), so F terms are **appended AFTER all live
    terms** (the live set is a prefix and always wins cap contention) and carry their own sub-cap
    `maxMemoryTerms ≤ 8`. Live A/C/D/E term sets and scores are provably unchanged — unit-tested
    byte-equal. Filters compose: (1) recurrence — only `sessionCount ≥ 2` terms are candidates;
    (2) agreement — candidates activate only when the live situation (current URL terms + live
    trace) shares ≥1 token. New `RelevanceSourceTag "F"` + capped knob (`memoryMatch ≤ directMatch`).
    Debug artifacts carry source tags only, never term text. No profile / no agreement ⇒
    byte-identical envelope.
  - **M3b memory verification, structural anchors.** Persisted stamps verify strategic memory
    against the live page — they never warm-start stableRefs/granularity (P1). Anchors are derived
    at record time into an optional internal frontmatter field `anchors` on `MemoryEntry` (additive,
    schemaVersion stays 1): `{ canonicalUrl?, fingerprintSummary?, stampSetId? }` captured from the
    origin profile / recent ledger frame when `record` executes with a live server. Verification
    tiers: anchors present and matching ⇒ `fresh`; present and drifted ⇒ `stale`; absent ⇒
    `unverified` — never guessed from body text. `fresh` raises confidence; the agent still
    re-resolves refs/selectors live before acting. Verification executes inside the observe runner
    as part of the augmentation plan (v4), feeding strike transitions through the serialized
    profile service (D9).
  - **M3c envelope.memory plane via runner-built `MemoryAugmentationPlan` (v4 restructure).**
    The observe scan/text runner — not the middleware — builds the full plan once per observe:
    recall (origin + IDF-weighted token overlap against the live trace), verification (M3b),
    conversation-once state, and BOTH render variants (inline body / handle-only). It passes the
    plan to the distilled-result call as a precomputed option; `resultMiddleware.ts` only attaches
    it and runs the displacement ladder — **no memory I/O in `responseEnvelope()`, no memory logic
    in distill-core**. Displacement ladder, mechanized (v4): compute the fitted envelope WITHOUT
    memory ⇒ `livePlaneSignature()` S0 (signature over entities/gist/outline/relations/diff/causal/
    treeDiff/snapshotProjection + `rendererOmitted` + envelope-level omissions + warnings); attach
    inline variant ⇒ S1; if S1 ≠ S0 try handle-only ⇒ S2; if S2 ≠ S0 **omit the plane entirely**.
    The same `livePlaneSignature()` function is used by the runtime ladder and the contract test —
    no rule/test drift possible. Scope: only `browser_observe` scan/text results. ≤2 cards;
    full body within existing 60-line/4000-char caps. Conversation-once economy: FULL card only the
    first time per conversation+origin, collapsing to a handle line after — keyed by a real
    conversation identity (resolution chain: explicit conversation id from tool ctx → process-
    instance id (Pi-native: one process ≈ one conversation) → **no stable key ⇒ no collapse,
    ever**). Plan computed once in the runner ⇒ the over-budget envelope rebuild
    (`resultMiddleware.ts:512,515,546,549`) reuses it by construction. AutoSurface recall hints are
    deleted in the same change.
- **D4 — write path split on the Brain-Hand line.** Mechanical memory auto-persists at the existing
  frame-record sites (zero agent involvement); strategic memory stays explicit `browser_memory record`.
  The autoSurface **record nudge stays** (sole strategic write-loop ignition) but its adoption is
  measured in M5 with a removal clause.
- **D5 — kill-switch semantics.** `PI_BROWSER_MEMORY=0` disables the KERNEL's automatic read/write
  paths only: profile persistence, F injection, verification, the envelope.memory plane, and the
  record nudge. The explicit `browser_memory` tool (record/recall/read/validate) stays fully
  functional. Existing `PI_BROWSER_MEMORY_AUTOSURFACE=0` remains as a compatible alias scoped to the
  nudge (master=0 implies it). Default ON. The plane is renderer-agnostic. Disabled or empty store
  must NOT materialize `.pi/browser-memory/` (profiles, index, or secret) — non-users keep a clean
  tree (P6 makes this provable: auto paths cannot write at all).
- **D6 — acceptance = within-task paired blind eval + negative controls + structured adoption schema
  (v4, replaces the three-arm design — T2-warm vs T1-cold confounded task difficulty with memory
  effect).** Same real site via `pi-browser-blind-eval`, READ-ONLY, harness-agnostic child-agent
  launch per the skill contract:
  - **Pair 1 (strategic payoff):** task T1 cold (fresh store) vs T1 warm (state from a prior T1 run).
  - **Pair 2 (mechanical payoff + harm bound):** task T2 warm (state from T1 runs — memory is about
    a DIFFERENT task) vs T2 control (same state, `PI_BROWSER_MEMORY=0`). Memory is the only
    variable; **harm bound: T2-warm must be ≥ T2-control on calls/tokens/success.**
  - **Negative controls (failure-mode probes):** (a) planted wrong-origin profile (vocabulary from
    an unrelated site) ⇒ must produce zero F activation (agreement gate); (b) planted stale anchors
    ⇒ cards must surface as `stale`, body suppressed at strike 3; (c) common-token flood entries
    ("login", "page" titles) ⇒ must not dominate recall (IDF).
  - **Structured adoption schema (v4):** the blind report template gains a mandatory block —
    `memoryPlaneSeen`, `inlineBodyUsed`, `readThroughUsed` (followed a handle to
    `browser_memory read`), `recordNudgeShown`, `recordCalled`, `usedInFinalAnswer` — self-reported
    by the blind agent AND operator-verified against the transcript. Field presence is not adoption;
    these six are.
  Removal clauses pre-committed: plane never `usedInFinalAnswer`/`readThroughUsed` across pairs ⇒
  delete M3c; no Pair-1/Pair-2 benefit ⇒ revert M3a; harm bound violated ⇒ revert M3a and tighten or
  abandon; `recordCalled` zero across all runs ⇒ delete the nudge.
- **D7 — negative-feedback strikes.** M3b `stale` verdict increments `strikes[entryId]` in the origin
  profile; at 3 strikes a mechanical anchor set is dropped (re-learned on next visit) and a strategic
  card stops carrying its body — handle line with `stale — re-record to supersede`. `fresh` resets
  strikes. Strike updates flow through the serialized merge path (D9) so they are never lost to a
  concurrent flush.
- **D8 — IDF-weighted routing.** Weight routing tokens by `log(1 + N/df)` (df = posting-list length,
  already in the index). Deterministic, zero new state; lands with the routing.ts relocation in M1.
  Recall ranking adds verification status then recency (`updatedAt`) as tie-breakers.
- **D9 — profile persistence is serialized read-merge-write, not last-writer-wins (v4).**
  `strikes` and `sessionCount` are accumulated state — LWW silently loses them under concurrent
  observes or a verification racing a flush, breaking D7's feedback loop. Contract:
  - All profile mutations for a given (cwd, origin) are serialized in-process (promise-chain mutex
    in `profileService`).
  - Every flush re-reads the on-disk profile and merges deltas (strikes = max per entry,
    sessionCount = max per term, url LRU merged by `capturedAt`, caps re-applied post-merge) before
    the atomic write.
  - `BrowserBridgeServer` shutdown drains pending flushes before the ledger is cleared.
  - Cross-PROCESS races remain possible (two hosts, same cwd): accepted residual — no lock file
    (blocking an observe on a cache is worse); the merge step narrows the window to the read-write
    gap, and any lost delta self-heals on the next visit. Documented, not hidden.

## 3. Current substrate facts (verified 2026-06-11)

- `PerceptionLedger` singleton on the server: `src/driver/BrowserBridgeServer.ts:38,62`; accessors
  `:310-327`. Frame-record sites with `ctx.cwd` in scope: `src/tools/observeRunners.ts:640,922`.
- Trace read-back uniformly tags `source: "A"` with positional age: `observeRunners.ts:116`;
  relevance assembly point: `buildObserveRelevance` `observeRunners.ts:169` (M3a splice site),
  callers `:786,833`. Caps: 8 frames/session×tab, 32 trace terms/session (`perceptionLedger.ts:55-56`);
  `prepareTerms` early-breaks at `RELEVANCE_TUNING.maxTerms` (`src/distill-core/relevance.ts:93`) —
  the mechanism behind M3a's append-last cap isolation.
- `granularityCeilingFromLedger` (`observeRunners.ts:436-441`) is a budget-pressure signal; per-ref
  compaction flows through `options.stableRefs` → `allocateFacts` (`resultMiddleware.ts:408`). Both
  session-scoped by P1.
- Relevance sources A–E: `src/distill-core/relevance.ts:4`; per-source base `:65-70`; tap table
  `src/tools/relevanceTaps.ts:9` (kind taxonomy that M0 splits into persistable/non-persistable).
- Envelope assembly + plane fitting: `src/tools/resultMiddleware.ts:437-497` (`responseEnvelope` is
  SYNCHRONOUS — a reason M3c's async recall cannot live there), `fitSalienceEnvelopeBudget` `:420`;
  autoSurface attach (double-call on over-budget rebuild): `:512,515,546,549`.
- **Live defect (fixed in M0):** `readMemoryIndex` self-heals a corrupt index by WRITING
  (`indexStore.ts:134-140`); `autoSurface.loadMemoryIndex` stat-guards absence but reaches
  `readMemoryIndex` when the file exists — a corrupt index makes the automatic path write (P6
  violation, pre-existing).
- `src/tools/memory/routing.ts` + `salience.ts` are pure zero-dep logic — RELOCATE into memory-core.
  `scoreCard` (`store.ts:101-127`) ignores confidence/verifiedAt (D8 gap). `safeSlug` truncates at 80
  (`paths.ts:19-27`) — collision risk fixed by D2 filename suffix.
- Storage root `.pi/browser-memory` (`paths.ts:5`); `atomicWriteText` is generic fs logic there.
- **Execution feedback plan is complete and archived**
  (`docs/archive/execution-feedback-layer-plan.full.md`): `executionJournal.ts` / `executionEffect.ts`
  landed; its touched set included `registerExecuteTool.ts`, `registerCommandTool.ts`,
  `observeRunners.ts`, and result-middleware-facing behavior — see §8.
- Boundary-check models: `tests/contracts/drift/check-{distill,abml}-core-boundary.mjs`
  (`package.json:110-111`). Byte-identity test model: `check-task-conditioned-salience.mjs`.

## 4. Tracks

### M0 — hardening pre-track (v4, lands before any kernel code)

Independent fixes that de-risk everything after and stand on their own:

- **No-repair automatic reads (fixes the live defect):** split `readMemoryIndex` into the existing
  repairing read (explicit tool path keeps it) and a read-only variant for all automatic callers
  (`autoSurface`, future recall): corrupt/missing ⇒ empty index + one low-noise diagnostic, never a
  write (P6).
- **Tap-kind split:** `urlPathToken` vs `urlQueryToken` in the term extraction layer
  (`src/distill-core/relevanceTaps.ts` + `src/tools/relevanceTaps.ts`); live relevance behavior
  unchanged (both kinds still feed live scoring) — this only creates the type seam D2 needs.
- **`PersistableMemoryTerm` type:** kernel-ready whitelist type (`selectorLiteral | ref |
  urlPathToken`) with a constructor that free-text kinds cannot pass.
- **HMAC secret infra:** `src/memory/secret.ts` — lazy creation of `.pi/browser-memory/.secret`
  (only when kernel persistence enabled), never logged, excluded from artifact sweeps.
- **`atomicWriteText` relocation** to `src/utils/fsAtomic.ts` (tools/memory re-imports).
- **Debug-term de-texting check:** assert the existing `PI_BROWSER_RELEVANCE_DEBUG` artifact path
  emits source tags only — a checked invariant, not a convention.

Gates: `tests/unit/tools/memoryAutoSurface.noRepair.test.ts` (corrupt index ⇒ no write, empty
result, single diagnostic); `tests/unit/distill-core/relevanceTaps.kindSplit.test.ts` (live scoring
unchanged; query tokens typed `urlQueryToken`); adversarial privacy fixture v0 (term-type level);
`check:task-conditioned-salience`, `check:tools` green.

### M1 — memory-core kernel (pure logic)

Files: `src/memory-core/{types.ts, profile.ts, recall.ts, staleness.ts, index.ts}` plus relocation of
`src/tools/memory/routing.ts` and `salience.ts` into the kernel (re-export shims at the old paths).
IDF weighting (D8) lands inside the relocated `routeByTokens`.

- `profile.ts`: `distillFrameIntoProfile(profile, frameView, traceView)` — merge one ledger frame
  view into an origin profile; `PersistableMemoryTerm`-typed term accounting; canonical-URL
  normalization; LRU/caps; pure **merge function for D9** (`mergeProfiles(disk, pending)`);
  deterministic.
- `recall.ts`: route strategic index entries by origin + IDF token overlap; rank with
  verification/recency tie-breakers; returns scored cards for the augmentation plan.
- `staleness.ts`: anchor-tier verification (`fresh | unverified | stale`); strike transition
  function (pure).
- `types.ts`: `MemoryOriginProfile`, `MemoryFrameView`, `MemoryTraceView`, `MemoryRecallQuery`,
  `MemoryVerification`, `MemoryAnchors`, `MemoryAugmentationPlan` — structural, no kernel imports.

Gates: `tests/contracts/drift/check-memory-core-boundary.mjs` (bans imports from
abml-core/distill-core/driver/tools/node-fs) as `npm run check:memory-core-boundary` in
`check:all:contracts`; unit tests `tests/unit/memory-core/{profile,recall,staleness}.test.ts`
(IDF beats raw overlap on a common-token fixture; strike transitions; one-off terms never become
candidates; merge is commutative on disjoint deltas and max-takes on overlapping counters).

### M2 — runtime persistence (`src/memory/`)

Files: `src/memory/{profileStore.ts, profileService.ts, hashStamp.ts, secret.ts}`.

- `profileStore.ts`: read/write `.pi/browser-memory/profiles/<origin-slug>-<fnv64>.json`, atomic,
  capped; corrupt or oversized ⇒ treated as absent + ONE low-noise diagnostic (a `details`-level
  warning on the next observe, never an envelope field, never repeated); never throws into the
  observe path; **read-only on automatic paths (P6)** — no file is created while
  `PI_BROWSER_MEMORY=0` or before the first real frame persists.
- `profileService.ts`: in-process cache; per-(cwd,origin) promise-chain mutex; debounced flush (on
  navigationEpoch change and ≥N frame records) that **re-reads disk and merges via kernel
  `mergeProfiles` before the atomic write (D9)**; strike transitions flow through the same path;
  `drainFlushes()` awaited by `BrowserBridgeServer` shutdown before ledger clear; fire-and-forget
  try/catch — **persistence failure must never fail an observe**.
- `hashStamp.ts`: HMAC-SHA256 truncated 128-bit over stamp strings, keyed by `secret.ts`.

Gates: `tests/unit/memory/profileStore.test.ts` (atomicity, caps, corrupt/oversized recovery with
low-noise diagnostic, slug-collision distinctness, no-materialization when disabled/empty) +
`tests/unit/memory/profileService.concurrency.test.ts` (concurrent observe + verification strike ⇒
both deltas survive; flush race vs second service instance ⇒ merge keeps max counters; drain on
shutdown) + **adversarial privacy fixture** (D2, full: planted PII never in profile files; stamps
not dictionary-invertible without `.secret`); `check:tools` stays green.

### M3a — trace warm-start (relevance source F)

Files: `src/distill-core/relevance.ts` (add `"F"`, `sourceBase` arm), `relevanceTuning.ts`
(`memoryMatch` knob + `maxMemoryTerms ≤ 8`), `src/tools/observeRunners.ts` (splice inside
`buildObserveRelevance` `:169`: load profile via profileService cache once per session+origin;
recurrence filter `sessionCount ≥ 2`; agreement gate against live URL/trace tokens;
`containsSensitiveEvidence` defense-in-depth; **append AFTER all live terms** with age offset +
halved weight, capped at `maxMemoryTerms`).

Gates: `npm run check:task-conditioned-salience` (update source-set enumeration if pinned);
`tests/unit/distill-core/relevance.test.ts` extension: (1) **cap isolation — live A/C/D/E term sets
and per-source scores byte-equal with and without F injection, including at a full 32-term live
ring**; (2) agreement gate — disjoint live situation ⇒ zero injected terms ⇒ byte-identical
envelope; (3) ring isolation — after an observe with F injection, the trace ring contents and next
persisted termStats are byte-identical to a run without injection; (4) debug artifact carries
source tags only.

### M3b — memory verification (structural anchors + strikes)

Files: `src/tools/memory/{types.ts, frontmatter.ts, store.ts}` (optional internal `anchors` field,
derived at record time from origin profile / recent ledger frame when a live server exists),
`src/tools/observeRunners.ts` (verification runs inside augmentation-plan construction, only when
recall produced candidate cards; verdicts via kernel `staleness.ts`), `src/memory/profileService.ts`
(strike transitions through the D9 merge path).

Gates: `tests/unit/tools/memoryVerification.test.ts` (anchor tiers: match ⇒ fresh, drift ⇒ stale,
absent ⇒ unverified — never body-regex; stale body suppressed at 3 strikes; fresh resets; strikes
survive a concurrent flush); `npm run check:session-delta-long-conversation` unchanged (P1: this
track must NOT touch stableRefs/granularity paths — the gate proves it).

### M3c — envelope.memory plane via MemoryAugmentationPlan (+ autoSurface recall-hint removal)

Files: `src/tools/observeRunners.ts` (build `MemoryAugmentationPlan` once per scan/text observe:
recall + verification + conversation-once state + inline/handle variants; pass as a precomputed
option), `src/tools/resultMiddleware.ts` (attach the plan and run the displacement ladder —
`livePlaneSignature()` lives HERE as a pure helper over the fitted envelope; `responseEnvelope()`
itself gains no I/O and no async), conversation-key resolution helper (ctx conversation id →
process-instance id → none), `src/tools/memory/autoSurface.ts` (delete recall-hint side; keep record
nudge behind both switches). **`src/distill-core/` is untouched by this track.**

Displacement ladder (runtime = contract test, same function): fit without memory ⇒ S0; attach
inline ⇒ S1, accept iff S1 = S0; else handle-only ⇒ S2, accept iff S2 = S0; else omit plane.
Signature covers entities/gist/outline/relations/diff/causal/treeDiff/snapshotProjection +
`rendererOmitted` + envelope-level omissions + warnings.

Gates: `npm run check:summaries`, `check:summary-boundary`, `check:token-economy`; new
`tests/contracts/runtime/check-memory-plane.mjs`: (1) disabled or empty store ⇒ whole envelope
byte-identical AND no `.pi/browser-memory/` materialization; (2) **livePlaneSignature equality holds
on every accepted variant** (fixture with tight budget forces the handle and omit rungs);
(3) second observe same conversation+origin ⇒ collapsed handle line; no stable conversation key ⇒
never collapses; (4) non-observe tools never carry the plane; (5) distill-core source unchanged
(boundary check stays green with zero memory imports).

### M4 — docs/contract/skill sync

`docs:generate` refresh (`browser_memory` description gains "recall is automatic — matched memory
appears in envelope.memory with a verification status; record remains explicit"), README, CHANGELOG,
`skills/pi-browser-tools/SKILL.md` (+ `quick_validate.py`), `npm run docs:sync-indexes`.

Gates: `npm run check:tool-docs`, `check:all:package`, full `npm run check`.

### M5 — acceptance (paired blind eval + negative controls, D6)

Procedure: `pi-browser-blind-eval` skill, mainland-reachable real site (linux.do or bilibili),
READ-ONLY; blind child agents launched via the operating harness's own child-agent mechanism per the
skill's harness-agnostic "Launching the blind agent" contract. Runs: Pair 1 (T1 cold/warm), Pair 2
(T2 memory-off/warm), negative controls (wrong-origin profile, stale anchors, common-token flood).
The blind report template (`blind-agent-prompt.md`) gains the structured adoption block
(`memoryPlaneSeen / inlineBodyUsed / readThroughUsed / recordNudgeShown / recordCalled /
usedInFinalAnswer`), self-reported and operator-verified against the transcript. Removal clauses
per D6, pre-committed.

## 5. Execution order and budget

M0 → M1 → M2 → M3a → M3b → M3c → M4 → M5. Each track lands gate-green before the next; M3a/M3b/M3c
are independently revertible behind the master switch but on separate code paths.

Cost budget: warm-start = one cached profile read per origin per session + a set intersection at
relevance assembly; frame-record = debounced merge+write; verification = HMAC comparisons only when
cards exist; envelope.memory = plan built once per observe, displacement ladder costs at most two
extra fit passes and only on routed hits; full body at most once per conversation+origin. Net new
envelope bytes on no-hit pages: **zero, contractually**.

## 6. Failure-mode ledger (designed-in)

1. **Task-bias pollution**: recurrence filter + agreement gate (M3a); harm bound = Pair 2
   within-task control; wrong-origin negative control.
2. **Conversation-continuity violation**: P1; verification-only cross-session reads; session-delta
   gate proves non-regression; conversation-once never keys on `browserSessionId`.
3. **Read-side feeding write-side** (P5): F terms ephemeral at relevance assembly; ring isolation
   unit-tested.
4. **Memory displacing live perception**: `livePlaneSignature()` ladder, same function in runtime
   and contract test (v4 — mechanically provable, not prose).
5. **F displacing live relevance terms** (v4): append-last + `maxMemoryTerms` sub-cap; byte-equal
   live scoring unit test including the full-ring case.
6. **Staleness**: structural-anchor verification; `unverified` honest default; `stale` annotated,
   never silently injected (P2); stale-anchor negative control.
7. **Self-reinforcing garbage**: strikes auto-deprecate failing anchors; stale cards drop to
   handle+re-record (D7).
8. **Accumulated-state loss under concurrency** (v4): D9 serialized read-merge-write; concurrency
   unit tests; shutdown drain. Residual cross-process window documented and self-healing.
9. **Kernel auto-path writes** (v4, P6): no-repair reads everywhere on the automatic path; the
   pre-existing index repair-write defect fixed in M0.
10. **Economy bypass**: plane competes inside the existing fitter; no-hit ⇒ byte-identical.
11. **Unbounded growth**: per-origin/LRU/byte caps machine-enforced; slug+fnv64 filenames.
12. **Privacy**: `PersistableMemoryTerm` whitelist type (free-text unrepresentable); canonical
    path-only URLs; local-secret HMAC stamps; sensitive filter as defense in depth; adversarial
    fixture gate; local-only under `.pi/`.
13. **Unread injection**: M5 removal clauses pre-committed; adoption measured by the six-field
    schema, not field presence.
14. **Observe-path safety**: persistence/recall/verification fire-and-forget; corrupt/oversized
    profiles degrade to absent with one low-noise diagnostic; memory failure never fails perception.
15. **Double-recall waste**: plan built once in the runner; over-budget rebuild reuses it by
    construction.

## 7. Out of scope (closed, with reopen bar)

- Semantic/embedding recall — reopen only with eval transcripts showing token-overlap misses.
- Cross-project/global memory promotion, multi-agent sharing — unchanged v1 store posture.
- Auto-crystallizing strategic SOPs (P4).
- New collection in mechanical profiles (login-wall flags, settle timings, execution outcomes) —
  reopen after M5; journal facts (`executionJournal.ts`) are the natural v2 profile ingestion,
  giving SOPs outcome-grounded evidence. Explicit synergy, deliberately staged.
- Hashed-query URL keying — reopen only if path-level canonical URLs prove too coarse in M5.
- Cross-process profile lock file — reopen only if M5 or production shows real delta loss beyond
  the documented residual window (D9).
- Cross-session treeDiff/snapshotProjection baselines — P1 violation class; permanently out unless a
  mechanism only ADDS (M3b's "structure unchanged since memory recorded" covers the useful case).

## 8. Coordination with the completed execution feedback layer

`docs/archive/execution-feedback-layer-plan.full.md` is complete: `executionJournal.ts` /
`executionEffect.ts` landed; its touched set included `registerExecuteTool.ts`,
`registerCommandTool.ts`, `observeRunners.ts`, and result-middleware-facing behavior. No active
track remains to wait on; memory-kernel implementation rebases against the archived final state
before editing `observeRunners.ts` or `resultMiddleware.ts`. Deeper synergy (fresh-verified anchors
raising `pi.resolve` confidence; journal facts as v2 profile input) is staged behind this plan's
acceptance, a dependency of neither plan.

## 9. Activation block for CURRENT.md

```markdown
## Active: memory kernel (retain)
- Decision: promote memory to the fourth kernel (sense→perceive→express→retain); read path becomes
  a perception source (ephemeral cap-isolated relevance F at buildObserveRelevance + structural-
  anchor verification + runner-built MemoryAugmentationPlan with livePlaneSignature displacement
  ladder and conversation-once economy); write path splits on the Brain-Hand line (mechanical
  auto-persist via serialized read-merge-write, strategic explicit); negative-feedback strikes close
  the loop. M0 hardening first (incl. fixing the live index repair-write defect).
- Boundary: new src/memory-core (pure, CI-locked) + src/memory (runtime); distill-core stays
  memory-agnostic; .pi/browser-memory/profiles/ (canonical path URLs, PersistableMemoryTerm
  whitelist, local-secret HMAC stamps, slug+fnv64 filenames); PI_BROWSER_MEMORY=0 disables kernel
  auto paths only (explicit browser_memory tool unaffected; AUTOSURFACE switch stays as nudge
  alias); no public tool surface change; P1 add/verify-only; P5 F never enters ring or live cap;
  P6 auto paths never write.
- Contract: no-hit/disabled ⇒ byte-identical envelopes AND no .pi/browser-memory materialization;
  livePlaneSignature equality on every accepted plane variant (inline→handle→omit ladder);
  verification status on every injected card; strikes/sessionCounts survive concurrency (merge,
  drain); persistence failure never fails observe; no page content on disk (HMAC stamps,
  adversarial privacy fixture).
- Verification: check:memory-core-boundary + per-track unit suites (cap isolation, ring isolation,
  concurrency, no-repair, privacy fixture); check:task-conditioned-salience,
  check:session-delta-long-conversation, check:summaries, check:token-economy, bench:distill,
  check-memory-plane contract; acceptance = paired blind eval (T1 cold/warm, T2 off/warm) +
  negative controls + six-field adoption schema with pre-committed removal clauses.
- Coordination: execution-feedback complete; rebase against its archived state before editing
  observeRunners.ts or resultMiddleware.ts (plan §8).
- Plan: docs/archive/memory-kernel-plan.full.md
```
