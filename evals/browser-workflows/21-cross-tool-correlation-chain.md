# Eval 21: Cross-Tool Correlation Chain

## Goal

Verify that an agent can carry correlation metadata across a realistic browser workflow and use targeted artifact reads instead of opening raw evidence blindly.

## Fixture

- Local target: `fixtures/interactive.html`
- Required files: `evals/browser-workflows/fixtures/interactive.html`
- Setup notes: run the fixture through the normal local manual browser flow. The page is synthetic, deterministic, and must expose a visible state change after one narrow action.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_wait`
- `browser_network`
- `browser_evidence`
- `browser_artifact`

## Expected tool sequence

1. Use `browser_tabs` to get an explicit `tabId` and stable target session state.
2. Use `browser_observe mode=scan` and record the returned `snapshotId` / `operationId` / `selectionVersion*` evidence from the distilled envelope.
3. Use `browser_execute` for one narrow DOM action and keep the returned `operationId`.
4. Use `browser_wait` to verify the state change and keep the returned `waitId` / `operationId` / `selectionVersion*` evidence.
5. If the flow captures network or hook evidence, keep the returned `requestId` / `listenerId` / `sessionId` evidence instead of guessing.
6. Use `browser_artifact` only with the saved artifact path and targeted `jsonPath` such as `operation.operationId`, `snapshot.snapshotId`, `data.requestId`, `data.waitId`, or `data.listenerId`.
7. Verify the final result using compact envelope evidence first, then targeted artifact reads only where correlation metadata points.

## Success criteria

- The agent keeps correlation metadata across at least three tools in the chain.
- The final explanation can point to concrete `operationId`, `snapshotId`, `waitId`, `requestId`, or `listenerId` facts instead of vague artifact references.
- `browser_artifact` is used with targeted `jsonPath` based on returned `correlationPaths` or known envelope structure.
- The agent does not open the full artifact before trying the pointed correlation `jsonPath`.
- Recovery, if needed, stays within existing canonical tools and does not invent a new orchestration layer.

## Required evidence

- Summary evidence: envelope `correlation`, `operation`, `snapshot`, `target.selectionVersionAtDispatch`, `target.selectionVersionAtResolve`; this is the required selection-version proof for this eval.
- Artifact evidence: one or more targeted `browser_artifact mode=json jsonPath=...` reads against correlation fields; this is the required targeted-artifact-read proof for this eval.
- Diagnostics evidence: if the chain breaks, the result must cite which correlation field was missing and what targeted follow-up was used.

## Recovery checks

- Expected failure mode: the agent sees `saved.path` and jumps straight to a broad artifact read without using correlation metadata.
- Required recovery path: retry with a narrow `browser_artifact` read using `operation.operationId`, `snapshot.snapshotId`, `data.requestId`, `data.waitId`, or `data.listenerId` first.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
- correlation metadata discipline
