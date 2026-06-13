# ABML kernel manifest

> Doc-class: contract

ABML (the perception substrate under `browser_*`) splits into **two layers** with a strict
one-way dependency direction:

```
   RUNTIME  ───imports──▶  PURE CORE        (never the reverse)
 (browser I/O)            (pure functions + types)
```

- **PURE CORE** — lives in `src/abml-core/`. Zero browser / zero Node dependencies. Pure
  functions and types that *model* a page: entities, refs, the DOM↔AX merge, actionability rules,
  verb decisions, error shaping, temporal entity diff, collection completeness, and mechanism-arm structure diff. Portable,
  unit-testable without a browser, and the long-term candidate for an isolated `@pi/abml-core`
  package. **23 modules + an `index.ts` barrel.**
- **RUNTIME** — lives in `src/abml/`. Everything that talks to the live browser: imports
  `driver/`, `tools/`, `scan/`, `resources/`, or `node:*`, or owns live session ledger state.
  Drives the pure core with real page data. **7 files.**

`src/abml/` also keeps **23 thin re-export shims** at the old pure-core paths, so existing importers such as `src/resources/resourceStore.ts`, `src/tools/summaries/scan.ts`, `src/tools/observeRunners.ts`, the runtime verbs, and unit tests keep their import paths unchanged.

The boundary is **enforced by a contract test**, not by convention:
`tests/contracts/drift/check-abml-core-boundary.mjs` (run via `npm run check:abml-core-boundary`,
and inside `npm run check` under the `docs` group). The tables below are generated from the same machine-readable manifest used by the test. If a new file is added to
`src/abml-core/` or `src/abml/` without classification, or a pure-core file imports a runtime
layer, or a shim goes missing, CI goes red.

## ABML documentation map

ABML is covered by a small, role-separated doc set. Start at the row that matches what you need;
each doc links back here.

| Doc | Role | Read it when |
| --- | --- | --- |
| [`src/abml-core/README.md`](../src/abml-core/README.md) | Kernel front door — onboarding + how to extend | you are working in the kernel code |
| `docs/abml-kernel-manifest.md` (this) | Layer manifest + CI boundary spec + package-promotion recipe | you need the pure-core ⇄ runtime rule or the file classification |
| [`docs/abml-p1-spec.md`](abml-p1-spec.md) | AX-authoritative state **language spec** (P1, REVIEWED) | you need the formal contract for entity state / pure-function behavior |
| [`docs/abml-perception-state-evolution-plan.md`](abml-perception-state-evolution-plan.md) | Perception **north-star** + R1/R2/R3 semantic-depth roadmap | you are planning new perception capability |
| [`docs/archive/abml-collection-continuation-kernel-plan.md`](archive/abml-collection-continuation-kernel-plan.md) | Completed execution summary for collection completeness + semantic continuation | you are reviewing how ABML long-list completeness shipped without public action verbs |
| [`docs/archive/abml-execution-plan.md`](archive/abml-execution-plan.md) | Historical execution contract (no longer the active queue — see `CURRENT.md` / `TODO.md`) | you want the historical phase log / file mapping |
| [`docs/abml-optimization-reference.md`](abml-optimization-reference.md) | Optimization reference for ABML cost/precision tradeoffs | you are changing perception budgets, summaries, or optimization heuristics |

## Pure core (23 — zero browser/Node deps)

<!-- BEGIN GENERATED: abml-pure-core-manifest (npm run docs:sync) -->
| File | Role |
| --- | --- |
| `types.ts` | Foundational types (locators, refs, actionability, errors, captures). No imports. |
| `refId.ts` | Pure pi-ref URI minting and summary placeholder ref IDs. |
| `refPolicy.ts` | Ref-access policy per kind (`defaultRefPolicyForKind`, `decideRefAccess`). |
| `actionabilityModel.ts` | Verb-to-actionability spec mapping; action-verb classification. |
| `entity.ts` | `Entity`/`EntityState`/`EntityStructure`/`EntityRelation` model plus builders. |
| `ax.ts` | DOM/AX merge core, AX-authoritative state/structure fusion, relation-anchor extraction. |
| `relations.ts` | ABML relationship graph materialization, dedupe, cap, and envelope relation summary. |
| `inference.ts` | ARIA pattern detection plus temporal form dependency over entities and relation summaries. |
| `diff.ts` | Temporal entity diff: appeared, disappeared, state/name changes, focused ref. |
| `stream.ts` | Capture-ref, network-entry, and event entity shaping. |
| `causal.ts` | Passive network-delta causal plane summary. |
| `grouping.ts` | ARIA-grounded grouping, descriptor derivation, scope helpers, display text normalization. |
| `templating.ts` | Repeated sibling structure templating and compact instance handles. |
| `treeDiff.ts` | Template-level living diff over repeated structures. |
| `semanticRefAnchor.ts` | Pure semantic ref-anchor candidate and shadow-hash derivation. |
| `snapshotProjection.ts` | Living snapshot projection and attached template deltas. |
| `collections.ts` |  |
| `identityGraph.ts` | Pure semantic identity graph used to stabilize entity identity across observations. |
| `errors.ts` | `normalizeAbmlError` plus recovery shaping. |
| `verbs/router.ts` | Verb dispatch types and actionability/verification failure builders. |
| `verbs/read.ts` | Read verb decision logic. |
| `verbs/frame.ts` | Frame verb decision logic. |
| `verbs/pierce.ts` | Pierce verb decision logic. |
<!-- END GENERATED: abml-pure-core-manifest -->

## Runtime (7 — talk to the live browser)

<!-- BEGIN GENERATED: abml-runtime-manifest (npm run docs:sync) -->
| File | Why runtime |
| --- | --- |
| `perceptionLedger.ts` | Live per-session perception ledger, render cache, and trace state. |
| `verbs/axRuntime.ts` | Driver/tool validation/resource integration for AX runtime work. |
| `verbs/frameRuntime.ts` | Driver/tool validation/resource integration for frame runtime work. |
| `verbs/pierceRuntime.ts` | Driver/tool validation/resource integration for pierce runtime work. |
| `verbs/visionRuntime.ts` | Node filesystem/path plus driver/resource integration for vision captures. |
| `verbs/runtime.ts` | Orchestrator that reaches driver, scan, tools, resources, and live browser state. |
| `verbs/integration.ts` | Driver-facing `createBrowserAbmlRuntime` wiring. |
<!-- END GENERATED: abml-runtime-manifest -->

## Whitelisted cross-cutting modules (5 — a pure-core file MAY import these)

Each has been verified **transitively pure** — its own dependency closure reaches no `driver/tools/scan/resources/node`. Adding to this whitelist requires re-verifying that closure; otherwise move the would-be consumer to RUNTIME instead.

<!-- BEGIN GENERATED: abml-crosscutting-manifest (npm run docs:sync) -->
| Module | Closure |
| --- | --- |
| `utils/records` | (no imports) |
| `utils/errors` | -> `protocol/nativeErrorCodes`, `utils/records`, `utils/redaction` |
| `utils/redaction` | -> `utils/json` |
| `utils/json` | (no imports) |
| `protocol/nativeErrorCodes` | (no imports, generated) |
<!-- END GENERATED: abml-crosscutting-manifest -->

## Kernel entry point

`src/abml-core/index.ts` is the public barrel — `export *` of all pure-core modules, the single place
that shows everything the kernel exposes. It is the future package's entry point. It is additive:
existing consumers still import individual modules through the `src/abml/` shims and are unchanged.

## Forward path

- **Phase 1 — boundary固化 (done):** this manifest + contract test. Zero code movement, zero
  behavior change — the kernel is documented and CI-locked.
- **Phase 2 — physical split (done):** the pure-core files now live in `src/abml-core/`; the 6
  runtime files stay in `src/abml/`; thin re-export shims at the old pure-core paths keep every
  consumer's import path unchanged. The whitelist above is now `abml-core`'s only outward
  dependency surface (verified by the boundary test). No behavior change — `tsc` (both projects)
  + `test:unit` (361) stay green.
- **Phase 3 — package identity (partial, done):** the `index.ts` barrel gives the kernel one
  readable entry point — the "understand the kernel by reading one self-contained unit" benefit —
  at zero risk (additive, pure re-exports, CI-locked).

  The remaining step — promoting `src/abml-core/` to a real **workspace package `@pi/abml-core`**
  (so code can `import "@pi/abml-core"` by name) — is **deliberately deferred**, not blocked. This
  repo is a single `private` package with a hard dependency allowlist (`check:deps` asserts
  `package-lock` ⇆ `package.json` parity) and ships **unbundled ESM** (a bare `@pi/abml-core`
  specifier would not resolve in `dist/` without a real `node_modules` entry). Making it a true
  workspace therefore mutates root `package.json` (`workspaces`), regenerates `package-lock.json`,
  and adds a published-artifact surface — outside the "safe / minimal / zero-risk" envelope this
  decoupling has held to so far. When that promotion is wanted, the ready recipe is:

  1. add `src/abml-core/package.json` → `{ "name": "@pi/abml-core", "private": true, "type":
     "module", "main": "./index.ts", "sideEffects": false }` (zero `dependencies`);
  2. add `"workspaces": ["src/abml-core"]` to root `package.json`; run `npm install`;
  3. re-point the `src/abml/` shims to `export * from "@pi/abml-core/<module>.js"` (or keep the
     relative shims — both work);
  4. either vendor the 5 whitelisted pure helpers into the package, or keep importing them
     relatively (the package stays zero **third-party** deps either way — they are first-party pure
     leaf utilities);
  5. extend `check:deps` to cover the workspace lockfile entry, and `check:abml-core-boundary` to
     assert the package has no `dependencies`.
