# Agent Development Harness Optimization Plan

> Status: COMPLETE — drafted and implemented 2026-06-12 from a 4-scout evidence fan-out (check-runner
> infrastructure, contract-corpus census, governance/process surfaces, dev-loop
> ergonomics), extended same day with a second 3-scout pass on the code
> navigation/comprehension dimension (codebase topology, orientation-doc audit,
> change-scenario discovery-cost walkthroughs) which added Track D. A same-day
> external design audit (7 findings + 2 optimizations) was code-verified and
> consumed: A1 fail-closed scopes with `unresolvedInputs`, A2 covers the
> `check:all:*` group aliases via existing DAG group mode (`check-dag.mjs:334`),
> B2 reordered ahead of its consumers, A3 graph semantics specified, B1 refined
> to cross-artifact consistency, D3 switched to registration-execution
> derivation, D6 renamed/rescoped to summary field maps, a shared
> `repo-introspection` library extracted, and C3 index entries made auditable.
> A v2 architect refactor pass (same day) then restructured execution into five
> independently closeable phases (a 22-item single chain is itself an off-track
> risk), added C4 (new-check scaffolder), C5 (workstream scope sentinel,
> visibility-only), made `AGENTS.md` the single editing surface for the mirrored
> governance rules (the CLAUDE.md inlined block becomes a D7 managed block), and
> retired the overlapping `check:lint` legacy aggregate (A5).
> Implementation was activated in `CURRENT.md` and executed under the repo
> executability rule as one continuous closure workstream; each phase below now
> has concrete code, docs, contracts, artifacts, and verification evidence in
> §Results.
> Scope: the **development harness** — the check graph, contract corpus, governance
> docs, and process tooling that AI dev agents use to change this project. This is
> the counterpart to `docs/agent-harness-optimization-plan.md` (ACI-1..12), which
> optimized the harness for agents *using* the tools; this plan optimizes the
> harness for agents *developing* them.

## Problem statement

This project is developed entirely by AI agents; humans decide and relay. The dev
harness already has strong recent layers (check acceleration: trace/DAG/cache/smart;
governance gates G1–G7; audit inbox; document-structure gates). Scout evidence shows
five structural weaknesses remaining:

1. **Trust gaps in the verification loop.** `check:smart` silently under-selects
   (a `src/abml-core/` edit selects 3 nodes while 16 `check:abml-*` contracts read
   abml-core sources — `scripts/check-dag.mjs:134-139`); the canonical closing gate
   `npm run check` is the *serial* engine (173.4s measured), excludes ESLint, and
   writes an artifact with empty output tails; CI never runs `check:src:types`.
2. **Contract-corpus brittleness.** ~1,100+ source-text `.includes()` assertions
   across 79 contract files; the rename-fragile subset (identifier names, verbatim
   code fragments) has already broken twice (`distDir`→`defaultDistDir` vs
   `check-package-files.mjs:59`; `templateGroupDescriptorForEntity` move vs
   `check-abml-tree-diff.mjs`). No way to query "which contracts pin this string"
   before renaming. Five ledgers re-pin only by hand with no tooling.
3. **Diagnostics that don't name their fix.** Several gate/sync failures omit the
   fixer command or ledger path (`sync-native-protocol.mjs:427`,
   `check-surface-liveness.mjs:122`, miss-artifact `likelyRepairTarget` is a
   hardcoded four-way disjunction).
4. **Process knowledge trapped outside the repo.** The hardest-won operational
   lessons (narrow gates ≠ closing gate; exit-code masking by piping; red-first
   test verification; activation-entry-before-work) live only in one operator's
   session memory, invisible to fresh or non-Claude agents. `CURRENT.md` has grown
   past 450 lines (most of them completed-entry prose) with no ceiling. Audit
   findings in `agent-audits/runs/` have no tracked lifecycle and the graduation
   rule is prose-only.
5. **Navigation/comprehension cost at current scale.** `src/` is 273 files /
   ~36.6k lines (plus 11.5k `bridge_src`, 26.4k tests); a dev agent must find the
   relevant code itself. Measured discovery cost is 4–12 files *read* per routine
   change, with gate-caught-late landmines (the `check-summaries.mjs` sha256
   golden lock, `check-errors.mjs` verbatim recovery-string pins,
   `serviceWorkerBridgeFiles` ordered array, the abml shim co-change). The one doc
   built for routing — `docs/maintainer-map.md` — omits all four pure-logic
   kernels and their runtime layers, and has no drift gate; `abml-kernel-manifest.md`
   has stale counts and a deleted-`mcp/` reference; `capture-src/entries/*` source
   headers literally begin "Generated seed …", misleading agents about which file
   is editable; high-value indexes (`kernel-export-inventory.json`,
   `spec-claims.js`, `check-graph.mjs` as the check inventory) are discoverable
   only by reading `tests/contracts/drift/` by accident.

## Design principles

- The harness must be **trustworthy before it is fast**: an acceleration layer that
  can report false green is worse than a slow one.
- **Derived, not hand-maintained, impact edges**: file→check mappings rot when
  maintained as prose-adjacent tables; derive them from what contracts actually read.
- **Every gate failure names its fixer**: the file to edit, the ledger field, or the
  command to run (existing tool-design rule, extended to the dev harness itself).
- Reuse the five proven gate patterns: single source + drift check, source-text
  contract assertions (bounded), shrink-only ratchets, committed baselines, shadow
  guards. Ratchet edits remain deliberate in-diff acts — no gate auto-writes its
  own baseline.
- **Plans execute as independently closeable phases**: each phase is its own
  workstream with its own `CURRENT.md` activation entry, full-gate closure, and
  §Results record; every phase boundary is a safe stopping point, and later
  phases may be re-planned from earlier results without invalidating closed ones.
  A 22-item single execution chain in one workstream is itself an off-track risk.
- Boundary: dev-harness only (`scripts/`, `tests/contracts/`, `tests/unit/` layout,
  `.github/`, `docs/`, `agent-audits/`, `package.json` scripts, `CURRENT.md`/
  `ARCHIVE.md`). No public `browser_*` tool, schema, envelope, or runtime behavior
  changes. `npm run check` stays the final full gate; its coverage may only grow.

---

## Track A — Gate engine trust & speed

### A1. Derived impact map for smart selection (false-green fix)

**Problem.** `selectSmartScripts` (`scripts/check-dag.mjs:84-177`) is a hand-
maintained prefix table. Verified gaps: `src/abml-core/` → only
`check:abml-core-boundary` + `check:abml-internal-integration` + `test:unit`,
missing the 16 `check:abml-*` tool contracts that import or read abml-core sources;
`src/distill-core/` similarly misses `check:distiller-coverage`,
`check:compaction-ledger`, `check:session-delta-long-conversation`,
`check:task-conditioned-salience`. A kernel edit + green `check:smart` is currently
false evidence — the exact failure class that the miss recorder caught once already.

**Mechanism.** New generator `scripts/sync-impact-map.mjs` statically derives each
check node's input set: (a) transitive ESM import graph of the contract entry file
(relative imports into `src/`, `cli/`, `scripts/`, `evals/`); (b) string-literal
paths passed to `readFileSync`/local `read()`/`readJson()` helpers; (c) directory
walks at directory granularity. The extraction primitives live in a shared
`scripts/lib/repo-introspection.mjs` (import graph, literal-path, script-step, and
marker parsing — also consumed by B2/D3/D6, so the repo gets one parser, not four
half-overlapping ones). **Fail-closed posture (audit F1):** the check graph also
expands package scripts, `COMMAND_OVERRIDES`, and chained npm-run steps
(`check-graph.mjs:83,181`), and contracts may spawn subprocesses or compute read
paths — any input the extractor cannot classify as a literal (non-literal
`readFileSync` argument, `spawnSync`/`execSync`, glob, env-dependent path) forces
that node to `scope:"global"`, and the generated map records the reason under
`unresolvedInputs[]`. A node may carry a narrow scope only when its input set is
fully resolved; the gate rejects precise-looking partial scopes (any node with
recorded unresolved inputs and a non-global scope fails). Output committed at
`tests/contracts/drift/check-impact-map.json`. `selectSmartScripts` keeps its
global-expansion triggers (`package.json`/lockfile/tsconfig*/eslint config/
`.github/`/`scripts/` → full graph; unknown prefix → full graph) and replaces the
per-`src/*` prefix table with map lookup (file match or dir-prefix match).
`sync:impact-map` regenerates the committed map; `check:impact-map` runs the same
generator in `--check` mode and byte-compares (the `sync:capture --check` pattern),
registered in the contracts group, `package.json`, and `scripts/check-graph.mjs`.

**Verification.** Extend the synthetic test in
`tests/contracts/drift/check-check-graph.mjs`: simulated changed file
`src/abml-core/treeDiff.ts` must select at least `check:abml-tree-diff` and
`check:abml-templating`; a simulated `src/distill-core/` file must select
`check:task-conditioned-salience`. Red-first: assert these fail against the old
prefix table before the swap. Existing miss recorder stays as the runtime backstop.

### A2. Closing-gate engine swap: `npm run check` → DAG runner

**Problem.** `npm run check` routes through serial `run-check-groups.mjs`
(`spawnSync` + npm-wrapper overhead, measured 173.4s full run, `test:unit` 92.7s of
it), excludes ESLint (the single most-repeated burn: gate-green ≠ lint-clean), and
with default `stdio:"inherit"` writes empty `stdoutTail` fields into the summary
artifact — an acceptance reviewer gets no output evidence. Meanwhile
`scripts/check-dag.mjs` already executes the same full graph in parallel
(concurrency ~cpu/2, direct binaries, `lint:eslint` injected,
`NON_PARALLEL_NODE_IDS` exclusivity) and closed green in the check-acceleration
workstream.

**Mechanism.** Repoint `check:all` to `node scripts/check-dag.mjs` (full graph; no
cache, no smart — `--cache` stays opt-in and is never implied by `npm run check`).
**Group aliases move with it (audit F2):** `check:all:bridge|package|contracts`
repoint to DAG group mode, which already exists (`check-dag.mjs:334` accepts
requested group names) — CI keeps calling the same aliases
(`.github/workflows/check.yml`), so the closing-evidence artifact exists in CI
runs too and local/CI engines cannot fork. Retain the serial engine as
`check:serial` plus `check:serial:bridge|package|contracts` (escape hatch +
diagnosis); `check:trace` unchanged. The DAG summary artifact
(`.pi/browser-artifacts/check-dag-summary.json`) already pipes per-node
stdout/stderr tails, exit codes, and durations — it becomes the canonical
closing-gate evidence artifact that acceptance reviewers read instead of trusting
transcript text (mechanizes the exit-code-discipline lesson). Because CI and
local diagnosis may run multiple DAG invocations in one job (`bridge`, `contracts`,
`package`, then full), the writer also records `requestedGroups`, `mode`, and
`runId`, keeps the stable "latest" path for local ergonomics, and writes a
per-run copy under `.pi/browser-artifacts/check-dag/` (or an equivalently
group-scoped path) so the last group run cannot overwrite the only evidence.
Per-run copies are retention-bounded (keep the most recent ~20, prune older on
write — the resource-store amortized-prune precedent) so a local agent running
dozens of checks per day does not grow the directory unboundedly; the stable
"latest" path and the current closing run are never pruned.
CI jobs that call DAG aliases upload `.pi/browser-artifacts/check-dag-summary.json`
and `.pi/browser-artifacts/check-dag/**` with `if: always()` (the existing
browser-smoke artifact-upload pattern), otherwise the "CI evidence artifact"
exists only on an ephemeral runner and cannot support acceptance review.
Update the
exact-pin contracts in the same diff: `check-package-files.mjs:23,27-30`,
`check-registry-drift.mjs`, `check-check-graph.mjs` canonical command strings, and
flip the "`npm run check` does NOT run ESLint" passages in `CLAUDE.md`/`AGENTS.md`
(mirrored) and README to "includes `lint:eslint` as a graph node".

**Verification.** Parity run: `npm run check:serial` and `npm run check` both green
on the same tree, with shared graph nodes matching and `lint:eslint` recorded as
the intentional DAG-only coverage addition; summary artifact carries every node
with exit code 0 and non-empty duration; group-alias runs produce distinct per-run
artifacts plus the same summary schema; CI artifact upload finds those paths on
success and failure; a deliberately broken node in a temp fixture or synthetic
graph entry propagates a non-zero overall exit without leaving broken source edits
(executed negative control). Wall-clock before/after recorded in §Results.

**Risk/rollback.** An undiscovered parallel-unsafe node (port/artifact collision):
mitigation is the existing `NON_PARALLEL_NODE_IDS` list (`check-graph.mjs:89-94`) —
any node found flaky under parallelism is added there with a reason comment.
Rollback is repointing `check:all` back plus the same contract pins.

### A3. Unit-test sharding + duplicate node dedupe

**Problem.** `test:unit` is a single node (`tsx --test tests/unit/**/*.test.ts`,
`package.json:56`) at 92.7s — 53% of the full gate — and cannot overlap with other
nodes' wall-clock under the DAG. `check:cli-json-envelopes` (`package.json:99`)
re-runs `tests/unit/cli/json-envelope-contract.test.ts`, which the `test:unit` glob
already covers: ~11.4s duplicated every full run.

**Mechanism.** Split the unit group into shard nodes (e.g. `test:unit:tools`,
`test:unit:abml`, `test:unit:distill`, `test:unit:cli`, `test:unit:driver`,
`test:unit:rest`) sized from a measured per-directory timing pass; the DAG runs
shards concurrently. **Graph semantics (audit F4):** the shard scripts replace
`test:unit` inside `CHECK_GROUPS.unit` (`check-graph.mjs:19`) as first-class
graph nodes; `test:unit` stays as the umbrella npm script and moves to
`GRAPH_SCRIPT_EXCLUSIONS` with the named reason "umbrella; covered by
test:unit:* shards". Shards default `parallelSafe:true`, gated by an
execution-time isolation audit: any shard whose tests mutate shared state
(shared `.pi/browser-artifacts` paths, `process.env`, fixed ports) is either
fixed to use per-test temp dirs or declared `parallelSafe:false` with a reason
comment in `NON_PARALLEL_NODE_IDS`. Add a shard-coverage drift assertion to
`check-check-graph.mjs`: the union of shard globs must cover every
`tests/unit/**/*.test.ts` file with no overlap (expanded at gate time — survives
file adds/moves). Dedupe: relocate `json-envelope-contract.test.ts` to
`tests/contracts/cli/` (out of the unit glob), keeping `check:cli-json-envelopes`
pointed at it. Node's per-file process isolation is unchanged by sharding.

**Verification.** Shard-coverage assertion red-first (drop one shard → gate fails);
full-gate wall-clock re-measured; duplicated file runs exactly once per full gate.

### A4. Per-node cache scopes (depends on A1)

**Problem.** The cache key is a whole-repo fingerprint
(`scripts/check-graph.mjs:257-294`): one byte changed anywhere in the 16 roots
invalidates all ~92 node entries. By design it only serves exact-repeat trees;
during real iteration it yields zero hits.

**Mechanism.** Cache key v2 per node = hash(per-node input scope from the A1 map +
a global config set: `package.json`, lockfile, tsconfig*, eslint config,
`check-graph.mjs`, `check-dag.mjs`) + nodeId + command. The scope hash covers both
tracked and untracked files matching the node scope, preserving the current coarse
fingerprint's no-hidden-untracked posture; a new untracked file under a scoped
directory invalidates that node. `scope:"global"` nodes keep the whole-repo key.
Bump the cache index schema version. The miss recorder and its artifact stay
unchanged as the runtime backstop. `--cache` remains opt-in and is never part of
the closing gate.

**Verification.** Key-derivation unit test (guard `check-graph.mjs` main flow
behind an `import.meta` check first — the `build-bridge.mjs` F3 precedent); two
synthetic demonstrations recorded in §Results: docs-only edit → non-docs nodes hit;
`src/abml-core/` edit → abml nodes miss while package/docs nodes hit.

### A5. CI parity

**Problem.** No CI job runs the default graph's `src` group — at minimum
`check:src:types` (the main `src/` typecheck) and `check:registry-drift` are absent
from CI's always-on path (`.github/workflows/check.yml`); local full-gate coverage
therefore exceeds CI coverage.

**Mechanism.** Add the full `src` group to the `lint-static` job, either by adding
a `check:all:src` DAG group alias or by explicitly running both
`npm run check:src:types` and `npm run check:registry-drift` (the job already
builds via the composite action). Extend the workflow source-text pins in
`check-package-files.mjs:62-64` in the same diff so the step cannot silently drop.
**Alias hygiene (v2):** retire the `check:lint` legacy aggregate — it overlaps
`check:boundaries`+`check:bridge:files`+`check:page-scripts` (already first-class
graph nodes) and wastes agent time on a name that sounds authoritative; repoint
the CI `lint-static` step to those components + `npm run lint`, remove the script,
and update its pins (`check-package-files.mjs` tsxScripts list,
`GRAPH_SCRIPT_EXCLUSIONS` entry), README/CLAUDE/AGENTS guidance, and any AI install
or quality docs that still mention `check:lint` in the same diff. Red-first
controls are explicit: the old `lint-static` workflow shape is rejected, a
package script named `check:lint` is rejected, and the graph exclusion list cannot
retain a stale `check:lint` reason after the script is gone.

**Verification.** Extended workflow pin red-first; next CI run green; the CI
always-on set covers every default check group (`src`, `bridge`, `unit`,
`package`, `docs`, `contracts`) through DAG aliases or explicit equivalent
commands; no script named `check:lint` remains and `check:check-graph` stays green.

---

## Track B — Contract corpus de-brittling

### B1. Single-source shared manifests

**Problem.** (i) Four ABML tool contracts read `check-abml-core-boundary.mjs` *as
source text* and assert filename strings inside its `PURE_CORE` array
(`check-abml-tree-diff.mjs:91`, `check-abml-diff.mjs:133`,
`check-abml-semantic-ref-anchor.mjs:122`, `check-abml-snapshot-projection.mjs:87`) —
reformatting one array breaks four contracts. (ii) Package facts are pinned 2–3×
each: version `0.3.0` in three contracts; `manifest.background.service_worker` in
three; the `sync:protocol` script string in two; offscreen entries in three.
(iii) `spec-claims.js` pins long verbatim code expressions (the `refId.ts` locator
expression, the `pi-ref://` template literal) that break on whitespace refactors.

**Mechanism.** (i) Extract the pure-core module list to
`tests/contracts/drift/abml-core-manifest.js` (the `purity-vocabulary.js`
precedent); the boundary check and the four tool contracts import it and assert
membership structurally. (ii) **Ground truth over shared literals (audit F5):**
a shared constants module must not become a hand-written oracle that contracts
compare against each other while nothing checks reality. Facts with a runtime
ground truth become **cross-artifact consistency assertions** — the version is
read from `package.json` and asserted equal in `manifest.json` and the build
manifest (no contract pins the literal `0.3.0` anywhere); the service-worker
path is read from `manifest.json` where consumers need it. Only true *semantic
expectations* (decisions, e.g. "the manifest service worker MUST be
`dist/service-worker.js`", the canonical `sync:protocol` script string) go into
`tests/contracts/drift/expected-package-facts.js`, each with a one-line
rationale comment — consumed by `check-pi-browser-bridge.mjs`,
`check-bridge-files.mjs`, `check-bridge-build.mjs`, `check-package-files.mjs`.
A version bump becomes a zero-contract-edit change. (iii) Review the six
spec-claims: replace exact-expression literals with the narrowest stable anchor
(exported symbol) that still proves the claim; where the claim's value *is* the
exact expression, keep it with an explicit fragility-accepted comment.

**Verification.** All consuming gates stay green; red-first: removing an entry from
the manifest module fails the boundary gate and the tool contracts coherently;
§Results records that the version string appears in exactly one contract-layer file.

### B2. Marker query tool (pre-rename step)

**Problem.** ~1,100+ `.includes()` assertions across 79 contract files; both
historical rename breakages were discovered only by full-gate failure. An agent
cannot ask "which contracts pin this string / read this file" before refactoring.

**Mechanism.** `scripts/query-markers.mjs` (on `scripts/lib/repo-introspection.mjs`)
with two modes: `--needle <string>` scans `tests/contracts/**/*.mjs`
(+`scripts/*.mjs`) for string-literal arguments of `.includes(...)`/regex literals
containing the needle and prints contract `file:line` plus the read-target file
when derivable; `--file <repo path>` prints every node whose A1-derived input
scope contains the file. Registered as `query:markers` with a named
`GRAPH_SCRIPT_EXCLUSIONS` reason (query tool, not a gate). Documented in C1 as
the mandatory pre-rename step. **Ordering (audit F3):** B2 lands immediately
after the quick-win batch and *before* C1/D2/B3, which all reference it
(`--needle` has no dependencies; `--file` consumes the A1 map, which lands
first in the plan).

**Verification.** Executed control: `--needle templateGroupDescriptorForEntity`
must list both `check-abml-tree-diff.mjs` and `check-abml-templating.mjs`.

### B3. Worst-marker conversion batch

**Targets** (from the census, judged rename-fragile):

- `check-package-files.mjs:53-59` — six code-literal pins against `scripts/*`
  internals (including the once-broken `defaultDistDir` marker). Convert each to an
  identifier-free semantic pin (stable strings like env-var names are de-facto API)
  or an executed assertion (the `computeBuildId` import path from the F3 fix).
- `check-scan-script.mjs:56` — verbatim fragment `children2.push([child, key2])`.
  Replace with a behavioral assertion in the vm-executed scan harness
  (`check-page-scripts.mjs` already executes scan in vm); drop the text pin.
- `check-compute-once.mjs` failure message — add the rename branch: "if the callee
  was intentionally renamed, update the COMPUTE_ONCE entry in this file."

**Convention codified (into C1):** a source-text marker may pin runtime-stable
strings (tool names, error codes, env vars, file paths, doc headings, message
text) — never local identifier names or exact code fragments. Intentionally-kept
fragile pins get a `// contract: tests/contracts/...` breadcrumb comment at the
pinned source site so the renaming agent sees the coupling in place.

**Verification.** Each conversion red-first (mutate the target, assert the gate
still fails); full corpus green after.

### B4. Ledger re-pin tooling (`--propose` convention)

**Problem.** Five ledgers re-pin only by hand with no generator:
`kernel-export-inventory.json` ("regenerate/classify the ledger" with nothing to
run), `input-surface-budget.json` (character counts computed by hand),
`kernel-test-map.json`, `file-ceilings.json`, `docs/compaction-ledger.json`.
Additionally `classBBaseline` is sitting at 101 while the recorded actual is 97 —
an accepted-deviation re-pin still pending.

**Mechanism.** Each of the five gate scripts gains `--propose`: prints the exact
minimal JSON patch (for surface-liveness: regenerated module/export sets preserving
existing statuses; new exports emitted as `"unclassified"`, which the normal gate
rejects — classification stays a deliberate act). No gate auto-writes its baseline;
growth still must be committed in-diff with a one-line justification, and the
`--propose` output includes the justification placeholder. Failure messages name
the flag. Fold in the pending honesty fix: re-pin `classBBaseline` 101→97.

**Verification.** Executed control: on a clean tree all five `--propose` runs
report "no changes needed"; perturbation cases exercised at execution and recorded
in §Results. `check:compaction-ledger` green at baseline 97.

### B5. Remediation-message fixes (quick wins)

- `scripts/sync-native-protocol.mjs:427` — append "Run `npm run sync:protocol`."
  (parity with `sync-capture.mjs`, which already names its fixer).
- `check-surface-liveness.mjs:122` — name the ledger path and the `--propose` flag.
- `check-compaction-ledger.mjs:70` — name the `classBBaseline` field, the ledger
  file, and the in-diff justification procedure.
- `check-registry-drift.mjs:21` — include the expected script string in the message.
- Miss artifact `likelyRepairTarget` (`check-graph.mjs:299`) — replace the
  hardcoded four-way disjunction with the computed reason: which changed file
  matched no impact-map scope for the failing node, and the command to regenerate.

**Verification.** Messages exercised by running each failure path once during
development; no new message-text pins added (that would create new markers).

---

## Track C — Process & knowledge layer

### C1. Dev handbook: `docs/agent-development.md`

**Problem.** No test-authoring or dev-workflow guide exists; the registration
checklist for a new check (package.json + `CHECK_GROUPS` + group + exclusions) is
derivable only by example; the operationally critical lessons (red-first
verification, byte-identity normalization in delta-established state, narrow gates
≠ closing gate, exit-code capture before piping, activation-entry-before-work,
branch hygiene under parallel agents) live only in one operator's session memory —
invisible to fresh agents and to non-Claude agents entirely.

**Mechanism.** One handbook with six sections: (1) the dev loop — narrow-gate
ladder, closing gate engine + artifact paths, `check:smart --dry-run
--changed-file` usage, `query:markers` pre-rename step; (2) writing a check —
registration checklist, remediation-message standard, parallel-safety and
`NON_PARALLEL_NODE_IDS`; (3) contract-test conventions — red-first mandatory,
byte-identity idiom (normalize run-incidental fields; prime to delta-established
state), marker rules + breadcrumb convention, prefer importable single-source
modules; (4) ledgers & ratchets — the five ledgers + token-economy `--update`,
the `--propose` convention, growth-with-justification; (5) closing a workstream —
activation entry before work, full `npm run check` + reading the summary artifact
instead of transcript text, skill `quick_validate`, the current doc sync command
(`docs:sync-indexes` before D7, `docs:sync` after D7) when touching generated
index/block content; (6) multi-agent parallel work — worktree isolation, branch
verification before commit, query-before-rename. Pinned by extending
`check-doc-structure.mjs` with required-headings assertions; `CLAUDE.md`/`AGENTS.md`
gain a mirrored pointer line.

**Verification.** `check:doc-structure` red-first (remove a required heading →
fail); skills untouched.

### C2. `CURRENT.md` ceiling + migration

**Problem.** 450+ lines, mostly completed-workstream prose, plus a duplicated
`## 最近完成且仍影响当前规则` header. Every other planning doc has a ceiling
(ARCHIVE 120 / TODO 30 / ROADMAP 80); `CURRENT.md` has none, so it rots toward
being the highest-cost mandatory read in the repo.

**Mechanism.** Migrate completed entries to `ARCHIVE.md` one-liners, but only
after confirming each moved entry has durable detail elsewhere: if a matching
`docs/archive/*.full.md` already exists, link it; otherwise create the full archive
detail first in the same diff and then shrink `CURRENT.md`. Fix the duplicate
header; add a `CURRENT.md` ceiling (≤180 lines) to `check-doc-structure.mjs`; in
the current phase order D7 has already landed, so run `docs:sync` after the move
(if this phase is ever re-planned ahead of D7, the fallback is the older
`docs:sync-indexes` command).

**Verification.** `check:doc-structure` red-first with the new ceiling; the
ARCHIVE 120-line ceiling still holds after migration; every moved completed entry
has either an existing or newly created `*.full.md` detail link before its prose is
removed from `CURRENT.md`.

### C3. Audit-findings index + lifecycle gate

**Problem.** All findings across the three reports in `agent-audits/runs/` carry
status `unverified` even though one batch (the harness-plan audits) was fully
consumed and fixed; nothing tracks consumption; the pi-kernel-audit graduation rule
("a finding recurring a second time must graduate to a static gate") is prose-only.

**Mechanism.** `agent-audits/runs/index.json`: per report → findings
`[{id, title, status: unverified|accepted|rejected|duplicate|fixed|graduated,
duplicateOf?, recurrenceOf?, evidenceCommit?, verifiedByGate?, graduatedGate?}]`.
`duplicateOf` is for same-root duplicate bookkeeping; `recurrenceOf` is reserved
for the graduation rule ("this defect recurred after being seen before").
**Auditable,
not just labeled (audit Opt-2):** a bare status enum degenerates into an
unauditable hand ledger, so the gate enforces evidence per terminal status —
`fixed` requires `evidenceCommit` (validated as a real commit via
`git cat-file -e`); `graduated` requires `graduatedGate` naming an existing
`package.json` check script; `verifiedByGate` is optional corroboration for
`accepted`/`fixed`; `rejected` requires a non-empty reason field; `duplicate`
requires `duplicateOf`. New gate
`check:audit-inbox` (docs group): every `runs/*.md` file is registered; statuses
come from the enum; any entry with `recurrenceOf` set must be `graduated` or
`rejected`; the evidence rules above. Because `git cat-file -e <old-commit>` is
history-depth-sensitive, the same diff updates CI checkout depth for any job that
runs the docs group (or the gate fails with a factual "shallow history" diagnostic
that names the workflow fix); otherwise old accepted fixes can false-red in
GitHub's default shallow checkout. Report templates gain a finding-ID line.
Backfill the three existing reports honestly (harness-plan findings → `fixed`
with their landing commits as `evidenceCommit`).

**Verification.** Gate red-first (unregistered report file → fail); shallow-history
diagnostic exercised with a missing commit object or temp git fixture; backfilled
index green; `check:doc-structure` audit-inbox assertions still green.

### C4. New-check scaffolder (`npm run new:check`)

**Problem.** Registering a check is the highest-frequency authoring chore — every
workstream adds gates — and it takes four manual steps across three files (test
file with the right conventions, `package.json` script, `CHECK_GROUPS` entry,
sometimes `GRAPH_SCRIPT_EXCLUSIONS`), derivable today only by copying an existing
check. `check:check-graph` catches omissions only after the fact; the conventions
(remediation messages, red-first) are caught only at acceptance review.

**Mechanism.** `scripts/new-check.mjs` (`npm run new:check -- --name <x> --group
<contracts|docs|…>`): writes `tests/contracts/<dir>/check-<x>.mjs` from a template
that already embodies the conventions (remediation-message standard, a
`// red-first: verify this fails against unmodified code before landing` block,
`repo-introspection` import where relevant), inserts the `package.json` script and
the `CHECK_GROUPS` entry, then runs `check:check-graph` to confirm wiring.
`--dry-run` prints the planned edits. Non-dry-run mode requires a clean git status
for the files it edits (`package.json`, `scripts/check-graph.mjs`, target test
path) unless `--force` is passed; the refusal message prints conflicting paths so
it cannot silently merge with another agent's work. The scaffolder is convenience,
not authority: the graph gate remains the verifier and hand-written checks remain
legal — this automates the bookkeeping, the handbook (C1) still teaches the
semantics.

**Verification.** `--dry-run` executed control on a clean tree; dogfood — the
next new gate after C4 in execution order (`check:docs-sync` in Phase 3, or the
first re-planned earlier equivalent) is created via the scaffolder with zero
manual registration edits in its diff. `check:audit-inbox` may also use the
scaffolder in Phase 5, but it is not the proof for C4 because it lands too late.

### C5. Workstream scope sentinel (visibility, not enforcement)

**Problem.** The recorded F6-class deviation (work landing outside any declared
boundary) is invisible until an acceptance reviewer reads the entire diff; the
activation entry's boundary is prose with no machine-readable trace in the
closing evidence.

**Mechanism.** Activation entries MAY include one machine-parseable line —
`Scope: src/tools/**, tests/contracts/tools/**` (globs, comma-separated).
`scripts/workstream-scope.mjs` parses the topmost 当前激活项 entry; when a scope
is declared, the DAG runner embeds `scope: {declared, outOfScope[]}` into the
closing summary artifact. It compares against an activation baseline when
available: either an optional `Baseline: <commit>` line plus recorded
`baselineDirtyFiles`, or a `.pi/browser-artifacts/workstream-scope-baseline.json`
written by a lightweight `npm run scope:begin` helper at activation time. If no
baseline exists, it falls back to `git diff --name-only HEAD` + untracked and
marks `baselineStatus:"implicit-head"` so reviewers know pre-existing dirty files
may be mixed in. Ignored runtime artifacts such as `.pi/**` are excluded. The
summary records `changedFilesSource:"git"`, `baselineCommit`,
`baselineDirtyFiles`, and the declared root used for matching so reviewers can
separate real scope drift from unrelated dirty files. **No gate fails on
out-of-scope** — scope legitimately grows mid-work — but the closing artifact
makes it visible, and the C1 closing checklist requires the completion entry to
explain any non-empty `outOfScope`. Inert when no `Scope:` line exists, so it
honors the closed decision against machine-enforcing the activation rule: this is
visibility, not enforcement.

**Verification.** Parser unit test (entry with/without scope line); one demo
closing artifact with a deliberate out-of-scope touch recorded in §Results; one
dirty-at-baseline file is recorded as `baselineDirtyFiles` rather than being
misreported as new scope drift.

---

## Track D — Code navigation & comprehension

Evidence principle for this track: prose orientation docs rot unless machine-pinned
(the routing map silently lost four entire kernels; the kernel manifest's counts
drifted; a fixed gap still reads as a pending task). So Track D prefers, in order:
(1) maps **generated from code**, (2) hand-written routing docs **pinned by drift
gates** (the `check:tool-doc-drift` / G1 patterns, which demonstrably kept
`tool-boundaries.md` and the generated docs accurate), (3) **in-place breadcrumbs**
at the exact files where agents get lost.

**Generation-first restructure (owner feedback, 2026-06-12).** Drift gates alone
solve "rot is detected", not "maintenance needs hands": a gate that fails on a
stale table still makes the agent hand-edit the table on every code change. So
every Track D doc surface is split into **generated fact blocks** (inventories,
counts, file chains, tables — rewritten by generators from single sources) and
**hand-written judgment prose** (routing advice, rationale, landmine commentary —
small, stable, changes only on architecture decisions). The split rule: an agent
making a routine code change must touch **zero** doc bookkeeping (generators
absorb it); hand edits are required only where new *judgment* is genuinely needed,
and the gate names exactly the empty judgment cell. Managed blocks use explicit
markers (`<!-- BEGIN GENERATED: <id> (npm run docs:sync) -->` …
`<!-- END GENERATED: <id> -->`) — self-documenting which command regenerates them;
the heading-based block rewriting in `scripts/sync-doc-indexes.mjs` is the proven
in-repo precedent. What deliberately STAYS hand-written: both skills (existing
ACI decision, drift-checked), `tool-boundaries.md` judgment rows (gated),
handbook/playbook prose, `CHANGELOG.md`/`CURRENT.md`, and the D6 ownership matrix
rows (architecture-frequency changes only).

### D1. Routing-map repair + structural pin (`docs/maintainer-map.md`)

**Problem.** The doc whose entire purpose is "where do I land a change" omits all
four pure-logic kernels (`capture-src`/`src/capture`, `src/abml-core`,
`src/distill-core`, `src/memory-core`) and their runtime layers, six newer driver
modules (`BrowserBridgeDiagnostics`, `leaseDiagnostics`, `extensionBuild`,
`bridgeUtils`, `browserBridgeConfig`, `BrowserRuntimeRecoveryArtifacts`), and the
load-bearing `toolAdapter.ts ↔ resultMiddleware.ts` envelope-pipeline coupling.
No gate watches it, so whole layers vanished silently.

**Mechanism (generation-first).** The doc's **layer inventory becomes a generated
block** (D7 engine): one row per first-level code directory (`src/*`, `cli`,
`bridge_src`, `capture-src`), auto-filled with file/line counts and detected
seams, plus a **hand judgment cell** ("change-landing advice") keyed by directory
name. The generator preserves existing judgment cells across regeneration; a new
directory appears automatically with an **empty judgment cell**, and the gate
fails naming exactly that cell (the surface-liveness "unclassified" pattern) —
bookkeeping is automated, only the judgment is demanded from a human/agent. Hand
prose around the block carries the repaired routing content: kernel
change-landing sections (including the capture edit path), the observe split, the
missing driver rows, the toolAdapter/resultMiddleware coupling, and a "data flow
of one observe call" chain (`registerObserveTool → toolAdapter →
observe/scanRunner → abml runtime → abml-core → resultMiddleware →
summaries/scan → distill-core → envelope`). Second gate assertion: **path
liveness** — every backticked repo-path token in the hand prose (matching
`^(src|cli|bridge_src|capture-src|tests|scripts|docs|evals|skills|bridge)/`,
no globs) must exist on disk (new `check:doc-paths`, docs group).

**Verification.** Red-first: a synthetic new `src/` directory must appear in the
regenerated block with an empty judgment cell and fail the gate naming it.
Path-liveness catches the stale-reference class going forward. Routine file adds
inside existing directories require zero hand edits (counts regenerate).

### D2. Change-path playbooks with landmine manifests

**Problem.** Five representative changes were walked end-to-end; measured read
cost is 4–12 files each, and every scenario except the env-flag one has at least
one landmine no doc points to: the `check-summaries.mjs:321-322` sha256+length
golden lock on the scan envelope; `check-errors.mjs` pinning ~30 recovery strings
verbatim; `check-pi-browser-bridge.mjs:130` `serviceWorkerBridgeFiles` ordered
array + `check-bridge-build.mjs:52` module loop (any new bridge service-worker
module); the `src/abml/` shim + barrel + `kernel-export-inventory.json` co-change
set on kernel renames; `token-economy-baseline.json` regeneration via `--update`.
The env-flag scenario is the proof of concept: registry + gate + CLAUDE.md mention
= ~4 files read, no landmines. That guidance level is the target for the rest.

**Mechanism (generation-first).** The verified chains land as a "Change-path
playbooks" section of `docs/agent-development.md` (C1's handbook — same audience,
same lifecycle; the existing `docs/playbooks/` layer is reserved for
browser/Web-security *task* playbooks and is not reused): one playbook each for
envelope/summary field, native bridge command, env flag, recovery/error text,
kernel export rename, and new tool (expanding CLAUDE.md Workflow step 4 with the
full sync rule). Static duplication is minimized two ways: (a) each playbook's
"which gates watch these files" table is a **generated block** derived from the
A1 impact map for the playbook's listed files — it refreshes whenever the map
regenerates, never by hand; (b) playbooks point at the **live queries**
(`check:smart --dry-run --changed-file=…`, `query:markers`) as the authoritative
answer, so the hand-written part is only the judgment that queries cannot give:
hop ordering, landmine explanations, baseline regeneration commands.
`maintainer-map.md` links the section.

**Verification.** The `check:doc-paths` path-liveness gate covers
`docs/agent-development.md`; every gate name cited in a playbook must exist as a
`package.json` script (same gate, second assertion); the generated gate tables
are covered by D7's idempotence check.

### D3. Generated code map

**Problem.** The best orientation indexes are machine-readable but undiscoverable
(`kernel-export-inventory.json` — the only complete kernel surface map;
`check-graph.mjs` — the only complete check inventory; `toolRegistry.ts` — the
tool roster), and no generated doc shows directory inventory, fan-in hot spots
(`driver/errors.ts` 57 importers, `BrowserBridgeServer.ts` 52, `toolShared.ts`
47), or the generated-file → source → sync-command table.

**Mechanism.** `scripts/sync-code-map.mjs` / `npm run sync:code-map` →
`docs/generated/code-map.generated.md`
(v1 scope, deliberately modest): per-directory file/line inventory; top-20 fan-in
modules; tool → file-chain table; the registries-as-indexes list; the
generated-file table (file → source of truth → sync command → guarding gate).
**Tool roster derived by executing registration, not filename convention (audit
F6):** the real surface has a shared native registrar (4 tools in
`registerNativeActionTools.ts`), nested webSecurity registrars, and a separate
slash-command namespace (`commands.ts`) — naming inference would misattribute
all three. The generator executes both `registerBrowserCommands()` and
`registerBrowserTools()` against a new recording adapter that records
`registerTool` and `registerCommand` calls (the placeholder-mode precedent already
used by `cli/registry.ts` collects tools and deliberately no-ops commands, so it is
insufficient here) to capture every Pi-native tool/command name with its true
source module, then walks imports from those modules (shared
`repo-introspection.mjs` walker, same engine as `check-surface-liveness.mjs`)
for the chain columns. Drift gate `check:code-map` = regenerate + byte-compare
(the `sync:capture --check` pattern); wired into the docs group, `package.json`,
`check-graph.mjs`, and CLAUDE.md Key Files.

**Verification.** `check:code-map` red-first (stale committed map fails); the map
cannot rot by construction.

### D4. In-place breadcrumbs at confusion hotspots

**Problem.** Verified hotspots where the file itself misleads: `capture-src/entries/*`
headers begin "Generated seed from src/scan/buildScanScript.ts …" although these
files ARE the editable source (the page-world logic lives there as single-line
template strings); `registerNativeActionTools.ts` registers 4 tools
(`browser_wait/network/hook/frame`) under a name no agent would guess;
`src/tools/commands.ts` registers a parallel slash-command namespace invisible
from `toolRegistry.ts`; `toolAdapter.ts`/`resultMiddleware.ts` are an undocumented
mandatory-read pair; `src/abml/verbs/runtime.ts` (1,024 lines) is the entire ABML
execution engine reachable only via `integration.ts`; `src/abml/` shims do not
say that renames must also touch the `abml-core/index.ts` barrel and the export
inventory.

**Mechanism.** One-to-three-line header comments stating the constraint the code
cannot show: capture entries get "EDITABLE SOURCE — compiled to
src/capture/generated/* by npm run sync:capture (gate: check:capture)"; the
generated bundles keep their existing correct headers; the other five sites get
the pointers above. Comment-only change; the capture header sits outside the
template string so page-world template payloads stay unchanged. Regenerated
bundles may still restamp generated headers / hash comments when `sync:capture`
runs; that is acceptable only when the template payload is unchanged and the
capture gates stay green.

**Verification.** `npm run check:capture` plus `check:scan` / `check:page-scripts`;
record whether generated bundles are byte-identical or header/hash-only restamped
in §Results.

### D5. Orientation-doc honesty triage

**Problem.** `abml-kernel-manifest.md`: module table missing `identityGraph.ts`,
"25 modules"/"25 shims" counts wrong, references deleted `mcp/handleResolver.ts`.
`agent-native-architecture.md`: describes the CLI `prepareArguments` gap as
pending although it is fixed (`cli/daemon.ts:245`, `cli/localCommands.ts:187`).
`abml-optimization-reference.md` has zero inbound links. CLAUDE.md's governance
section omits `check:param-surface` and `check:input-surface`; Key Files omits
`resultMiddleware.ts`, `src/tools/observe/`, and the three discovery indexes.

**Mechanism.** Fix the stale prose; eliminate the manifest-table staleness class
rather than patch it — after B1 extracts `abml-core-manifest.js`, the doc's
module table becomes a **generated block** rendered from that single source (D7
engine; counts can never drift again). Mark the fixed architecture-doc gap as
Done. Add the missing links (README 维护入口 += `agent-native-architecture.md`,
`abml-tool-coverage-map.md`; kernel manifest += optimization reference). For
governance text, edit `AGENTS.md` and let D7's `docs:sync` regenerate the CLAUDE
inlined block; only non-generated CLAUDE.md surfaces such as Key Files are edited
directly.

**Verification.** `check:doc-structure`, `check:spec-truth`, `check:tool-doc-drift`
green; the new spec-claim is red-first against the unrepaired doc.

### D6. Concept-ownership matrix + envelope-field map

**Problem.** No doc answers "which layer owns concept X" (ref, artifact, lease,
snapshot, operation, perception ledger, token budget/renderer, session delta,
memory plane, effect, wordlists) or "which file produces envelope field Y" — the
two questions every cross-layer change starts with.

**Mechanism (generation-first).** `docs/reference/concept-ownership.md` (the
`docs/reference/` layer is the declared home for long-lived reference docs), two
parts: (a) **summary field maps as generated blocks** — named accurately (audit
F7): `ScanSummarySchema` top-level keys describe the *scan summary*, not the
whole envelope, so the doc generates one field table **per registered distiller
output schema** (enumerated from `src/tools/summaries/outputSchemas.ts` via the
distiller registry, scan first-class), producer-candidate column derived by
scanning assignment sites in `src/tools/summaries/` and `src/tools/observe/`
(shared `repo-introspection.mjs`), plus a hand notes column preserved by field
key across regeneration; a new schema field appears automatically with an empty
notes cell and the gate names it. Envelope-level common fields (`delta`,
`renderer`, `saved`, `nextActions`, …) get their own small table sourced from
the `distilledJsonResult` path rather than any single tool schema. (b) the
**concept-ownership matrix stays hand-written** (ref, artifact, lease, snapshot,
operation, perception ledger, token budget/renderer, session delta, memory
plane, effect, wordlists → owning module(s) → key types → guarding gates): it
changes only on architecture moves, so hand maintenance is cheap and the
judgment content is not derivable. Pinned by `check:doc-paths` path-liveness.

**Verification.** Red-first: add a temp key to the schema fixture path → the
regenerated table gains the row and the empty-notes gate names it; matrix rows
covered by path-liveness.

### D7. `docs:sync` umbrella + managed-block engine

**Problem.** The repo already has four generator/gate pairs (`docs:sync-indexes`,
`docs:generate`, `sync:protocol`, `sync:capture`) plus the ones this plan adds
(`sync:impact-map` A1, `sync:code-map` D3, the D1/D2/D5/D6 managed blocks). Left
as separate commands, the maintenance question becomes "which of seven sync
commands do I run after this edit?" — recreating the discovery problem the
generators were meant to remove.

**Mechanism.** (a) A small shared managed-block library
(`scripts/lib/managed-blocks.mjs`): find/replace content between
`<!-- BEGIN GENERATED: <id> (npm run docs:sync) -->` markers, preserve
hand-judgment cells keyed by row id, and support `--check` byte-compare mode —
consumed by every block generator so the mechanics are written once. D7 lands the
engine, a block-registry convention, and the first live managed block
(`AGENTS.md` -> CLAUDE.md). Later D1/D2/D5/D6 tasks register their own block
generators as they land; D7 must not require generators that do not exist yet.
(b) One umbrella `npm run docs:sync` running the currently registered doc-side
generators idempotently (`docs:sync-indexes`, `docs:generate`, `sync:code-map`
once D3 lands, plus registered managed-block generators; `sync:protocol`/
`sync:capture` stay separate — they regenerate code, not docs, and already have
lefthook hooks). (c) One umbrella drift gate
`check:docs-sync` = all generators in `--check` mode, failure message naming the
one command to run (`npm run docs:sync`) while preserving the failing child
generator name and paths in the diagnostic details; existing child messages such
as `docs:generate --check` are rewritten or wrapped so they do not tell agents to
run a narrower fixer when the umbrella is the intended contract. Legacy doc
generators that currently lack a read-only mode (`scripts/sync-doc-indexes.mjs`)
must either gain `--check` in D7 or be invoked through a temp-copy comparator; the
real tree must never be mutated by `check:docs-sync`. Wired into the docs group,
`check-graph.mjs`, and the A1 impact map. (d) Lefthook: auto-run + stage on
commit only if the full umbrella measures ≤2s (decided by measurement at
execution); otherwise rely on the gate + its self-naming remediation. (e) The
README tool table joins the managed blocks (generated from registered tool
metadata — the same source `docs:generate` already reads), removing one more
hand-sync burden item; `check:tool-doc-drift`'s README assertions stay satisfied
by construction. (f) **`AGENTS.md` becomes the single editing surface for the
mirrored governance rules (v2):** the CLAUDE.md "Design, Governance & Workflow
Rules (inlined from AGENTS.md)" section becomes a managed block regenerated from
`AGENTS.md` by `docs:sync` — today every governance edit is a manual double-edit
that `check-doc-structure.mjs` merely verifies after the fact; with the block
generated, the verbatim-equality assertion is retained as the `--check` mode and
the double-edit class disappears. The managed-block markers must be ignored by
the CLAUDE/AGENTS section parser (or placed outside its parsed body) so the
closing `<!-- END GENERATED -->` marker cannot become part of the final AGENTS
section and break verbatim equality. The "edit here and mirror in AGENTS.md" prose
in both files flips to "edit `AGENTS.md`; `npm run docs:sync` regenerates the
CLAUDE.md block". C1's handbook and C2/CURRENT references are updated in the same
phase from `docs:sync-indexes` to the broader `docs:sync` rule once the umbrella
exists.

**Resulting burden model** (the point of the restructure): routine code change →
**zero hand doc edits** (`docs:sync` or the pre-commit hook absorbs bookkeeping;
gates stay green by construction); new directory / schema field / kernel export →
exactly **one judgment cell** named by a gate; new tool → judgment rows only
(boundaries row, skill mention) while every table auto-fills.

**Verification.** Idempotence: running `npm run docs:sync` twice produces no
second diff. `check:docs-sync` itself is read-only: it invokes generators only in
`--check` mode against the real tree, while any "sync then check" idempotence
assertion runs on a temp fixture/copy. Judgment-cell preservation: a regeneration
must not lose existing hand cells (unit test on the managed-block library).
Red-first per block: stale committed block fails `check:docs-sync` naming the
block id.

---

## Phased execution structure

Each phase is **one workstream**: its own `CURRENT.md` activation entry (with a
`Scope:` line once C5 exists), its own full-gate closure, its own §Results
record appended to this doc. Phases are ordered by dependency and value; every
boundary is a safe stopping point, and later phases may be re-scoped from earlier
results without reopening closed ones.

**Phase 1 — Trust the loop** (A1 → A2 → A5 → A3 → B5 → B2)
The verification loop becomes truthful and fast: derived fail-closed impact map,
DAG closing engine with ESLint + evidence artifact (groups included, CI parity),
unit shards, remediation quick wins (incl. the `classBBaseline` 101→97 re-pin),
marker query tool. Closes with: serial/DAG parity, wall-clock table, A1 red-first
synthetics, `query:markers` executed control.

**Phase 2 — Authoring & knowledge** (C1 → C4 → C5 → B1)
What agents need to know and the chores they shouldn't do by hand: the handbook
(including the durable "hard-won lessons" home that replaces operator-only
memory), the new-check scaffolder, the scope sentinel, single-source manifests +
cross-artifact consistency. Closes with: handbook headings pinned, scaffolder
dry-run control, scope demo artifact, version-bump = zero contract edits.

**Phase 3 — Docs maintain themselves** (D7 → D5 → D1 → D2 → D4)
The generation-first restructure: managed-block engine + `docs:sync` umbrella
(incl. `AGENTS.md` single-sourcing and the README tool table), orientation-doc
honesty triage, routing-map repair with judgment cells, playbooks, breadcrumbs.
Closes with: `docs:sync` idempotence, the zero-hand-edit demo (routine file add),
an `AGENTS.md`-only governance edit propagating via `docs:sync`, capture
breadcrumbs with `check:capture` byte-identity intact.

**Phase 4 — Corpus & maps** (B3 → B4 → D3 → D6 → A4)
Remaining de-brittling and the generated reference surfaces: worst-marker
conversions, ledger `--propose` tooling, generated code map
(registration-execution derivation), summary field maps + ownership matrix,
per-node cache scopes. Closes with: red-first per conversion, five `--propose`
clean-tree controls, `check:code-map`/`check:docs-sync` green, cache
hit/miss demonstrations.

**Phase 5 — Process closure** (C2 → C3)
`CURRENT.md` ceiling + migration; audit-findings index with evidence fields and
backfill. Closes with: ceilings red-first then green, index gate green.

Cross-phase dependencies honored by the ordering: A1 (P1) feeds B2 `--file`,
D2's generated tables, and A4; B1 (P2) feeds D5's generated manifest table; D7
(P3) precedes every managed-block consumer; C4's scaffolder is dogfooded by the
first later new gate that actually lands after C4, normally `check:docs-sync`
in Phase 3.

## Results

Completed 2026-06-12. The implementation stayed inside the dev-harness boundary:
check runners/graph/cache/smart selection, contracts, package/CI/doc/process
tooling, generated reference docs, audit lifecycle, and archive/current hygiene.
No public `browser_*` tool name, schema, envelope, or browser runtime behavior was
added.

### Phase Closure Evidence

| Phase | Delivered surfaces | Verification evidence |
| --- | --- | --- |
| Phase 1 - Trust the loop | `scripts/sync-impact-map.mjs`, `scripts/lib/repo-introspection.mjs`, committed `tests/contracts/drift/check-impact-map.json`, DAG-backed `check:all*`, `check:all:src`, CI artifact upload, unit shards, retired `check:lint`, `query:markers`, `classBBaseline` 101 -> 97 | `npm run check:all:src` 18.6s; `npm run check:all:bridge` 97.6s; `npm run check:all:contracts` 21.9s; `npm run check:all:package` 17.6s; `npm run check:check-graph`; `npm run query:markers -- --needle templateGroupDescriptorForEntity`; `npm run query:markers -- --file src/abml-core/treeDiff.ts`; `node scripts/check-dag.mjs --self-test-miss-recorder` |
| Phase 2 - Authoring & knowledge | `docs/agent-development.md`, `scripts/new-check.mjs`, `scripts/workstream-scope.mjs`, `tests/contracts/drift/abml-core-manifest.js`, `tests/contracts/drift/expected-package-facts.js` | `npm run new:check -- --name dry-run-demo --group docs --dry-run`; `node scripts/workstream-scope.mjs`; `npx tsx --test tests/unit/utils/workstream-scope.test.ts`; `npm run check:doc-structure`; `npm run check:abml-core-boundary`; `npm run check:package` |
| Phase 3 - Docs maintain themselves | `scripts/lib/managed-blocks.mjs`, `scripts/sync-docs.mjs`, `scripts/sync-managed-blocks.mjs`, README tool index, CLAUDE AGENTS inline block, generated maintainer/playbook blocks, capture-source breadcrumbs | `npm run docs:sync` twice with no second diff; `npm run check:docs-sync`; `npm run check:capture`; `npm run check:doc-paths`; `npm run check:tool-docs` |
| Phase 4 - Corpus & maps | identifier-fragile pins moved to manifest/spec claims, `--propose` on five ledgers, `scripts/sync-code-map.mjs`, `docs/generated/code-map.generated.md`, `scripts/sync-concept-ownership.mjs`, `docs/reference/concept-ownership.md`, v2 per-node cache scopes | `npm run check:surface-liveness -- --propose`; `npm run check:input-surface -- --propose`; `npm run check:file-ceilings -- --propose`; `npm run check:kernel-test-map -- --propose`; `npm run check:compaction-ledger -- --propose`; `npm run check:code-map`; `npm run check:check-graph` cache-scope fixture |
| Phase 5 - Process closure | compact `CURRENT.md`, compact `TODO.md`, audit lifecycle index `agent-audits/runs/index.json`, `check:audit-inbox`, full-history CI checkout for audit evidence commits | `npm run check:audit-inbox`; `npm run check:doc-structure`; `npm run docs:sync`; `npm run check:all:package` |

### Acceptance Audit

- Closing engine: `package.json` now routes `check` -> `check:all` -> `node scripts/check-dag.mjs`; `check:serial` and grouped `check:serial:*` remain escape hatches. `check:all:bridge|package|contracts|src` are DAG group aliases, and CI uploads `.pi/browser-artifacts/check-dag-summary.json` plus `.pi/browser-artifacts/check-dag/**`.
- Smart selection: `check:impact-map` fails on drift; `check:check-graph` asserts ABML `treeDiff` selects `check:abml-tree-diff` and `check:abml-templating`, and distill relevance selects `check:task-conditioned-salience`. Impact-map nodes are either `scope:"paths"` with no unresolved inputs or `scope:"global"` with reasons.
- Wall-clock record:

| Gate | Result / duration | Evidence |
| --- | --- | --- |
| Design baseline serial full run | 173.4s | scouting baseline recorded in this plan |
| Final serial parity `npm run check:serial` | exit 0, about 193s | serial parity transcript / grouped summary |
| Final DAG full `npm run check` | exit 0, about 124s, 99 node results | `.pi/browser-artifacts/check-dag-summary.json` plus per-run copy under `.pi/browser-artifacts/check-dag/` |
| `npm run check:all:src` | exit 0, 18.6s | `.pi/browser-artifacts/check-dag/` group run |
| `npm run check:all:package` | exit 0, 17.6s | `.pi/browser-artifacts/check-dag/` group run |
| `npm run check:all:contracts` | exit 0, 21.9s | `.pi/browser-artifacts/check-dag/` group run |
| `npm run check:all:bridge` | exit 0, 97.6s | `.pi/browser-artifacts/check-dag/` group run |
- Ledger/propose controls: `surface-liveness`, `input-surface`, `file-ceilings`, `kernel-test-map`, and `compaction-ledger` all support `--propose` and currently report no changes needed. `docs/compaction-ledger.json` is re-pinned to `classBBaseline:97`.
- Docs/generation burden: `docs:sync` covers doc indexes, generated tool docs, code map, concept ownership field maps, and managed blocks. README tool table and CLAUDE AGENTS inline block are generated from live sources. Running `docs:sync` twice produced no second diff.
- Navigation/reference surfaces: `docs/agent-development.md`, `docs/generated/code-map.generated.md`, `docs/reference/concept-ownership.md`, and generated blocks in `docs/maintainer-map.md` now provide the dev-agent routing layer.
- Process closure: `CURRENT.md` is below the 180-line ceiling, `TODO.md` is a navigation page, `agent-audits/runs/index.json` is gated, and shallow-history diagnostics name `fetch-depth: 0` plus `check:audit-inbox`.
- Scope sentinel: `scripts/workstream-scope.mjs` is visibility-only and included in DAG summaries. A parser bug found during closure (wrapped Markdown-code `Scope:` entries were misread as out-of-scope) was fixed and covered by `tests/unit/utils/workstream-scope.test.ts`.
- D4 capture-breadcrumb honesty: generated capture bundle files did change during the run, but only in generated header/hash stamp material; the editable template payload stayed unchanged and `check:capture` / page-script gates stayed green. The original "generated bundles stay byte-identical" wording was too strong and is superseded by the D4 verification rule above.

### Acceptance Follow-up

The independent acceptance pass accepted the implementation conditionally and identified F-1..F-6. The accepted fixes are closed in this follow-up rather than left as backlog:

| Finding | Disposition | Follow-up evidence |
| --- | --- | --- |
| F-1 / F-2 | Accepted. The remaining `defaultDistDir` source-text pin was removed, and the retained fragile `--quiet` pin now has a source-site `// contract:` breadcrumb. | `tests/contracts/drift/check-package-files.mjs`; `scripts/build-bridge.mjs`; pinned by `check:package` and `check:doc-structure`. |
| F-3 | Accepted as an honesty fix. Bundle changes were header/hash-only, not full payload byte identity. | D4 mechanism and Acceptance Audit now record this deviation explicitly. |
| F-4 | Accepted. The original demo evidence was not retained as standalone artifacts; reproducible parts are now either recorded with artifact paths or converted to gates. | Closing artifacts live at `.pi/browser-artifacts/check-dag-summary.json` and `.pi/browser-artifacts/check-dag/`; bad-node exit is gated by `tests/contracts/drift/check-check-graph.mjs`; scope baseline behavior is gated by `tests/unit/utils/workstream-scope.test.ts`. |
| F-5 | Accepted. Baseline-dirty filtering now has a git-backed unit regression. | `tests/unit/utils/workstream-scope.test.ts`. |
| F-6 | Accepted. Handbook lessons and AGENTS/CLAUDE source guidance are now explicit and gate-pinned. | `docs/agent-development.md`; `AGENTS.md`; `CLAUDE.md`; `tests/contracts/drift/check-doc-structure.mjs`. |

Process deviation disposition: the five-phase activation discipline was not
followed during the original implementation; it ran as one continuous workstream.
This is accepted as a visible process deviation, not treated as a hidden success
condition. The control remains non-blocking by design: C5 records declared-scope
state in closing artifacts, while activation-entry enforcement stays a closed
non-machine-enforced decision unless future evidence reopens it.

## Rejected alternatives (closed decisions)

- **Pre-push/pre-commit full-check hook** — rejected: a 1–3 minute commit gate
  trains `--no-verify` habits; the closing-gate artifact (A2) is the chosen control.
- **Machine-enforcing the activation-entry rule** — rejected: "work started" is not
  reliably machine-detectable; mitigated by the C1 checklist plus acceptance review
  reading the closing artifact. C5 deliberately stays on the visibility side of
  this line: it reports declared-scope deviations in the closing artifact but
  never blocks, and is inert when no scope is declared.
- **Auto-writing ledger baselines (`--write` for ratchets)** — rejected: ratchet
  growth must remain a deliberate in-diff act; `--propose` gives the mechanics
  without ceding the decision.
- **Converting all source-text markers to executed assertions** — rejected as
  change-for-change: the stable-string subset (tool names, error codes, env vars)
  is cheap and effective; only the identifier/code-fragment subset is converted (B3).

## Acceptance bar

Per-phase closure criteria live in §Phased execution structure; each phase closes
with the full gate and appends its §Results (wall-clock numbers, red-first
evidence, demo artifacts) to this doc. Whole-plan acceptance additionally
requires:

- Full `npm run check` (new engine, ESLint included) exit 0, plus
  `npm run check:serial` parity green on the same tree; `check:all:bridge|package|contracts`
  route through DAG group mode and produce the same summary artifact shape plus
  non-overwriting per-run evidence paths; CI always-on coverage includes the
  `src` group and uploads check artifacts for review; no script named
  `check:lint` remains.
- Smart-gate regression: the A1 synthetic selections pass red-first and
  green-after; every node in the committed impact map either has a fully-resolved
  scope or is `scope:"global"` with `unresolvedInputs[]` recorded (gate-asserted).
- Wall-clock table (serial baseline 173.4s vs DAG full vs DAG+shards) recorded in
  §Results.
- All five ledger gates demonstrate `--propose`; `classBBaseline` re-pinned to 97.
- `query:markers` executed control passes; handbook and ceilings pinned by
  `check:doc-structure`; audit index backfilled and gated with evidence fields,
  duplicate/recurrence semantics, and shallow-history handling.
- The three burden/off-track demos all recorded in §Results: (1) routine file-add
  change → zero hand doc edits (`docs:sync` absorbs); (2) governance-rule edit
  made **only** in `AGENTS.md` → `docs:sync` regenerates the CLAUDE.md block and
  all gates stay green; (3) a closing artifact showing a deliberate out-of-scope
  touch surfaced by the C5 sentinel.
- Track D mechanics: `docs:sync` idempotent (second run no-diff); `check:docs-sync`
  red-first on any stale block; a synthetic new `src/` directory surfaces in the
  maintainer-map block with an empty judgment cell and the gate names it;
  `check:code-map` red-first on a stale map; D6 field tables gain rows
  automatically with empty-notes cells named; capture breadcrumbs ship with
  `check:capture` byte-identity intact; all playbook-cited gates resolve to real
  `package.json` scripts.
- Every phase closed with the full gate under that phase's current check contract
  (ESLint included after A2), with the closing evidence being the summary artifact,
  not transcript text.
