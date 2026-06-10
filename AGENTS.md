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

## Anti-Patterns

- Tools that decide strategy for the agent or hide uncertainty behind broad if/else logic.
- Zero-opinion tools with no mechanical expertise or defaults, forcing agents to spend attention on deterministic decisions better encoded as auditable, overridable tool behavior.
- Duplicate or overlapping tools, namespace drift, and capability sprawl.
- Swiss-army workflow tools that cannot be diagnosed, replayed, or composed.
- Excessive fragmentation that makes tool choice the task.
- Static design without evals, transcript review, or production feedback.

## Change Workflow

- Before large architecture changes, scope changes, mature substitutions, bridges, or major refactors, update `TODO.md` with the concrete decision and execution path.
- When changing an implemented tool, update affected contracts/docs in the same workstream; do not document future capability as current callable capability.
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
- Document structure rules live in `docs/document-structure.md`. When changing archive/roadmap/todo/current index blocks or archive file layout, run `npm run docs:sync-indexes` before `npm run check`.
- After code or contract changes run `npm run check` in this extension.
- For fast local iteration, use the narrowest grouped gate first when sufficient: `npm run check:all:bridge`, `npm run check:all:package`, `npm run check:all:contracts`; keep `npm run check` as the final full gate.
- When a structured local verification summary is useful, run `node scripts/run-check-groups.mjs --json ...`; artifact is written to `.pi/browser-artifacts/check-groups-summary.json`.
- The `pi-browser-tools` skill source lives in-repo at `skills/pi-browser-tools/SKILL.md`; the global load path `D:/Pi/agent/skills/pi-browser-tools` is a directory junction to it. When touching skill text, edit the repo file and run `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`.
- After runtime reload for new/enhanced tools, run bounded local-fixture smoke tests and actual callable-tool runtime tests that write artifacts; summarize artifact paths.
