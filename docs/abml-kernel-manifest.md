# ABML kernel manifest

ABML (the perception substrate under `browser_*`) splits into **two layers** with a strict
one-way dependency direction:

```
   RUNTIME  ───imports──▶  PURE CORE        (never the reverse)
 (browser I/O)            (pure functions + types)
```

- **PURE CORE** — zero browser / zero Node dependencies. Pure functions and types that *model*
  a page: entities, refs, the DOM↔AX merge, actionability rules, verb decisions, error shaping.
  Portable, unit-testable without a browser, and the long-term candidate for an isolated
  `@pi/abml-core` package. **15 files.**
- **RUNTIME** — everything that talks to the live browser: imports `driver/`, `tools/`, `scan/`,
  `resources/`, or `node:*`. Drives the pure core with real page data. **7 files.**

The boundary is **enforced by a contract test**, not by convention:
`tests/contracts/drift/check-abml-core-boundary.mjs` (run via `npm run check:abml-core-boundary`,
and inside `npm run check` under the `docs` group). The test holds the same lists below as the
machine-readable manifest; **keep the two in sync** — if they diverge, or a new `src/abml/*.ts`
file is added without classification, or a pure-core file imports a runtime layer, CI goes red.

## Pure core (15 — zero browser/Node deps)

| File | Role |
| --- | --- |
| `types.ts` | Foundational types (locators, refs, actionability, errors, captures). No imports. |
| `refPolicy.ts` | Ref-access policy per kind (`defaultRefPolicyForKind`, `decideRefAccess`). |
| `actionabilityModel.ts` | Verb→actionability spec mapping; action-verb classification. |
| `resolveModel.ts` | Candidate/resolve result shaping (pure data). |
| `entity.ts` | `Entity`/`EntityState`/`EntityStructure` model + builders. |
| `ax.ts` | DOM↔AX merge core: box-IoU/role/name scoring, AX-authoritative state/structure fusion. |
| `stream.ts` | Capture-ref / network-entry / event entity shaping. |
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

## Forward path

This manifest + contract test is **phase 1** (boundary固化): zero code movement, zero behavior
change — the kernel is now documented and CI-locked.

- **Phase 2** (physical split): move the 15 pure-core files to `src/abml-core/`, leave the 7
  runtime files in `src/abml/`, and keep thin re-export shims so every consumer's import path is
  unchanged. The whitelist above becomes `abml-core`'s only outward dependency surface.
- **Phase 3** (optional): extract `src/abml-core/` into a zero-runtime-dep workspace package
  `@pi/abml-core` (pure functions + types). Understanding the kernel then means reading one
  dependency-free package.
