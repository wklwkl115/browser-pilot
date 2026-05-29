# Eval 25: Wasm artifact metadata

## Goal

Given an explicit local Wasm artifact, extract bounded Wasm metadata facts without introducing a new public browser tool or whole-site Wasm discovery workflow.

## Fixture

- Local target: explicit local Wasm artifact analysis only
- Required files:
  - `fixtures/wasm-minimal.wasm`
  - `fixtures/wasm-minimal.wat`
- Setup notes:
  - Input must be an explicit local artifact path.
  - The `.wat` file is a malformed/non-Wasm control for diagnostics.

## Allowed starting tools

- `browser_artifact`

## Expected tool sequence

1. Start from an explicit local Wasm file path.
2. Run the internal Wasm artifact analyzer.
3. Return compact metadata first.
4. Use artifact paths when raw bytes or later bridge outputs are needed.
5. Keep launcher/decompiler work out of this phase unless an explicit mature bridge is available.

## Success criteria

- The result includes Wasm header/version/hash/section facts.
- The result includes imports/exports/memory metadata.
- The workflow stays explicit-input and artifact-first.

## Required evidence

- Summary evidence:
  - `wasm-summary`
- Artifact evidence:
  - `artifact-path`
  - explicit local Wasm input path
- Diagnostics evidence:
  - bounded malformed/non-Wasm input diagnostics

## Recovery checks

- Expected failure mode:
  - malformed/non-Wasm input
  - oversized input
- Required recovery path:
  - correct the input path or choose a smaller explicit artifact
  - do not fall back to whole-site Wasm discovery

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
