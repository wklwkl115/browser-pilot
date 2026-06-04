# ABML kernel manifest

ABML (the perception substrate under `browser_*`) splits into **two layers** with a strict
one-way dependency direction:

```
   RUNTIME  ───imports──▶  PURE CORE        (never the reverse)
 (browser I/O)            (pure functions + types)
```

- **PURE CORE** — lives in `src/abml-core/`. Zero browser / zero Node dependencies. Pure
  functions and types that *model* a page: entities, refs, the DOM↔AX merge, actionability rules,
  verb decisions, error shaping, temporal entity diff, and mechanism-arm structure diff. Portable,
  unit-testable without a browser, and the long-term candidate for an isolated `@pi/abml-core`
  package. **22 modules + an `index.ts` barrel.**
- **RUNTIME** — lives in `src/abml/`. Everything that talks to the live browser: imports
  `driver/`, `tools/`, `scan/`, `resources/`, or `node:*`. Drives the pure core with real page
  data. **7 files.**

`src/abml/` also keeps **22 thin re-export shims** at the old pure-core paths (e.g.
`src/abml/entity.ts` → `export * from "../abml-core/entity.js"`), so every existing importer —
`src/resources/resourceStore.ts`, `src/tools/summaries/scan.ts`, `src/tools/observeRunners.ts`,
the runtime verbs, `mcp/handleResolver.ts`, and all unit tests — keeps its import path unchanged.

The boundary is **enforced by a contract test**, not by convention:
`tests/contracts/drift/check-abml-core-boundary.mjs` (run via `npm run check:abml-core-boundary`,
and inside `npm run check` under the `docs` group). The test holds the same lists below as the
machine-readable manifest; **keep the two in sync** — if they diverge, or a new file is added to
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
| [`docs/abml-execution-plan.md`](abml-execution-plan.md) | Historical execution contract (no longer the active queue — see `CLAUDE.md`) | you want the historical phase log / file mapping |

## Pure core (23 — zero browser/Node deps)

| File | Role |
| --- | --- |
| `types.ts` | Foundational types (locators, refs, actionability, errors, captures). No imports. |
| `refPolicy.ts` | Ref-access policy per kind (`defaultRefPolicyForKind`, `decideRefAccess`). |
| `actionabilityModel.ts` | Verb→actionability spec mapping; action-verb classification. |
| `resolveModel.ts` | Candidate/resolve result shaping (pure data). |
| `entity.ts` | `Entity`/`EntityState`/`EntityStructure`/`EntityRelation` model + builders. |
| `ax.ts` | DOM↔AX merge core: box-IoU/role/name scoring, AX-authoritative state/structure fusion; AX relation-anchor extraction (R1). |
| `relations.ts` | ABML R1 relationship graph: anchor→ref materialization, dedupe/cap, envelope relation summary. |
| `inference.ts` | ABML R2/R3 inference layer: generic ARIA pattern detection plus temporal `form-dependency` over entities + R1 relation summary + optional R3 diff. |
| `diff.ts` | ABML R3 temporal entity diff: appeared/disappeared/state-changed/name-changed/focusedRef between two entity snapshots. |
| `stream.ts` | Capture-ref / network-entry / event entity shaping. |
| `causal.ts` | ABML R3.x causal plane (P0): network-delta summary — requests fired since a baseline observation, redacted + capped; passive (no control attribution). |
| `templating.ts` | ABML mechanism arm (M1): structure templating — folds repeated sibling entities (same AX container / aria-setsize + role/kind) into one template + compact instances + handles. |
| `treeDiff.ts` | ABML mechanism arm (M2a): template-level living diff over repeated structures; O(change) projection for scan baselines without changing ref minting. |
| `semanticRefAnchor.ts` | ABML mechanism arm (M2b): pure semantic ref-anchor candidate and shadow-hash input derivation; high-confidence anchors feed gated runtime ref minting. |
| `snapshotProjection.ts` | ABML mechanism arm (M2c): living snapshot projection — compact current templates plus attached template deltas for saved observe artifacts. |
| `errors.ts` | `normalizeAbmlError` + recovery shaping (uses pure redaction/error utils). |
| `verbs/router.ts` | Verb dispatch types + actionability/verification failure builders. |
| `verbs/click.ts` | Click verb decision logic (pure; no browser call). |
| `verbs/type.ts` | Type verb decision logic. |
| `verbs/scroll.ts` | Scroll verb decision logic. |
| `verbs/read.ts` | Read verb decision logic. |
| `verbs/frame.ts` | Frame verb decision logic. |
| `verbs/pierce.ts` | Pierce verb decision logic. |

## Runtime (7 — talk to the live browser)

| File | Why runtime (forbidden-for-core imports) |
| --- | --- |
| `verbs/runtime.ts` | Orchestrator: `driver`, `scan/buildScanScript`, `tools/*`, `resources/resourceStore`. |
| `verbs/axRuntime.ts` | `driver`, `tools/bridgeResultValidation`, `resources/resourceStore`. |
| `verbs/frameRuntime.ts` | `driver`, `tools/bridgeResultValidation`, `resources/resourceStore`. |
| `verbs/pierceRuntime.ts` | `driver`, `tools/bridgeResultValidation`, `resources/resourceStore`. |
| `verbs/streamRuntime.ts` | `resources/resourceReader`, `resources/resourceStore`. |
| `verbs/visionRuntime.ts` | `node:fs/promises`, `node:path`, `driver`, `tools/artifacts`, `resources`. |
| `verbs/integration.ts` | `driver`; wires `createBrowserAbmlRuntime`. |

## Whitelisted cross-cutting modules (5 — a pure-core file MAY import these)

Each has been verified **transitively pure** — its own dependency closure reaches no
`driver/tools/scan/resources/node`. Adding to this whitelist requires re-verifying that closure;
otherwise move the would-be consumer to RUNTIME instead.

| Module | Closure |
| --- | --- |
| `utils/records` | (no imports) |
| `utils/json` | (no imports) |
| `utils/redaction` | → `utils/json` |
| `utils/errors` | → `protocol/nativeErrorCodes`, `utils/records`, `utils/redaction` |
| `protocol/nativeErrorCodes` | (no imports — generated) |

## Kernel entry point

`src/abml-core/index.ts` is the public barrel — `export *` of all pure-core modules, the single place
that shows everything the kernel exposes. It is the future package's entry point. It is additive:
existing consumers still import individual modules through the `src/abml/` shims and are unchanged.

## Forward path

- **Phase 1 — boundary固化 (done):** this manifest + contract test. Zero code movement, zero
  behavior change — the kernel is documented and CI-locked.
- **Phase 2 — physical split (done):** the pure-core files now live in `src/abml-core/`; the 7
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
  3. re-point the 15 `src/abml/` shims to `export * from "@pi/abml-core/<module>.js"` (or keep the
     relative shims — both work);
  4. either vendor the 5 whitelisted pure helpers into the package, or keep importing them
     relatively (the package stays zero **third-party** deps either way — they are first-party pure
     leaf utilities);
  5. extend `check:deps` to cover the workspace lockfile entry, and `check:abml-core-boundary` to
     assert the package has no `dependencies`.
