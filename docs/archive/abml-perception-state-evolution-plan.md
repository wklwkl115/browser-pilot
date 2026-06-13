# ABML Perception State Evolution Plan

> Summary archive for
> `docs/archive/abml-perception-state-evolution-plan.full.md`.

This 2026-06-02 to 2026-06-13 living perception roadmap recorded ABML's
north-star, ARIA-spectrum generality principle, R1/R2/R3/R3.x execution history,
and later collection-continuation direction. The shipped R1/R2/R3/R3.x and
mechanism-arm records are complete; the remaining Mid/Far ideas are historical
forward-looking context, not an active execution queue.

Current project-level ABML development rules now live in `AGENTS.md` under
`ABML Project Development Rules`; do not recover those rules from this archived
draft.

## Archived Decisions

- ABML models an agent-native page affordance graph grounded in DOM/AX/browser
  truth, not a replay of human viewport and gesture loops.
- The model follows the full ARIA/AX spectrum across landmarks, document
  structure, widgets, live regions, and relationships; per-site or per-page-type
  branches remain overfitting.
- R1 relationship graph, R2 inference, R3 temporal diff, R3.x causal/stream
  planes, and M1/M2a/M2b/M2c mechanism work shipped through existing
  `browser_observe` / internal ABML paths rather than a new public
  `browser_abml_*` surface.
- Long, hidden, lazy, virtualized, and paginated content belongs in collection
  completeness, continuation, data-source, evidence, and state-transition
  modeling before any runtime input is considered.

## Evidence

- Full historical plan:
  `docs/archive/abml-perception-state-evolution-plan.full.md`
- Current project development rules:
  `AGENTS.md` -> `ABML Project Development Rules`
- Final material update:
  2026-06-13
