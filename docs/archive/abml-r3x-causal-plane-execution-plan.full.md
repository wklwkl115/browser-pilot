# ABML R3.x — network/API causal plane execution contract

> Status: **P0 + P1 + P2 (A+B+C) COMPLETE — browser-verified** (activated 2026-06-04 by explicit user priority
> change). This is a new ABML main line; per project rules it gets its own execution contract and a
> CURRENT.md activation. The handoff conditions in `docs/abml-r3-runtime-events-execution-plan.md §6`
> are met: R3.1 entity diff is stable in model-facing output, and a real-page state-transition
> diff was live-verified (`npm run smoke:browser:abml-inference`, 2026-06-04; that smoke was later removed with the 2026-06-05 `envelope.inference` refactor — inference regression is now covered by `check:abml-inference`).
>
> **P0 landed (2026-06-04):** passive network-delta plane shipped + browser-verified across 4
> commits — `99b9bf3` pure-core selector, `729aef6` runtime wiring (envelope `causal`),
> `ff319cd` contract `check:abml-causal`, `63a0bff` live smoke `smoke:browser:abml-causal` (Edge:
> `causal.unavailable`, seq high-water, redacted `/api/ping` delta).
>
> **P1 landed (2026-06-04):** attribution to the activated control via a `triggered` (control →
> network request) relation, `source:"timing"` / confidence `"low"` (timing-window only, no
> initiator-stack proof). Explicit `actionRef` param or the focus-normalized `diff.focusedRef`
> (control/element only — a frame/region focus is rejected, the §7 focus-robustness fix). Browser-
> verified on Edge: `relations.summary.triggered`, the control's inline `triggered` edge targeting
> the redacted `/api/ping2` request ref. The focus-only path is recorded as fragile on live pages
> (the documented reason `actionRef` exists).

## 1. Goal

Give the perception model a **causal plane**: "since the last observation, these network
requests fired" (P0), and later "this control triggered these requests" (P1). Reuse the existing
network recorder and the already-scaffolded ABML stream plane — wire them into the observe
envelope. No new public tool, no protocol change, no per-site heuristics.

## 2. What already exists (reuse, do not rebuild)

- **Network recorder** (`bridge_src/service_worker/network_model.ts`, `network_events.ts`,
  `types.ts` `NetworkRecord`): captures requestId/tabId/**seq**/timestamps/type/request/response/
  initiator(CDP)/documentURL/frameId/bodyRef. `browser_network` exposes start/stop/list/get/wait
  with **seq-windowed queries** (`sinceSeq`). This is the data source.
- **ABML stream plane scaffold** (`src/abml-core/stream.ts`): already defines `network-entry`
  entity builders and an `Entity.stream?` field (currently never populated); router already
  declares `plane: "structure"|"network"|"event"` (only `structure` implemented — `network`/
  `event` throw `BACKEND_UNAVAILABLE` at `src/abml/verbs/runtime.ts`). R3.x wires this scaffold
  into the entity graph + envelope.
- **Baseline machinery** (`src/tools/observeRunners.ts` `resolveBaselineEntities`,
  `BrowserObservationSnapshotRegistry`): `browser_observe(mode:scan, baseline:X)` already
  resolves a prior snapshot and lifts an entity `diff` to the envelope top level. P0 extends the
  snapshot + baseline path with a network seq high-water mark.
- **Relation materialization** (`src/abml-core/relations.ts` `materializeRelations`): the P1
  control→request edge reuses this exactly like R1 relations.
- **Redaction** (`src/utils/redaction.ts`): URL/param/body redaction for the network entries.

## 3. The core constraint that shapes the design

`browser_observe` is passive — it does NOT know which control the agent activated (the agent acts
via `browser_execute` JS, then observes). So:
- "requests fired since baseline" needs **no attribution signal** → P0, reuses baseline directly.
- "this control triggered these requests" needs an **action context** (`diff.focusedRef`, or an
  explicit caller-provided action ref) → P1.

Attribution uses the **timing window only** (requests with `seq > baseline.networkSeq`). We do NOT
parse the CDP `initiator.stack` to map to a DOM element — that is a JS call stack (script url/line),
not the triggering control; mapping it is brittle and per-site (overfitting smell). `initiator.type`
/`url` may be carried as *secondary evidence* labels only.

## 4. Design

### P0 — network-delta plane (passive, reuses baseline)  ✓ LANDED (slices 1–4, browser-verified)

1. `browser_observe(mode:scan)` records the network recorder's current **seq high-water mark**
   alongside the ABML snapshot (in `BrowserObservationSnapshotRegistry` + envelope `correlation`).
2. `browser_observe(mode:scan, baseline:X)` additionally queries network entries with
   `seq > X.networkSeq` (requests that fired since the baseline observation).
3. Each new entry → a `network-entry` Entity via the existing `stream.ts` builder, minting
   `pi-ref://network/<id>`.
4. Envelope top-level `causal: { sinceSeq, requests: DetectedRequest[] }` (budget-immune like
   diff/relations/inference). `DetectedRequest = { ref, method, url(redacted+truncated), status,
   type, at }`. Capped (like MAX_EVIDENCE_REFS) with a sibling count; no bodies; URL redacted.
5. **Recorder-not-active handling**: if no network recorder is active for the tab, emit
   `causal: { unavailable: "network recorder not active — start via browser_network start" }`.
   P0 does NOT auto-start the recorder (side-effect + boundary); the agent opts in.

This carries the request details inline in `causal.requests` (ref + method/url/status), so the
agent can read them directly — which also sidesteps the "evidence ref not resolvable in the
salience-subset `envelope.entities`" gap (see §7).

### P1 — attribution to a control  ✓ LANDED (browser-verified)

As shipped (`entity.ts`/`relations.ts`/`causal.ts`/`observeRunners.ts`/`registerObserveTool.ts`):

- Relation type `triggered` (control → network request) on `RelationType`, ordered high in
  `TYPE_ORDER` (after `expandedTarget`); new relation `source:"timing"`. The target is a
  `pi-ref://network/<id>` resolvable inline in `causal.requests` (NOT a graph entity), so the
  edges bypass the anchor→ref `materializeRelations` pass and attach via the exported
  `addEntityRelations` (same dedupe + per-entity cap).
- `buildTriggeredRelations(causal)` mints one edge per delta request (capped at
  `MAX_TRIGGERED_RELATIONS`), `confidence:"low"` — timing-window attribution, never an
  initiator-stack proof.
- Attribution signal: the explicit scan-only `actionRef` param, else the R3 `diff.focusedRef`,
  resolved by `resolveActionEntityRef`. **Focus robustness (the §7 risk) resolved:** a ref is
  accepted ONLY when it resolves to a `control`/`element` entity — a `focusedRef` (or `actionRef`)
  landing on a `frame`/`region` is rejected, so the delta is never mis-attributed. The passive P0
  behavior is preserved: with no trustworthy control, `causal` ships without `triggered`.
- Contract: `check:abml-causal` (P1 pure + envelope `relations.summary.triggered` lift + static
  wiring). Live: `smoke:browser:abml-causal` step C (browser-verified on Edge — `triggered` edge
  to the redacted `/api/ping2` ref, counted in `relations.summary`). The focus-only path proved
  fragile live (the documented reason the explicit `actionRef` exists).

### P2 — event causal entries + event-sourced attribution + stream plane  ✓ A + B + C LANDED

> Landed 2026-06-04: **A** (event causal entries) browser-verified via `smoke:browser:abml-causal`
> step D (console.error → `envelope.causal.events`, redacted); **B** (event-sourced attribution)
> verified deterministically through the envelope by the integration test + `check:abml-causal`
> (an event naming its element → `triggered` `source:"event"`/medium on that control), with a
> non-gating live DOM-sink probe (step E; live selector-match is fixture-sensitive). **C**
> (causal stream plane) landed: the previously-stubbed `read(plane:"network"|"event")` + the
> `stream.ts` capture-ref scaffold are activated into a cursor-based drain channel —
> browser-verified via `smoke:browser:abml-causal` step F (arm pins the cursor at the recorder
> high-water, drain returns a redacted `pi-ref://network/` stream entity + advances the cursor on a
> refreshed signal capture-ref; the event plane drained an event entity live too). Commits:
> `d003c38` `b746027` `1422b31` `4e6719e` `541c4b6` `1b02a1f` + the P2-C slice.

Extends the causal plane from network-only to **hook events** (console / DOM-sink / storage /
error / …), reusing P0/P1 machinery wholesale. Verified substrate (2026-06-04): `hook.collect`
already takes `since_seq` (seq-windowed, like `network.list`); each `HookEvent = { seq, type,
timestamp, data }`; DOM-sink events carry an `elementRef` (`{ nodeName, className, selector }`);
and `src/abml-core/stream.ts` already has a pure `buildEventEntity` scaffold (kind `event`, source
`hook`, `stream.eventType/phase/payloadHandle`) that was never populated.

- **A — event causal entries (primary):** envelope `causal` gains an `events` array alongside
  `requests`: events fired since the baseline observation. `CausalEvent = { ref:
  pi-ref://event/<seq>, type, at, summary(redacted+truncated), selector? }`. Pure-core selector
  `buildCausalEvents(events, sinceSeq)` mirrors `buildCausalSummary` (seq>baseline window, sorted,
  capped + count, redacted, no raw payloads). Runtime: a hook seq high-water mark on the
  observation snapshot (like `networkSeq`); on `baseline:X`, `hook.collect since_seq=X.hookSeq` →
  the delta. Recorder/hook not active → events simply omitted (same opt-in posture as P0; the agent
  arms hooks via `browser_hook`).
- **B — event-sourced attribution (secondary):** when a delta event carries an `elementRef.selector`
  that resolves to a control/element entity (the relation key space already has `s:<selector>`),
  hang a `triggered` edge from that control to the event ref with a STRONGER signal than P1's pure
  timing — `source:"event"`, higher confidence — because the event names its own target element.
  Pure timing (P1) stays the fallback when no element is named.
- **C — causal stream plane (cursor drain channel)  ✓ LANDED:** true server→model push is impossible
  in this request/response tool surface, so P2-C reduces to a **pull/cursor** drain: a long-lived
  `signal` capture-ref (`stream.ts` `createCaptureRef`, `streamState.lastSeq`) carries the cursor.
  `read(plane:"network")` / `read(plane:"event")` — the previously-stubbed planes
  (`runtime.ts` BACKEND_UNAVAILABLE) — now **arm** (no ref → cursor pinned at the recorder/hook
  high-water, no history replay) and **drain** (pass the prior captureRef → only what fired since the
  cursor), activating the dead `buildNetworkEntryEntity`/`buildEventEntity` builders. Entities are
  redacted by reusing `buildCausalRequest`/`buildCausalEvent` (raw url/payload never escapes) and
  carry the causal ref scheme (`pi-ref://network/<id>`, `pi-ref://event/<id>`) so they match
  `data.causal`. The cursor advances via the pure `latestSeq` and round-trips on a refreshed
  capture-ref. **Internal substrate only** (reached via Pi-native / `createBrowserAbmlIntegration`
  `readStream`); no new public tool, no protocol change. Solves the snapshot model's weak case:
  background async / polling / WebSocket frames + over-cap deltas, without a full DOM scan.

Boundaries unchanged: no new public tool, no schema change (reuse `hook.*`), pure-core stays pure,
redaction at the same contract, no per-site/stack heuristics.

## 5. Behavior boundaries

- No new public `browser_*` tool; P0 rides `browser_observe` baseline.
- No `bridge/native_command_schema.json` change; reuse existing `network.*` recorder commands.
- Pure-core boundary held: entity/builders/selection stay pure (`stream.ts`, a new pure
  `causal.ts` selector if needed); live network fetch stays in runtime. No npm import in abml-core.
- Privacy: URL redacted + truncated, no bodies, summary-level — same contract as evidence output.
- Explainability: P0 `causal` is explicitly "requests observed since baseline", NOT a claim of
  control attribution. Timing-window only; no initiator-stack parsing; no per-site branches.

## 6. Phases, contracts, acceptance

- **P0**: `check:abml-causal` (pure selection of seq>baseline + network-entry shape + redaction +
  envelope `causal` field + cap/count + recorder-unavailable path). Unit tests for the selector.
  Live: extend `smoke:browser:abml-inference` (or a new `smoke:browser:abml-causal`) —
  `browser_network start` → observe → `browser_execute` fires an XHR → observe(baseline) →
  assert `envelope.causal.requests` contains the XHR (redacted), and the unavailable path when
  the recorder is off.
- **P1** ✓: `check:abml-causal` extended (buildTriggeredRelations timing/low + cap;
  resolveActionEntityRef precedence + frame/region rejection; `triggered` lifted to
  `envelope.relations.summary`; static wiring). Live: `smoke:browser:abml-causal` step C —
  focus a control + fire `/api/ping2` → observe(baseline, actionRef) asserts the `triggered`
  edge on the control (browser-verified on Edge).
- **P2 (A+B)** ✓: `check:abml-causal` extended (buildCausalEvents seq-window + redaction + cap/count;
  event-sourced `triggered` `source:"event"`/medium via eventTriggeredByEntity when a delta event
  names its element; envelope `causal.events` lift). Live: `smoke:browser:abml-causal` step D
  (`browser_hook` console arm → fire console.error → observe(baseline) → `envelope.causal.events`
  redacted, browser-verified on Edge) + step E (non-gating DOM-sink attribution probe). B is proven
  deterministically by the integration test (the live element-selector match is fixture-sensitive).
  Slices delivered: 1 pure selector, 2 runtime wiring, 3 attribution, 4 smoke.
- **P2-C (causal stream plane)** ✓: `check:abml-causal` extended (pure `latestSeq` cursor-advance; a
  browser-free behavioral gate running `read(plane:"network")` arm→drain against a fake bridge + the
  real pi-ref store — redacted causal-scheme entities, cursor advance, refreshed signal capture-ref,
  recorder-inactive `unavailable`; static wiring: runtime implements both planes / no BACKEND_UNAVAILABLE,
  `integration.readStream` exposed). Unit/integration: `tests/unit/abml/verbs-stream.test.ts` (arm/drain,
  redaction, filter.sinceSeq escape hatch, both planes). Live: `smoke:browser:abml-causal` step F
  (gating network drain; event-plane drain non-gating but live-verified this run). No new public tool,
  no protocol change — pure internal substrate.
- Gate each phase on `npm run check` green + the live smoke.
- Update `docs/archive/abml-perception-state-evolution-plan.full.md` R3.x section as phases land.

## 7. Folded-in R3 quality findings (from the 2026-06-04 live smoke)

- **evidence-ref resolvable in output** ✓: `envelope.entities` is a salience subset, so an
  evidence ref can point outside it. P0 carries request details inline in `causal.requests` (not
  only a ref); P1's `triggered` edges target those same `pi-ref://network/<id>`, resolvable inline
  in `causal.requests` — no separate entity lookup needed.
- **focus robustness** ✓ (resolved in P1): `resolveActionEntityRef` accepts a `focusedRef`/`actionRef`
  ONLY when it resolves to a `control`/`element` entity; a ref landing on a `frame`/`region` is
  rejected (no mis-attribution). The explicit `actionRef` param is the robust path when live focus
  is unreliable — the smoke confirmed the focus-only path is fragile on real pages.

## 8. Out of scope (unchanged ABML non-goals)

- No vision/OCR expansion; no iframe AX aggregation; no public ABML verb tools; no orchestration
  revival. R3.x stays internal substrate surfaced through `browser_observe`.
