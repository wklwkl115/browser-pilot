# jshookmcp Native Absorption Closure

## 完成定义

`jshookmcp` is closed as a native absorption track for `pi-browser-tools`. The project absorbs the useful capability model, evidence discipline, and eval lessons, but it does not add a parallel public jshookmcp tool family.

Closure means:

- Existing browser primitives remain the callable surface.
- Source-map, debugger, interception, storage, and canvas evidence are routed through existing tools, artifacts, and internal engines.
- Rejected public tool names stay rejected: `browser_sources`, `browser_debugger`, `browser_intercept`, `browser_storage`, and `browser_canvas`.
- Follow-up work must improve existing canonical tools or internal engines instead of creating overlapping public verbs.
- Contract coverage prevents rejected tools from being registered or documented outside approved planning and eval records.

## 非目标

This closure does not attempt to recreate the old MCP server inside this extension. It also does not create a compatibility facade for old jshookmcp commands, does not add a second debugger abstraction, and does not create a strategy-shaped workflow tool.

Non-goals:

- No new public `browser_sources` tool.
- No new public `browser_debugger` tool.
- No new public `browser_intercept` tool.
- No new public `browser_storage` tool.
- No new public `browser_canvas` tool.
- No duplicate CTF or solver policy in this package.
- No hidden tool chain that decides strategy for the agent.

## Agent Navigation Boundary

Rejecting jshookmcp's runtime router does **not** mean this package has no capability navigation layer.

The navigation layer is skill-first:

- `skills/pi-browser-tools/SKILL.md` tells Pi-native agents how to choose and sequence the always-on `browser_*` tools by intent.
- `skills/pi-browser-cli/SKILL.md` tells shell/CLI agents how to drive the same tool core through `pi-browser` commands, `commands --json`, and `schema --json`.
- Generated tool contracts remain the source of exact parameters, enums, defaults, and error/recovery fields.
- Tool results provide factual `recovery.nextActions` and artifact handles for the next bounded step.
- Blind agent evals check whether real agents naturally follow these routes or need skill/contract/recovery changes.

Therefore the project keeps a capability radar, but it is not a dynamic MCP `route_tool` / `search_tools` / `activate_tools` layer. If a jshookmcp-derived capability area is hard for agents to use, first improve the relevant skill route, canonical owner mechanics, generated contract, recovery hints, or eval coverage. Do not introduce hidden activation profiles or a strategy-shaped runtime router to solve an agent guidance problem.

## 能力归属表

| Absorbed capability | Native owner | Public surface decision |
|---------------------|--------------|-------------------------|
| Source-map and bundled-source evidence | `browser_artifact`, crawl/source-map internals, saved artifacts | Do not expose `browser_sources`. |
| Debugger evidence | persistent CDP internals, runtime diagnostics, existing execute/observe artifacts | Do not expose `browser_debugger`. |
| Request replay and mutation | `browser_http_replay`, network recorder, artifacts | Do not expose `browser_intercept`. |
| Cookie/local/session storage evidence | existing state, cookie, artifact, and execute/read paths | Do not expose `browser_storage`. |
| Canvas/visual observation | scan/vision regions, screenshots, artifacts | Do not expose `browser_canvas`. |

The rule is public surface thin, internal engines thick. When a capability needs better mechanics, improve the owning engine and expose factual evidence through existing canonical tools.

## 任务账本

### TODO 241.1 - Capability Inventory

Status: closed.

The useful jshookmcp capability areas were inventoried and mapped to existing browser-tool owners. No capability required a new public tool namespace.

Evidence owners:

- `docs/tool-boundaries.md`
- `CURRENT.md`
- `ROADMAP.md`
- `README.md`
- `CHANGELOG.md`

### TODO 241.2 - Public Surface Rejection

Status: closed.

The rejected tools are explicitly recorded:

- `browser_sources`
- `browser_debugger`
- `browser_intercept`
- `browser_storage`
- `browser_canvas`

They remain rejected because each would overlap existing canonical surfaces or encode a workflow-shaped abstraction rather than a pure capability.

### TODO 241.3 - Native Evidence Routing

Status: closed.

Evidence routing stays native:

- Source and bundle evidence is stored as artifacts and read through artifact tooling.
- Debugger evidence is collected by persistent CDP internals and surfaced through diagnostics.
- Replay evidence is represented by replay artifacts and request/response summaries.
- Storage and cookie evidence is exposed through existing tab/session scoped flows.
- Canvas and visual evidence is represented by screenshots, scan regions, and saved observations.

### TODO 241.4 - Eval and Transcript Coverage

Status: closed.

The closure relies on eval records rather than a new surface:

- `evals/browser-workflows/eval-plan.md`
- `evals/browser-workflows/12-jshook-source-map-artifact.md`
- `evals/browser-workflows/13-jshook-storage-evidence.md`
- `evals/browser-workflows/14-jshook-replay-not-intercept.md`
- `evals/browser-workflows/15-jshook-canvas-observation.md`

If a future transcript proves an agent cannot complete a real task because the canonical surfaces lack a necessary mechanical primitive, the fix is to improve that primitive first.

### TODO 241.5 - Contract Ratchet

Status: closed.

`tests/contracts/tools/check-jshookmcp-closure.mjs` is the ratchet:

- Required planning docs must mention the jshookmcp boundary.
- Rejected public tool names are allowed only in approved planning/eval/contract files.
- Source, bridge, and config trees must not register or document the rejected tools.
- `package.json` must continue running the closure contract.

## 新公开工具 RFC 准入

A future public tool proposal that touches this area must pass all of the following before implementation:

1. It identifies an irreducible physical browser capability not already covered by a canonical tool.
2. It proves that improving `browser_execute`, `browser_observe`, `browser_http_replay`, `browser_artifact`, wait/state tools, or internal engines is insufficient.
3. It includes eval or transcript evidence showing agent outcome improvement, not only implementer convenience.
4. It defines recovery semantics, artifacts, and stale-state behavior.
5. It updates tool boundaries, docs, contracts, budgets, summaries, and evals in the same workstream.

Absent that proof, the decision remains closed: no public `browser_sources`, `browser_debugger`, `browser_intercept`, `browser_storage`, or `browser_canvas`.

## Closure Statement

The jshookmcp absorption is complete. This package keeps the concrete browser/Web tools, evidence paths, and skill-first agent navigation. It does not absorb jshookmcp's dynamic MCP routing/activation architecture, and challenge policy or solver methodology remain outside this extension. Future work should be expressed as improvements to existing native owners, skills/contracts/recovery, or as a new, fully evidenced RFC.
