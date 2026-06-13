# Execution-Plane CDP Fusion Plan

> Status: **completed implementation** (2026-06-14). The workstream landed
> dispatch-only `pi.click(ref)` through an execute-time privileged binding to
> internal `input.ref`, with ABML remaining perception-only and no public
> `browser_*` tool or `browser_execute action:{...}` surface added.
> Scope: `src/tools/executeStdlib.ts`, `bridge/native_command_schema.json`,
> generated native protocol mirrors, `bridge_src/service_worker/input.ts`,
> `bridge_src/service_worker/exec.ts`, runtime/contracts/eval fixtures, README,
> skills, and generated bridge dist.
> Boundary: no ABML actuator/runtime restore, no `pi.type`/upload/download, no
> OOPIF routing, no semantic success verification inside the command.
> Closure: archived per `docs/document-structure.md` after focused gates,
> runtime fixture eval 31, docs sync, and final full `npm run check`.

## Completed Outcome

- Added internal native command `input.ref` for dispatch-only physical click.
  Backend-node targets use `DOM.scrollIntoViewIfNeeded` + `DOM.getBoxModel`
  first and fail closed on stale/cross-target resolution instead of falling
  back to points. Descriptors without backend identity may use the explicit
  point tier.
- Added `pi.click(ref, options?)` to the execute stdlib only when referenced.
  The page prelude sends safe target facts through a per-execute
  `Runtime.addBinding`; the service worker invokes the local `input.ref`
  handler and resolves/rejects the page promise through explicit response
  injection.
- Kept ABML perception-only. No actuator paths were added under
  `src/abml-core/` or `src/abml/verbs/runtime.ts`.
- Added runtime and contract coverage for stale backend failure, point tier,
  no nested Node write, disabled stdlib mode, and exactly one new stdlib action
  name: `pi.click`.
- Added eval 31 fixture proving a trusted-event-gated control ignores raw
  `el.click()` but accepts the CDP physical input path. The eval records the
  old two-action fallback (`browser_execute` measurement +
  `browser_command input.pointer`) and the fused one-action execute path.
- Enabled service-worker/offscreen syntax minification while preserving
  non-minified identifiers; the generated service-worker bundle closes at
  408,051 bytes, below the `<416,000` budget.

## Closure Evidence

- Focused gates passed:
  `npm run check:bridge:types`,
  `npm run check:bridge:build`,
  `npm run check:bridge:files`,
  `npm run check:abml-verb-runtime`,
  `npm run check:tools`,
  `npm run check:protocol`,
  `npm run check:runtime-fixtures`,
  `npm run check:eval-workflows`,
  `npm run check:browser-workflow-results`.
- Runtime eval passed:
  `npm run eval:browser-workflows -- --fixture-server --eval 31-execution-plane-cdp-fusion --timeout-ms 120000`.
- Eval artifact directory:
  `.pi/browser-artifacts/eval-browser-workflows/2026-06-13T16-36-16-306Z-d97b6642`.
- Eval summary:
  `.pi/browser-artifacts/eval-browser-workflows/2026-06-13T16-36-16-306Z-d97b6642/browser-workflow-eval-summary.json`.
- Eval dispatch artifact:
  `.pi/browser-artifacts/eval-browser-workflows/2026-06-13T16-36-16-306Z-d97b6642/31-execution-plane-cdp-fusion-pi-click.json`.
- Sample committed result:
  `evals/browser-workflows/results/31-execution-plane-cdp-fusion.result.json`.

## Objective

Collapse the current trusted-input escape path from two agent-managed tool calls into one
`browser_execute` script path:

```text
today: browser_execute measures/chooses target -> browser_command input.pointer dispatches
target: browser_execute JS calls pi.click(ref) -> SW resolves ref by backendNodeId and dispatches CDP input
```

The new path is physical input sourced below the JS sandbox. It uses the ABML/ref descriptor as input,
but execution remains in the bridge/runtime layer. The plan does not restore the reverted
`browser_execute action:{...}` surface and does not add a public `browser_*` tool.

## Current Facts

- `browser_execute` is raw JavaScript only. The public fallback for trusted-event-gated controls is
  `browser_command` with `input.pointer` / `input.keys`.
- `src/tools/executeStdlib.ts` currently exposes only `resolve`, `box`, `setValue`, and `settled`;
  `tests/contracts/tools/check-execute-stdlib.mjs` intentionally rejects `pi.click` and `pi.type`.
- ABML is perception-only. `tests/contracts/tools/check-abml-verb-runtime.mjs` locks out actuator
  verbs and direct `input.pointer` / `input.keys` dispatch from ABML runtime code.
- SW physical input already exists at `bridge_src/service_worker/input.ts` as coordinate-keyed
  `Input.dispatchMouseEvent`, `Input.insertText`, and `Input.dispatchTouchEvent`.
- SW page-to-privileged callback mechanics already exist through `Runtime.addBinding` /
  `Runtime.bindingCalled` in `bridge_src/service_worker/wait_selector.ts`.
- `backendNodeId` exists on many merged AX/DOM descriptors and survives descriptor storage into the
  execute stdlib registry, but page-world `pi.resolve()` cannot use it. It is a CDP-side identity.

## Contract Decisions

1. **Explicit namespace reopen.** This workstream deliberately reopens the stdlib namespace ratchet
   for a narrow physical-input primitive. The first accepted API is:

   ```js
   await pi.click(ref, options?)
   ```

   It means "dispatch a CDP physical pointer press against this ref"; it does not mean
   "verify user intent", "retry until semantic success", or "run an actionability ladder".
   `pi.type`, `pi.setFiles`, and `pi.download` are out of scope for this workstream.

2. **No ABML execution.** `src/abml-core/` and `src/abml/verbs/runtime.ts` remain perception-only.
   The descriptor is consumed by execution; execution logic is not added to ABML.

3. **One new native command, internal-first.** Add one bridge command:

   ```json
   {
     "cmd": "input.ref",
     "action": "click",
     "target": {
       "refId": "pi-ref://control/submit",
       "backendNodeId": 123,
       "point": { "x": 40, "y": 20 }
     }
   }
   ```

   It is tab-scoped, write-mode, and routed under the existing `input` domain. It is callable through
   `browser_command` for diagnostics, but public guidance remains `browser_execute` + `pi.click` after
   runtime proof. The initial normalized error codes are:
   - `BACKEND_NODE_STALE`: `DOM.getBoxModel` reports no current node for a supplied backend id.
   - `OOPIF_SESSION_UNSUPPORTED`: the backend id cannot be resolved in the current tab CDP target.
   - `INVALID_REF_TARGET`: the target lacks both backend id and point fallback.

4. **Backend identity first, point only as the explicit gap tier.**
   - If `backendNodeId` is present, the command must use it.
   - If `backendNodeId` is present but `DOM.getBoxModel` fails, return a structured fail-closed
     result. Do not silently fall back to point for that descriptor.
   - If no `backendNodeId` exists and a descriptor point exists, dispatch at that point and mark
     `resolution:"point"`.

5. **No intent verification inside the command.** The command reports dispatch facts only. It may
   report stale/detached target failure, but swallowed-yet-live clicks are learned through the
   existing execute `effect`, `pi.settled()`, or the next `browser_observe`.

6. **No nested Node write.** `pi.click` must not call back into `BrowserBridgeCommandService.sendCommand`.
   The binding is serviced inside the in-flight SW execute request, so it does not enqueue a second
   tab write or contend with its parent lease. The binding is a request/response RPC:
   - the page prelude allocates a request id and promise;
   - the page calls the per-execute `Runtime.addBinding` function with the request payload;
   - the SW receives `Runtime.bindingCalled`, invokes the local `input.ref` handler directly, then
     resolves/rejects the page promise through a bounded response injection;
   - cleanup removes the binding and rejects any unresolved request on timeout/cancel.

7. **Same-target first.** The first landing supports the top-level tab CDP target only. OOPIF routing
   is a closed out-of-scope item for this workstream; a backendNodeId that cannot be resolved in the
   current tab session fails closed with `OOPIF_SESSION_UNSUPPORTED` or `BACKEND_NODE_STALE` diagnostics
   rather than guessing another session.

## Implementation Plan

### P0 - Activate and Reopen the Stdlib Contract

Files:

- `CURRENT.md`
- `docs/execution-plane-cdp-fusion-plan.md`
- `tests/contracts/tools/check-execute-stdlib.mjs`
- `tests/unit/tools/execute-stdlib.test.ts`
- `docs/abml-tool-coverage-map.md`

Actions:

1. Add a `CURRENT.md` active entry naming this plan, the no-ABML/no-new-tool/no-action-param boundary,
   and the verification commands below.
2. Change the stdlib contract from "no semantic action verbs" to "only `pi.click` is allowed, and only
   as dispatch-only physical input".
3. Add a unit test that ordinary scripts and existing `pi.resolve` / `pi.box` behavior remain
   byte-compatible when the new click path is not referenced.
4. Update ABML coverage docs to state that this is not an ABML actuator restore.

Verification:

```bash
npm run docs:sync
npm run check:doc-structure
npm run check:docs-sync
npx tsx --test tests/unit/tools/execute-stdlib.test.ts
npm run check:abml-verb-runtime
npm run check:tools
git diff --check
```

### P1 - Add SW `input.ref` Backend-Node Physical Click

Files:

- `bridge/native_command_schema.json`
- `src/protocol/nativeProtocol.ts` (generated)
- `bridge_src/service_worker/protocol.ts` (generated)
- `bridge_src/service_worker/ref_action.ts` for ref-targeted CDP dispatch
- `bridge_src/service_worker/input.ts` for shared pointer helpers if needed
- `bridge_src/service_worker/runtime.ts` for `input.ref` routing
- `tests/contracts/protocol/check-protocol-contract.mjs` or a new focused input-ref contract
- `tests/contracts/runtime/` for a fake-CDP command contract if the existing harness can host it

Actions:

1. Add `input.ref` to the native command schema under the `input` domain:
   - `tabScoped:true`
   - `accessMode:"write"`
   - required: `action`, `target`
   - accepted first action: `"click"` only
2. Implement `input.ref` as one SW handler:
   - select `backendNodeId` by locator identity, never by locator array position
   - optionally call `DOM.scrollIntoViewIfNeeded { backendNodeId }`
   - call `DOM.getBoxModel { backendNodeId }`
   - compute viewport center from the returned box model
   - dispatch `mouseMoved`, `mousePressed`, `mouseReleased` through existing CDP input helpers
   - keep box lookup and dispatch co-located in this SW handler under the same logical CDP channel name
3. Add point-tier dispatch only for descriptors with no `backendNodeId`.
4. Return compact structured facts:
   - `resolution:"backendNodeId"|"point"`
   - `events:["mouseMoved","mousePressed","mouseReleased"]`
   - `dispatchOnly:true`
   - `cdpSessionName` / logical channel name
   - `dispatched:0` on fail-closed paths
   - `target.refId`, `target.backendNodeId` when present
   - `error_code:"BACKEND_NODE_STALE"|"OOPIF_SESSION_UNSUPPORTED"|"INVALID_REF_TARGET"` when applicable
5. Keep the command free of actionability checks, observe calls, semantic retries, and ABML imports.

Verification:

```bash
npm run sync:protocol
npm run check:protocol
npm run check:bridge:types
npm run check:bridge:build
npm run check:bridge:files
npm run check:abml-verb-runtime
npm run check:all:bridge
git diff --check
```

### P2 - Wire `pi.click(ref)` Through an In-Flight Execute Binding

Files:

- `src/tools/executeStdlib.ts`
- `src/tools/registerExecuteTool.ts` only for result/journal metadata if needed
- `bridge_src/service_worker/exec.ts`
- `bridge_src/service_worker/input.ts`
- `tests/unit/tools/execute-stdlib.test.ts`
- `tests/contracts/tools/check-execute-stdlib.mjs`
- `tests/contracts/runtime/` for binding/reentrancy coverage

Actions:

1. Extend the stdlib prelude only when a script references `pi.click`.
2. The prelude resolves `ref` from the embedded descriptor registry and sends a bounded payload to a
   SW `Runtime.addBinding` name installed for this execute request.
3. The binding payload must contain only the safe target facts needed by `input.ref`: `refId`,
   selected `backendNodeId`, point fallback, and redacted metadata. Do not send raw descriptor blobs
   beyond the existing allowlist.
4. `exec.ts` installs and removes the binding around the user script and services
   `Runtime.bindingCalled` by invoking the local `input.ref` handler directly.
5. The page-side promise must resolve through an explicit response channel, not through the return
   value of the binding call. Use a per-execute request map plus a SW response injection such as
   `Runtime.evaluate("__piBrowserStdlibResolve(requestId, payload)")`, bounded by the execute timeout.
6. Add a reentrancy regression: a `pi.click` inside `browser_execute` must not enqueue another Node
   write, must not self-deadlock, and must resolve/reject the page promise exactly once.
7. Add a negative control that fails if `BrowserBridgeCommandService.sendCommand` is called for the
   inner click.
8. Preserve `PI_BROWSER_STDLIB=0`: when disabled, scripts are not rewritten and `pi.click` is absent.

Verification:

```bash
npx tsx --test tests/unit/tools/execute-stdlib.test.ts
npm run check:tools
npm run check:capture
npm run check:all:bridge
npm run check:eval-workflows
git diff --check
```

### P3 - Runtime Proof and Agent Guidance

Files:

- `evals/browser-workflows/fixtures/` or existing local fixture files
- `evals/browser-workflows/runner.mjs` only if a new eval assertion is required
- `evals/browser-workflows/31-execution-plane-cdp-fusion.md` or the repo's current eval manifest shape
- `tests/contracts/tools/check-browser-workflow-results.mjs` when result schema changes
- `skills/pi-browser-tools/SKILL.md`
- `skills/pi-browser-cli/SKILL.md`
- generated docs from `npm run docs:sync`

Actions:

1. Add or reuse a fixture with a trusted-event-gated button where `el.click()` returns but does not
   trigger the intended event, while `pi.click(ref)` triggers it through CDP input.
2. Record result evidence that `pi.click` returns dispatch facts and that semantic success is learned
   through effect/observe, not hidden verification.
3. Compare `pi.click` against the existing `browser_execute` + `browser_command input.pointer` path
   for call count, latency, and artifact evidence. The plan succeeds by reducing orchestration and
   intra-action measurement/dispatch split, not by claiming semantic verification.
4. Add a fail-closed fixture or fake-CDP contract for same-target miss/OOPIF-unsupported behavior.
5. Update skill text only after the fixture proves the path. The wording must say:
   - use normal JS first
   - use `pi.click(ref)` for physical trusted input against a fresh observed ref
   - re-observe on stale/ref failure
   - do not double-click just because intent is unverified
6. Run docs sync after skill/doc changes.

Verification:

```bash
npm run check:eval-workflows
npm run eval:browser-workflows -- --fixture-server --eval 31-execution-plane-cdp-fusion
npm run check:browser-workflow-results
PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools
npm run docs:sync
npm run check:tool-docs
npm run check:all:package
git diff --check
```

### P4 - Close the Workstream

Files:

- `docs/execution-plane-cdp-fusion-plan.md`
- `CURRENT.md`
- `ARCHIVE.md`
- `docs/archive/execution-plane-cdp-fusion-plan.md`
- `docs/archive/execution-plane-cdp-fusion-plan.full.md`
- generated doc indexes

Actions:

1. Mark this plan complete with exact command evidence and artifact paths.
2. Archive the full plan and summary through the repo's document sync flow.
3. Reset `CURRENT.md` to no active execution line unless another active workstream is explicitly
   started.

Verification:

```bash
npm run docs:sync
npm run check
git diff --check
```

## Acceptance Criteria

- No public `browser_*` tool is added.
- `browser_execute` keeps the `script`-only public parameter surface; no `action:{...}` returns.
- `check:abml-verb-runtime` stays green and no ABML runtime actuator is restored.
- `pi.click` is the only new stdlib name in this workstream.
- `PI_BROWSER_STDLIB=0` preserves disabled behavior.
- `input.ref` fails closed for stale/detached backend nodes.
- A `backendNodeId` target never silently falls back to point after backend resolution failure.
- OOPIF/cross-target backend ids fail closed in this workstream rather than routing by guesswork.
- `pi.click` inside `browser_execute` does not enqueue a nested Node write or self-deadlock.
- Page-side `pi.click` promises resolve/reject exactly once and do not rely on `Runtime.addBinding`
  returning a value.
- Result summaries distinguish `dispatchOnly:true` from semantic/intent verification.
- The fixture eval proves at least one trusted-event-gated control succeeds through `pi.click` while
  raw `el.click()` does not.
- Closing `npm run check` passes and writes `.pi/browser-artifacts/check-dag-summary.json`.

## Closed Out of Scope

- `pi.type`, `pi.setFiles`, `pi.download`, and tool absorption for `browser_upload` /
  `browser_download`.
- OOPIF-specific CDP session routing.
- BackendNodeId backfill for DOM-only gap entities.
- Actionability ladders, semantic retries, and hidden "verify then escalate" logic.
- Public skill guidance before runtime fixture evidence exists.

## Reopen Evidence Bars

- Add OOPIF routing only after a real fixture or blind eval shows same-target fail-closed behavior is
  the limiting factor.
- Add backendNodeId backfill only after blind eval evidence shows point-tier gap targets are common
  and materially harmful.
- Add `pi.type` only after `pi.click` lands with green fixture evidence and no reentrancy or
  double-execution regressions.
