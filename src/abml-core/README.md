# `@pi/abml-core` — the ABML pure-core kernel

This folder is the **pure-core kernel** of ABML, the perception substrate under the `browser_*`
tools. It models a web page as a trustworthy, actionable, focusable semantic graph — entities,
refs, the DOM↔AX merge, DOM identity bootstrap, actionability rules, verb decisions, error shaping,
collection completeness, and mechanism-arm structure projection.

**The one rule:** everything here is **pure** — zero browser, zero Node, zero npm dependencies.
Pure functions and types only. The browser-facing **runtime** lives next door in
[`../abml/`](../abml) and depends on this kernel; the kernel never depends on the runtime.

```
   src/abml/  (runtime: driver/tools/scan/resources/node)  ──imports──▶  src/abml-core/  (this)
```

This is the whole reason the kernel was split out: it can be read, reasoned about, and unit-tested
without a browser, and is the candidate for an isolated `@pi/abml-core` package.

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

`index.ts` is the **single entry point** — `export *` of every module below. Read it to see the
kernel's entire public surface at a glance.

| Module | Role |
| --- | --- |
| `types.ts` | Foundational types — locators, refs, actionability, errors, captures. |
| `refId.ts` | Pure pi-ref URI minting and summary placeholder ref IDs. |
| `entity.ts` | `Entity` / `EntityState` / `EntityStructure` model + builders. |
| `refPolicy.ts` | Ref-access policy per kind (`defaultRefPolicyForKind`, `decideRefAccess`). |
| `ax.ts` | **DOM↔AX merge** — box-IoU/role/name scoring, AX-authoritative state/structure fusion. |
| `stream.ts` | Capture-ref / network-entry / event entity shaping. |
| `grouping.ts` | Shared ARIA-grounded grouping kernel: descriptors, indexed groups, scope helpers, normalized/display text helpers. |
| `identityBootstrap.ts` | Best-effort scan rect ↔ DOMSnapshot backendNodeId bootstrap with fail-open diagnostics. |
| `templating.ts` | Structure templating for repeated AX/ARIA sibling groups. |
| `treeDiff.ts` | Template-level living diff over repeated structures; O(change) projection without ref-mint changes. |
| `semanticRefAnchor.ts` | M2b semantic ref-anchor candidate + shadow-hash input derivation; high-confidence anchors feed gated ref minting in runtime. |
| `snapshotProjection.ts` | M2c living snapshot projection — compact current templates plus attached template deltas for saved observe artifacts. |
| `collections.ts` | Collection completeness and read-only continuation evidence for long/virtualized/lazy/paginated structures. |
| `actionabilityModel.ts` | Verb → actionability-spec mapping; action-verb classification. |
| `errors.ts` | `normalizeAbmlError` + recovery shaping. |
| `verbs/router.ts` | Verb input/result/runtime types + actionability/verification failure helpers. |
| `verbs/{read,frame,pierce}.ts` | Per-verb **decision** logic (no browser call). |

The matching browser I/O for each verb lives in `../abml/verbs/*Runtime.ts` (e.g. `ax.ts`'s merge
is fed by `../abml/verbs/axRuntime.ts`, which reads the live AX tree).

## The boundary is CI-enforced

`npm run check:abml-core-boundary` (also part of `npm run check`) asserts that every file here
imports **only** another core module or one of the whitelisted transitively-pure cross-cutting
modules — `utils/records`, `utils/json`, `utils/redaction`, `utils/errors`,
`protocol/nativeErrorCodes`. A `driver/tools/scan/resources/node`/npm import, a reach back into
`../abml/`, or a new unclassified file makes CI red. The formal manifest is
[`docs/abml-kernel-manifest.md`](../../docs/abml-kernel-manifest.md).

## Extending the kernel

- **New verb decision** → add `verbs/<verb>.ts` (pure: input → decision/verification result),
  wire it in `verbs/router.ts`, and put the browser I/O in `../abml/verbs/<verb>Runtime.ts`. Keep
  the decision and the I/O on opposite sides of the line.
- **Improve perception** (new ARIA state/relationship/structure) → it almost always belongs in
  `ax.ts` (the merge), `entity.ts` (the model), `grouping.ts`, `templating.ts`, `treeDiff.ts`, `semanticRefAnchor.ts`, `snapshotProjection.ts`, or `collections.ts`. Stay generic —
  ABML models ARIA patterns, never per-site/per-framework branches (see the project-level
  ABML development rules).
- **Need a new shared helper** → if it is genuinely pure, add it to the `PURE_CROSSCUTTING`
  whitelist in the boundary test (after re-verifying its dependency closure stays pure).
  Otherwise the consumer belongs in the runtime layer, not here.

After any change: `tsc -p tsconfig.json` + `npm run test:unit` (the kernel's unit tests are under
`tests/unit/abml/`) + `npm run check:abml-core-boundary`.

## Consumers

External callers still import the individual modules through thin re-export shims at the old
`../abml/` paths (e.g. `../abml/entity.js`), so the split changed no import path. The runtime
layer, `resourceStore`, `summaries/scan`, `observeRunners`, and the unit tests all go through
those shims. New code may import the barrel directly: `import { ... } from ".../abml-core/index.js"`.

## Related docs

The full ABML doc set + roles is mapped in
[`docs/abml-kernel-manifest.md` → ABML documentation map](../../docs/abml-kernel-manifest.md#abml-documentation-map).
The ones you will reach for most:

- [`docs/abml-kernel-manifest.md`](../../docs/abml-kernel-manifest.md) — formal layer manifest + boundary spec + the workspace-package promotion recipe (and the doc map).
- [`docs/abml-p1-spec.md`](../../docs/abml-p1-spec.md) — the AX-authoritative state spec.
- [`AGENTS.md`](../../AGENTS.md#abml-project-development-rules) — current project-level ABML development rules.
- [`docs/archive/abml-perception-state-evolution-plan.md`](../../docs/archive/abml-perception-state-evolution-plan.md) — historical perception north-star + R1/R2/R3 semantic-depth roadmap.
