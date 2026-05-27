# Eval 17: Debugger evidence workflow

## Goal

Determine whether existing canonical tools can capture meaningful debugger-like evidence from a deterministic local fixture before any new public capability is proposed.

## Fixture

- Local target: `fixtures/debugger-evidence.html`
- Required files: `evals/browser-workflows/fixtures/debugger-evidence.html`
- Setup notes: use a local-only fixture server or manual fixture tab. The page is synthetic and deterministic.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_execute`
- `browser_frame`
- `browser_artifact`

## Expected tool sequence

1. Use `browser_tabs` to select or create the fixture tab with explicit `tabId`.
2. Observe the page with `browser_observe mode=scan` or `browser_observe mode=html` only to confirm trigger elements and status text.
3. Use `browser_execute` command mode with explicit CDP calls only for bounded debugger evidence reads; do not assume a new public debugger tool exists.
4. Preserve large or stateful outputs as artifacts and read them back with `browser_artifact`.
5. Verify whether the collected evidence is sufficient without inventing a new public debugger tool.

## Success criteria

- The evaluation distinguishes between one-shot CDP evidence that already works and true lifecycle gaps that remain unresolved.
- The result cites bounded debugger evidence such as script locations, stack frames, object previews, or cleanup diagnostics.
- The result does not propose or assume a new public tool name during execution.
- The result explicitly states whether the class remains RFC-only.

## Required evidence

- Summary evidence: one-shot CDP evidence obtained through existing tools.
- Artifact evidence: saved artifact paths for larger stack/object/script evidence.
- Diagnostics evidence: cleanup-diagnostics, stale-state risk, or lifecycle recovery notes.
- RFC-only evidence: an explicit statement that unresolved workflow gaps remain RFC-only unless future evals prove otherwise.

## Recovery checks

- Expected failure mode: one-shot `browser_execute` CDP commands cannot provide sustainable pause/resume/breakpoint workflow evidence.
- Required recovery path: record the insufficiency as RFC-only gap evidence; do not invent a new tool or widen the action scope.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
