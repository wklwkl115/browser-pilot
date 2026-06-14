# Eval 34: OOPIF Composite Key Boundary

## Goal

Collect deterministic execution evidence for `(targetId, backendNodeId)`: the local fixture exposes a
cross-origin iframe, discovers its debugger target, resolves a child `backendNodeId` inside that
target, and dispatches `input.ref` through `Target.setAutoAttach` / `Target.attachedToTarget`
flat-session routing.

## Fixture

- Local target: `fixtures/oopif-parent.html`, `fixtures/oopif-child.html`
- Required files:
  - `evals/browser-workflows/fixtures/oopif-parent.html`
  - `evals/browser-workflows/fixtures/oopif-child.html`
- Setup notes: the parent loads the child through the alternate loopback hostname (`127.0.0.1` vs
  `localhost`) to create a cross-origin iframe under the local-only fixture server.

## Allowed starting tools

- `browser_tabs`
- `browser_wait`
- `browser_observe`
- `browser_frame`
- `browser_execute`
- `browser_command`
- `browser_artifact`

## Expected tool sequence

1. Open the parent fixture.
2. Wait for the iframe element.
3. Use `browser_execute` to prove the child document is not same-origin readable from the parent.
4. Use `browser_frame` and `browser_command persistent_cdp targets` to capture frame/target signals.
5. Use target-scoped `persistent_cdp DOMSnapshot.captureSnapshot` to locate the child button
   `backendNodeId`.
6. Dispatch `input.ref` twice: a bare parent `backendNodeId` for legacy same-target compatibility and
   `(targetId, backendNodeId)` for the child target.
7. Write a boundary artifact proving attach routing, child click delivery, old-ref compatibility, and
   fail-closed behavior for an invalid target id.

## Success criteria

- The parent/child origins differ and parent JS cannot read the child document.
- Frame/Target-domain evidence is captured in artifacts and includes a child target id.
- The child target snapshot resolves `#child-action` to a `backendNodeId`.
- `input.ref` with `(targetId, backendNodeId)` reports `attachRouteUsed:true` and the child frame
  delivers a click signal back to the parent.
- A bare same-target `backendNodeId` still works for the parent control.
- A bogus target id fails closed with zero dispatched events.

## Required evidence

- Summary evidence: cross-origin iframe signal, frame list, Target-domain signal, composite-key proof.
- Artifact evidence: `browser_frame` artifact, debugger targets artifact, parent/child DOMSnapshot
  artifacts, input.ref artifacts, and `34-oopif-composite-key-boundary-boundary.json`.
- Diagnostics evidence: child origin, parent access error, target count, composite/legacy node keys,
  attach route details, click delivery counters, and fail-closed boundary.
- Manifest evidence labels: `cross-origin-iframe`, `frame-list`, `target-domain-signal`,
  `composite-key-proof`, `old-ref-compatibility`.

## Recovery checks

- Expected failure mode: Chrome does not materialize a separate OOPIF target for this local fixture,
  or `Target.setAutoAttach` cannot produce a matching flat-session attachment.
- Required recovery path: record `oopifTargetPresent:false` or `attachRouteUsed:false`; do not dispatch
  by point fallback for a target-scoped backend ref.

## Metrics

- success/failure
- tool call count
- artifact sufficiency
- target count
- cross-origin access result
- composite-key proof status
- attach route status
- old-ref compatibility status
