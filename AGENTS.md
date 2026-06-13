# AGENTS.md

## Scope

- Applies to `D:/Pi/agent/extensions/pi-browser-tools` and all child paths.
- Inherits `D:/Pi/agent/AGENTS.md`; this file only adds stricter browser/Web extension rules.

## Role

- This package is Pi's browser/Web capability layer.
- Keep CTF protocol, routing, solver methodology, and challenge policy in `pi-ctf-protocol`.
- Keep concrete callable browser/Web tools, evidence capture, replay, state sync, and artifacts here.

## Design Principles

- Brain-Hand Separation: tools expose perception and execution; agents keep strategic judgment, planning, and proof construction. The line is not computation versus judgment — tools should encode deterministic mechanical expertise and provide sensible, visible, overridable defaults. What belongs to the agent is context-dependent strategic choice; what belongs in the tool is reliable domain knowledge that does not depend on task context and can be audited, overridden, and improved independently.
- Semantic Singularity: one capability class has one canonical tool. Names, schemas, and descriptions must have clear non-overlapping boundaries.
- Atomic Composability: prefer Unix-like primitives and programmable surfaces over black-box workflows or excessive micro-tools.
- Recoverable Diagnostics: optimize for feedback loops. Return structured high-signal summaries, actionable errors, observable state, idempotent/replayable operations, and artifact evidence.
- Eval-Driven Evolution: evolve tool interfaces from realistic task evals, failed transcripts, token/call cost, success rate, and recovery quality.
- Root-Truth Sourcing (釜底抽薪): solve at the lowest *real* layer, never on a convenient but lossy upper layer — this is a standing stance, not a one-off technique. When building, observe truth from *beneath* the abstraction boundary that hides it (CDP below the JS sandbox; the browser engine below any framework) and ask the engine directly rather than inferring from downstream artifacts (`DOMDebugger.getEventListeners` over sniffing `__reactProps`/`cursor:pointer`). A fix must dissolve a *class* of inputs, not one instance — agnostic by construction, not by per-framework coverage, so a tech-stack name appearing in the code is an overfit smell; thread it by an identity that survives boundaries (`backendNodeId`, not CSS selector). When deciding, source from running code (verified `file:line`), first principles, and measured/real-agent evidence — never from framework products or archived/superseded docs. Going lower is a hypothesis until proven at the mechanism and net-positive.

## Tool Design Rules

- Expose pure capability. Do not encode strategic decisions, challenge-solving policy, broad safety gates, or hidden risk tiers in this extension.
- Prefer improving `browser_execute`, `browser_http_replay`, `browser_artifact`, evidence, and wait/state tools before adding narrow one-off tools.
- Specialized automation, scanners, fuzzers, and bridges are follow-up layers; they must consume explicit scoped inputs and preserve evidence.
- Tool descriptions must state purpose, when to use, constraints, limitations, and examples when helpful.
- Choose granularity by frequency, certainty, and risk: high-frequency deterministic actions stay atomic; side effects need verification/stale-state protection; rare work may use bounded aggregation.
- Parameters should be minimal, strongly typed, and enum-based where practical. Normalize loose input early; do not let `unknown`-heavy flows spread.
- Outputs must be compact by default, structured, semantically named, token-efficient, optionally detailed, and non-leaking for cookies/tokens; full evidence belongs in artifacts.

## Agent-First Tool Constitution

- Public tools serve agent decision quality first, not implementer convenience.
- Good atomicity means **low hidden dependency cost**. Do not make the agent guess undocumented prerequisite steps.
- If a tool depends on prior state, expose it explicitly through params, handles, artifacts, or diagnostics.
- Keep Core tools aligned to irreducible physical capabilities. Do not split them into strategy-shaped micro-tools.
- WebSecurity tools may represent follow-up domains, but they must not rely on silent workflow assumptions.
- Internalize only the cheapest deterministic prerequisite; do not hide expensive, risky, or escalation decisions inside a tool.
- Keep **public surface thin, internal engines thick**. Prefer internal consolidation before public tool merges.
- Do not merge public tools unless execution context, parameter model, error semantics, and recovery flow are truly shared.
- Strategy belongs to skills and evals, not hidden tool chaining.
- Every complex tool must fail with factual remediation: missing prerequisite, reusable handle/artifact, and next concrete action.
- Any tool-surface consolidation requires eval proof that agent outcomes improve and recovery quality does not regress.

## Architecture Rules

- Keep one Web package; prefer internal layering over parallel Web extensions unless explicitly required.
- Keep registration/composition entrypoints thin; put domain logic in domain modules.
- Split files before they become mixed-domain maintenance bottlenecks.
- Keep external tool contracts stable unless a migration is explicit and documented: names, schemas, summaries, artifacts, and verification flow must not drift.
- Prefer mature dependencies for generic parsing/format work and Pi-native bridges for mature external engines when they beat local reimplementation.
- Mature bridges must be portable: no private absolute paths, throwaway scripts, or host-specific production assumptions.
- Future `browser_*` names must not be registered until implemented.

## ABML Project Development Rules

- ABML is the perception substrate under `browser_*`, not an agent-visible action surface. Do not add public ABML verbs, restore ABML click/type/scroll/action runtimes, or make `browser_execute {action}`-style sugar the shape of the ABML contract.
- For scrollable, lazy, virtualized, paginated, or hidden content, model the missing browser truth first: collection membership, completeness, continuation, data source, evidence, and semantic state transitions. Physical input, page JS, `pi.click`, or `browser_command input.*` may be runtime mechanics or explicit escape hatches, but they must not become first-class ABML/public verb design.

## Anti-Patterns

- Tools that decide strategy for the agent or hide uncertainty behind broad if/else logic.
- Zero-opinion tools with no mechanical expertise or defaults, forcing agents to spend attention on deterministic decisions better encoded as auditable, overridable tool behavior.
- Duplicate or overlapping tools, namespace drift, and capability sprawl.
- Swiss-army workflow tools that cannot be diagnosed, replayed, or composed.
- Excessive fragmentation that makes tool choice the task.
- Static design without evals, transcript review, or production feedback.

## Code Search

- For concept-level location questions ("where is X thrown", "which files implement Y across layers"), use semantic code search FIRST when available: the `acemcp` MCP tool `search_context` (exposed in Claude Code as `mcp__acemcp__search_context`). Call it with `project_root_path` set to this repo root using forward slashes and a natural-language query plus optional keywords, e.g. query "Where is the tab lease conflict thrown and where is its recovery text generated? Keywords: TAB_LEASE_CONFLICT, recovery nextActions".
- It incrementally indexes the working tree before each search (uncommitted and untracked files included) and returns scored file/line snippets across src, tests, contracts, scripts, and docs — use it instead of blind directory grepping when you do not yet know the identifiers.
- Treat hits as leads, not verification: results can miss one layer of a multi-layer chain, so open the files and apply the verify-before-naming rule before referencing or editing anything a hit suggested.
- Exact-string questions stay with exact tools: `npm run query:markers` for contract marker pins, plain grep for known identifiers, `npm run check:smart -- --dry-run --changed-file=<path>` for gate impact. Semantic search routes you to the neighborhood; the exact tools and the source decide.

## Change Workflow

- Before large architecture changes, scope changes, mature substitutions, bridges, or major refactors, update `TODO.md` with the concrete decision and execution path.
- When changing an implemented tool, update affected contracts/docs in the same workstream; do not document future capability as current callable capability.
- Audit-only agent reviews belong in `agent-audits/`: auditors may record reports under `agent-audits/runs/` but must not change project code; fix agents/maintainers use `skills/pi-browser-audit-fix/SKILL.md`, verify findings, then fix through normal workstreams.
- Keep TODO order actionable; mark completed items and reorder dependent work when scope changes.

## Executability Rule

Every plan item and every eval must be executed **now**. The default is to do the work immediately, not to schedule, stage, or gate it.

**Forbidden patterns — these are avoidance, not planning:**
- "Needs eval evidence first" — the eval infrastructure exists (`npm run eval:browser-workflows`, `eval:blind:launch`); run it now or drop the dependency.
- "Pending decision / design / signal" — make the decision now with current information, or write a closed decision; do not leave a placeholder.
- "Park / defer / suspend / wait for X" — not valid states; work is either executing or closed.
- "After Y lands / once Z is verified / when the feedback loop matures" — if Y and Z are in the same repo, do them in sequence now, not as future prerequisites.
- "Run eval first before doing X" when X has a clear contract and the eval can run now — this delays without cause.

**Required form for any plan item:**
1. The action is fully specified: files, functions, and parameters known from the current codebase.
2. The verification step is a concrete existing gate: `npm run check:*`, a named test file, or a smoke command.
3. Execution starts immediately after the item is written.

**The only valid reason not to execute now** is a genuine external blocker: infrastructure that does not exist in the repo, an external service that is unreachable, or a destructive action requiring explicit owner sign-off. Uncertainty, risk, or "needing more data" are not blockers — they are reasons to scope the work more tightly and execute the tighter scope now. If a blocker is real, write a closed decision in `ROADMAP.md` under "Closed decisions + reopen evidence bar" and stop tracking it as a plan item.

## Sync & Verification

- Tool additions or material changes must update code, contracts, budgets, summaries, README, CHANGELOG, TODO, the `pi-browser-tools` skill, and related `pi-ctf-protocol` docs/contracts when affected.
- Document structure rules live in `docs/document-structure.md`. When changing generated doc indexes or managed blocks, run `npm run docs:sync` before `npm run check`.
- For mirrored governance rules, `AGENTS.md` is the single editing surface: edit this file, then run `npm run docs:sync` to regenerate the `CLAUDE.md` inlined block.
- Development-harness authoring rules live in `docs/agent-development.md`; use it for check wiring, marker queries, ledger ratchets, and workstream closure.
- After code or contract changes run `npm run check` in this extension.
- For fast local iteration, use the narrowest grouped gate first when sufficient: `npm run check:all:bridge`, `npm run check:all:package`, `npm run check:all:contracts`; keep `npm run check` as the final full gate.
- For external CLI/tool parameter surface changes, include `npm run check:param-surface` and `npm run check:input-surface` in the focused verification set.
- When a structured serial verification summary is useful, run `node scripts/run-check-groups.mjs --json ...`; artifact is written to `.pi/browser-artifacts/check-groups-summary.json`. The closing `npm run check` artifact is `.pi/browser-artifacts/check-dag-summary.json` plus per-run copies under `.pi/browser-artifacts/check-dag/`.
- For accelerated local verification, use the graph-backed runners after the relevant narrow gate: `npm run check:trace` records grouped per-script durations, `npm run check:dag` executes the graph with direct local binaries and ESLint, `npm run check:dag -- --cache` may skip nodes by v2 per-node impact-map scope while global-scope nodes still use the whole-repo key, and `npm run check:smart` records impact-selected nodes plus conservative expansion reasons. These are acceleration aids; completed workstreams still close with full `npm run check`.
- The `pi-browser-tools` skill source lives in-repo at `skills/pi-browser-tools/SKILL.md`; the global load path `D:/Pi/agent/skills/pi-browser-tools` is a directory junction to it. When touching skill text, edit the repo file and run `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`.
- After runtime reload for new/enhanced tools, run bounded local-fixture smoke tests and actual callable-tool runtime tests that write artifacts; summarize artifact paths.
