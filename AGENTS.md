# AGENTS.md

## Scope

- Applies to `D:/Pi/agent/extensions/pi-browser-tools` and child paths.
- Inherits `D:/Pi/agent/AGENTS.md`; this file refines project rules and must not weaken root engineering rules.

## Project Role

- This extension is the browser/Web tool execution layer.
- Keep CTF protocol, routing, solver methodology, and challenge policy in `pi-ctf-protocol`, not here.
- Keep concrete callable browser/Web capabilities here.

## Project Rules

- Capability first: implement complete behavior, parameters, artifacts, summaries, and contracts.
- Tools must enhance agent situational judgment, not replace it. Prefer capabilities that expose observation, execution, replay, state synchronization, and evidence access over pre-baked decision flows.
- Keep programmable execution surfaces first-class. When a task-specific short script can locate, act, verify, and return structured evidence, prefer improving `browser_execute`, `browser_http_replay`, `browser_artifact`, or evidence surfaces over adding narrow one-off tools.
- Specialized automation must be evidence-triggered. Do not design tools so agents can skip baseline observation, request capture, replay, or proof construction and jump directly to crawl/fuzz/scanner-style conclusions.
- Expert bridges and scanners are follow-up layers, not default reasoning substitutes. They should consume stable scoped inputs and preserve artifacts; they should not become the first step for ordinary browser/Web tasks.
- Do not weaken tool capability through tool-layer safety/policy wording, hidden gates, or risk-tier defaults. Security boundaries belong to Pi/platform guard layers, not this extension.
- Keep one Web package. Prefer clear internal layering over spawning parallel Web extensions unless explicitly required.
- Keep composition entrypoints thin. Put domain logic in domain modules, not in top-level registration/composition files.
- Avoid oversized monolithic files or modules. Split by responsibility before a file becomes a mixed-domain maintenance bottleneck.
- Keep external tool contracts stable unless an explicit migration is required and fully documented: tool names, schemas, summaries, artifact behavior, and verification flow must not drift accidentally.
- Prefer mature dependencies for generic parsing/format support. Prefer deeply adapted Pi-native bridges for mature external engines when they are better than maintaining a local reimplementation.
- Mature substitutions and bridges must be package-portable: no private absolute paths, no throwaway local scripts, no host-specific production assumptions.
- Reuse existing project architecture where possible: registration shell, budgets, summaries/distill, artifact handling, cookie/HAR/raw-request flows, and verification conventions.
- Normalize loose external inputs early and keep internal implementation types as strong as practical. Do not let broad `unknown`-heavy flows spread through core implementation layers.
- Future `browser_*` labels must not be registered as callable tools until implemented.
- Keep summaries compact and avoid leaking cookies/tokens; preserve full evidence through artifacts.

## TODO Workflow

- Before large architecture changes, scope redefinitions, mature-substitute adoption, bridge introduction, or major refactors, update `TODO.md` first so the execution path is explicit before coding.
- TODO entries must make a decision, not defer vaguely. State whether work continues as native implementation, adopts a mature dependency, adds a Pi-native bridge, or is prerequisite refactor debt.
- When changing an already implemented tool, update TODO explicitly to record the scope/boundary/doc/contract change; do not hide it under unrelated future work.
- Keep TODO order actionable. Prerequisite refactors or debt that unblock later work should be placed before the dependent features.
- After completing a TODO item, update its status and any affected next-step ordering in the same workstream.

## Sync Requirements

- When a tool is added or materially changed, update code, contracts, budgets, summaries, README, CHANGELOG, TODO, the `pi-browser-tools` skill, and related `pi-ctf-protocol` docs/contracts in the same workstream.
- Runtime capability claims in docs/skills/contracts must match actual implemented tools. Do not document future capability as current callable capability.

## Verification

- After code or contract changes run `npm run check` in this extension.
- When touching global skill text, run `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`.
- After runtime reload, run both verification layers for newly registered or enhanced browser tools: bounded local-fixture smoke tests and actual callable-tool runtime tests that write artifacts.
- Summarize runtime smoke and actual test artifact paths in the final response.