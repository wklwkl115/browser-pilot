# Temporal Control Kernel Plan

> Status: **completed implementation** (2026-06-13). T0-T8 shipped as the V1
> temporal control kernel: pure taxonomy/classifiers/planners, boundary gate,
> profile harvest, driver coordinator, wait/execute diagnostics, compact model
> verdicts, and artifact summaries. T9 deterministic workflow acceptance passed;
> blind-friction acceptance was dropped as a closure dependency for this landing
> because no public tool/strategy surface changed.
> Scope: internal temporal/control algorithm kernel for browser runtime
> coordination: target freshness, wait budgeting, state-loss classification,
> consistency windows, and timeout diagnostics.
> Boundary: no new public `browser_*` tools; no public merge of `browser_tabs` and
> `browser_wait`; no hidden agent strategy such as choosing alternate buttons,
> closing overlays, or crossing browser/tab boundaries automatically.
> Verification: temporal profile harvest + pure-core oracle tests + deterministic
> runtime fixtures + workflow eval; closing gate `npm run check`.
> Activation: activated from `CURRENT.md`, closed after docs sync and full check,
> then archived per `docs/document-structure.md`.

---

## Execution Closure

Implemented surfaces:

- `src/temporal-core/**`: frozen V1 vocabulary, deterministic target/page/wait
  classifiers, deadline pressure/budget allocator, and sync planners.
- `src/driver/BrowserTemporalCoordinator.ts` and
  `src/driver/temporalProfileArtifacts.ts`: runtime stamp/profile adapter and
  temporal artifact writer.
- `BrowserBridgeCommandService` and `BrowserWaitSupervisor`: queue-delay,
  ACK/no-ACK, bridge timeout, lease timeout, worker-history-loss, and compact
  temporal diagnostics.
- `browser_execute` / native action adapters and `executionEffect`: temporal
  profile sampling plus stale-before-dispatch classification without adding any
  public tool or hidden workflow.
- Governance gates: temporal-core boundary check, kernel test map/export
  inventory entries, surface liveness wiring, check graph wiring, and workflow
  eval temporal summary validation.

Verification evidence for closure:

- Unit/contract: `npm run test:unit:temporal`,
  `npm run check:temporal-core-boundary`, `npm run check:kernel-test-map`,
  `npm run check:surface-liveness`, `npm run check:eval-workflows`,
  `npm run test:unit:driver`, `npm run test:unit:tools`,
  `npm run check:src:types`.
- Focused gates: `npm run check:governance`, `npm run check:fake-ws`,
  `npm run check:summaries`, `npm run check:artifact`,
  `npm run check:output-schema-conformance`, `npm run check:token-economy`,
  `npm run check:doc-structure`.
- Workflow eval: `npm run eval:browser-workflows -- --fixture-server` passed
  28/28 and wrote `.pi/browser-artifacts/temporal-profile-summary.json`.
- Closing gate: `npm run docs:sync`, then final `npm run check`.

T9 blind-friction handling: `eval:blind:launch` is an operator stage launcher,
not an automated report producer. This landing changed internal diagnostics and
artifact/control contracts only; deterministic acceptance is the closure oracle.
Reopen blind-friction work only on a real blind report showing agents still make
false temporal decisions or spend extra recovery calls because the compact
temporal frontier is insufficient.

## 0. Decision

Build a fourth internal kernel family for browser-agent control:

```text
capture-core   -> sense      collect browser facts
abml-core      -> perceive   model entities, refs, relations, and affordances
distill-core   -> express    allocate value under output/token budgets
temporal-core  -> coordinate estimate time-state trust and choose sync plans
```

`temporal-core` is not a field-pack, wait wrapper, or public tool. It is the
internal control substrate that answers:

1. Is the target observed by the agent still the same usable runtime target?
2. Is the page/window/network state still inside the consistency window for the
   intended action?
3. What is the cheapest deterministic synchronization plan under the remaining
   deadline?
4. If timing failed, which state was missing, late, stale, or lost?

The kernel should optimize the agent loop, not merely decorate failures. A local
`targetRegionDirty:true` or `WAIT_TIMEOUT` is useful evidence, but it is not yet
an algorithmic control plane.

---

## 1. Problem

The current browser loop intentionally exposes separate perception and action
tools:

```text
browser_tabs -> browser_observe -> browser_execute / browser_wait -> browser_observe
```

This keeps the public surface composable, but it leaves several temporal facts
distributed across separate mechanisms:

- target identity and `selectionVersion` in `BrowserTabSessionRouter`
- write serialization and auto leases in `BrowserBridgeCommandService`
- wait deadlines, lease attempts, `workerRestarts`, and `historyLost` in
  `BrowserWaitSupervisor`
- page `changeSeq`, dirty roots, network seq, hook seq, and execute effect in
  `pageSignals` / `executionEffect`
- observe stage costs in `observeTimings`
- service-worker wait event state in `wait_coordinator`, `wait_navigation`,
  `wait_selector`, and `wait_network_idle`

The result is a real TOCTOU class:

1. Agent observes button A.
2. Agent executes against A.
3. Between the two calls, DOM, URL, popup, route, tab handle, worker state, or
   network state changes.
4. Runtime has partial facts, but no single algorithm estimates whether the
   action was still based on valid perception.

This is the **inter-action** window (observe → execute). It is distinct from the
**intra-action** window (measure → dispatch) covered by the separate
execution-plane CDP fusion draft: that draft makes one physical
action TOCTOU-immune at the CDP mechanism, but cannot tell whether the ref it
acts on is still a valid live target. Estimating *that* is this kernel's job; the
two drafts are complementary and neither absorbs the other.

The same scatter also weakens timeout handling: a timeout can mean URL mismatch,
selector absence, background throttling, inflight network, bridge no-ACK, ACKed
bridge timeout, lease timeout, MV3 worker state loss, or an under-specified wait.
Those causes have different recovery paths and different cost profiles.

---

## 2. Current Mechanism Anchors

These are the live code anchors the implementation must consume rather than
replace blindly:

| Area | Current anchor | Temporal role |
| --- | --- | --- |
| Target/session identity | `src/driver/BrowserTabSessionRouter.ts` | `tabHandle`, `targetRef`, `selectionVersion`, replacement/reconnect identity |
| Write dispatch | `src/driver/BrowserBridgeCommandService.ts` | resolve target, queue writes, re-resolve queued target, assert lease invariants, send pending request |
| Lease control | `src/driver/BrowserLeaseRegistry.ts` | write conflict control and lease migration on tab replacement |
| Queue control | `src/driver/BrowserCommandQueueRegistry.ts` | per-session/tab write ordering and queue-depth pressure |
| Wait supervision | `src/driver/BrowserWaitSupervisor.ts` | total deadline, lease attempts, reconnect budget, late success, state loss |
| Runtime wait registry | `bridge_src/service_worker/wait_coordinator.ts` | active waits, event subscriptions, terminal wait history, diagnostics |
| Navigation wait | `bridge_src/service_worker/wait_navigation.ts` | URL/current-state/webNavigation/CDP event fusion |
| Selector wait | `bridge_src/service_worker/wait_selector.ts` | immediate probe, MutationObserver/binding, poll fallback, last state |
| Network idle wait | `bridge_src/service_worker/wait_network_idle.ts` | inflight/idle-window/CDP network event fusion |
| Page signals | `src/tools/pageSignals.ts` | `changeSeq`, dirty roots, readyState, network/hook high-water marks |
| Execute feedback | `src/tools/executionEffect.ts` | before/after/quiet windows, dirty target-region feedback |
| Observe timings | `src/tools/observe/scanRunner.ts` | timing harvest and bridge round-trip count |

Implementation should consolidate control decisions while preserving these
mechanisms until a measured replacement is justified.

---

## 3. Non-Goals

- No public `browser_timing`, `browser_temporal`, or merged
  `browser_tabs+browser_wait` tool.
- No hidden workflow tool that performs observe -> execute -> wait -> reobserve
  without the agent seeing evidence and tradeoffs.
- No strategic retry policy. The kernel may say `reobserve_required`,
  `target_possibly_stale`, or `wait_underconstrained`; it must not pick a
  different business action.
- No fabricated continuity across MV3 service-worker restart, tab replacement,
  navigation, or history loss. Unknown continuity is a first-class state.
- No learned or model-in-the-loop timing heuristics. Mechanical rules must be
  deterministic, auditable, and replayable.
- No landing by plausibility. Algorithmic changes require measured wins or a
  correctness fix with explicit regression coverage.

---

## 4. Target Architecture

```text
src/temporal-core/
  types.ts
    TemporalStamp
    TemporalAnchor
    TemporalIntent
    TemporalObservation
    TemporalPlan
    TemporalVerdict
    TemporalRecovery

  estimate.ts
    estimateTargetContinuity()
    estimatePageFreshness()
    estimateWaitContinuity()

  budget.ts
    allocateTemporalBudget()
    classifyDeadlinePressure()

  classify.ts
    classifyTimeout()
    classifyStaleness()
    classifyStateLoss()

  plan.ts
    planPreDispatchSync()
    planPostActionSync()
    planWaitAttempt()

src/driver/BrowserTemporalCoordinator.ts
  runtime coordinator that reads live browser/driver state, calls temporal-core,
  executes allowed mechanical plans, and records evidence.

Tool adapters
  browser_tabs      keeps public resource/session boundary
  browser_wait      keeps public wait boundary
  browser_observe   provides snapshot/signal facts used to synthesize anchors
  browser_execute   consumes refs/effect facts and emits temporal verdicts
```

The pure core owns deterministic classification and planning. The driver
coordinator owns I/O: reading snapshots, requesting page fingerprints, sending
wait commands, observing worker boot ids, and recording artifacts. Runtime
consumes the core; the core must not import driver, browser, Node I/O, timers,
or environment globals.

---

## 5. Core Model

### 5.1 TemporalStamp

`TemporalStamp` is the smallest cross-tool state vector that can be compared
without re-reading the whole page:

```ts
type TemporalStamp = {
  version: "temporal-stamp/v1";
  browserSessionId?: string;
  tabId?: number;
  targetRef?: string;
  tabHandle?: string;
  browserId?: string;
  selectionVersion?: number;
  workerBootId?: string;
  pageEpoch?: string;
  url?: string;
  readyState?: string;
  changeSeq?: number;
  dirtySinceSeq?: number;
  networkSeq?: number;
  hookSeq?: number;
  capturedAtMs: number;
  clockDomain: "driver_wall" | "bridge_worker_wall" | "page_wall";
  sequence?: number;
};
```

This is not a public schema promise. It is the internal comparison substrate for
kernel decisions. Wall-clock values are comparable only inside the same
`clockDomain`. Cross-domain freshness must use stable identity, epoch, or seq
facts such as `selectionVersion`, `changeSeq`, `networkSeq`, `hookSeq`,
`workerBootId`, `waitId`, and replacement lineage. A missing seq is `unknown`,
not zero.

### 5.2 TemporalAnchor

`TemporalAnchor` ties an agent-facing fact to the stamp that made it credible:

```ts
type TemporalAnchor = {
  version: "temporal-anchor/v1";
  source: "observe" | "execute" | "wait" | "ref" | "network" | "hook";
  operationId?: string;
  snapshotId?: string;
  observationId?: string;
  refId?: string;
  stamp: TemporalStamp;
  evidence?: {
    locators?: Array<
      | { by: "backendNodeId"; value: number }
      | { by: "axNodeId"; value: string }
      | { by: "css"; value: string }
      | { by: "textAnchor"; value: string }
      | { by: "point"; x: number; y: number }
    >;
    cssRoots?: string[];
    selector?: string;
    waitId?: string;
    requestId?: string;
  };
};
```

Carrier decision for V1: do not persist a full `TemporalAnchor` in
`BrowserObservationSnapshotInfo` or add a model-facing anchor block first.
`BrowserTemporalCoordinator` synthesizes anchors lazily from the existing
carriers:

- `BrowserObservationSnapshotInfo`: `snapshotId`, `browserSessionId`, `tabId`,
  `selectionVersion`, `url`, `capturedAt`, `networkSeq`, `hookSeq`, `saved`.
- `RefDescriptor`: `refId`, `owner`, `documentEpoch`, `locators`,
  `observationId`, `createdAt`, `ttlMs`, `stabilityScore`.
- `ExecuteEffect`: `anchor`, dirty-root facts, target feedback, before/after
  signal snapshots.
- wait results/diagnostics: `waitId`, `workerBootId`, supervisor leases,
  `historyLost`, terminal wait history.

Anchor evidence must prefer root-truth locators that survive abstraction
boundaries (`backendNodeId`, `axNodeId`, frame identity, ref descriptor owner)
before CSS selectors. `cssRoots` and selectors are fallback evidence only and
must not be the sole proof of target continuity when a stable node identity is
available.

### 5.3 TemporalVerdict

The kernel returns verdicts, not strategy:

```ts
type TemporalVerdict =
  | { status: "fresh"; confidence: "mechanical"; reasons: string[] }
  | { status: "possibly_stale"; confidence: "bounded"; reasons: string[] }
  | { status: "stale"; confidence: "mechanical"; reasons: string[] }
  | { status: "unknown"; confidence: "lost" | "partial"; reasons: string[] };
```

`unknown` is important. It prevents the system from rendering partial signal loss
as a false zero-delta or a false success.

### 5.4 TemporalPlan

`TemporalPlan` is the internal control output:

```ts
type TemporalPlan = {
  action:
    | "none"
    | "immediate_probe"
    | "wait"
    | "diagnose"
    | "quiet_read"
    | "reobserve_required"
    | "fail_closed";
  budgetMs: number;
  reason: string;
  expectedEvidence: string[];
};
```

The runtime may execute the plan, but it must not hide expensive or strategic
follow-up. For example, `reobserve_required` is exposed as recovery; it is not a
silent observe call unless the public tool already owns that read path.

### 5.5 Frozen V1 Vocabulary

The first implementation step must create `src/temporal-core/types.ts` with
these exact enums before any runtime profile sample writes `verdict` or
`recovery`.

```ts
type TemporalVerdictStatus = "fresh" | "possibly_stale" | "stale" | "unknown";
type TemporalConfidence = "mechanical" | "bounded" | "partial" | "lost";
type TemporalSource =
  | "driver_snapshot"
  | "observation_snapshot"
  | "ref_descriptor"
  | "execute_effect"
  | "wait_supervisor"
  | "wait_diagnose"
  | "page_signal"
  | "cdp_event"
  | "poll_fallback";
type TemporalFrontierNext =
  | "reuse_target"
  | "retry_same_wait"
  | "reobserve"
  | "diagnose"
  | "fail_closed";
type TemporalReason =
  | "same_target"
  | "same_page_epoch"
  | "same_wait_history"
  | "target_possibly_stale"
  | "target_stale_before_dispatch"
  | "target_region_dirty"
  | "url_changed"
  | "selection_version_changed"
  | "tab_replaced"
  | "tab_disconnected"
  | "extension_unavailable"
  | "queue_saturated"
  | "queue_delay_budget_exceeded"
  | "no_ack"
  | "acked_bridge_timeout"
  | "lease_timeout"
  | "client_disconnected"
  | "worker_restarted_history_lost"
  | "url_mismatch"
  | "load_state_unreached"
  | "selector_missing"
  | "selector_unstable"
  | "background_throttling_suspected"
  | "network_active"
  | "signal_unavailable"
  | "underconstrained_wait"
  | "late_success_after_deadline"
  | "unknown_due_to_history_loss"
  | "unknown_due_to_clock_domain"
  | "unknown_due_to_missing_anchor";
```

---

## 6. Algorithm Responsibilities

### 6.1 State Estimation

Estimate whether the live runtime state still matches the state that made the
agent's fact credible.

Inputs:

- `tabHandle`, `targetRef`, `browserSessionId`, numeric `tabId`
- replacement chain and reconnect identity
- `selectionVersionAtDispatch` / `selectionVersionAtResolve`
- `workerBootId`, `historyLost`, pending ACK state
- `changeSeq`, dirty roots, readyState, URL
- network/hook seq high-water marks

Outputs:

- `same_target`
- `same_page_epoch`
- `same_wait_history`
- `unknown_due_to_history_loss`
- `target_possibly_stale`
- `target_stale_before_dispatch`

### 6.2 Consistency Window

Define a window around each action:

```text
observe anchor captured
  -> pre-dispatch sync decision
  -> dispatch
  -> post-action effect / wait / quiet read
  -> verdict
```

This window makes TOCTOU explicit. A dirty region found before dispatch is a
different fact from a dirty region caused by the dispatch. The current execute
effect already has before/after/quiet reads; temporal-core should make the
classification explicit and reusable.

### 6.3 Event Fusion

Fuse event streams without pretending they have the same trust level:

- navigation: current URL + webNavigation + tabs events + CDP page events
- selector: immediate DOM probe + MutationObserver/binding + poll fallback
- network idle: CDP network events + inflight counters + idle window
- bridge: ACK/no-ACK + pending timeout + client disconnect
- worker: boot id changes + history-loss markers

Fusion outputs must include source and coverage, because a poll fallback success
and a CDP event success do not have identical diagnostic value.

### 6.4 Budget Allocation

Temporal budget is a first-class optimization target. The allocator should
divide a declared deadline across:

- extension readiness grace
- queue delay
- write lease attempt
- pending request timeout
- wait lease attempt
- reconnect budget
- quiet-read budget
- diagnose budget

The current wait supervisor already scales bridge grace and reconnect budget
against remaining time. The kernel generalizes that pattern across the browser
loop.

### 6.5 Timeout Classification

Timeout classification should answer "what did not happen in time?" rather than
only "the deadline elapsed."

Initial classifier reasons:

- `extension_unavailable`
- `queue_saturated`
- `no_ack`
- `acked_bridge_timeout`
- `lease_timeout`
- `client_disconnected`
- `worker_restarted_history_lost`
- `url_mismatch`
- `load_state_unreached`
- `selector_missing`
- `selector_unstable`
- `background_throttling_suspected`
- `network_active`
- `signal_unavailable`
- `underconstrained_wait`
- `late_success_after_deadline`

---

## 7. Optimization Dimensions

Temporal optimization is multi-objective. A change is not good merely because it
adds more timestamps; it must improve at least one dimension without hiding risk
in another.

| Dimension | Current gap | Kernel responsibility | Do not optimize by |
| --- | --- | --- | --- |
| Correctness | TOCTOU facts are split across observe, execute, wait, and refs. | Estimate target/page/wait continuity and classify stale-before-dispatch separately from post-dispatch effects. | Blocking all writes whenever uncertainty exists. |
| Latency | Repeated list/observe/wait recovery loops cost bridge RTTs and agent turns. | Choose the cheapest mechanical sync plan under deadline: no-op, probe, wait, quiet read, diagnose, or reobserve-required. | Silent observe/execute/wait chains that hide evidence. |
| Deadline control | Extension ready grace, queue delay, pending timeout, wait lease, reconnect, and quiet read budgets are local. | Allocate one temporal budget and preserve remaining/used time as evidence. | Extending wall-clock beyond user timeout to "be safer". |
| Event confidence | Navigation/selector/network waits have heterogeneous sources and fallbacks. | Attach source/coverage/confidence to temporal verdicts. | Treating poll fallback, CDP event, and page probe as equal truth. |
| Agent-call economy | Agents compensate for stale uncertainty by relisting, rescanning, and retrying broad paths. | Return narrow recovery frontiers and reusable handles when safe. | A black-box workflow tool that takes over planning. |
| Token economy | Rich diagnostics can crowd out live page facts. | Keep model-facing temporal facts compact; full timelines go to artifacts. | Dumping all event histories into summaries. |
| Runtime resilience | MV3 restart, bridge disconnect, stale extension, and replacement chains are handled per path. | Make history loss explicit and fail closed on fabricated continuity. | Cross-browser/tab fallback or invented event continuity. |
| Concurrency | Queue/lease/operation states are visible but not one control model. | Estimate queue pressure and lease conflict as budget/risk inputs. | Moving wait lease semantics into write leases. |
| Governance | Kernel additions can become another unbounded internal substrate. | Boundary lock, test map, metric artifact, and acceptance bar from first landing. | Adding env flags or exported helpers without ownership. |

### 7.1 Correctness Optimization

Correctness work should remove a class of stale-action ambiguity. Examples:

- A `pi-ref://` target was dirtied before dispatch: classify
  `target_stale_before_dispatch`, not merely `targetRegionDirty` after the
  action.
- A navigation wait loses worker history: classify `unknown/history_lost`, not
  a false `timeout` or fake delta.
- A tab replacement preserves logical `tabHandle`: classify continuity by
  replacement/reconnect identity, not numeric `tabId` alone.

Acceptance is an oracle, not a benchmark: deterministic fixtures must show the
old ambiguity and the new classification.

### 7.2 Latency and Round-Trip Optimization

Temporal latency has its own budget term:

```text
T_temporal = probe RTTs + wait attempts + reconnect wait + queue delay
           + quiet reads + recovery reobserve calls + agent follow-up calls
```

The kernel should reduce this term by making synchronization cheaper and more
precise:

- prefer immediate probes when the condition is already satisfied
- avoid refreshing tabs when the current stamp proves target continuity
- avoid full reobserve when a quiet read or effect stamp is enough
- escalate directly to `diagnose` when wait evidence says the condition is
  underconstrained or history is lost
- preserve the declared deadline; late success remains a timeout/state-loss
  class, not success

The acceptance metric is p50/p95 workflow wall-clock and tool-call count, plus
no regression in false-timeout fixtures.

### 7.3 Agent-Call and Token Economy

A temporal verdict must be short enough to help the next agent step:

```ts
type TemporalFrontier = {
  reason: string;
  next: "reuse_target" | "retry_same_wait" | "reobserve" | "diagnose" | "fail_closed";
  handle?: { targetRef?: string; snapshotId?: string; waitId?: string };
  why: string;
};
```

This mirrors the distill frontier idea: every cut or failure gives one concrete
retrieval/recovery path. Full timelines stay artifact-backed. The summary should
carry only the verdict, reason, confidence, and one next action.

### 7.4 Runtime Resilience

Runtime resilience is not "try harder." It is honest continuity management:

- same extension + same logical tab + bounded replacement chain can preserve
  target continuity
- worker restart can preserve connection readiness but lose event history
- bridge ACK/no-ACK splits transport failure classes
- selector wait fallback to polling is valid, but lower-confidence than a
  subscription-triggered success
- network idle must account for long-poll and filters, not assume all inflight
  requests are blockers

The kernel should make those distinctions available as deterministic verdicts.

### 7.5 Security and Privacy

Temporal artifacts may contain URLs, selectors, request ids, wait ids, and
event histories. They must follow existing artifact privacy rules:

- model-facing summaries do not dump raw URL queries, cookies, tokens,
  authorization headers, request bodies, or WebSocket payloads
- artifact paths carry detailed evidence; summaries carry redacted pointers
- `TemporalStamp` should not become a durable cross-session tracking key
- memory/retain paths may consume temporal verification only after privacy
  review; temporal-core itself does not write memory

---

## 8. Closed Execution Contract

This plan is executable when activated from `CURRENT.md`. The following
decisions are closed for V1; implementation must change the contract first if a
decision becomes invalid.

### 8.1 Taxonomy First

`src/temporal-core/types.ts` lands before any runtime adapter or profile writer.
No adapter may invent local verdict, reason, confidence, source, or frontier
strings. T0 profile collection may record raw fields before classifiers exist,
but it must omit `verdict` and `recovery` until the frozen enums compile and have
unit coverage.

Focused verification:

- `tests/unit/temporal-core/types.test.ts`
- boundary check updated to include `src/temporal-core/`
- `npm run check:kernel-test-map -- --propose` when the new test map entry is
  first added, then `npm run check:kernel-test-map`

### 8.2 Temporal Cost Model

Use this deterministic tuple for allocator comparisons:

```ts
type TemporalCost = {
  wallMs: number;
  bridgeRoundTrips: number;
  expectedToolCalls: number;
  tokenChars: number;
  confidenceLoss: 0 | 1 | 2 | 3;
};
```

The allocator compares plans using this tuple, not wall-clock alone. For
example, a 50 ms diagnose that prevents two agent turns may be cheaper than a
20 ms ambiguous timeout summary.

### 8.3 Profile Artifact Schema and Paths

Create temporal profile artifacts before optimizing. The canonical summary is:

```text
.pi/browser-artifacts/temporal-profile-summary.json
```

Each workflow/eval run writes:

```text
.pi/browser-artifacts/temporal-profile/<runId>/temporal-profile-samples.jsonl
.pi/browser-artifacts/temporal-profile/<runId>/temporal-profile-summary.json
```

If the sample came from `evals/browser-workflows`, copy the per-run summary into
that eval's run directory beside `browser-workflow-eval-summary.json`.

The V1 sample schema is:

```ts
type TemporalProfileSample = {
  operationId?: string;
  tool: string;
  command?: string;
  target?: { browserSessionId?: string; tabId?: number; targetRef?: string };
  deadlineMs?: number;
  elapsedMs: number;
  bridgeRoundTrips?: number;
  queueDepthAtEnqueue?: number;
  queueDepthAtStart?: number;
  queueDelayMs?: number;
  waitAttempts?: number;
  workerRestarts?: number;
  historyLost?: boolean;
  rawSignals?: string[];
  verdict?: TemporalVerdictStatus;
  reasons?: TemporalReason[];
  recovery?: TemporalFrontierNext;
};
```

Write both a canonical summary and per-run copy, following the observe timing
harvest precedent. This is the optimization baseline and regression oracle.

Queue delay measurement is owned by the driver write path: record
`queuedAt=Date.now()` immediately before `BrowserCommandQueueRegistry.enqueue`,
record `startedAt=Date.now()` at the beginning of the queued closure, and compute
`queueDelayMs=max(0, startedAt-queuedAt)`. The queue registry remains the owner
of ordering/depth; the temporal layer only records timing around it.

### 8.4 Runtime/Pure Boundary

Pure core may compare stamps, classify, and plan. Runtime may read clocks,
snapshots, driver registries, bridge results, and artifacts. The boundary must
be enforced with a drift gate before the first broad wiring lands.

Boundary rule:

- `src/temporal-core/**` may import only other `src/temporal-core/**`,
  `src/utils/**` pure helpers, and type-only schema files approved by the gate.
- It must not import `src/driver/**`, `src/tools/**`, `bridge_src/**`, Node I/O,
  timers, random, locale, process env, or browser globals.
- Runtime gathering belongs in `src/driver/BrowserTemporalCoordinator.ts` and
  adapter helpers under driver/tool ownership.

### 8.5 Output Placement

Model-facing V1 fields are fixed:

- `verdict.status`
- `verdict.reasons` capped to 3
- `verdict.confidence`
- `frontier.next`
- one reusable handle when safe

Everything else defaults to artifact diagnostics. Full anchors, timelines,
clock-domain evidence, raw URLs with queries, request bodies, headers,
WebSocket payloads, and selector histories are artifact-only and must be
redacted under existing artifact privacy rules. Any additive envelope field must
be covered by `check:summaries`, `check:token-economy`, `check:artifact`,
`check:output-schema-conformance`, and the owning unit/contract tests.

### 8.6 Diagnose Ownership

`browser_wait action=diagnose` / `wait.diagnose` is the canonical wait
diagnostic read surface. The temporal classifier may attach compact verdicts to
existing wait failures and may point the frontier to `diagnose`, but normal wait
or execute calls must not silently invoke `wait.diagnose`. A runtime plan action
`diagnose` is executable only inside an explicit diagnose call or a non-user
profile/eval harness where the artifact records that extra diagnostic read.

### 8.7 Kill Switch and Parity Semantics

Default V1 has no new env flag. If runtime behavior changes require a kill
switch, register the flag in the env-flag gate and add disabled-path byte/shape
parity tests before enabling the behavior by default. A disabled temporal layer
must preserve existing public tool count, command names, target resolution,
recovery strings, summary shape, and artifact availability except for existing
operation/artifact metadata that already varies per run.

---

## 9. Development Tracks

### T0 - Pure Taxonomy and Boundary Gate

Create `src/temporal-core/types.ts` with the frozen V1 vocabulary and pure data
types only. Add the boundary drift gate before any runtime import path can reach
the core. No behavior changes and no profile verdicts land in this track.

Focused verification:

- `tests/unit/temporal-core/types.test.ts`
- `npm run check:kernel-test-map`
- new/updated temporal-core boundary gate

### T1 - Measurement Baseline

Add temporal profile collection without behavior changes and without optimizer
decisions:

- wait attempt counts, retry delay, late success, history loss
- pending request ACK/no-ACK/timeout split
- queue delay and queue depth using the enqueue/start measurement in section 8.3
- stale target/ref raw signals that can be inferred today
- observe bridge round trips and follow-up tool-call counts

This track ends with `temporal-profile-summary.json` and per-run samples. No
allocator, retry optimizer, or pre-dispatch blocker may land before this data
exists.

Focused verification:

- unit tests for profile sample construction
- `npm run eval:browser-workflows -- --fixture-server`
- profile artifact existence/schema check

### T2 - Pure Classifiers and Oracle

Create pure classifiers/planners under `src/temporal-core/`. Build red-first
fixtures for:

- same target vs replacement vs disconnected target
- fresh page vs dirty target region vs unknown fingerprint
- wait timeout vs state loss vs underconstrained wait
- budget exhausted vs valid immediate probe

The oracle is deterministic input -> verdict. No driver imports.

Focused verification:

- `tests/unit/temporal-core/*.test.ts`
- temporal-core boundary gate
- `npm run check:kernel-test-map`

### T3 - Runtime State Adapter

Add a driver adapter that gathers current state into `TemporalStamp` and
`TemporalObservation` without changing command behavior. It should read existing
registries and results, not duplicate ownership:

- `BrowserTabSessionRouter` for target identity
- `BrowserLeaseRegistry` / `BrowserCommandQueueRegistry` for concurrency
- `BrowserWaitSupervisor` and bridge wait diagnostics for wait state
- `pageSignals` / `executionEffect` for page state

Focused verification:

- `tests/unit/driver/BrowserTabSessionRouter.test.ts`
- driver coordinator unit tests with fake snapshots
- `tests/contracts/runtime/check-fake-ws.mjs`

### T4 - Timeout and State-Loss Classifier

Wire classifier output into existing wait failures first. This is lower risk
than changing action timing because it improves recovery diagnostics while
preserving the wait contract.

The classifier must use existing `wait.diagnose` as the explicit diagnostic
frontier and must not auto-run diagnose in normal wait failure paths.

Focused verification:

- `tests/unit/driver/BrowserWaitSupervisor.test.ts`
- `tests/contracts/runtime/check-fake-ws.mjs`
- `npm run check:summaries`
- `npm run check:artifact`

### T5 - Pre-Dispatch Stale Classifier

Separate the action window:

```text
anchor captured -> pre-dispatch check -> dispatch -> post-dispatch effect
```

The key acceptance case is a target dirty before dispatch being reported as
pre-existing stale risk, not only as a post-action dirty effect.

This track must prefer root-truth locators (`backendNodeId`, `axNodeId`, frame
identity, ref owner) before CSS dirty-root overlap. CSS-only continuity is
`bounded` or `unknown`, never `mechanical`.

Focused verification:

- execute-effect unit tests for stale-before-dispatch vs post-dispatch dirty
  roots
- page-script fixture for dirty-window ordering
- summary/token gates if model-facing verdicts change

### T6 - Budget Allocator

Unify deadline allocation after classifiers are stable. The allocator should
choose among immediate probe, wait attempt, reconnect, quiet read, diagnose, and
fail-closed. It should not silently run full observe unless the existing public
tool call already requested observation.

Focused verification:

- fake-clock budget tests
- deadline-overrun profile metrics
- no regression in `BrowserWaitSupervisor` deadline tests

### T7 - Event Fusion Upgrade

Normalize navigation/selector/network source confidence. Preserve path-specific
mechanics, but return a shared temporal verdict shape.

Focused verification:

- wait navigation/selector/network fixture tests
- `tests/contracts/runtime/check-page-scripts.mjs`
- `tests/contracts/runtime/check-fake-ws.mjs`

### T8 - Token, Artifact, and Summary Economy

Lock model-facing output size and artifact fallback behavior.

Focused verification:

- `npm run check:summaries`
- `npm run check:token-economy`
- `npm run check:artifact`
- `npm run check:output-schema-conformance`

### T9 - Agent-Loop Acceptance

Run deterministic workflow and blind-friction acceptance:

- stale SPA route change
- popup/overlay between observe and execute
- delayed selector insertion
- MV3 restart during wait
- same numeric tab id across browser sessions

The goal is fewer false decisions and fewer recovery calls, not merely richer
diagnostics.

---

## 10. Public Tool Boundary

Public tools stay semantically singular:

- `browser_tabs`: resource/session/tab/snapshot management.
- `browser_wait`: durable waits and state probes.
- `browser_observe`: canonical perception.
- `browser_execute`: precise JS execution and effect evidence.

Temporal facts ride existing envelopes, diagnostics, artifacts, operation
metadata, and recovery fields where appropriate. If any public summary field
changes, it must be additive, bounded, and covered by summary, token, artifact,
and output-schema gates. `browser_wait action=diagnose` remains the canonical
wait diagnostic read; temporal work must not introduce a second diagnose tool or
hidden diagnose workflow.

---

## 11. Execution Order

| Order | Item | Why first | Focused verification |
| --- | --- | --- | --- |
| 0 | Taxonomy + boundary gate | Prevent local strings and invalid core imports before any runtime writes temporal facts. | `tests/unit/temporal-core/types.test.ts` + temporal-core boundary gate + `check:kernel-test-map` |
| 1 | Temporal profile harvest | Algorithm work needs a baseline before choosing optimizations. | `npm run eval:browser-workflows -- --fixture-server`; temporal metrics artifact schema check |
| 2 | `temporal-core` pure classifiers + oracle | Establish deterministic semantics before runtime wiring. | unit tests + boundary drift gate |
| 3 | Runtime state adapter | Gather existing target/wait/page state without behavior change. | driver unit tests + fake-ws shape parity |
| 4 | Timeout and state-loss classifier | Improves recovery diagnostics with low behavior risk. | `BrowserWaitSupervisor` tests + `check:fake-ws` + `check:artifact` |
| 5 | Pre-dispatch TOCTOU classifier | Separates stale-before-dispatch from mutations caused by dispatch. | execute-effect unit tests + page-script fixture |
| 6 | Budget allocator | Unifies grace/retry/reconnect/quiet-read decisions after classifiers are stable. | fake clock tests + deadline overrun metrics |
| 7 | Event-source confidence normalization | Makes navigation/selector/network verdicts comparable. | wait navigation/selector/network fixture tests |
| 8 | Token/artifact/summary economy pass | Ensures temporal facts help the next agent step without summary bloat. | `check:summaries`, `check:token-economy`, `check:artifact`, `check:output-schema-conformance` |
| 9 | Workflow and blind-friction acceptance | Prove agent-loop improvement, not just cleaner code. | workflow eval + targeted blind eval report |

Close an activated workstream with full `npm run check`.

---

## 12. Metrics

Temporal work must report before/after metrics. Candidate metrics:

| Metric | Meaning |
| --- | --- |
| `deadlineOverrunMs` | wall-clock over declared timeout |
| `lateSuccessCount` | operation succeeded after deadline and was converted to timeout/state-lost |
| `waitAttempts` | lease/probe attempts per wait |
| `reconnectBudgetMs` | time spent waiting for extension reconnect |
| `queueDelayMs` | time spent behind per-tab write queue |
| `noAckTimeoutCount` | requests never acknowledged by the bridge |
| `ackedBridgeTimeoutCount` | requests acknowledged but not completed |
| `historyLostCount` | worker/tab/session history continuity was lost |
| `staleBeforeDispatchCount` | observed target stale before the action was sent |
| `targetRegionDirtyCount` | target region dirty across action window |
| `fallbackPollCount` | selector wait fell back from event subscription to polling |
| `falseTimeoutFixtureCount` | deterministic fixture expected success but timed out |
| `toolCallsPerWorkflow` | agent-loop cost from workflow eval |
| `observeBridgeRoundTrips` | transport cost from observe timings |
| `reobserveAvoidedCount` | safe recovery avoided a full observe |
| `reobserveRequiredCount` | kernel correctly refused to reuse stale evidence |
| `frontierFollowedSuccessRate` | recovery frontier led to success in deterministic eval |
| `temporalSummaryChars` | model-facing temporal diagnostic size |

No optimization lands solely because an individual unit test passes. The
representative workflow must improve, or the change must close a correctness
class with explicit evidence.

---

## 13. Verification Plan

### Pure Core

- `tests/unit/temporal-core/*.test.ts`
- deterministic fixtures for target continuity, page freshness, timeout
  classification, budget allocation, and state-loss verdicts
- boundary gate mirroring ABML/distill core: no driver/browser imports, no Node
  I/O, no environment reads, no direct clock/random/locale usage
- `check:kernel-test-map` entry for each temporal-core module

### Driver Runtime

- `tests/unit/driver/BrowserWaitSupervisor.test.ts`
- `tests/unit/driver/BrowserTabSessionRouter.test.ts`
- driver coordinator unit tests for stamp synthesis, clock-domain handling,
  queue-delay sampling, and no-behavior-change profile collection
- `tests/contracts/runtime/check-fake-ws.mjs`
- `tests/contracts/runtime/check-lifecycle.mjs`

### Tool and Envelope

- execute effect tests for stale-before-dispatch vs post-dispatch dirty roots
- observe integration tests for temporal anchor propagation
- summary/token/artifact/output-schema gates if any model-facing field or
  artifact shape is added
- docs sync when generated docs or managed indexes change

### Workflow

- deterministic `evals/browser-workflows` run with temporal metrics artifact
- correlation-chain scenario: observe -> execute -> wait -> artifact
- blind-agent friction run only after deterministic gates show no regression

---

## 14. Acceptance Bar

Use the same discipline as prior kernel optimizations:

1. Correctness fixes must have a red-first fixture that failed because the old
   system could not distinguish two temporal states.
2. Performance optimizations must report before/after numbers on the temporal
   profile artifact. A representative regression closes the item with no
   landing, even if synthetic cases improve.
3. Public tool count and public command semantics must remain unchanged unless a
   separate surface migration proves better agent outcomes.
4. Model-facing output must stay compact. Rich temporal timelines belong in
   artifacts.
5. Unknown continuity must remain explicit. It is better to return
   `unknown/history_lost` than to fabricate a fresh state.

---

## 15. Governance Gate Impact

| Gate | Impact |
| --- | --- |
| G1 `check:spec-truth` | Add spec claims only after runtime behavior exists. |
| G2 `check:surface-liveness` | New `temporal-core` exports must be internal; no public tool names. |
| G3 `check:compute-once` | Add call-site limits if temporal plan/classifier work is used in hot paths. |
| G4 `check:purity-vocabulary` | Extend purity checks for `temporal-core`. |
| G5 `check:kernel-test-map` | Map all new temporal-core unit tests. |
| G6 `check:env-flags` | No new flags in the default plan; any kill switch must be registered. |
| G7 `check:artifact` | Temporal profile and detailed timelines must remain artifact-readable. |
| G8 `check:output-schema-conformance` | Any additive envelope field must match schema contracts. |

---

## 16. Closed Decisions

1. Runtime coordinator name: `BrowserTemporalCoordinator`. The term "kernel"
   stays reserved for pure `src/temporal-core/**` modules.
2. Anchor storage: V1 synthesizes anchors lazily from existing snapshot, ref,
   execute-effect, and wait-supervisor carriers. It does not persist full
   anchors in `BrowserObservationSnapshotInfo`.
3. Model-facing metrics: only `verdict.status`, up to three `verdict.reasons`,
   `verdict.confidence`, `frontier.next`, and one reusable handle. All other
   temporal details are artifact-only.
4. Wait diagnostics: existing `browser_wait action=diagnose` is canonical.
   Driver snapshots may carry compact classifier verdicts; they do not become a
   second diagnostic read surface.
5. Initial blind-eval scenario: stale SPA route change between
   `browser_observe` and `browser_execute`, because it exercises target/page
   continuity without requiring artificial MV3 restart control.
6. Profile artifacts: canonical summary under `.pi/browser-artifacts/`; per-run
   samples and summaries under `.pi/browser-artifacts/temporal-profile/<runId>/`;
   workflow eval copies under that eval run directory.
7. Token budget: temporal model-facing fields target <= 600 chars per envelope
   and are guarded by `check:summaries` plus `check:token-economy`. Exceeding
   this requires an explicit budget baseline update in the same diff.
8. Queue/lease delay sampling: sample all wait and tab-scoped write operations.
   Non-tab read operations may omit queue/lease fields.
9. Reusable `targetRef`: allowed only when target continuity is `fresh` with
   `mechanical` confidence or `possibly_stale` with a bounded non-target reason
   and unchanged owner/session/page epoch. Any history loss, tab replacement
   ambiguity, URL mismatch, dirty target region, or missing stable locator forces
   `reobserve`.

---

## 17. Closure Record

The workstream was activated from `CURRENT.md`, executed taxonomy/boundary before
runtime wiring, created temporal profile harvest before optimizer decisions,
preserved the public tool boundary, and closed with deterministic workflow eval
plus full repo verification.
