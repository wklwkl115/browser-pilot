# Governance Mechanisms Plan (accumulation-class defect prevention)

> Status: **completed** (2026-06-12). G1-G7 are now concrete contract gates or a
> validated read-only audit procedure.
>
> Origin: the 2026-06-11 ABML and distill kernel audits found ~20 defects that all
> cluster into five structural causes — prose-contract drift, add/remove asymmetry
> (dead surface accumulation), slice-scoped recomputation, a purity ban-list lagging
> the purity requirement, and delta-only test gating. The existing gate system
> prevents *regression* perfectly on the dimensions it gates; every finding lived on
> an ungated dimension. This plan extends the project's five proven gate patterns
> (single source + drift check, source-text contract assertions, shrink-only
> ratchets, committed baselines, shadow guards) onto those ungated dimensions.
>
> Relationship to other plans: the original design expected G3/G4/G5/G6 to ride
> along with `docs/distill-kernel-hygiene-plan.md` items (D1/D7, D2, D6, D4).
> Execution happened after distill hygiene and value-ordered compaction had already
> completed, so this workstream retrofitted the gates onto the post-D/post-K state
> and used the already-fixed defects as the first negative controls. G1/G2/G7
> remained independent slices.
>
> Governance: activation was registered in `CURRENT.md` before execution started;
> completion evidence is recorded below.

## Design constraints

- Every mechanism is a fail-fast script in the `contracts` check group. No human
  approval steps, no RFC process — the Executability Rule stays intact.
- Each new check runs in seconds; total added wall-clock to `npm run check` stays
  under +10s (~5% of the current full gate).
- Ratchets are shrink-only with committed baselines (the `check:summary-boundary`
  31-position precedent). Grandfathering is allowed at introduction; growth is not.
- Anti-goals: no coverage-percentage targets (gameable); no freezing of specs (G1
  keeps them honest, not immutable); no gating of `docs/archive/**` (historical
  records); no G2 inventory for the public tools layer (already governed by
  `docs:generate` + tool-docs drift checks).

## G1 — Spec-truth gate (counters: prose-contract drift)

**Mechanism.** A claims registry bridges living contract docs and code, the protocol
single-source pattern applied to prose.

- Registry: `tests/contracts/drift/spec-claims.js` — a committed list of contract
  docs, each with claim entries `{ anchor, symbol, status: "implemented" | "reserved",
  sourceGlob }`. Registered docs add a `> Doc-class: contract` header line; only
  registered docs are gated (no mass-editing of other docs).
- Gate: `check:spec-truth` (`tests/contracts/drift/check-spec-truth.mjs`):
  - `implemented` → the symbol greps in the claimed source glob;
  - `reserved` → the doc carries an explicit reserved/unimplemented marker within the
    anchor's section (the post-K1 `abml-p1-spec.md` reserved appendix is the format
    precedent);
  - every claim's `anchor` text still exists in the doc (anchors cannot rot);
  - mechanical doc facts are re-derived where cheap (e.g. the kernel-manifest module
    counts are asserted against actual file counts in `src/abml-core/`).

**Seed claims.** `docs/abml-p1-spec.md` (post-K1): dual locator-priority section
present; §scoring weights + `CandidateSummary` marked reserved; ref URI format
`pi-ref://<kind>/<id>` matches `refId.ts`. `docs/abml-kernel-manifest.md`: module
counts match the boundary check's PURE_CORE/RUNTIME arrays.

**Gates.** New `check:spec-truth` wired into contracts group; `check:doc-structure`
extended to accept the `Doc-class` header.

## G2 — Kernel surface-liveness ledger (counters: dead-surface accumulation)

**Mechanism.** `check:surface-liveness` over the pure kernels only (`src/abml-core/`,
`src/distill-core/`, `src/memory-core/`; capture's entry set is already pinned by its
own boundary).

- Inventory: `tests/contracts/drift/kernel-export-inventory.json` — every export of
  every kernel module with a status: `consumed` | `internal` | `test-harness` |
  `reserved:<promotion bar>`. Initial inventory is script-generated, statuses seeded
  from the two audit reports.
- Assertions:
  1. actual exports ⊆ inventory — a new export without a declared status fails;
  2. inventory ⊆ actual exports — stale ledger entries fail;
  3. `consumed` → at least one importer outside the kernel, its shims, and tests
     (grep-verified) — an export that loses its last consumer turns the gate red and
     forces an explicit decision: remove, or re-classify with a written bar;
  4. `reserved` → non-empty bar string (the V6 shadow-guard comment is the format
     precedent).

**Seed statuses from execution.** The committed ledger covers 49 kernel modules.
The only reserved member entries are `FactSalience.novelty` and `Locator.xpath`,
each with a written promotion bar. `FactSalience.relevance` is active in current
code/tests, so it is not reserved. `test-harness` covers direct-test exports such
as `buildTemplateSummary` and `assertRelevanceTuningBounds`. Anything removed
before this workstream never entered the ledger.

**Gates.** New `check:surface-liveness` in contracts group.

## G3 — Compute-once contract + serialization canary (counters: slice-scoped recomputation; A1→D1/D7 recurred three times)

**Mechanism A — call-site ledger.** `check:compute-once`
(`tests/contracts/drift/check-compute-once.mjs`): a committed table of
`{ file, callee, maxCallSites }`, asserted by source-text counting (the
`check-abml-templating.mjs:104` "must NOT call" precedent, parameterized). Seeds
(post-D1/D7 state):

- `src/tools/observeRunners.ts`: `buildSnapshotProjection` ≤ 1 (A1 regression lock),
  `scanEntitiesForEnvelope` ≤ 1, `buildScanEntities` ≤ 1 (built once in the observe
  render path and threaded onward);
- `src/tools/resultMiddleware.ts`: `envelopeEntities(` ≤ 1 (post-D7);
- `src/tools/summaries/scan.ts`: `buildScanEntities` ≤ 2.

**Mechanism B — serialization-count canary.** `stableJson` (`src/utils/json.ts`) gains
a test-readable invocation counter (one module-level increment — negligible cost; use
`node:test` module mocking instead if the runtime supports it). A unit test renders
the committed high-entropy scan fixture through `distilledJsonResult` and asserts the
serialization count ≤ a committed ceiling with headroom. Catches reintroduced
double-fitting that the byte-only `bench:distill` cannot see.

**Ride-along.** Lands in the same workstream as D1/D7.

**Gates.** New `check:compute-once`; canary in `test:unit`.

## G4 — Shared purity vocabulary (counters: ban-list lag; generalizes landed K3 + planned D2)

**Mechanism.** Extract the banned-API list into one module,
`tests/contracts/drift/purity-vocabulary.js`, exporting the patterns
(`Date.now(`, `Math.random(`, `new Date(`, `performance.now(`, `localeCompare(`,
`toLocale`, `process.env`). Consumers: `check-abml-core-boundary.mjs` (refactor the
K3-landed list to import the shared one), `check-distill-core-boundary.mjs` (D2),
`check-memory-core-boundary.mjs` (new adoption — memory-core is spec'd pure).
`check-capture-core-boundary.mjs` is exempt initially: page-world sensing code may
legitimately read page-time; revisit only with evidence.

A new word added to the vocabulary tightens all adopting kernels in one diff; a fifth
kernel inherits the vocabulary by importing one module.

**Ride-along.** Lands with D2.

**Execution note.** Importing the shared vocabulary into memory-core exposed
locale-sensitive ordering in `profile.ts`, `recall.ts`, and `staleness.ts`; those
paths now use plain lowercase/codepoint ordering before the memory-core boundary
check runs.

**Gates.** The three adopting boundary checks stay green; a vocabulary self-test
asserts each pattern matches a synthetic positive and misses a synthetic negative.

## G5 — Kernel stock-coverage ratchet (counters: delta-only test gating)

**Mechanism.** `check:kernel-test-map` (`tests/contracts/drift/check-kernel-test-map.mjs`):

- Committed map: kernel module → direct test file(s); the gate verifies each listed
  test file exists and actually imports the module (grep).
- Grandfather list of zero-direct-coverage modules, seeded by re-running the audit
  greps at execution time. The committed baseline is `grandfatherMax: 6`:
  `src/abml-core/grouping.ts`, pure barrels `src/abml-core/index.ts` and
  `src/memory-core/index.ts`, `src/distill-core/frontier.ts`,
  `src/memory-core/routing.ts`, and `src/memory-core/salience.ts`.
- Assertions: every kernel module is either mapped or grandfathered; the grandfather
  count is shrink-only against its committed baseline; a NEW kernel module must ship
  mapped (fail on new unmapped module).

Explicitly not a coverage-percentage gate: the unit is "module has at least one test
file that directly imports and asserts it".

**Ride-along.** Lands with D6 (which shrinks the distill side of the list to zero).

**Gates.** New `check:kernel-test-map` in contracts group.

## G6 — Cross-cutting env-flag registry (counters: unkeyed caches / signature misses)

**Mechanism.** `check:env-flags` (`tests/contracts/drift/check-env-flags.mjs`) with a
committed registry of every `PI_BROWSER_*` flag:
`{ name, affectsOutput: boolean, signatureSites: string[] }`.

- Assertions:
  1. every `process.env.PI_BROWSER_*` hit in `src/` is registered (unregistered flag
     fails — forces the "which caches must key on this?" question at introduction);
  2. for `affectsOutput: true` flags, each listed signature site (e.g.
     `observeRenderParamsSignature` post-D4) textually references the flag or its
     derived marker;
  3. registry entries with zero source hits fail (stale entries rot out).
- Seeded by grep at execution time. The committed registry currently has 22
  `PI_BROWSER_*` flags under `src/` and `cli/`. Output-affecting flags include
  renderer/token-cost/session-delta/relevance/relevance-debug, memory and memory
  autosurface, JSON projection, execute effect, and stdlib flags; each declares
  a source marker that must stay in its signature site.
- Side benefit: the registry becomes the single authoritative env-flag list
  (currently scattered across CLAUDE.md, skills, and code comments).

**Ride-along.** Lands with D4.

**Gates.** New `check:env-flags` in contracts group.

## G7 — Institutionalized kernel audit (compensation for whatever stays ungated)

**Mechanism.** `skills/pi-kernel-audit/SKILL.md` — an operator/cron procedure in the
`agent-audits/` role contract (auditors write reports under `agent-audits/runs/`,
never change code):

- The reusable prompt set from the two 2026-06-11 audits, one per dimension:
  consumption surface, spec/doc drift, dataflow liveness, determinism, caps/redaction
  (perception kernels) or constants/budget tree (express kernel), performance,
  test coverage. Read-only subagents, file:line evidence, facts-only output.
- Triage convention: the eval-fixes bar applies — only true general defects become
  plan items; rejected findings are recorded in the consuming plan so they are not
  re-litigated.
- Cadence: per quarter or per ~5 completed workstreams, whichever first.
- **Graduation rule (meta):** when an audit-class finding recurs a second time, it
  must graduate from G7 into a static gate (G1-G6 pattern). This is codified here
  because it is exactly how G3 was born (A1 → D1/D7).

**Gates.** `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py`
on the new skill; `check:doc-structure` for the audit-inbox wording if touched.

## Execution result

1. G4/G3/G6/G1/G5/G2 landed as drift checks in `tests/contracts/drift/`, with
   package scripts and `scripts/run-check-groups.mjs` contract-group wiring.
2. G4 reused a shared purity vocabulary across ABML, distill, and memory pure
   kernel boundary checks.
3. G3 locked current compute-once call-site ceilings and added a
   `stableJson` serialization-count canary to `resultMiddleware` unit coverage.
4. G6 introduced the committed env-flag registry and expanded observe render-cache
   signatures for output-affecting observe flags.
5. G1 promoted `docs/abml-p1-spec.md` and `docs/abml-kernel-manifest.md` to
   registered contract docs, including a real manifest correction: ABML runtime
   files are 7, not 6, because `src/abml/perceptionLedger.ts` is runtime.
6. G2 committed the kernel export inventory with 49 modules and 2 reserved members.
7. G5 committed direct-test mapping for 43 modules with a shrink-only
   `grandfatherMax: 6` baseline.
8. G7 added `skills/pi-kernel-audit/SKILL.md` and records the graduation rule:
   a recurring audit-class finding must become a static G1-G6 style gate.

## Acceptance

- New focused gates passed: `check:spec-truth`, `check:surface-liveness`,
  `check:compute-once`, `check:purity-vocabulary`, `check:kernel-test-map`,
  `check:env-flags`, and `check:memory-core-boundary`.
- Related focused tests passed:
  `npx tsx --test tests/unit/tools/resultMiddleware-advanced.test.ts` and
  `npx tsx --test tests/unit/memory-core/profile.test.ts tests/unit/memory-core/recall.test.ts tests/unit/memory-core/staleness.test.ts tests/unit/memory/profileService.concurrency.test.ts tests/unit/memory/profileStore.test.ts`.
- Contract group passed: `npm run check:all:contracts`.
- Audit skill validation passed:
  `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-kernel-audit`.
- Final closeout passed: `npm run lint`, full `npm run check`, and
  `git diff --check`.
- Ratchet baselines committed: G5 grandfather count, G2 reserved count recorded (G2
  reserved is tracked, shrink encouraged, growth requires a written bar; G5 is
  strictly shrink-only).
- The graduation rule is recorded in this doc and referenced from the audit skill, so
  the next recurrence of any audit-class finding has a defined escalation path.
