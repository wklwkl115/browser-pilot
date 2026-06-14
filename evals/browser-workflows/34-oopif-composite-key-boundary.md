# Eval 34: OOPIF Composite Key Boundary

## Goal

Collect deterministic boundary evidence for `(targetId, backendNodeId)`: the current local fixture
runner can expose cross-origin iframe facts and Target-domain signals, but it does not yet prove
cross-target composite identity joins.

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
4. Use `browser_frame` and `browser_command persistent_cdp Target.getTargets` to capture frame/target
   signals.
5. Write a boundary artifact summarizing whether an OOPIF target appeared, whether
   `Target.attachToTarget` was used, and why current evidence does not prove composite-key joins.

## Success criteria

- The parent/child origins differ and parent JS cannot read the child document.
- Frame/Target-domain evidence is captured in artifacts.
- The boundary artifact explicitly records that current public refs remain tab-scoped and do not prove
  `(targetId, backendNodeId)` dual-key joins.
- Passing this eval means the OOPIF boundary evidence is complete, not that composite keys shipped.

## Required evidence

- Summary evidence: cross-origin iframe signal, frame list, Target-domain signal, composite-key
  non-claim.
- Artifact evidence: `browser_frame` artifact, Target.getTargets artifact, and
  `34-oopif-composite-key-boundary-boundary.json`.
- Diagnostics evidence: child origin, parent access error, target count, and fail-closed boundary.
- Manifest evidence labels: `cross-origin-iframe`, `frame-list`, `target-domain-signal`,
  `composite-key-non-claim`.

## Recovery checks

- Expected failure mode: Chrome does not materialize a separate OOPIF target for this local fixture.
- Required recovery path: record `oopifTargetPresent:false` and keep the composite-key work behind a
  stronger fixture or real-browser execution contract.

## Metrics

- success/failure
- tool call count
- artifact sufficiency
- target count
- cross-origin access result
- composite-key proof status
