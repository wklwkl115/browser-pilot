# `@browser-pilot/abml-kernel` — the ABML pure-core kernel

This folder is the **pure-core kernel** of ABML, the perception substrate under the `browser_*`
tools. It models a web page as a trustworthy semantic graph: entities, refs, DOM↔AX fusion,
identity, relations, diffs, collection completeness, projections, and verification results.

**The one rule:** everything here is **pure** — zero browser, zero Node, zero npm dependencies.
Pure functions and types only. The browser-facing **runtime** lives in
[`../../browser-runtime/abml/`](../../browser-runtime/abml) and depends on this
kernel; the kernel never depends on the runtime.

```
   src/browser-runtime/abml/  (browser I/O)  ──imports──▶  src/kernels/abml/  (this)
```

This split keeps the kernel readable and unit-testable without a browser.

## Agent-native perception contract

ABML is not a better wrapper around human browser gestures. Human browser surfaces expose viewports,
scrolling, pointer hits, and stepwise clicks because a person has a fast visual feedback loop.
Agents pay for each interaction but can consume a larger structured model at once, so the kernel
must remove that viewport/action burden from the public cognition path.

Treat scroll, click, pagination, virtual-list probing, and lazy loading as evidence/state/data-source
problems before treating them as public verbs. The kernel should model entities, relations,
collections, completeness, data-source provenance, and state transitions; any
physical input or page JS needed to discover or verify them belongs in runtime mechanics with visible
diagnostics, not in a wider agent-facing ABML surface.

Viewport facts are coverage/evidence metadata, not the boundary of page understanding. If a page
requires a manual "go there, then look again" loop, first ask whether ABML can expose the missing
collection, completeness, resource-backed region, or source structure so the agent does not have to perform
that loop.

Pixel-only surfaces are the narrow exception, not a second page model. `browser_observe` keeps DOM+AX as
the semantic backbone and may attach one coherent viewport screenshot plus normalized ABML target boxes.
The screenshot is captured inside the same fingerprint bracket, exposed as an MCP image resource, and bound
to a short-lived visual ref. Pixel actions must use that ref, its observation id, and normalized image points;
runtime rechecks the screenshot hash and bracketed page fingerprint, reverse-grounds the live node, then
returns post-action pixel evidence. OCR or a vision model may interpret the image, but neither may mint a
parallel identity graph or bypass ABML ownership, freshness, and execution policy.

## Layout

The modules below make up the kernel's public surface — consumers import them directly.

| Module | Role |
| --- | --- |
| `types.ts` | Shared ref aliases and structured verification results. |
| `entity.ts` | `Entity` / `EntityState` / `EntityStructure` model + builders. |
| `ax.ts` | **DOM↔AX merge** — backend identity plus bounded geometry/semantic enrichment, DOM-authoritative physical state, AX-authoritative accessible semantics/state/structure. |
| `grouping.ts` | Shared ARIA-grounded grouping kernel: descriptors, indexed groups, scope helpers, normalized/display text helpers. |
| `nodeKey.ts` | Stable cross-provider node keys. |
| `identityBootstrap.ts` | Best-effort scan rect ↔ DOMSnapshot backend identity candidate diagnostics. |
| `spatialIndex.ts` | Shared bounded spatial candidate index with correctness-preserving overflow fallback. |
| `templating.ts` | Structure templating for repeated AX/ARIA sibling groups. |
| `treeDiff.ts` | Template-level living diff over repeated structures; O(change) projection without ref-mint changes. |
| `semanticRefAnchor.ts` | Semantic ref-anchor candidate derivation for repeated structures. |
| `snapshotProjection.ts` | M2c living snapshot projection — compact current templates plus attached template deltas for saved observe artifacts. |
| `collections.ts` | Collection completeness evidence for long, virtualized, lazy, and paginated structures. |
| `relations.ts`, `causal.ts` | Semantic relations and causal evidence. |
| `diff.ts`, `verification.ts` | Entity-level changes and post-action verification. |
| `pageWorldScan.ts`, `pageObservation.ts` | Page-world input and assembled observation contracts. |

Generic ref descriptor types, URI minting, stable IDs, and ref-access policy live in
[`../refs/`](../refs) so resource storage and ABML share one ref owner without
making resource ports depend on ABML.

Browser I/O lives in `../../browser-runtime/abml/runtime.ts`; AX capture lives in
`../../browser-runtime/abml/axRuntime.ts` and feeds the pure merge kernel.

## Fusion invariants

- A fused observation is accepted only when the same page fingerprint brackets DOM scan through AX capture; missing or changed fingerprints get one retry before scan-only degradation and never publish a scan-local fingerprint.
- Entity/ref geometry is viewport-relative CSS pixels. Raw DOMSnapshot bootstrap and paint geometry is document-relative CSS pixels and is converted only at the runtime boundary.
- Backend identity is authoritative and scoped by `(targetId, backendNodeId)`. The current full-AX reader and DOMSnapshot projection consume only the main target/document; skipped snapshot documents are diagnosed instead of flattened into the top-level coordinate space.
- Geometry and semantic matches must be role-compatible and mutually unique. They may enrich fields, but never promote backend/AX locators, identity hints, or actionability; geometry bootstrap is diagnostic-only.
- DOM owns physical visibility, viewport, occlusion, focus, editability, and `aria-current`. AX owns accessible role/name/value, structure, and checked/selected/pressed/expanded state; AX values are admitted only when the main DOMSnapshot classifies the backend node as non-password.
- AX-only controls declare click/edit actions only when they carry an executable backend identity; otherwise they remain semantic context.
- Unsafe AX text suppresses only semantic fallback. An exact backend match may still contribute safe state and structure.

## The boundary is CI-enforced

`mise run verify` includes the architecture boundary checks for this kernel through the canonical lint gate. Files here must import only another core
module or an approved transitively-pure cross-cutting helper. A command, adapter, bridge, browser
runtime, Node-only, or npm dependency import is a boundary violation.

## Extending the kernel

- **Improve perception** (new ARIA state/relationship/structure) → it almost always belongs in
  `ax.ts` (the merge), `entity.ts` (the model), `grouping.ts`, `templating.ts`, `treeDiff.ts`, `semanticRefAnchor.ts`, `snapshotProjection.ts`, or `collections.ts`. Stay generic —
	ABML models ARIA patterns, never per-site/per-framework branches.
- **Improve verification** → keep browser reads in runtime code and put deterministic evidence
  evaluation in `verification.ts`.

## Consumers

Consumers import the kernel modules directly from `src/kernels/abml/*`. Browser I/O code stays
outside the kernel in the browser-runtime layer.
