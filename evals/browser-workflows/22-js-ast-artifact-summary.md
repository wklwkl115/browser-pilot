# Eval 22: JS AST artifact summary

## Goal

Given an explicit local JavaScript artifact, extract bounded AST facts and suspicious-pattern summaries without introducing a new public browser tool or whole-site source workflow.

## Fixture

- Local target: explicit local artifact analysis only
- Required files:
  - `fixtures/js-ast-minified.js`
  - `fixtures/js-ast-malformed.js`
  - `fixtures/js-ast-patterns.js`
  - `fixtures/js-ast-reduction.js`
- Setup notes:
  - No browser runtime is required.
  - Input must be explicit artifact text or explicit local artifact path.

## Allowed starting tools

- `browser_artifact`

## Expected tool sequence

1. Start from an explicit local artifact path or explicit JavaScript text.
2. Read only the bounded artifact content needed for analysis.
3. Run the internal AST parse/summary primitive.
4. Return compact facts first; keep larger reduced output artifact-first.
5. Verify malformed input diagnostics on a bounded bad fixture when needed.

## Success criteria

- The task result includes correct imports/exports/function/suspicious facts.
- The result stays bounded and artifact-first.
- The agent does not claim a new public callable JS deobfuscation tool exists.

## Required evidence

- Summary evidence:
  - `ast-summary`
  - imports/exports counts
  - function inventory preview
  - suspicious-pattern counts
- Artifact evidence:
  - `artifact-path`
  - explicit input path references
  - reduced preview or saved artifact path when large
- Diagnostics evidence:
  - `parse-diagnostics`
  - parse error line/column/code on malformed JS

## Recovery checks

- Expected failure mode:
  - malformed JS parse failure
  - oversized input rejection
- Required recovery path:
  - narrow the artifact slice or choose a smaller explicit input
  - use bounded parse diagnostics rather than guessing code structure

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
