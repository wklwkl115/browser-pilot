# Eval 26: Wasm WAT bridge

## Goal

Given an explicit local Wasm artifact and an available mature local bridge, generate a `.wat` artifact and return compact bridge metadata without introducing a public Wasm browser tool.

## Fixture

- Local target: `fixtures/wasm-minimal.wasm`
- Required files:
  - `fixtures/wasm-minimal.wasm`
- Setup notes:
  - Input must be an explicit local Wasm path.
  - Bridge availability is environment-dependent; when unavailable, diagnostics must stay structured and bounded.

## Allowed starting tools

- `browser_artifact`

## Expected tool sequence

1. Start from an explicit local Wasm file path.
2. Confirm metadata first.
3. Run the optional mature bridge only when explicitly requested and available.
4. Save larger `.wat` output as an artifact.
5. Keep launcher/tool failure diagnostic instead of guessing reverse output.

## Success criteria

- The result includes bridge launcher metadata.
- The result includes a readable `.wat` artifact path when the bridge succeeds.
- The workflow stays artifact-first and explicit-input only.

## Required evidence

- Summary evidence:
  - `wat-bridge`
- Artifact evidence:
  - `artifact-path`
  - `.wat` output path
- Diagnostics evidence:
  - launcher-unavailable or bridge failure diagnostics when the bridge cannot run

## Recovery checks

- Expected failure mode:
  - bridge launcher unavailable
  - bridge process timeout/failure
- Required recovery path:
  - configure/install a local mature bridge launcher explicitly
  - do not fall back to fake inline decompilation

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
