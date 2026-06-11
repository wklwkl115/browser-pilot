# Memory Kernel Plan — retain as the fourth kernel

Status: Draft v3 (2026-06-11). Not yet activated in `CURRENT.md`.
v3 = owner architect review accepted 7/7: memory plane budget subordination hardened, M3a injection
point corrected to ephemeral relevance assembly (the v2 design would have polluted the trace ring
AND self-reinforced sessionCounts), session-once retied to a real conversation key, M3b anchors made
structural, profile privacy schema hardened, kill-switch semantics defined against the existing
autosurface switch, coordination recomputed against the now-ACTIVE execution feedback plan.
v2 = adversarial self-review of v1: task-bias pollution and conversation-continuity defects fixed,
M3b repurposed to verification, IDF routing and negative-feedback strikes added, three-arm eval.

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
  perception the current conversation has not earned.** Corollary (v3): any "show once, then
  collapse" economy must be keyed to a REAL conversation identity, never to `browserSessionId`
  (which a long-lived daemon reuses across conversations).
- **P2 — Memory is a hypothesis, not a fact.** Everything recalled across sessions is potentially
  stale. Injection must carry verification status (`fresh | unverified | stale`) computed against
  live anchors, and verification failures must feed back into the store (strikes → deprecation).
  Never assert remembered state as current state.
- **P3 — Boost-never-gate is necessary but NOT sufficient.** Under a fixed budget, boosting wrong
  things demotes right things (allocation is zero-sum). So warm-start signals must additionally be
  (a) recurrence-filtered (site vocabulary, not last task's vocabulary) and (b) agreement-gated
  (activate only when live signals overlap). And the memory PLANE itself is budget-subordinate:
  it must never displace live page perception (D3-M3c rule). "No profile ⇒ byte-identical" is the
  floor; "wrong profile ⇒ no measurable harm" is the bar, eval-checked (M5 arm 3).
- **P4 — Brain-Hand split of the write path.** Mechanical memory (stamps, vocabulary, verification
  outcomes) is deterministic and auto-persisted. Strategic memory (SOPs, judgments) stays explicit
  agent authorship. The kernel never auto-crystallizes judgment.
- **P5 — Read-side injection must not feed the write side.** Warm-start terms are ephemeral
  per-observe inputs assembled at relevance time; they never enter the trace ring, never get
  re-persisted, never inflate recurrence counts. (The v2 design via `recordTraceTerms` violated
  this — injected terms would have been counted as live terms on the next persist, self-reinforcing
  the site vocabulary regardless of whether it was still relevant.)

## 2. Closed decisions

- **D1 — independent fourth kernel.** New pure-logic kernel `src/memory-core/` (profile distillation,
  recall scoring, staleness verification) + runtime layer `src/memory/` (fs persistence, in-process
  cache), CI-boundary-locked like the other three. Not merged into distill-core: lifetime management
  is a distinct concern from expression. Kernel takes structural-typed inputs only (K4 precedent) —
  zero imports from abml-core/distill-core runtime or Node fs.
- **D2 — v1 mechanical profile = existing ledger data only, hashed, privacy-hardened.** Per origin:
  `{ schemaVersion, origin, sessions: ≤8 recent session digests,
  termStats: {term → {sessionCount, lastSeenAt, weight}} (≤48, STRUCTURAL KINDS ONLY),
  urls: LRU≤8 of { canonicalUrl, factStamps(ref→HASH), fingerprintSummary, capturedAt },
  strikes: {entryId → count} }`. No new collection. Hardening (v3):
  - **Canonical URLs only**: `origin + path`, query string and fragment stripped (query/fragment are
    the PII carriers — search terms, user ids, tokens). If path-level keying ever proves too coarse,
    a hashed query may be added later; never raw.
  - **termStats persist structural vocabulary only**: terms whose tap kind is selector-shaped
    literal, ref, or url-path token. Free-text kinds (`query`, `intent`, scalar prose) are NEVER
    persisted — they are the kinds that carry user task text, names, and personal queries that
    `containsSensitiveEvidence` cannot reliably catch (e.g. Chinese personal names). The sensitive
    filter still runs on top as defense in depth.
  - **Stamps are one-way hashes** (FNV-64, same constants family as refId): `versionStamp`/
    `stableStamp` (`src/abml/perceptionLedger.ts:70-91`) embed entity `value` (page content) and must
    never reach disk raw. Equality comparison is all the read path needs.
  - **Adversarial privacy fixture** (gate, M2): fixture session with emails / Chinese names / search
    queries / tokens in params and page content ⇒ assert none of those strings appear anywhere in
    written profile files.
  - Caps: ≤64 KB/origin file, ≤64 origins LRU global, atomic writes. Profiles are reconstructible
    caches: last-writer-wins atomic replace, no lock file (unlike the strategic store). Profile
    filename = `<origin-slug>-<fnv64(origin)>.json` — slug is human-readable, the hash suffix kills
    slug-truncation collisions (`safeSlug` caps at 80 chars).
- **D3 — read path = three injection points, shipped in this order:**
  - **M3a trace warm-start (relevance source F): ephemeral, recurrence-filtered, agreement-gated.**
    Injection point is `buildObserveRelevance()` (`src/tools/observeRunners.ts:169`): warm-start
    terms are spliced into the `terms` array passed to `computeRelevanceMap` with `source: "F"`,
    age offset, and halved weight — **never** via `server.recordTraceTerms` (v2 defect: the ring
    tags everything `source: "A"` on read-back at `observeRunners.ts:116`, so F would be lost; ring
    entries get re-persisted, so injected terms would self-reinforce sessionCounts, violating P5;
    and injected terms would consume the 32-term live cap). Filters compose:
    (1) recurrence — only `sessionCount ≥ 2` terms are candidates (site vocabulary, not task
    residue); (2) agreement — candidates activate only when the live situation (current URL terms +
    live trace) shares ≥1 token. New `RelevanceSourceTag "F"` (`src/distill-core/relevance.ts:4`) +
    one capped tuning knob (`memoryMatch ≤ directMatch`). Debug artifacts carry source tags only,
    never term text (existing `PI_BROWSER_RELEVANCE_DEBUG` redaction discipline). No profile / no
    agreement ⇒ byte-identical envelope.
  - **M3b memory verification, structural anchors (REPURPOSED from v1, hardened in v3).** Persisted
    stamps verify strategic memory against the live page — they never warm-start
    stableRefs/granularity (P1). v3 anchor model: regex-mining SOP bodies for selectors/refs is
    fragile and `pi-ref://` handles are short-lived, so verification runs on **structural anchors
    derived at record time**: a new optional internal frontmatter field `anchors` on `MemoryEntry`
    (additive, schemaVersion stays 1) holding `{ canonicalUrl?, fingerprintSummary?, stampSetId? }`
    captured automatically from the origin profile / recent ledger frame when `record` executes with
    a live server. Verification tiers: anchors present and matching ⇒ `fresh`; anchors present and
    drifted ⇒ `stale`; no anchors (old entries, serverless record) ⇒ `unverified` — never guessed
    from body text. `fresh` raises confidence and is annotated on the card; the agent still
    re-resolves any refs/selectors live before acting — no "directly actionable" claim.
  - **M3c envelope.memory plane: budget-subordinate, observe-family only, conversation-once.**
    Strategic entries routed by origin + IDF-weighted token overlap (D8) against the live trace,
    injected as a bounded plane. Scope: only `browser_observe` scan/text results. Hard budget rule
    (v3, replaces "yields under squeeze"): **memory may NEVER displace live page perception** —
    card body inlines only when doing so causes zero additional demotion/omission of live planes
    (entities/gist/outline/relations/diff/causal: `rendererOmitted` and plane granularities must be
    identical to the without-memory render); otherwise the plane carries handle-lines only
    (id + title + verification + `browser_memory read` pointer). ≤2 cards. Conversation-once
    economy: FULL card only the first time per conversation+origin, collapsing to a handle line
    after — keyed by a real conversation identity with this resolution chain: explicit conversation
    id from tool ctx if the host exposes one → process-instance id (correct for Pi-native, the
    primary frontend, where one process ≈ one conversation) → **no stable key (shared long-lived
    daemon) ⇒ no collapse, ever** (P1 corollary; repeated full cards are the lesser evil and the
    budget rule already bounds them). Recall result is memoized per tool call (the over-budget path
    rebuilds the envelope — `resultMiddleware.ts:512,515,546,549` — and must not re-run recall).
    AutoSurface recall hints are deleted in the same change.
- **D4 — write path split on the Brain-Hand line.** Mechanical memory auto-persists at the existing
  frame-record sites (zero agent involvement); strategic memory stays explicit `browser_memory record`.
  The autoSurface **record nudge stays** (sole strategic write-loop ignition) but its adoption is
  measured in M5 with a removal clause.
- **D5 — kill-switch semantics (v3, defined against the existing switch).** `PI_BROWSER_MEMORY=0`
  disables the KERNEL's automatic read/write paths only: profile persistence, F injection,
  verification, the envelope.memory plane, and the record nudge. The explicit `browser_memory` tool
  (record/recall/read/validate) stays fully functional — it is agent-initiated, not kernel behavior.
  Existing `PI_BROWSER_MEMORY_AUTOSURFACE=0` remains as a compatible alias scoped to the nudge
  (master=0 implies it). Default ON. The plane is renderer-agnostic (ships under both salience and
  ladder fitting, like diff/causal). Disabled or empty store additionally must NOT materialize
  `.pi/browser-memory/` (profiles or index) — non-users keep a clean tree.
- **D6 — acceptance = three-arm blind eval with harm metrics.** Same real site via
  `pi-browser-blind-eval`, READ-ONLY:
  - Arm 1 cold: fresh `.pi/browser-memory/`, task T1 — baseline.
  - Arm 2 warm-same-task: state kept, task T1 again — strategic memory payoff (SOP reuse).
  - Arm 3 warm-different-task: state kept, task T2 same site — mechanical memory payoff AND the
    harm bound: arm 3 must be ≥ arm 1 on calls/tokens/success. Worse-than-cold ⇒ task-bias
    pollution ⇒ M3a filters failed.
  Metrics: tool calls, total tokens, success, friction triage, transcript-verified actual reading of
  envelope.memory (presence ≠ adoption). Removal clauses pre-committed: plane unread ⇒ delete M3c;
  no warm-start benefit ⇒ revert M3a; harm bound violated ⇒ revert M3a and tighten or abandon;
  record-nudge adoption zero across all arms ⇒ delete the nudge.
- **D7 — negative-feedback strikes.** M3b `stale` verdict increments `strikes[entryId]` in the origin
  profile; at 3 strikes a mechanical anchor set is dropped (re-learned on next visit) and a strategic
  card stops carrying its body — it is injected as a handle line with an explicit
  `stale — re-record to supersede` annotation (the fix path is the existing supersede flow).
  `fresh` resets strikes. Memory that keeps failing verification loses standing automatically —
  mirror of the allocation feedback loop in distill.
- **D8 — IDF-weighted routing (~5 lines).** `routeByTokens` counts raw overlap; common tokens
  ("login", "page") match everything. The routing index already contains document frequency
  (posting-list length): weight tokens by `log(1 + N/df)`. Deterministic, zero new state. Lands with
  the routing.ts relocation in M1. Recall ranking adds verification status then recency
  (`updatedAt`) as tie-breakers — `confidence`/`verifiedAt` exist today but never affect ranking.

## 3. Current substrate facts (verified 2026-06-11)

- `PerceptionLedger` singleton on the server: `src/driver/BrowserBridgeServer.ts:38,62`; accessors
  `:310-327`. Frame-record sites with `ctx.cwd` in scope: `src/tools/observeRunners.ts:640,922`.
- Trace read-back uniformly tags `source: "A"` with positional age: `observeRunners.ts:116`;
  relevance assembly point: `buildObserveRelevance` `observeRunners.ts:169` (M3a splice site),
  callers `:786,833`. Caps: 8 frames/session×tab, 32 trace terms/session (`perceptionLedger.ts:55-56`).
- `granularityCeilingFromLedger` (`observeRunners.ts:436-441`) is a budget-pressure signal; per-ref
  compaction flows through `options.stableRefs` → `allocateFacts` (`resultMiddleware.ts:408`). Both
  session-scoped by P1.
- Relevance sources A–E: `src/distill-core/relevance.ts:4`; per-source base `:65-70`; tap table
  `src/tools/relevanceTaps.ts:9` (kind taxonomy for D2's structural-only persistence rule).
- Envelope assembly + plane fitting: `src/tools/resultMiddleware.ts:437-497`, `fitSalienceEnvelopeBudget`
  at `:420`; autoSurface attach (double-call on over-budget rebuild): `:512,515,546,549`.
- `src/tools/memory/routing.ts` + `salience.ts` are pure zero-dep logic — RELOCATE into memory-core.
  `scoreCard` (`store.ts:101-127`) ignores confidence/verifiedAt (D8 gap). `safeSlug` truncates at 80
  (`paths.ts:19-27`) — collision risk fixed by D2 hash suffix.
- Storage root `.pi/browser-memory` (`paths.ts:5`); `atomicWriteText` is generic fs logic there.
- **Execution feedback plan is ACTIVE** (`CURRENT.md:16`): `src/tools/executionJournal.ts`,
  `executionEffect.ts` exist; its touched set includes `registerExecuteTool.ts`,
  `registerCommandTool.ts`, **`observeRunners.ts`**, and `resultMiddleware.ts` is pending for its
  later tracks — see §8.
- Boundary-check models: `tests/contracts/drift/check-{distill,abml}-core-boundary.mjs`
  (`package.json:110-111`). Byte-identity test model: `check-task-conditioned-salience.mjs`.

## 4. Tracks

### M1 — memory-core kernel (pure logic)

Files: `src/memory-core/{types.ts, profile.ts, recall.ts, staleness.ts, index.ts}` plus relocation of
`src/tools/memory/routing.ts` and `salience.ts` into the kernel (re-export shims at the old paths).
IDF weighting (D8) lands inside the relocated `routeByTokens`.

- `profile.ts`: `distillFrameIntoProfile(profile, frameView, traceView)` — merge one ledger frame view
  into an origin profile; structural-kind term filter + sessionCount accounting; canonical-URL
  normalization; LRU/caps; strikes bookkeeping; deterministic.
- `recall.ts`: route strategic index entries by origin + IDF token overlap; rank with
  verification/recency tie-breakers; returns scored cards for the plane.
- `staleness.ts`: anchor-tier verification (`fresh | unverified | stale`) from canonicalUrl /
  fingerprint tolerance / stamp-set equality; strike transition function (pure).
- `types.ts`: `MemoryOriginProfile`, `MemoryFrameView`, `MemoryTraceView`, `MemoryRecallQuery`,
  `MemoryVerification`, `MemoryAnchors` — structural, no kernel imports.

Gates: `tests/contracts/drift/check-memory-core-boundary.mjs` (bans imports from
abml-core/distill-core/driver/tools/node-fs) as `npm run check:memory-core-boundary` in
`check:all:contracts`; unit tests `tests/unit/memory-core/{profile,recall,staleness}.test.ts`
(IDF beats raw overlap on a common-token fixture; strike transitions; one-off terms never become
candidates; free-text kinds never persisted).

### M2 — runtime persistence (`src/memory/`)

Files: `src/memory/{profileStore.ts, profileService.ts, hashStamp.ts}`; move `atomicWriteText` to
`src/utils/fsAtomic.ts` (tools/memory re-imports).

- `profileStore.ts`: read/write `.pi/browser-memory/profiles/<origin-slug>-<fnv64>.json`, atomic,
  last-writer-wins, capped; corrupt or oversized file ⇒ treated as absent + ONE low-noise diagnostic
  (a `details`-level warning on the next observe, never an envelope field, never repeated per call);
  never throws into the observe path. No file is ever created while `PI_BROWSER_MEMORY=0` or before
  the first real frame persists.
- `profileService.ts`: in-process cache + debounced flush (on navigationEpoch change and ≥N frame
  records; never per-frame fsync); called from `observeRunners.ts:640,922` with `ctx.cwd`;
  fire-and-forget try/catch — **persistence failure must never fail an observe**.
- `hashStamp.ts`: FNV-64 over stamp strings.

Gates: `tests/unit/memory/profileStore.test.ts` (atomicity, caps, corrupt/oversized recovery with
low-noise diagnostic, slug-collision distinctness, no-materialization when disabled/empty) +
**adversarial privacy fixture** (D2): planted emails / Chinese names / queries / tokens never appear
in profile files; `check:tools` stays green.

### M3a — trace warm-start (relevance source F)

Files: `src/distill-core/relevance.ts` (add `"F"`, `sourceBase` arm), `relevanceTuning.ts`
(`memoryMatch` knob), `src/tools/observeRunners.ts` (splice point inside `buildObserveRelevance`
`:169`: load profile once per session+origin via profileService cache; recurrence filter
`sessionCount ≥ 2`; agreement gate against live URL/trace tokens; `containsSensitiveEvidence`
defense-in-depth; append as ephemeral `source:"F"` terms with age offset + halved weight).

Gates: `npm run check:task-conditioned-salience` (update source-set enumeration if pinned);
`tests/unit/distill-core/relevance.test.ts` extension (F boosts, never gates; empty profile ⇒
identical scores); new unit tests: (1) agreement gate — disjoint live situation ⇒ zero injected
terms ⇒ byte-identical envelope; (2) **ring isolation — after an observe with F injection, the
trace ring contents and next persisted termStats are byte-identical to a run without injection**;
(3) debug artifact carries source tags only, no term text.

### M3b — memory verification (structural anchors + strikes)

Files: `src/tools/memory/{types.ts, frontmatter.ts, store.ts}` (optional internal `anchors` field,
derived at record time from origin profile / recent ledger frame when a live server exists),
`src/tools/observeRunners.ts` / `resultMiddleware.ts` (verification runs only when M3c has candidate
cards; verdicts via kernel `staleness.ts`), `src/memory/profileService.ts` (strike transitions, D7).

Gates: `tests/unit/tools/memoryVerification.test.ts` (anchor tiers: match ⇒ fresh, drift ⇒ stale,
absent ⇒ unverified — never body-regex; stale body suppressed at 3 strikes; fresh resets);
`npm run check:session-delta-long-conversation` unchanged (P1: this track must NOT touch
stableRefs/granularity paths — the gate proves it).

### M3c — envelope.memory plane (+ autoSurface recall-hint removal)

Files: `src/tools/resultMiddleware.ts` (new `memory?: Record<string, unknown>` envelope field,
observe-family only, populated via kernel `recall.ts` inside `responseEnvelope`, memoized per call),
`src/distill-core/salienceEnvelope.ts` (budget subordination: compute live-plane fit WITHOUT memory
first; inline card body only if adding it changes no live plane's granularity/omission; else
handle-lines), conversation-key resolution helper (ctx conversation id → process-instance id → none),
`src/abml/perceptionLedger.ts` or the helper's own map (cards shown per conversation+origin),
`src/tools/memory/autoSurface.ts` (delete recall-hint side; keep record nudge behind both switches).

Gates: `npm run check:summaries`, `check:summary-boundary`, `check:token-economy`; new
`tests/contracts/runtime/check-memory-plane.mjs`: (1) disabled or empty store ⇒ whole envelope
byte-identical AND no `.pi/browser-memory/` materialization; (2) **memory hit must not increase any
live plane's `rendererOmitted`/granularity demotion vs the without-memory render unless the plane is
handle-only**; (3) second observe same conversation+origin ⇒ collapsed handle line; no stable
conversation key ⇒ never collapses; (4) non-observe tools never carry the plane.

### M4 — docs/contract/skill sync

`docs:generate` refresh (`browser_memory` description gains "recall is automatic — matched memory
appears in envelope.memory with a verification status; record remains explicit"), README, CHANGELOG,
`skills/pi-browser-tools/SKILL.md` (+ `quick_validate.py`), `npm run docs:sync-indexes`.

Gates: `npm run check:tool-docs`, `check:all:package`, full `npm run check`.

### M5 — acceptance (three-arm blind eval, D6)

Procedure: `pi-browser-blind-eval` skill, mainland-reachable real site (linux.do or bilibili),
READ-ONLY; arms cold / warm-same-task / warm-different-task per D6. Blind child agents are launched
via the operating harness's own child-agent mechanism per the skill's harness-agnostic "Launching
the blind agent" contract (isolation properties, not a specific subagent type — Claude Code / Codex /
Pi / fresh-process all valid). Transcript inspection is the adoption test, not field presence.
Removal clauses per D6, pre-committed.

## 5. Execution order and budget

M1 → M2 → M3a → M3b → M3c → M4 → M5. Each track lands gate-green before the next; M3a/M3b/M3c are
independently revertible behind the master switch but on separate code paths.

Cost budget: warm-start = one cached profile read per origin per session + a set intersection at
relevance assembly; frame-record = debounced JSON write; verification = hash comparisons only when
cards exist; envelope.memory = budget-subordinate tokens only on routed hits, full body at most once
per conversation+origin. Net new envelope bytes on no-hit pages: **zero, contractually**.

## 6. Failure-mode ledger (designed-in)

1. **Task-bias pollution**: recurrence filter + agreement gate (M3a), harm bound in eval arm 3.
2. **Conversation-continuity violation**: P1; M3b repurposed to verify-only; session-delta gate
   proves non-regression; conversation-once never keys on `browserSessionId` (v3).
3. **Read-side feeding write-side** (v3, P5): F terms are ephemeral at relevance assembly; ring
   isolation is unit-tested — injection leaves ring and next persist byte-identical.
4. **Memory displacing live perception** (v3): budget subordination rule + contract test — body
   inlines only at zero live-plane cost, else handles.
5. **Staleness**: structural-anchor verification before assertion; `unverified` is the honest
   default for anchor-less entries; `stale` annotated, never silently injected (P2).
6. **Self-reinforcing garbage**: strikes auto-deprecate failing anchors; stale cards drop to
   handle+re-record annotation (D7).
7. **Economy bypass**: plane competes inside the allocator; no-hit ⇒ byte-identical (contract).
8. **Unbounded growth**: per-origin/LRU/byte caps machine-enforced; slug+hash filenames kill
   collision aliasing (v3).
9. **Privacy**: canonical path-only URLs; structural-kind-only termStats; hashed stamps; sensitive
   filter as defense in depth; adversarial fixture gate (v3); local-only under `.pi/`.
10. **Unread injection**: M5 removal clauses pre-committed.
11. **Observe-path safety**: persistence/recall/verification fire-and-forget; corrupt/oversized
    profiles degrade to absent with one low-noise diagnostic (v3); memory failure never fails
    perception.
12. **Double-recall waste**: over-budget envelope rebuild memoizes recall (M3c).

## 7. Out of scope (closed, with reopen bar)

- Semantic/embedding recall — reopen only with eval transcripts showing token-overlap misses.
- Cross-project/global memory promotion, multi-agent sharing — unchanged v1 store posture.
- Auto-crystallizing strategic SOPs (P4).
- New collection in mechanical profiles (login-wall flags, settle timings, execution outcomes) —
  reopen after M5 AND after the execution journal stabilizes: journal facts (selector resolved,
  settle duration, effect deltas) are the natural v2 profile ingestion, giving SOPs outcome-grounded
  evidence. Explicit synergy, deliberately staged.
- Hashed-query URL keying — reopen only if path-level canonical URLs prove too coarse in M5.
- Cross-session treeDiff/snapshotProjection baselines — P1 violation class; permanently out unless a
  mechanism only ADDS (M3b's "structure unchanged since memory recorded" already covers the useful case).

## 8. Coordination with the ACTIVE execution feedback plan (recomputed v3)

`docs/execution-feedback-layer-plan.md` is ACTIVE in `CURRENT.md` and has already landed
`executionJournal.ts` / `executionEffect.ts`; its touched set includes `registerExecuteTool.ts`,
`registerCommandTool.ts`, **`observeRunners.ts`**, and later tracks will touch `resultMiddleware.ts`.
Overlap with this plan is therefore TWO hot files: `observeRunners.ts` (their effect wiring vs our
M3a splice + M2 service calls — different functions, same file) and `resultMiddleware.ts` (their
journal/effect surfacing vs our memory plane — independent envelope fields). Rule: **this plan does
not activate while an execution-feedback track that edits either file is in flight**; activation
slots in after their current track lands, and each side rebases mechanically. Deeper synergy
(fresh-verified anchors raising `pi.resolve` confidence; journal facts as v2 profile input) is
staged behind both plans' acceptance, a dependency of neither.

## 9. Activation block for CURRENT.md

```markdown
## Active: memory kernel (retain)
- Decision: promote memory to the fourth kernel (sense→perceive→express→retain); read path becomes
  a perception source (ephemeral agreement-gated relevance F at buildObserveRelevance + structural-
  anchor verification + budget-subordinate envelope.memory with conversation-once economy); write
  path splits on the Brain-Hand line (mechanical auto-persist, strategic explicit); negative-feedback
  strikes close the loop.
- Boundary: new src/memory-core (pure, CI-locked) + src/memory (runtime); .pi/browser-memory/profiles/
  (canonical path URLs, structural-kind terms, hashed stamps, slug+fnv64 filenames);
  PI_BROWSER_MEMORY=0 disables kernel auto paths only (explicit browser_memory tool unaffected;
  AUTOSURFACE switch stays as nudge alias); no public tool surface change; P1: cross-session memory
  only adds/verifies, never compacts a conversation's first view; P5: F injection never enters the
  trace ring.
- Contract: no-hit/disabled ⇒ byte-identical envelopes AND no .pi/browser-memory materialization;
  memory body never displaces live planes (handle-only otherwise); verification status on every
  injected card; persistence failure never fails observe; no page content on disk (hashed stamps,
  adversarial privacy fixture).
- Verification: check:memory-core-boundary + per-track unit suites (incl. ring isolation + privacy
  fixture); check:task-conditioned-salience, check:session-delta-long-conversation, check:summaries,
  check:token-economy, bench:distill, check-memory-plane contract; acceptance = three-arm blind eval
  (cold / warm-same / warm-different) with harm bound and pre-committed removal clauses.
- Coordination: does not activate while an execution-feedback track editing observeRunners.ts or
  resultMiddleware.ts is in flight (plan §8).
- Plan: docs/memory-kernel-plan.md
```
