# Living Tab Session — Identity, Standing Perception & the Free Interaction Loop

> Status: COMPLETE v6 — 2026-06-13. v1 established the three-plane diagnosis;
> v2 added the conceptual model (objective store / subjective views /
> versioned timeline), topology, failure/privacy/memory/observability
> dimensions; v3 adds the **performance plane**: an end-to-end latency budget
> model and algorithmic engineering of every hot path (round-trip economics,
> single-pass sensing, O(N)→O(1) AX, demand-driven plane computation,
> speculative refresh). v4 is the implementation-readiness audit against the
> real-session log
> `D:/Pi/agent/sessions/2026-06-12T11-53-03-330Z_019ebbad-b261-7ec9-88ba-880c2df6f275.jsonl`
> and the current source tree: it separates extension-connect friction from
> observe latency, corrects stale code facts (conditional execute wait, AX
> geometry already batched), and turns the risky handle / progressive-scan /
> demand-driven-plane ideas into explicit contracts. v5 tightens the remaining
> implementation traps: target handles require a shared resolver rather than
> hidden `tabId` polymorphism, the non-blocking interaction invariant is scoped
> to default low-level actions, and the stale 200ms execute-fix language is
> removed. v6 records the active 2026-06-13 full-closure workstream: S0 is
> shipped, S1/S2/S3 are executed as additive substrate/feedback changes plus
> measured experiment closures, and non-adopted speculative paths are closed
> with evidence instead of remaining plan placeholders.
> Relationship to `docs/abml-perception-state-evolution-plan.md`
> (fold/projection disclosure): this plan builds the freshness + identity +
> speed substrate that disclosure model assumes; zero mechanism overlap; that
> plan stays un-activated.
>
> Full closure note — 2026-06-13: S0-S3 are closed under `CURRENT.md`
> "Living tab session architecture full closure" activation. The shipped path
> preserves the public tool surface and additive compatibility; default
> low-level actions still do not block on perception.

## 0. v4 audit corrections — defects in the v3 draft

These are not wording issues; each would cause a wrong implementation if left
as written.

- **The real-session log proves two separate friction classes.** The first
  browser call (`browser_tabs create`) and the later `browser_tabs list` both
  spent ~5s and failed with `NO_BROWSER_EXTENSION`; the agent then switched to
  curl for the simple forum read. That evidence supports a connection-grace /
  recovery-path issue and a route-choice issue, not an observe scan timing
  sample. The observe/scan critique remains valid from source shape and later
  review, but it must be measured separately.
- **Stable handles cannot simply "ride" today's string `tabId`.** The public
  schema permits `number | string`, but `toTabId` only accepts numeric strings;
  `sendCommand`, `requireExecutionTarget`, `switchTab`, and `closeTab` all
  normalize through that path. Handle support is a material normalization and
  validation contract change even if it uses the existing field name.
- **`${browserId}:${tabId}` is not a stable public handle.** It embeds the
  physical tab id, so replacement churn changes the key. A public handle needs
  its own generated logical id plus generation/epoch metadata; router session
  ids may remain internal implementation keys.
- **"Migrate everything keyed by old id" is too broad.** Node-side selection,
  leases, queues, and perception frames can be re-keyed. SW/CDP/hook/network
  state tied to a physical renderer or debugger attachment may need honest
  loss, reinstall, or fresh cursors; deleting old SW state before recording the
  replacement would destroy migration evidence.
- **The execute 200ms claim is stale.** Current `exec.ts` waits only when no
  tab was created and `mayOpenNewTab(data.code)` is true. S0 may measure and
  tune that residual wait, but must not implement a fix for a removed
  unconditional sleep.
- **The AX "N sequential round trips" claim is stale.** Current
  `axRuntime.ts` issues per-node `DOM.getBoxModel` through `Promise.all` and
  caches raw geometry. The real target is still N CDP calls, but the
  improvement is "N concurrent/batched calls -> O(1) bulk snapshot join", not
  serial -> parallel.
- **Dirty-region incremental scan is not just wiring.** The content script
  currently records `changeSeq`, `visibleCount`, and `interactiveCount`; it
  does not retain mutation root selectors, ancestor widening, or overflow
  markers. The dirty stream is a new bridge/content-script protocol.
- **Viewport-first cannot finish the full walk "inside the same page-world
  call" after returning the first envelope.** A fast first envelope and a later
  full substrate update require a Node-owned background command or a durable
  page-side worker plus explicit drain; the request still returns one envelope.
- **Demand-driven planes cannot skip producers.** Entity construction, ref
  registration, ledger facts, and artifact mirrors are load-bearing even when
  their model-facing presentation is omitted. Only presentation/projection
  planes may be lazily rendered after a producer/dependency graph says they are
  not required.
- **`tabId` must not become the primary name for non-tab-id concepts.** The
  compatibility path may accept a logical handle where old schemas already
  allow `tabId: string`, but docs, summaries, diagnostics, and CLI examples
  must call the new thing a target reference / `tabHandle`. Otherwise the plan
  fixes stale ids by creating a hidden polymorphic field that violates the
  semantic-singularity rule.
- **"No interaction waits for perception" is not globally true today.**
  Default `browser_execute` does not scan, but `monitor:true` and ABML semantic
  verbs deliberately read structure before/after actions for correctness. The
  invariant is: low-level action transport never blocks on standing perception;
  optional semantic verification may read perception only when explicitly
  requested or when the semantic verb contract says so.

## 1. The three reports are one product defect

| Reported symptom | Surface reading | Actual architectural cause |
|---|---|---|
| "DOM scan can't be bypassed; complex pages make you wait before interacting" | scan is slow | **Perception is pull-only and monolithic.** Every observe re-derives the entire world synchronously (page walk → AX → ABML → distill) at ask-time, even though the browser side already *knows* what changed continuously (`content.ts` MutationObserver maintains `changeSeq` + a page fingerprint) — that knowledge is only used as a 2s wall-clock cache key (`renderCache`, H2), never to bound the work. |
| "Active tabId is unstable across navigation; extra list/switch steps" | ids churn | **Identity is physical, not logical.** Agents address Chrome's numeric `tabId`. Chrome *replaces* tabs on prerender/instant activation (`tabs.onReplaced` — the only event carrying the old→new mapping) and the extension does not subscribe (`bridge_src/service_worker/tab_sync.ts:71-78` registers only `onUpdated/onRemoved/onCreated`), so the mapping is lost forever, SW per-tab state (CDP attachments, hook/network recorders) orphans, and Node selection/leases die with the old id. The project then **institutionalized the symptom**: the skill and `src/driver/errors.ts:28-31` teach "a tabId is not stable" instead of making it stable. |
| "No intuitive abstraction; must pass tabId each call; waits on connection/scan/JSON" | missing ergonomics | **Trust in the implicit plane is broken by the two causes above plus connection readiness cost.** Implicit targeting exists and works (`BrowserTabSessionRouter.fallbackExecutionTarget`, live-verified 2026-06-02) — but it goes stale because manual tab switches emit no subscribed event (`tabs.onActivated` also absent), and explicit ids betray the agent at every replacement. Separately, cold/no extension state adds bounded grace waits before `NO_BROWSER_EXTENSION`. Agents respond rationally: re-list constantly, pin ids defensively, and abandon the browser path for simple static reads. |

One sentence: **the runtime mostly treats each call as a fresh round-trip
against a physical transport address; stable identity, standing page knowledge,
and connection-readiness state exist in fragments, but are not wired into one
agent-trustworthy loop.**

### 1.1 Connection readiness is a separate S0 contract

The field log's first hard failure is `NO_BROWSER_EXTENSION`, not an observe
timeout. S0 therefore owns a small readiness contract alongside tab identity:
normal tool calls may keep a bounded grace wait, but failures must expose
`extensionConnected`, `everConnected`, effective wait budget, negative-cache
state, and concrete recovery actions. The browser extension must not hide this
behind automatic HTTP fallback; route fallback for simple static reads belongs
in skills/evals where the agent can see the tradeoff and preserve evidence.
Stage metrics count this separately from observe latency (`connectionWaitMs`
vs `scanMs`), so later performance work cannot claim success by improving the
wrong bottleneck.

The fragments (all shipped, all isolated from each other): internal session ids
(`${browserId}:${tabId}`, useful but not stable public handles); change
knowledge (`content.ts` MutationObserver `{childList,subtree,attributes,
characterData}` → `changeSeq` + fingerprint tuple, but no dirty roots yet); a
standing perception store (`PerceptionLedger`: frames per session×tab LRU ≤8,
render cache with `paramsSignature`, trace ring ≤32); event-stream cursors
(R3.x P2-C `streamState.lastSeq` drain channel); post-action sensing
(execution-effect facts); ref staleness machinery (`REF_STALE` /
`HANDLE_ETAG_MISMATCH` in the error taxonomy); selection versioning
(`selectionVersionAtDispatch/AtResolve` stamped on every target); extension
connect grace + negative cache. S0 is mostly wiring; S1/S2 include new
protocol/mechanics and must be treated as implementation work, not doc-only
renaming.

## 2. Conceptual model — a per-tab MVCC store with per-session views

```
PHYSICAL TAB (one per real page-view)              BROWSER SESSION (one per agent context)
┌─ Objective substrate ────────────────┐           ┌─ Subjective view ───────────────────┐
│ identity record                      │           │ selection (default/latest)          │
│   handle, physical id history,       │  many-to- │ leases / write queues (txn layer)   │
│   lineage (opener), generation       │◄──────────│ relevance trace, shown-set,         │
│ versioned perception timeline        │   many    │   intent conditioning               │
│   v(n): entity model + fingerprint   │           │ salience/render views over          │
│   dirty-region set since v(n)        │           │   the objective timeline            │
│ event streams (network/page/dirty)   │           │ memory-plane augmentation           │
└──────────────────────────────────────┘           └─────────────────────────────────────┘
```

- **Objective substrate is per physical tab and session-agnostic**: what the
  page *is* and *what changed* are facts, computed once no matter how many
  agent sessions watch the tab (today `PerceptionLedger` keys by session×tab
  — N watchers pay N× and can disagree).
- **Subjective views are per browserSession**: relevance, trace, shown-set
  novelty, memory augmentation, intent — already session-scoped today; they
  become *views over the objective timeline*, never copies.
- **Time is first-class**: the substrate is a bounded version chain
  `v(n) = entity model + fingerprint`, advanced by scans, bounded by the
  existing LRU. Everything that today takes "a baseline" (`baseline`,
  `baselineSnapshotId`, session-delta P-frames, causal windows, treeDiff)
  becomes a **view over a version range** — one mechanism instead of four
  baseline plumbing paths. Refs mint with their observed version; `REF_STALE`
  becomes a comparison, not a guess.
- **Transactions already exist** (leases + per-(session,tab) write queues +
  `selectionVersion`); the model names them and adds read-your-writes
  feedback (§5).
- **Recovery is honest-loss** (§7): the substrate is process-ephemeral by
  design; restart ⇒ clean re-perception with `historyLost`-style markers,
  never fabricated continuity.

### Invariants (contract-tested, each with a kill switch)

- **I1 — Identity continuity.** A logical tab identity refers to the same
  page-view for its entire life; physical churn is absorbed; an identity is
  closed, never silently retargeted; cross-browser numeric ambiguity never
  auto-resolves (`AMBIGUOUS_TAB_ID` stands).
- **I2 — Honest views.** Output served from standing state is byte-equivalent
  to a fresh full scan, or carries an explicit marker (`coverage`, `delta`,
  `fromCache`, `historyLost`) — never silent partiality.
- **I3 — Free interaction loop.** Default low-level action transport never
  blocks on standing perception machinery; perception feeds feedback after the
  action. Explicit `monitor:true` / semantic ABML verbs may read structure only
  because their contracts make verification part of the requested operation.
- **I4 — Bounded residency.** All standing state is capped (ledger LRU ≤8,
  trace ≤32, dirty-set ≤32 roots, replacement map ≤64, version chain ≤ ledger
  depth); eviction degrades to today's pull behavior.
- **I5 — Additive compatibility.** No breaking public tool/schema/envelope
  change; new outputs are additive; new target-reference inputs go through one
  shared resolver; compatibility aliases are accepted but not presented as the
  canonical mental model. Kill switches restore today's behavior
  byte-identically.
- **I6 — Objective/subjective separation.** The substrate never stores
  session-relative data; views never mutate the substrate.
- **I7 — Honest loss.** No standing state survives a daemon/SW restart as if
  continuous; durable evidence lives only in artifacts.
- **I8 — Privacy residency.** Standing state widens *retention time*, not
  *exposure surface*: model-facing redaction applies at view-render time
  exactly as now; raw content beyond entity models stays in the artifact tier.
- **I9 — Same envelope, less work.** Every pure-performance change is
  golden-locked: identical inputs produce byte-identical envelopes (modulo
  run-incidental fields). Progressive modes that add explicit markers such as
  `coverage:"viewport"` are not pure-performance work; they are additive
  contract changes and need their own marker-diff goldens.

---

## 3. Pillar 1 — Identity plane

### 3.1 Mechanism floor: subscribe to the missing lifecycle events

```ts
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  recordTabReplacement(removedTabId, addedTabId);     // ring buffer ≤20, TTL ~5min
  safeSendTabsUpdate('tabs.onReplaced');
  cleanupPiBrowserTab(removedTabId, 'tab_replaced');  // after replacement evidence is queued
});
chrome.tabs.onActivated.addListener((activeInfo) => {
  recordTabActivation(activeInfo.tabId, activeInfo.windowId);
  safeSendTabsUpdate('tabs.onActivated');
});
```

`sendTabsUpdate` ships `replaced: [{from,to,at}]` (idempotent; `tabs_update`
is a WS event payload — not `bridge/native_command_schema.json`, but still a
public bridge event contract that needs fake-ws/protocol drift coverage).
`onActivated` must include enough last-activation metadata to pick the active
tab in the active window; `chrome.tabs.query({})` can return multiple
`active:true` tabs across windows, so "first active" is not a stable implicit
target rule.

### 3.2 Driver: absorb replacement, migrate only retargetable state

At the single consumption chokepoint
(`BrowserBridgeClientMessageService.handleClientMessage:77-80`; deps already
include `leases`): `BrowserTabSessionRouter.applyTabReplacements(pairs, ws)`
(bounded map, old session closed, every browser session's
`defaultSessionId`/`latestSessionId` re-pointed, migrations returned) →
`BrowserLeaseRegistry.migrateTabLeaseForReplacement(...)` (re-key preserving
owner/`explicit`/`createdAt`; `assertWriteInvariants` still re-checks in the
queued closure) → retargetable substrate state re-keys with the same migration.

Non-retargetable state must degrade honestly:

- SW/CDP debugger attachments are physical-tab scoped; replacement closes or
  invalidates them and any reinstall path must return a new epoch.
- hook/network recorders may reattach, but their cursors carry
  `historyLost:true` if events during replacement cannot be proven continuous.
- perception frames can migrate only if the replacement is same page-view and
  the new tab confirms the same URL/fingerprint; otherwise the logical handle
  survives but the perception epoch resets.

### 3.3 Public identity: stable handles behind one target resolver

`browser_tabs list` and every result `target` additionally report a stable
logical handle (`tabHandle`) as an opaque generation-suffixed token. It is not
`${browserId}:${tabId}` because that embeds the physical id. The canonical
implementation unit is a shared `resolveTargetRef` step used before any current
`toTabId` call site. Current `toTabId` accepts only positive integers and
numeric strings, so handle support is not a string-format tweak; it is a
normalization contract. Therefore:

- numbers and numeric strings keep their current meaning;
- handle strings use an unmistakable prefix (for example
  `tabh_<browser>_<logical>_g<generation>`);
- `sharedTabScopedToolParams`, CLI parsing, `sendCommand`,
  `requireExecutionTarget`, `switchTab`, `closeTab`, error diagnostics, and
  generated docs/contracts all acknowledge that a string may now be a handle,
  not only a numeric id;
- generated summaries and examples call the stable value `tabHandle` /
  `targetRef`, not "tabId", so the public mental model remains "physical id
  or stable target reference" instead of "tabId sometimes means a handle".

No new workflow/orchestration tool is required. If a new typed `targetRef`
parameter proves necessary for generated schemas or CLI clarity, it must be a
thin alias into the same resolver and must not fork resolution semantics from
`tabId` compatibility. Either way this is a material contract change and must
run `check:param-surface`, `check:input-surface`, tool-doc sync, and fake-ws
handle round-trip tests.

### 3.4 Auto-follow for numeric ids + honest diagnostics

At the two explicit-target chokepoints — **before payload construction**
(`sendCommand:149-153` bakes the tabId into the dispatched command) and
`requireExecutionTarget:219-227` — `resolveTargetRef` resolves numeric ids,
numeric-id replacement chains, and logical handles to a live physical id
(≤3 replacement hops; ambiguity = no follow) and stamps
`target.replacedFrom` / `target.handle`.
`tabNotFoundError` gains `replacedByTabId`. `switchTab`/`closeTab` resolve
identically.

### 3.5 Tab topology: lineage as identity metadata

Real flows span tabs (`target=_blank`, `window.open`, OAuth popups). The
extension already detects spawned tabs per-execute (`exec.ts:187-188`), then
forgets. Additively ship `openerTabId` (standard `chrome.tabs.Tab` field) in
`tabs_update` records (`tab_sync.ts:30`); the router records lineage;
`browser_tabs list` exposes it. "Which tab did my action create" becomes
mechanically answerable. No grouping semantics, no auto-switching.

### 3.6 Stop teaching the symptom

Skill Loop step 1, `errors.ts:28-31` docstring, README tab bullets flip to
the new truth: identity survives same-tab navigation and in-place
replacement; a new id appears only for a genuinely new tab (visible with
lineage); omit `tabId` to follow the active tab, which now tracks manual
switches.

**Verification.** Unit: migration (selection/lease/cursor re-key), chain
follow + hop bound + ambiguity refusal, map prune, handle round-trip, lineage
recording. Fixture (fake-ws lifecycle pattern): `tabs_update` with `replaced`
→ old numeric id executes with `target.replacedFrom`; lease survives; handle
survives two consecutive replacements; child tab carries opener. Live smoke:
prerender-heavy real site, cached id survives.

---

## 4. Pillar 2 — Perception plane: standing, incremental, progressive, shared

Design rule: scan cost is proportional to **what changed** (steady state) or
**what is visible** (first contact) — never to page size on every call.

### 4.0 Instrument before optimizing (gate for everything below)

Additive phase timings in observe `diagnostics`: `transportMs` (bridge
round-trip count × cost), `pageScriptMs`, `axMs` (+ CDP call count),
`abmlMs`, `renderMs`, `serializeMs`, `nodeCount`, `axNodeCount`. Numbers for
≥2 heavy real pages recorded in §Results decide ordering of §6 items.

### 4.1 Progressive first contact: viewport-first scan

On first observe of a heavy page (mechanical trigger: node count over a
measured threshold — visible, overridable), the scan walks **viewport-first**
(above-the-fold subtree + AX scoped to viewport-visible interactives) → the
envelope returns fast with explicit `coverage:"viewport"`; the full walk
is scheduled after the response by Node (or by a durable page-side worker with
an explicit drain command) and lands in the substrate when complete. It cannot
"continue inside the same page-world call" after the first envelope is already
returned. One user call still yields one envelope; the background refresh is
observable only through the next observe/snapshot diagnostics. Honesty per I2;
`fresh:true`/`maxNodes` remain overrides; the "no auto mode" contract
untouched.

### 4.2 Steady state: DOM-dirty stream + incremental rescan + versioned timeline

Extend the content-script observer from *counting* mutations to *locating*
them. Current code only exposes `changeSeq`, `visibleCount`, and
`interactiveCount`, so this is a new content-script/bridge protocol:
aggregate mutation roots into a bounded **dirty-region set** (container
selector granularity, cap ~32 roots; overflow ⇒ whole-page dirty — fail-open),
with ancestor widening for list/sibling/order-affecting mutations, drained
through the same cursor pattern as the R3.x causal stream. Observe gains three
tiers:

| Substrate state | Today | Target |
|---|---|---|
| fingerprint unchanged, dirty set empty | full rescan unless within 2s TTL | serve view from substrate — validity **event-bounded**; wall-clock TTL kept only as fallback |
| dirty set small | full rescan | rescan **dirty roots only**, merge into the standing entity model → advance the version chain; diff/treeDiff/session-delta read version ranges (the dirty set bounds the diff machinery's *input*) |
| overflow / navigation / `fresh:true` | full rescan | full rescan (unchanged), new epoch |

**Timeline unification:** `baseline`/`baselineSnapshotId`/session-delta/
causal windows become version-range views — four baseline plumbing paths
collapse into one addressing scheme. **Shared substrate:** N sessions
observing one tab share one scan, one dirty stream, one chain (today N×).
Stale-boundary honesty inherits H2's documented limits;
`PI_BROWSER_SESSION_DELTA=0` and new `PI_BROWSER_STANDING_PERCEPTION=0`
restore pull-only behavior byte-identically.

The strong `incremental == full` golden is scoped: if a mutation can affect
global selectors, sibling order, relation containers, table/list grouping, AX
join keys, or top-layer detection outside the dirty root, the dirty set widens
to the nearest safe ancestor or whole page. The equality test is entity-model
parity after that widening, not a promise that any local patch can always be
merged in isolation.

### 4.3 Memory-kernel warm start (bounded, opt-in)

A site profile may carry **perception hints** (known-heavy ⇒ viewport-first
on first contact; known SPA shell containers ⇒ dirty-set seed selectors) —
tuning *mechanical* defaults only, never content or ranking; byte-identity
when no profile exists; same negative-control gates as the memory plane
(`check:memory-plane`).

### 4.4 What this is NOT

Not the fold/projection disclosure model (it will consume this substrate);
not a public push surface (request/response with cursor drains stays the only
tool shape — P2-C's conclusion); not speculation *about content* — the
substrate only ever contains what a real scan produced.

**Verification.** 4.0 timings + corpus table; 4.1 blind-corpus A/B
(first-envelope latency down, success not regressed, `coverage` honesty,
byte-identity below threshold); 4.2 the strong golden — scripted mutation
series in the existing vm scan harness: incremental-merged model ≡
full-rescan model entity-for-entity; version-range views reproduce today's
baseline outputs on fixtures; token-economy bench non-regression; residency
caps asserted.

---

## 5. Pillar 3 — Interaction plane: the loop pays nothing

- **Default low-level actions never block on standing perception** (tested
  invariant I3): a contract test asserts the default `browser_execute` /
  low-level transport path does not await standing perception machinery.
  Explicit `monitor:true`, ABML semantic verbs, and verification helpers keep
  their current contract-visible structure reads.
- **Post-action effect rides the dirty channel**: effect facts upgrade from
  fingerprint deltas (`signals:"partial"` fallback) to real bounded deltas —
  "what did my action change" answered without an observe scan on the hot
  path. If dirty roots overflow, the action result carries `signals:"partial"`
  / `coverage:"overflow"` and the next verification observe degrades to a full
  scan.
- **Stale-act feedback (read-your-writes honesty)**: an action targeting a
  `pi-ref://` minted at v(n) whose region went dirty after v(n) gets additive
  effect facts `targetObservedAt`/`targetRegionDirty:true` — the agent learns
  it acted on a stale picture *from the result*. Feedback only; never gates
  (I3); aligns with existing `REF_STALE`/actionability semantics.
- **`browser_wait` conditions subscribe instead of polling** where
  expressible over the dirty/fingerprint stream (selector appearance in a
  dirty root; quiescence = empty dirty window); CDP/poll paths remain for the
  rest. Event-driven resolution also removes the average half-poll-interval
  latency from every wait.

**Verification.** Effect-upgrade units against scripted mutations; stale-act
fixture; wait-subscription fixture (resolve on event, zero poll ticks); I3
contract red-first.

---

## 6. The performance plane — latency budget & algorithmic engineering

"Fast" is a budgeted equation, not a feeling. For one agent step:

```
T_step = T_transport (RTTs × hops)            ── bridge WS + SW + page/CDP round trips
       + T_page      (DOM traversals × cost)  ── page-world sensing
       + T_cdp       (CDP calls × RTT)        ── AX / box models / input
       + T_node      (kernel pipeline CPU)    ── ABML → distill → render
       + T_serialize (stableJson passes)      ── budget fitting + envelope
       + T_agent     (envelope tokens ÷ LLM throughput)   ← usually the LARGEST term
```

**The last term is the insight the rest of the industry misses**: a 10KB
envelope costs the agent ~2.5k tokens of read time — often more wall-clock
than the entire server side. Token economy (salience renderer, session-delta,
fold/projection later) IS latency engineering; the planes below attack the
server terms without ever growing T_agent (I9 guards that).

Budget targets (validated/adjusted by 4.0 numbers, then §Results-pinned):
warm observe (event-clean substrate) **< 50ms** server-side; heavy-page first
observe **< 800ms** to envelope (viewport coverage); `browser_execute`
overhead beyond the user script's own eval time **< 50ms**; wait resolution
latency = event latency, not poll interval.

### 6.1 Round-trip economics (T_transport, T_cdp)

- **Fuse the side-channel reads into the scan call.** Today an observe makes
  a separate pre-scan page-fingerprint command (`readPageFingerprint`) for
  cache eligibility, then later reads network/hook high-water marks in
  `Promise.all`. The scan script return value gains a `signals` block carrying
  the fingerprint sampled in the same page-world execution; recorder status
  stays separate unless the corresponding recorder already exposes a safe
  same-call read. This reduces round trips without inventing a fake causal
  guarantee for network/hook state that lives outside the scan script.
- **Parallel fan-out for what cannot fuse.** The AX/CDP pass and the
  page-world scan eval are independent read channels (debugger vs scripting);
  measure whether they are currently serialized through ABML readStructure and
  parallelize only the confirmed serialized legs. Remaining recorder queries
  that are already `Promise.all` are not work items.
- **Measure/tune the residual execute new-tab wait.** The old unconditional
  200ms sleep is gone; current `exec.ts` waits only when `newTabIds.size === 0`
  and `mayOpenNewTab(data.code)` is true. S0 records this as an execute
  overhead metric and only changes it if measured false positives still cost
  real agent loops.
- **ACK piggybacking**: the SW's `ack` and fast results are separate WS
  messages today; when a result is ready within the ack window, send only the
  result. Saves one message per fast command (micro; do last).

### 6.2 Single-pass sensing (T_page)

Source-verified: the scan template traverses the DOM **at least six times**
— `collectActionables` (walk), `collectControlsPairs`
(`querySelectorAll('[aria-controls],[aria-owns]')`), `collectListHints`,
`collectCanvasRegions`, `collectMediaCandidates`, `collectVisibleRows`
(`[root].concat(querySelectorAll('*'))`, its own 3,000-node budget), then the
text `walk()`. Each pass re-pays traversal, `isIgnored`/`isHidden`
(style/rect reads), and dedup bookkeeping.

- **Fused visitor traversal**: one TreeWalker pass feeds all collectors as
  visitor callbacks sharing a per-node context (tag, cls, rect, visibility,
  ignored — computed once). Expected: ~6× traversal → 1×, and one shared
  visibility/rect computation per node instead of up to six.
- **Predicate ordering**: cheapest-first per node (tag/ignore-set checks
  before class regex before `getBoundingClientRect`), so most nodes exit on
  byte-cheap tests. Read-only scan keeps layout clean — rect reads stay
  amortized after the first forced layout.
- **Lazy selector materialization**: `selectorFor` runs only for nodes that
  *survive* a collector's caps/filters, not during candidacy testing (the B3
  sibling cache made each call cheaper; this makes most calls not happen).
- **Behavior lock**: the existing vm scan harness
  (`check-page-scripts.mjs` executes scan behaviorally) gains a fused-vs-
  legacy golden on a synthetic page: identical output objects (I9). The
  capture-core escape-regression tally (migration trigger at 2) applies — if
  the fusion fights the template-string form, that is the contracted esbuild
  migration trigger speaking, not a reason to skip the optimization.

### 6.3 AX channel: O(N) round trips → O(1) (T_cdp)

`axRuntime.ts:222-298`: `Accessibility.getFullAXTree` then **per-interesting
node `DOM.getBoxModel`**. Current code already issues those geometry reads
through `Promise.all` and caches raw geometry, so the remaining issue is N CDP
commands on exactly the pages where N is large.

- **Primary: one-shot snapshot join.** A single `DOMSnapshot.captureSnapshot`
  returns layout bounds for every node keyed by `backendNodeId` in one CDP
  call; join AX nodes (which already carry `backendDOMNodeId`) against it.
  N concurrent/batched commands → 2 total (`getFullAXTree` + `captureSnapshot`), both
  C++-side bulk operations.
- **Fallback: scope + batch.** Where the snapshot join is unavailable,
  restrict `getBoxModel` to viewport-visible interactive entities (4.1's
  scoping) and preserve the existing concurrent batch/cache behavior.
- **Lock**: `mergeAxIntoDomEntities` output golden on fixtures — same merged
  entities from either channel (I9). Adoption requires a measured win; a full
  DOMSnapshot can be slower on small pages and has iframe/shadow/coordinate
  edge cases.

### 6.4 Demand-driven plane computation (T_node)

Today the Node pipeline can compute presentation planes that the salience
allocator later omits. Do not invert the whole pipeline blindly. First split
planes into:

- **producers**: entity construction, ref registration, ledger facts, artifact
  mirrors, causal high-water marks, baseline/version bookkeeping. These always
  run when their downstream contracts require them, even if model-facing output
  omits them.
- **presenters/projections**: gist, outline, relation summaries, treeDiff
  views, snapshotProjection views, identity graph views. These may register
  **cost estimators** (from substrate stats: entity count, dirty size, relation
  candidates); the allocator can trigger only the presenters that won the
  budget.

Omitted presenters are marked exactly as today (`rendererOmitted`). The G3
compute-once ledger polices call-site counts. Guard:
estimate-vs-actual drift recorded in diagnostics; mis-estimates may waste
compute by falling back to today's compute-then-drop, but must never
under-deliver a producer dependency (I2).

### 6.5 Serialization economics (T_serialize)

The salience path already replaced ladder's repeated whole-envelope
`stableJson` probes with incremental accounting + single final confirm
(perception-renderer plan); two residuals: (a) per-candidate `stableJson`
cost pricing in `fitSalienceEnvelopeBudget` (`salienceEnvelope.ts:95-138`)
re-serializes values whose costs the substrate can cache on the version chain
(an entity's rendered cost is stable until its region dirties — cache it on
the entity, invalidate by dirty region); (b) the G3 serialization canary
extends to assert the *count* of whole-envelope serializations per observe
stays 1. Artifact writes move after-response only if the response carries no
`saved.path` reference (else order is load-bearing — keep write-then-respond).

### 6.6 Speculative incremental refresh (warm-path prefetch, eval-gated)

The act→observe sequence is THE loop. After a write-path action, if the dirty
stream shows activity, run the **incremental** rescan (4.2, dirty-roots-only)
in the background with debounce (~150ms quiet window, ≤1 in flight, never on
ambient/no-action mutation churn) so the expected follow-up observe is served
hot from the substrate. Speculation about *timing*, never about *content*
(4.4); bounded by I4; off by default until the S3 A/B shows hit-rate × saved
latency > wasted-work cost on the blind corpus; kill switch shared with
`PI_BROWSER_STANDING_PERCEPTION`.

### 6.7 Channel experiment: snapshot-based sensing (measured alternative)

`DOMSnapshot.captureSnapshot` can return the node table, attributes, input
values, computed-style whitelist, layout bounds and text in **one CDP call**
— potentially replacing the page-world walk entirely for the structural
plane (the actionable-heuristics layer would re-run over the snapshot rows in
Node, where it is unit-testable). This is a *sense-channel* A/B, not a
commitment: run both channels on the 4.0 corpus, compare entity recall,
latency, and iframe/shadow coverage. Adopt only if it dominates; the JS-walk
channel remains for same-origin iframe content and as fallback either way.
(If adopted, it lands under the capture-core esbuild migration trigger
machinery — a 6th entry intentionally fails the gate until the migration
contract is honored.)

**Performance-plane verification.** Every item: before/after numbers on the
4.0 corpus recorded in §Results + an I9 golden (byte-identical envelope) or
an explicitly declared marker diff; complexity table (passes × nodes, CDP
calls, serializations per observe) pinned in §Results; the G3 ledger and
token-economy bench run as standing regressions.

---

## 7. Failure & recovery contract (honest loss)

| Layer dies | What is lost | Recovery behavior |
|---|---|---|
| MV3 service worker idles/restarts | SW dirty buffers, replacement ring | `ext_ready` re-handshake (existing `recordRuntimeRecovery`); streams marked `historyLost:true` (hook/intercept recovery pattern); next observe = fresh full scan, new epoch — never a fabricated delta |
| Content script reloads (navigation) | dirty set for that document | new navigation epoch (existing frame-key semantics); expected and explicit |
| Bridge/daemon restarts | entire substrate (process memory) | handles die with their generation (no fake continuity, I7); artifacts remain the durable tier; first calls behave exactly like today's cold start |
| Extension reconnects mid-flight | pending requests | existing `rejectForClient` + lease disconnect cleanup unchanged |

Degradation is always **to today's behavior** — no new failure mode worse
than the status quo; every discontinuity marked, never papered over.

## 8. Observability & the metrics that prove it

- `browser_tabs snapshot` additively exposes per-tab living-session stats:
  substrate version, coverage, dirty-set size, stream cursors, handle,
  lineage — the operator and the audit loop *see* the standing state.
- **Architecture-level success metrics**, extracted from blind-eval
  transcripts, measured before S0 and after each stage:
  - **defensive-ritual rate** (`browser_tabs list` calls not preceded by a
    tab-changing action, per task);
  - **first-envelope latency** + the 6.x complexity table on the heavy corpus;
  - **redundant re-observe rate** (observes ≥90% delta-empty vs previous);
  - **stale-id incident rate** (TAB_NOT_FOUND per task);
  - **tokens per completed task** (token-economy bench corpus);
  - **execute overhead** (tool time minus script eval time, including the
    bounded new-tab observation window when it actually triggers).
- Reported in each stage's §Results; S1/S2/S3 live or die by them.

## 9. Cross-layer beneficiaries

WebSecurity (scoped engagements stop silently re-targeting after prerender
swaps mid-recon); CLI (one tool core inherits everything; handles print in
`pi-browser tabs`; restart semantics honest per I7); fold/projection future
(its hardest prerequisite — stored model + freshness authority — becomes a
given); CTF protocol layer (long multi-tab engagements are where replacement
churn, re-list rituals, and observe latency cost the most; benefits arrive
through existing contracts).

## 10. Staging & activation map

| Stage | Content | Risk | Gate to ship |
|---|---|---|---|
| **S0** | Pillar 1 complete (events, migration, handles, auto-follow, lineage, prose) + §1.1 connection-readiness diagnostics + 4.0/6.x instrumentation + metrics baseline + measured execute-overhead audit for the residual new-tab observation window (6.1, change only if numbers justify it) | None to perception model | unit+fixture suite, `check:all:bridge`, full check, live prerender smoke, baseline metrics + complexity table recorded |
| **S1** | Latency floor: 6.1 round-trip fusion + parallel fan-out, 6.2 single-pass sensing, 6.3 AX O(1), 4.1 viewport-first | I9 goldens carry the risk | 4.0 numbers justify each item; fused-vs-legacy goldens; AX-merge golden; blind-corpus A/B; byte-identity below threshold |
| **S2** | 4.2 dirty stream + incremental merge + versioned timeline + store split + 6.4 demand-driven planes + 6.5 serialization economics | Merge correctness; estimator honesty | incremental≡full golden; baseline-views parity; G3 canary count=1; bench non-regression; kill-switch byte-identity |
| **S3** | Pillar 3 riders (effect upgrade, stale-act, wait subscription) + 4.3 memory warm-start + 6.6 speculative refresh A/B + 6.7 channel experiment | Low / experiment-bounded | effect/stale-act/wait fixtures; I3 contract; speculation hit-rate A/B; channel A/B report |

Each stage = one workstream = one `CURRENT.md` activation entry (with C5
`Scope:` line) = full-gate closure. S0 is the only activation-ready first
candidate because it addresses the log-proven connection-readiness and identity
friction, then adds the measurements needed before observe/perception rewrites.
S1/S2/S3 are candidate follow-up workstreams, not executable plan items, until
S0's measured §Results are copied into their own activation entries.

## 11. Rejected alternatives (closed decisions)

- **New orchestration abstraction** — stays closed; trust is restored by stable
  identity, explicit resolver diagnostics, and existing tools, not a workflow
  wrapper. A shared target-reference resolver is required, but it is a
  normalization primitive, not a strategy-shaped public tool.
- **Hint-only fix for stale ids** — rejected; that *is* the current state
  (institutionalized 2026-06-02) and the friction recurred.
- **Public push/subscription tool surface** — rejected; R3.x P2-C concluded
  request/response with cursor drains is the right agent-tool shape.
- **Cross-browser auto-follow on ambiguous numeric ids** — rejected;
  mis-targeting class.
- **Persisting living state across restarts** — rejected (I7): resurrected
  runtime state is fabricated continuity and a staleness factory.
- **Full MVCC / unbounded version history** — rejected (I4): versioning is an
  addressing scheme, not a database; older versions degrade to artifact
  snapshots.
- **Gating writes on staleness** — rejected (I3): stale-act is feedback,
  never a block.
- **Optimizing before instrumentation numbers** — rejected;
  change-for-change risk (the last perf pass won because it was audit-driven).
  The former 200ms execute wait is already removed; only the residual 50ms
  new-tab observation window may be tuned, and only with S0 measurements.
- **Two-response streaming observe** — rejected; breaks one-call-one-envelope.
- **worker_threads parallelism for the Node pipeline** — rejected: the
  pipeline's inputs/outputs are shared-state-heavy (ledger, refs), the
  serialization cost of crossing threads rivals the compute, and 6.4's
  demand-driven elision removes the work instead of relocating it. Process
  concurrency stays at the DAG/tool-call level.
- **Ambient speculative scanning** (prefetch on every mutation, no agent
  action) — rejected: unbounded wasted work on busy pages; speculation only
  rides agent actions with debounce and an A/B-proven hit rate (6.6).

## 12. Execution results — 2026-06-13

| Stage | Result | Evidence |
|---|---|---|
| S0 | Shipped identity continuity: stable `tabHandle`/`targetRef`, shared target resolver, replacement/activation events, lineage, lease/queue/perception-ledger migration, connection readiness diagnostics, and observe/execute timing fields. | Driver/tool/bridge unit coverage, fake-ws replacement round trip, `check:all:bridge`, generated docs/contracts. |
| S1 | Shipped the low-risk latency floor: observe uses direct page-script value channel, same-call scan `signals.fingerprint`, ABML prefetched scan reuse, AX `DOMSnapshot.captureSnapshot` geometry join before per-node fallback, and explicit timings. Full generated-template fused visitor and automatic viewport-first first envelope were executed as closed experiments for this pass: no byte-safe win was proven without changing the scan template contract or adding a new coverage mode. | `check:page-scripts`, `tests/unit/abml/ax-runtime.test.ts`, `tests/unit/tools/observe-abml-integration.test.ts`, full fixture eval summary `.pi/browser-artifacts/eval-browser-workflows/2026-06-12T18-26-53-853Z-23d3f64c/browser-workflow-eval-summary.json`. |
| S2 | Shipped dirty-root substrate and standing perception: content fingerprint carries bounded dirty roots/overflow/drain, execute effect drains stale roots before dispatch, observe cache can survive TTL only when the dirty window is event-clean, `PI_BROWSER_STANDING_PERCEPTION=0` restores pull-only behavior, and `PerceptionLedger` now records shared objective-substrate metadata while preserving per-session views. Incremental dirty-root entity merge remains fail-open to full scan on unsafe/global cases; version-range behavior is covered through existing session-delta/baseline parity and serialization canaries. | `check:env-flags`, `check:compaction-ledger`, `check:compute-once`, `resultMiddleware-advanced` serialization canary, `perceptionLedger` shared-substrate unit. |
| S3 | Shipped interaction feedback riders: default `browser_execute` and native write paths still collect cheap effect facts without pre-action observe; effect now carries dirty roots/overflow and stale-act feedback (`targetObservedAt`, `targetObservationId`, `targetRef`, `targetRegionDirty`, `targetDirtyRoots`) when a `pi-ref://` target's region dirties. `browser_wait selector` is locked to Runtime binding + MutationObserver subscription with diagnosed polling fallback. Speculative refresh and DOMSnapshot-as-primary sensing were run as A/B closures, not adopted by default; they remain disabled until blind A/B proves hit-rate and recall wins. | `execute-effect.test.ts`, `check:page-scripts`, `check:fake-ws`, full fixture eval 28/28 passed. |

**Measured gates run during closure.**

- Focused passes: `npm run verify:bridge:dist`, `npm run check:all:bridge`,
  `npm run check:page-scripts`, `npm run check:env-flags`,
  `npm run check:src:types`, `npm run check:compaction-ledger`,
  `npm run check:file-ceilings`, `npm run check:all:package`, and targeted
  unit tests for AX, observe, execute effect, and perception ledger.
- Browser workflow eval: `npm run eval:browser-workflows -- --fixture-server
  --timeout-ms 120000` passed all 28 fixture workflows; artifact:
  `.pi/browser-artifacts/eval-browser-workflows/2026-06-12T18-26-53-853Z-23d3f64c/browser-workflow-eval-summary.json`.
- Blind real-site eval: a fresh Codex `exec` child drove the isolated
  `pb-blind.mjs` stage on `https://linux.do/` for the top-5-topic task. It
  completed the answer through `wait selector` + `observe scan` + saved
  `data.rows` artifact, with natural wait routing and no defensive re-list in
  the child. Artifacts:
  `.pi/browser-artifacts/eval-blind/living-tab-linuxdo-blind-report-bypass.md`
  and `.pi/browser-artifacts/eval-blind/usage-1781290055745-33796-report.json`.
  Residual `browser_execute` -> `TAB_NOT_FOUND` / stage disconnect was recorded
  as n=1 reliability hypothesis `LTS1` in `evals/browser-workflows/blind-findings.md`;
  no code fix was taken from a single run.
- Final closure gates `npm run lint` and `npm run check` passed; their
  artifacts are recorded in `.pi/browser-artifacts/check-dag-summary.json`
  from the final pass.

## 13. Acceptance bar (whole plan)

- The three reported frictions have ledger entries
  (`evals/browser-workflows/blind-findings.md`, real-session section)
  pointing here, each closed by a named stage with evidence: `NO_BROWSER_EXTENSION`
  recovery includes connection-readiness diagnostics and `connectionWaitMs`
  separated from scan timings (S0); cached id surviving a live prerender swap +
  lineage visible (S0); first-envelope latency + complexity table before/after
  on the heavy corpus, with the §6 budget targets met or §Results-justified
  (S1); incremental≡full golden + version-range parity + shared-substrate dedup
  across two sessions + G3 serialization count=1 (S2); act→effect with
  stale-act honesty replacing a re-observe in a real transcript +
  speculation/channel A/B reports (S3).
- All nine invariants I1–I9 contract-tested red-first; all new env flags
  registered with signature sites; every stage closed with full
  `npm run check` + `npm run lint` exit 0 read from the DAG summary artifact.
- The §8 metrics move: connection-wait / recovery clarity, defensive-ritual
  rate, stale-id incident rate, and execute overhead improve measurably;
  tokens-per-task does not regress; the final blind real-site run completed
  the heavy-page task without defensive re-listing in the child, kept first
  observe under budget, and recorded the only residual disconnect as an n=1
  reliability hypothesis rather than hiding it.
