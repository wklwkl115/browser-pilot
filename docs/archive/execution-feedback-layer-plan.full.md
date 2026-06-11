# Execution Layer Optimization Plan

## Status: Executed v3 (2026-06-11) - completed with Track C kept internal

This document is the executed contract for the execution-side counterpart to the perception layer.
It supersedes the v1 `diagnose: true` idea and the v2 narrow A/B/C draft.

Execution result:

- Track A/D/E shipped: default cheap `effect` facts, shared page signals, execution journal, and
  monitor correlation cleanup are implemented and verified.
- Track B shipped: coordinate-addressed physical `input.*` commands are implemented, ABML internal
  click/type fallback now converges through them, and the canvas blind run adopted `input.pointer`.
- Track C implemented but not publicly guided: `pi.*` injection remains an explicit-marker,
  opt-out internal convenience (`PI_BROWSER_STDLIB=0`), with namespace/compatibility tests. The
  form-fill blind run completed the task but ignored `pi.resolve`/`pi.setValue`, so the plan's
  honest revert clause is applied as "keep Track C internal/underdocumented until product-shape
  evidence changes".
- Track F shipped for the adopted pieces: skill/README guidance promotes `effect`, `monitor:true`
  boundaries, and `input.pointer` / `input.keys`; it does not ask agents to use `pi.*`.

## Current Substrate Facts

These facts were checked against the current tree and should not be rediscovered during
implementation:

| Fact | Current location | Consequence |
|---|---|---|
| `content.fingerprint` exists and the content observer already watches `childList`, `subtree`, `attributes`, and `characterData` | `bridge_src/page_scripts/content.ts` | Attribute toggles and in-place text edits are already visible to the fingerprint. The old A4 observer upgrade is complete and must not stay as a TODO. |
| Observe cache hardening is already in place: fingerprint tuple, TTL from original `renderedAt`, params signature, cache-hit ledger frame, artifact save | `src/tools/observeRunners.ts` | Execution feedback should reuse these readers instead of adding another observer. |
| `readPageFingerprint()`, `readNetworkRecorderSeq()`, and `readHookRecorderSeq()` are shared signal helpers | `src/tools/pageSignals.ts` | Observe/execute/command use one signal source; do not reintroduce duplicate reader logic. |
| `browser_execute` now emits cheap `effect` facts by default, while `monitor:true` remains the heavy semantic before/after read | `src/tools/registerExecuteTool.ts` | Keep default effect fact-only and keep monitor as opt-in semantic comparison. |
| `browser_command` already routes write commands through the same queue/lease machinery as execute based on protocol `accessMode` | `src/driver/BrowserBridgeCommandService.ts` and `bridge/native_command_schema.json` | Input gesture commands only need schema `accessMode:"write"` to inherit write safety. |
| Persistent CDP supports logical session names, precompile, and per-session script caches | `bridge_src/service_worker/cdp.ts` | Physical input and execute stdlib must choose session names deliberately and avoid serializing unrelated CDP work. |
| `pi-ref://` records already carry descriptor locators, owner, TTL, etag, and policy | `src/resources/resourceStore.ts` | Ref dereference can embed the existing locator bundle; it must not reconstruct locators from rendered summaries. |
| `browser_execute` first tries MAIN-world `chrome.scripting.executeScript`, then falls back to CDP `Runtime.evaluate` | `bridge_src/service_worker/exec.ts` | Any page-world stdlib changes execution source text; its compatibility and world/prototype claims need contract tests. |

## Problem

Two problems were previously conflated:

**P-1 - Post-return feedback gap.** A `browser_execute` script's horizon ends at its own `return`.
It can inspect everything before return, but it cannot see late DOM mutations, navigation,
network requests, hook events, or target selection drift after the script completes.

**P-2 - Execution mechanics live in the wrong places.** Deterministic mechanics are split across
internal ABML code, skill prose, and agent-written snippets:

| Mechanical knowledge | Where it lives today | Defect |
|---|---|---|
| Trusted event sequences (`mouseMoved` -> `mousePressed` -> `mouseReleased`, buttons and click count bookkeeping) | `src/abml/verbs/runtime.ts` | Publicly reachable only by hand-assembling raw CDP calls through `browser_command`. |
| Controlled input value protocol (native setter -> `input`/`change`) | skill prose | Untested and repeatedly retyped by agents. |
| Ref -> live DOM node resolution | no public runtime helper | Agents copy a single `hints.selector` string and lose ABML's multi-locator binding. |
| In-script settling (act, wait for quiet, then read) | ad hoc `setTimeout` polling | Long polls burn tool timeout and bridge lease budget. |
| Execution evidence journal | scattered operation/artifact metadata | Dispatch facts, effect facts, and monitor facts do not share one compact schema. |

The grounded frictions are not "the tool should diagnose why a click failed." They are:

1. The agent lacks cheap post-return consequence facts.
2. The agent has to hand-code physical input and controlled input protocols.
3. The agent has to transcribe locators from perception to execution.
4. The agent cannot cheaply chain execute -> observe using a shared anchor.
5. The result artifact does not yet read like an execution timeline.

## Design Principles

1. **Facts, not verdicts.** The tool reports observed consequences and structured misses. It never
   claims "verified", never infers intent, and never emits strategic recovery categories.
2. **Reuse sensors.** Use the existing content fingerprint, network seq, hook seq, operation
   registry, result artifacts, and perception ledger. Do not add a second MutationObserver or a
   parallel telemetry plane.
3. **Refs are bidirectional coordinates.** Perception emits refs; execution may dereference those
   refs mechanically. The agent still chooses which ref and what action.
4. **Addressing and physics are allowed; semantic verbs are not.** `input.pointer` encodes
   deterministic physical mechanics. The `pi.resolve` / `pi.box` / `pi.setValue` stdlib exists as
   an internal explicit-marker convenience but is not public agent guidance after the blind adoption
   result. `pi.click`, `input.submit`, auto-retry, and intent verification are permanently out.
5. **Default feedback must be cheap.** The default effect block is a small consequence sensor.
   Heavy semantic before/after comparison remains opt-in `monitor:true`.
6. **Artifacts are the evidence source.** Model-facing summary stays short; full dispatch/effect
   journal lives in the artifact with redaction and bounded shape.

## Architecture Overview

```
Perception substrate                         Execution layer
--------------------                         ----------------
entities + pi-ref locators   ----------->    C: internal pi.resolve / pi.box convenience
fingerprint / network seq     ----------->    A: effect block
hook seq / causal plane        ----------->    A/B/D: effect + journal
operation registry/artifacts   ----------->    D: execution timeline
browser_command protocol       ----------->    B: input.* physical gestures
```

## Act Lifecycle Contract

Every act decomposes into four stages. Report the stage and facts; leave semantic judgment to the
agent.

| Stage | Facts | Source |
|---|---|---|
| precondition | target tab, lease state, ref lookup miss, ref stale/expired, locator strategies tried | driver + `resourceStore` + stdlib |
| actuation | JS path used, CDP session name, gesture event count, focus emulation attempted | execute/command/input engine |
| settlement | mutation delta, quiet window, navigation, target selection drift | shared page signals |
| attribution | network seq delta, hook seq delta, causal anchor for next observe | shared page signals + observe causal plane |

## Track A - Shared Execution Signals and Effect Block

This is the corrected feedback layer. It replaces v1 `diagnose` with cheap observable deltas.

### A1 - Move signal readers into `pageSignals`

Create `src/tools/pageSignals.ts` and move these helpers there as the single source of truth:

- `normalizePageFingerprint()`
- `readPageFingerprint()`
- `readNetworkRecorderSeq()`
- `readHookRecorderSeq()`
- `queryNetworkDelta()` and `queryHookDelta()` only if Track D needs artifact-side samples; otherwise
  leave the heavy query helpers in observe.

Consumers:

- `src/tools/observeRunners.ts`
- `src/tools/registerExecuteTool.ts`
- `src/tools/registerCommandTool.ts` for write-command effect coverage

Behavior requirement: observe cache behavior must stay byte-identical after relocation. Do not
duplicate the same reader logic in observe and execute.

### A2 - Default effect block for `browser_execute`

In `src/tools/registerExecuteTool.ts`, collect before/after signals around the normal
`server.executeJavaScript()` call:

```ts
type ExecuteEffect = {
  mutations: number;
  settled: boolean;
  navigated: boolean;
  visibleDelta: number;
  interactiveDelta: number;
  requestsFired?: number;
  hookEventsFired?: number;
  targetDelta?: {
    selectionVersionBefore?: number;
    selectionVersionAfter?: number;
    tabIdBefore?: number;
    tabIdAfter?: number;
  };
  anchor?: {
    changeSeq?: number;
    networkSeq?: number;
    hookSeq?: number;
  };
};
```

Summary shape is one compact field, for example:

```json
{"effect":{"mutations":2,"settled":true,"requestsFired":1}}
```

Full details live in the artifact under `execution.effect`. The field is fact-only; `mutations:0`
and `requestsFired:0` are not called failure.

Default: on. Escape hatch: `PI_BROWSER_EXECUTE_EFFECT=0`, making output byte-identical to the
current non-monitor path except for existing operation/artifact fields.

### A3 - Effect block for tab-scoped write `browser_command`

Wrap only commands whose protocol plan resolves to tab-scoped `accessMode:"write"`. Read commands
remain unchanged. The first user-facing target is Track B `input.*`, but this helper should be
generic enough to cover existing write commands such as `wait.navigateAndWait` when invoked through
`browser_command`.

Implementation location:

- shared helper in `src/tools/executionEffect.ts`
- used by `registerExecuteTool.ts` and `registerCommandTool.ts`

Do not collect effect for non-tab-scoped commands (`tabs.list`, `management.list`, cookies, etc.).

### A4 - Monitor convergence, not monitor removal

`monitor:true` remains the heavy semantic before/after read. Change it to reuse the same
pre/post signal snapshot as the default effect block so it does not perform duplicate
fingerprint/network/hook reads.

Contract:

- `monitorSource` remains for compatibility.
- New `effect` is always present when enabled, including on `monitor:true`.
- `monitor:true` adds semantic diff fields; it does not replace `effect`.

### A5 - Mechanical effect hints

Only two hints are allowed, both factual:

- `navigated:true` or target tab drift -> "tab identity may have changed; list/switch tabs if the
  next call is tab-scoped".
- nonzero network/hook delta with an anchor -> point to the existing observe baseline/causal path.

No failure classes, no `retry`, no `use-cdp`, no semantic recommendations.

**Verification**

```bash
npx tsx --test tests/unit/tools/execute-effect.test.ts
npx tsx --test tests/unit/tools/command-effect.test.ts
npm run check:tools
npm run check:runtime-fixtures
npm run smoke:browser:scan-summary
npm run check
```

## Track B - Physical Gesture Commands (`input.*`)

Add structured physical input to `browser_command`. This promotes existing internal CDP event
mechanics into a public physical layer without adding semantic action verbs.

### B1 - Protocol schema

Add domain `input` to `bridge/native_command_schema.json`:

```json
{
  "input.pointer": {
    "domain": "input",
    "tabScoped": true,
    "accessMode": "write",
    "required": ["gesture", "x", "y"]
  },
  "input.keys": {
    "domain": "input",
    "tabScoped": true,
    "accessMode": "write",
    "requiredAny": [["text"], ["keys"]]
  },
  "input.touch": {
    "domain": "input",
    "tabScoped": true,
    "accessMode": "write",
    "required": ["gesture", "x", "y"]
  }
}
```

Parameter contract:

- `input.pointer`: `gesture:"press"|"drag"|"wheel"|"hover"`, `x`, `y`, `button?`,
  `count?`, `path?`, `deltaX?`, `deltaY?`, `modifiers?`
- `input.keys`: `text?`, `keys?: [{key, modifiers?}]`
- `input.touch`: `gesture:"tap"|"swipe"`, `x`, `y`, `path?`

Naming is physical. Do not introduce `click`, `type`, `submit`, or ref-addressed gestures.

### B2 - Service-worker sequence engine

New file: `bridge_src/service_worker/input.ts`.

Responsibilities:

- pointer event expansion (`mouseMoved` -> `mousePressed` -> `mouseReleased`)
- drag interpolation
- wheel dispatch
- keyboard `insertText` vs key event table
- modifier bookkeeping
- best-effort `Emulation.setFocusEmulationEnabled` for background tabs
- one bridge command -> one ACK/result

Session strategy: use a named persistent CDP session such as `pi-input` so input dispatch does not
serialize with `pi-script-eval` scan/content extraction.

### B3 - Internal engine convergence

Replace the duplicated visual/trusted-click/type CDP snippets in `src/abml/verbs/runtime.ts` with
calls to the new `input.*` command path. Existing internal ABML behavior is contract-locked; this is
mechanical convergence, not a new public ABML action surface.

### B4 - Dispatch journal and redaction

Every `input.*` result artifact records:

- gesture type
- event types dispatched
- coordinate facts
- focus emulation attempt/result
- CDP session name
- elapsed time

For `input.keys`, do not write raw inserted text to the model-facing summary or dispatch journal.
Store `charCount`, key names for non-printable keys, and redacted text metadata only.

**Verification**

```bash
npm run sync:protocol
npm run check:protocol
npm run check:all:bridge
npm run check:abml-ax-runtime
npm run smoke:browser
```

## Track C - `pi.*` Page-World Stdlib

A minimal library available inside the JavaScript the agent already writes for `browser_execute`.
It is not a new public tool and not a structured action parameter. Final public-guidance status:
**internal/underdocumented**. The implementation exists for explicit use and testing, but the
form-fill blind adoption run did not naturally use it, so it is not promoted in `SKILL.md`.

### C1 - Compatibility-preserving injection

New file: `src/tools/executeStdlib.ts`.

Inject the prelude only when the script text contains `pi.` or a `pi-ref://` literal. Injection must
preserve the current `browser_execute` script semantics:

- Do not wrap user code in a way that changes top-level `return`, implicit-return behavior, or error
  serialization from `bridge_src/service_worker/exec.ts`.
- Contract-test `buildExecScript()` with and without the stdlib marker.
- `PI_BROWSER_STDLIB=0` disables injection and restores current byte behavior.

### C2 - Ref dereference and geometry

Server side:

- scan script text for `pi-ref://...` literals
- call `resolveRefUriDetailed()`
- embed only the resolved descriptor's locator bundle, owner, etag/freshness, and captured geometry

Page side:

- `pi.resolve(ref)` returns `{ el, freshness, tried }`
- `pi.box(ref)` returns current viewport CSS-px geometry

Resolution order is the existing locator order: css -> text anchor/role -> point/geometry. Misses
return tried-strategy facts and never throw automatically.

### C3 - Controlled input and settling

Exports:

- `pi.setValue(el, text)` - native setter plus `input`/`change` dispatch
- `pi.settled({ quietMs = 300, maxMs = 3000 })` - explicit MutationObserver quiet window

No implicit wait inside `pi.resolve`, `pi.box`, or `pi.setValue`.

### C4 - Prototype and world honesty

The prelude can snapshot prototypes before the agent's own script runs, but it cannot undo page
prototype poisoning that occurred before execution in MAIN world. Therefore:

- Do not document `pi.*` as a security boundary.
- `pi.resolve` is a convenience and transcription-elimination layer.
- For adversarial or canvas/trusted-event cases, the honest path is observe/box/screenshot plus
  Track B physical input.

This replaces v2's overly strong "not poisonable" claim.

### C5 - Namespace ratchet

Contract test pins the namespace exactly:

```txt
resolve
box
setValue
settled
```

The test rejects verb-shaped names (`click`, `type`, `submit`, `retry`, `waitAndClick`, etc.).

**Verification**

```bash
npx tsx --test tests/unit/tools/execute-stdlib.test.ts
npx tsx tests/contracts/tools/check-execute-stdlib.mjs
npm run check:page-scripts
npm run check:tools
npm run smoke:browser
npm run check
```

## Track D - Execution Journal and Artifact Schema

Track D makes execution evidence readable and stable. It is not a new capability; it is the schema
that prevents A/B/C from scattering facts across unrelated result fields.

### D1 - One execution timeline schema

Add `src/tools/executionJournal.ts`:

```ts
type ExecutionJournal = {
  version: 1;
  operationId?: string;
  target?: {
    tabId?: number;
    browserSessionId?: string;
    selectionVersionAtDispatch?: number;
    selectionVersionAtResolve?: number;
  };
  dispatch?: {
    kind: "javascript" | "native-command" | "input";
    command?: string;
    cdpSessionName?: string;
    eventCount?: number;
    text?: { redacted: true; charCount: number };
  };
  effect?: ExecuteEffect;
  monitor?: Record<string, unknown>;
  stdlib?: {
    used: boolean;
    refsEmbedded?: number;
    resolveMisses?: number;
  };
};
```

Tool artifacts write this under `execution`. Model-facing summaries lift only short derived fields
(`effect`, `piRuntime`, `input` dispatch count).

### D2 - Redaction and size guards

The journal must never be a raw script or raw input-text dump:

- raw script source stays where current artifacts already put it, governed by existing result
  redaction/budget behavior
- key text is summarized by length and redaction marker
- coordinate arrays are capped
- full event lists are artifact-only and bounded

### D3 - Correlation continuity

When effect anchors exist, copy them into the journal and summary so the next observe can use:

- prior observe `baseline` / snapshot id for treeDiff
- network/hook seq for causal windows

Do not invent a new public `effectAnchor` parameter until an implementation proves the existing
`baseline`/snapshot path cannot consume the anchor. For this plan, expose facts, not a second
baseline system.

**Verification**

```bash
npx tsx --test tests/unit/tools/execution-journal.test.ts
npm run check:summaries
npm run check:token-economy
npm run smoke:browser:correlation-chain
npm run check
```

## Track E - Monitor and Observe Correlation Cleanup

This track is a small compatibility cleanup after A/D.

### E1 - Keep `monitor:true` as the heavy semantic diff

No contract break:

- `monitorSource` stays in summaries.
- Existing smoke `smoke:browser:abml-monitor-comparison` remains valid.
- New `execution.effect` and old monitor fields point to the same operation id.

### E2 - Avoid double post-action reads

When `monitor:true` is set:

- use A's pre/post signal snapshots
- run the heavy before/after ABML read only once per side
- do not separately query network/hook/fingerprint again inside monitor code

### E3 - Documentation position

Docs should present:

- default `effect`: cheap consequence facts
- `monitor:true`: expensive semantic comparison
- `browser_observe baseline`: full perception diff/causal read

This prevents users from treating monitor as a default verification system.

**Verification**

```bash
npm run smoke:browser:abml-monitor-comparison
npm run smoke:browser:correlation-chain
npm run check:tool-docs
npm run check
```

## Track F - Skill and Agent Adoption Pass

This is last because documentation must not advertise unimplemented capability.

Update:

- `skills/pi-browser-tools/SKILL.md`
- `README.md`
- generated tool docs via `npm run docs:generate`
- `docs/abml-tool-coverage-map.md`

Skill guidance changes:

1. Use `browser_execute` for page JS and read the cheap `effect` facts after actions.
2. Use `monitor:true` only when a semantic before/after scan is worth the cost.
3. Use `input.pointer` / `input.keys` for trusted-event, canvas, WebGL, or cross-origin iframe
   physical input.
4. Never ask the tool to verify intent.

### F1 - Real-agent adoption gate

Track C and the canvas/trusted-event branch of Track B must earn their public guidance with a
blind-agent adoption run, not only fixture replay. Add two blind task classes:

- form fill with controlled inputs, where the useful path is `browser_observe` -> `pi.resolve` ->
  `pi.setValue` -> `effect`
- canvas or trusted-event interaction, where the useful path is `browser_observe` / screenshot or
  `pi.box` -> `input.pointer`

Metrics:

- whether blind agents use `pi.resolve` / `pi.setValue` without being directly prompted
- whether blind agents use `input.pointer` for the canvas/trusted-event task without falling back
  to three raw CDP calls
- selector transcription errors (target: zero when `pi.resolve` is adopted)
- round-trip count vs. current skill guidance

Honest revert clause: if blind agents ignore `pi.*` the way they ignored the reverted action arm,
Track C is reverted or kept undocumented/internal until the product shape changes. Track A/D stand
on their own, and Track B may remain if the canvas/trusted-event task shows adoption.

Outcome (2026-06-11):

- `ef-form-pi-resolve`: completed successfully, but the blind agent used selector-based raw
  `browser_execute` JS and did **not** adopt `pi.resolve` / `pi.setValue`. Track C public guidance
  failed the adoption bar and is kept internal/underdocumented.
- `ef-canvas-input-pointer`: completed successfully; the blind agent used `browser_command`
  `{cmd:"input.pointer", gesture:"press", x, y}` rather than raw CDP mouse events. Track B public
  guidance passed this adoption bar.

**Verification**

```bash
npm run docs:generate
npm run check:tool-docs
PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools
npm run eval:browser-workflows -- --fixture-server --eval 02-scan-execute-wait
npm run eval:blind:launch
npm run check
```

## Execution Order

1. **Activation entry when the owner starts implementation**: copy the `CURRENT.md` decision block
   below, then execute the tracks in this order.
2. **A + D first**: shared signals, default effect block, and execution journal. This is the
   smallest useful ship and gives every later track a common evidence schema.
3. **E next**: monitor convergence while the execute code is still hot.
4. **B next**: protocol change for `input.*`, then internal ABML sequence convergence.
5. **C next**: stdlib, after journal/effect can report its use and misses.
6. **F last**: docs/skill/eval adoption after capability exists.

Each phase is independently revertable:

- A/D can be disabled with `PI_BROWSER_EXECUTE_EFFECT=0`.
- B is isolated behind `input.*` commands and protocol sync.
- C is disabled by `PI_BROWSER_STDLIB=0`.
- E is compatibility-only and should not change monitor's public meaning.

## Completion Block for `CURRENT.md`

```markdown
### Execution feedback layer optimization (2026-06-11, 完成)

Decision: execute the broadened execution feedback plan v3, now archived at
`docs/archive/execution-feedback-layer-plan.full.md`. Default execution gains cheap factual effect
reporting built on existing page fingerprint, network seq, hook seq, operation, and artifact
substrates. Physical input is exposed only as coordinate-addressed `input.*` bridge commands. `pi.*`
was implemented as an explicit-marker internal page-world stdlib, but it did not pass the blind
adoption bar for public guidance.

Boundary: no public semantic action verbs, no `mode=auto`-style execution guessing, no
`diagnose:true`, no failure taxonomy, no intent verification, no auto-retry, no ref-addressed
gestures. Existing `browser_execute monitor:true` remains the heavy semantic before/after read.
Default effect facts are cheap and factual only. Track C remains internal/underdocumented and does
not claim a security boundary against pre-existing page-world prototype poisoning.

Contract: `browser_execute` and tab-scoped write `browser_command` calls may include compact
`effect` facts unless `PI_BROWSER_EXECUTE_EFFECT=0`. Full execution journal lives under
artifact `execution`. `input.*` commands are write access and inherit tab lease/queue semantics.
`piRuntime:"1"` appears only when stdlib is injected; namespace is pinned to
`resolve`, `box`, `setValue`, `settled`, but skill/README guidance does not promote `pi.*` after
the blind result.

Verification: passed the track-specific gates plus real browser smoke. The blind adoption gate
produced a split result: form-fill succeeded but ignored `pi.resolve` / `pi.setValue`, so Track C
stayed internal; canvas/trusted-event succeeded with `input.pointer`, so Track B public guidance
remains.
```

## Cost Budget

| Item | Round trips | Latency | Model tokens |
|---|---:|---:|---:|
| Effect block | two lightweight signal reads around the write | about 2-15 ms; optional 150 ms quiet reread only when mutation delta is nonzero | one short object |
| Heavy monitor | current before/after ABML reads | unchanged or lower after signal reuse | unchanged compatibility field |
| `input.pointer` press | one native command instead of three raw CDP commands | saves two Node-extension round trips | one short dispatch summary |
| internal `pi.resolve` | zero extra bridge round trips after descriptor embedding | in-page only | no model tokens |
| Execution journal | artifact-only full detail | no extra runtime work beyond A/B/C | summary lifts only small fields |

Expected practical effect: common execution flows gain cheap post-action `effect` facts and a stable
execution journal; trusted-event/canvas flows use one physical `input.pointer` command instead of
hand-expanded raw CDP mouse events. The proposed selector-transcription reduction via `pi.*` did not
earn public guidance in blind eval and remains internal.

## Closed Designs

| Design | Decision |
|---|---|
| `browser_execute diagnose:true` | Rejected. It guessed intent from script text and produced post-hoc actionability claims. |
| Regex selector extraction from script | Rejected. Variables, templates, stored elements, and read-only extraction scripts make this unsound. |
| Post-action occlusion/disabled probe | Rejected. Actionability is a pre-action property and post-action probes misattribute successful UI changes. |
| `failureClass` taxonomy | Rejected. It hides uncertainty behind false categories. |
| `recoveryHint` action enum | Rejected. Tool-level strategy. |
| Public semantic action verbs or `pi.click`/`pi.type` | Rejected by the existing B2 tombstone and reaffirmed here. |
| Ref-addressed physical gestures (`input.pointer {ref}`) | Rejected. It mixes addressing failures into the physical layer; use `pi.box(ref)` then coordinates. |
| Claiming stdlib prototype hardening as a security boundary | Rejected. MAIN-world prelude cannot undo pre-existing page poisoning. |

## Out of Scope

| Item | Reason |
|---|---|
| Intent verification | Task-level judgment. |
| Auto-retry / auto-downgrade / auto-wait | Strategy hidden inside tools. |
| Vision-based auto-aiming | Perception supplies regions; the agent aims. |
| `navigator.webdriver` or debugger infobar concealment | Trust-ladder residue outside this layer. |
| Cross-origin iframe DOM dereference | Browser security boundary. Physical input by coordinates remains available. |
| Canvas/WebGL semantic feedback | Use screenshot/network/evidence; content fingerprint cannot see redraws. |
