# `@browser-pilot/abml-kernel` — the ABML pure-core kernel

This folder is the **pure-core kernel** of ABML, the perception substrate under the `browser_*`
tools. It models a web page as a trustworthy, actionable, focusable semantic graph — entities,
refs, the DOM↔AX merge, DOM identity bootstrap, actionability rules, verb decisions, error shaping,
collection completeness, and mechanism-arm structure projection.

**The one rule:** everything here is **pure** — zero browser, zero Node, zero npm dependencies.
Pure functions and types only. The browser-facing **runtime** lives in
[`../../browser-runtime/abml/`](../../browser-runtime/abml) and depends on this
kernel; the kernel never depends on the runtime.

```
   src/browser-runtime/abml/  (browser I/O)  ──imports──▶  src/kernels/abml/  (this)
```

This is the whole reason the kernel was split out: it can be read, reasoned about, and unit-tested
without a browser, and is the candidate for an isolated `@browser-pilot/abml-kernel` package.

## Agent-native perception contract

ABML is not a better wrapper around human browser gestures. Human browser surfaces expose viewports,
scrolling, pointer hits, and stepwise clicks because a person has a fast visual feedback loop.
Agents pay for each interaction but can consume a larger structured model at once, so the kernel
must remove that viewport/action burden from the public cognition path.

Treat scroll, click, pagination, virtual-list probing, and lazy loading as evidence/state/data-source
problems before treating them as public verbs. The kernel should model entities, relations,
collections, completeness, continuation handles, data-source provenance, and state transitions; any
physical input or page JS needed to discover or verify them belongs in runtime mechanics with visible
diagnostics, not in a wider agent-facing ABML surface.

Viewport facts are coverage/evidence metadata, not the boundary of page understanding. If a page
requires a manual "go there, then look again" loop, first ask whether ABML can expose the missing
collection, completeness, continuation, or source structure so the agent does not have to perform
that loop.

## Layout

The modules below make up the kernel's public surface — consumers import them directly.

| Module | Role |
| --- | --- |
| `types.ts` | Foundational types — locators, refs, actionability, errors, captures. |
| `entity.ts` | `Entity` / `EntityState` / `EntityStructure` model + builders. |
| `ax.ts` | **DOM↔AX merge** — box-IoU/role/name scoring, AX-authoritative state/structure fusion. |
| `stream.ts` | Capture-ref / network-entry / event entity shaping. |
| `grouping.ts` | Shared ARIA-grounded grouping kernel: descriptors, indexed groups, scope helpers, normalized/display text helpers. |
| `identityBootstrap.ts` | Best-effort scan rect ↔ DOMSnapshot backendNodeId bootstrap with fail-open diagnostics. |
| `templating.ts` | Structure templating for repeated AX/ARIA sibling groups. |
| `treeDiff.ts` | Template-level living diff over repeated structures; O(change) projection without ref-mint changes. |
| `semanticRefAnchor.ts` | Semantic ref-anchor candidate derivation for repeated structures. |
| `snapshotProjection.ts` | M2c living snapshot projection — compact current templates plus attached template deltas for saved observe artifacts. |
| `collections.ts` | Collection completeness and read-only continuation evidence for long/virtualized/lazy/paginated structures. |
| `actionabilityModel.ts` | Actionability blocker diagnostics and failure-reason shaping. |
| `errors.ts` | `normalizeAbmlError` + recovery shaping. |
| `verbs/router.ts` | Verb input/result/runtime types shared by pure decisions and browser runtime. |
| `verbs/{read,frame,pierce}.ts` | Per-verb **decision** logic (no browser call). |

Generic ref URI minting, stable ref IDs, and ref-access policy live in
[`../refs/`](../refs) so resource storage and ABML share one ref owner without
making resource ports depend on ABML.

The matching browser I/O for each verb lives in `../../browser-runtime/abml/*Runtime.ts`
(e.g. `ax.ts`'s merge is fed by `../../browser-runtime/abml/axRuntime.ts`, which reads the
live AX tree).

## The boundary is CI-enforced

`mise run verify` includes the architecture boundary checks for this kernel through the canonical lint gate. Files here must import only another core
module or an approved transitively-pure cross-cutting helper. A command, adapter, bridge, browser
runtime, Node-only, or npm dependency import is a boundary violation.

## Extending the kernel

- **New verb decision** → add `verbs/<verb>.ts` (pure: input → decision/verification result),
  wire it in `verbs/router.ts`, and put the browser I/O in
  `../../browser-runtime/abml/<verb>Runtime.ts`. Keep the decision and the I/O on opposite
  sides of the line.
- **Improve perception** (new ARIA state/relationship/structure) → it almost always belongs in
  `ax.ts` (the merge), `entity.ts` (the model), `grouping.ts`, `templating.ts`, `treeDiff.ts`, `semanticRefAnchor.ts`, `snapshotProjection.ts`, or `collections.ts`. Stay generic —
  ABML models ARIA patterns, never per-site/per-framework branches (see the project-level
  ABML development rules).
- **Need a new shared helper** → if it is genuinely pure, add it to the `PURE_CROSSCUTTING`
  whitelist in the boundary test (after re-verifying its dependency closure stays pure).
  Otherwise the consumer belongs in the runtime layer, not here.

For repo-wide contributor workflow, canonical gates, and validation expectations, start with
[`REPO_GOVERNANCE.md`](../../../REPO_GOVERNANCE.md). During development, use the affected gate for the touched scope; before claiming completion, run `mise run verify` plus any focused manual verification needed for the touched surface.

## Consumers

Consumers import the kernel modules directly from `src/kernels/abml/*`. Browser I/O code stays
outside the kernel in the browser-runtime layer.
