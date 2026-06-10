# ABML R3 Quality Follow-up Execution Plan

## Status

COMPLETE — 2026-06-05.

> 注：本合同 P4/Validated 中列出的 `npm run smoke:browser:abml-inference[-postaction]` 与 `tests/smoke/smoke-abml-inference*.mjs` 已随 2026-06-05 `envelope.inference` 重构（commit `b6feaf3`，移除 agent-facing `inference`/`templates` 字段）一并移除；inference 逻辑回归现由 `check:abml-inference` contract 承担。下方保留为完成时的历史验证记录。

## Goal

Tighten the existing R3/R2 substrate without adding new public tools or protocol surface:

1. Make `form-dependency` less brittle when live focus moves after an action.
2. Ensure inference evidence refs shown to the agent are backed by entity details in `envelope.entities` when those entities are available in the scan summary/artifact substrate.

## Boundaries

- No new public `browser_*` tool.
- No native protocol change.
- No ref-minting or `stableRefIdForDescriptor` change.
- No DOM tag/class/selector guessing as a semantic shortcut.
- Preserve existing `relations`, `inference`, `diff`, `treeDiff`, and `snapshotProjection` output shapes.
- Keep all changes generic and ARIA/ABML grounded.

## P0 — Inventory

Check current R3/R2 paths:

- `src/abml-core/diff.ts`
- `src/abml-core/inference.ts`
- `src/tools/observeRunners.ts`
- `src/tools/resultMiddleware.ts`
- `tests/contracts/tools/check-abml-diff.mjs`
- `tests/contracts/tools/check-abml-inference.mjs`
- `tests/smoke/smoke-abml-inference-postaction.mjs`

## P1 — Robust form-dependency anchor

Current issue: `form-dependency` requires `diff.focusedRef` to resolve to an editable control. On real pages, focus can move to the newly enabled submit button or disappear between action and rescan.

Implementation:

- Keep the existing high-confidence path: current `diff.focusedRef` resolves to an editable control distinct from the enabled control.
- Add a generic fallback: if exactly one editable control has a `focused` state transition in `diff.changed`, use that control as `requiredRef`.
- If the transition is `focused:false -> true`, keep high confidence.
- If the transition is `focused:true -> false`, emit medium confidence because the field likely lost focus after enabling the control.
- Reject ambiguous multiple editable focus transitions.

Validation:

- Contract cases for focusedRef, gained-focus fallback, lost-focus fallback, and ambiguous focus transition suppression.
- Existing `check:abml-diff` behavior remains compatible.

## P2 — Evidence-ref entity surfacing

Current issue: `inference.intents[*].evidence` can reference refs absent from `envelope.entities`, forcing the agent to re-read or guess entity details.

Implementation:

- Extract `pi-ref://` refs from inference evidence recursively.
- Surface matching entities from the available focus candidate sets, including `referenced_entities`.
- Prefer inference evidence entities before salience-only entities in `envelope.entities`.
- In `browser_observe`, populate `focus.referenced_entities` with ABML entities required by inference evidence when available.
- Keep caps and dedupe stable.

Validation:

- Contract: an inference evidence ref present only in `focus.referenced_entities` appears in `envelope.entities`.
- Contract: referenced evidence survives tight summary budget.
- Static guards for observe/middleware wiring.

## P3 — Baseline artifact preference

Current issue: prior scan envelopes carry a capped `envelope.entities` subset, while the saved artifact carries full `abml.entities`. Using only the capped subset makes R3 diffs weaker.

Implementation:

- When `browser_observe(..., baseline=<prior envelope>)` includes `saved.path`, prefer full ABML entities from the saved artifact.
- If a prior envelope advertises `saved.path` but the artifact cannot provide full ABML entities, reject with a structured baseline error instead of silently using the capped subset.
- Preserve inline-entity and snapshotId baseline behavior when no `saved.path` is provided.

Validation:

- Contract/static guard plus live smoke: post-action inference should gate `form-dependency` as a passing condition.

## P4 — Final gate

Run:

- `npm run check:src:types`
- `npm run check:abml-inference`
- `npm run check:abml-diff`
- `npm run smoke:browser:abml-inference-postaction`
- `npm run lint`
- `npm run check`

## Completion criteria

- `form-dependency` no longer depends only on current live focus.
- Inference evidence refs have entity details surfaced when available.
- Full ABML entities are preferred for prior-envelope baselines.
- No new public tool/protocol/ref-minting surface.

## Completion record

Implemented:

- DOM scan now records `focused` for actionable elements, so R3 `focusedRef` can land on the actual editable control instead of only AX/frame focus.
- `form-dependency` keeps the old focusedRef path and adds unique editable focus-transition fallback (`focus-gained` high, `focus-lost` medium, ambiguous suppressed).
- `inferenceEvidenceRefs` / `entitiesForInferenceEvidence` expose evidence refs and allow observe to carry matching entities into `focus.referenced_entities`.
- `resultMiddleware` promotes inference-evidence entities ahead of salience-only entities in `envelope.entities`.
- Prior-envelope baselines with `saved.path` load full saved `abml.entities` instead of relying on the capped top-level `envelope.entities` subset.

Validated:

- `npm run check:src:types`
- `npm run check:abml-inference`
- `npm run check:abml-diff`
- `npm run check:scan`
- `npm run smoke:browser:abml-inference`
- `npm run lint`
- `npm run check`
