# ABML R3.x — network/API causal plane execution contract

> Status: **ACTIVE — P0 COMPLETE, P1 in progress** (activated 2026-06-04 by explicit user priority
> change). This is a new ABML main line; per project rules it gets its own execution contract and a
> CURRENT.md activation. The handoff conditions in `docs/abml-r3-runtime-events-execution-plan.md §6`
> are met: R3.1 entity diff is stable in model-facing output, and a real-page state-transition
> diff was live-verified (`npm run smoke:browser:abml-inference`, 2026-06-04).
>
> **P0 landed (2026-06-04):** passive network-delta plane shipped + browser-verified across 4
> commits — `99b9bf3` pure-core selector, `729aef6` runtime wiring (envelope `causal`),
> `ff319cd` contract `check:abml-causal`, `63a0bff` live smoke `smoke:browser:abml-causal` (Edge:
> `causal.unavailable`, seq high-water, redacted `/api/ping` delta). P1 (attribution) is now the
> active phase.

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

### P1 — attribution to a control  ← THIS PHASE

- Add a relation type `triggered` (control → network-entry) in `entity.ts` `RelationType` +
  `relations.ts` ordering; materialize via `materializeRelations`.
- Attribution signal: `diff.focusedRef`, or a new optional `browser_observe` param `actionRef`
  (the agent says "I just activated ref R"). Requests in the delta window hang on that control's
  subtree as `triggered`, `source:"timing"`.
- Risk to resolve here: focus robustness — the R3 `diff.focusedRef` can land on a `frame` entity
  rather than the activated control on a live page (observed 2026-06-04 in the post-action smoke).

### P2 — deferred

Event (non-network) causal entries; stronger attribution (hook `elementRef`/stack correlation);
live streaming/push. Each needs its own follow-up.

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
- Gate each phase on `npm run check` green + the live smoke.
- Update `docs/abml-perception-state-evolution-plan.md` R3.x section as phases land.

## 7. Folded-in R3 quality findings (from the 2026-06-04 live smoke)

- **evidence-ref resolvable in output**: `envelope.entities` is a salience subset, so an evidence
  ref can point outside it. P0 mitigates by carrying request details inline in `causal.requests`
  (not only a ref). When P1 mints control→request relations, ensure referenced network entities
  are resolvable (inline in `causal`, or a documented ref→entity lookup).
- **focus robustness**: `diff.focusedRef` can land on a frame, not the activated editable/control
  (breaks form-dependency and would break P1 attribution). Resolve in P1 (normalize focus to the
  deepest focusable entity, or accept an explicit `actionRef`).

## 8. Out of scope (unchanged ABML non-goals)

- No vision/OCR expansion; no iframe AX aggregation; no public ABML verb tools; no orchestration
  revival. R3.x stays internal substrate surfaced through `browser_observe`.
