# AGENTS.md

Agent operating guide for Browser Pilot.

## Authority

- `AGENTS.md`: agent routing and operating loop.
- `CODE_WIKI.md`: architecture/development map, module ownership, runtime flow, boundaries, maintenance playbooks.
- `REPO_GOVERNANCE.md`: canonical contributor workflow, repository boundaries, and validation gates.
- `skills/browser-pilot-cli/SKILL.md`: Codex-facing CLI operating guide; live `browser-pilot --help` and `browser-pilot schema <command> --json` remain the command-syntax authority.
- Public docs (`README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`) are not development-rule owners.
- Module-local docs may own narrower rules, e.g. `src/kernels/abml/README.md` for ABML kernel boundaries.

If docs disagree, trust source/generated schemas first, then `REPO_GOVERNANCE.md`, then `CODE_WIKI.md`, then this file. Fix stale docs; do not add another rule source.

## Project shape

Browser Pilot lets AI agents control real Chrome/Edge tabs through a Manifest V3 extension, a local Node bridge/daemon, and a fixed `browser_*` CLI/tool surface.

```text
apps/cli + apps/daemon
        │
src/bridge/server  ◀──WebSocket──▶  src/bridge/extension
        │
src/commands
        │
runtime layers: browser-runtime, browser-command-runtime, browser-page-runtime, scan, capture
        │
src/kernels/*
```

## Operating loop

For non-trivial work:

1. Orient: read relevant `CODE_WIKI.md` sections; read `REPO_GOVERNANCE.md` when gates or repo boundaries matter.
2. Inspect: verify behavior against source, schemas, tests, and module-local owner docs before editing.
3. Change: make the smallest bounded change; preserve the canonical owner for the touched behavior.
4. Sync docs: update `CODE_WIKI.md` or a narrower owner doc when architecture, public contracts, workflows, validation gates, or module ownership change.
5. Verify: run the relevant `mise` gate before claiming completion; use `mise run dev-governance` for governance/workflow/documentation-rule changes.
6. Close: report changed files, validation evidence, uncovered scope, and residual risk.

A task is not closed while source behavior, `CODE_WIKI.md`, `REPO_GOVERNANCE.md`, or module-local owner docs disagree about the changed surface.

## Code Wiki routing

Use `CODE_WIKI.md` as the first stop for unfamiliar areas:

- Sections 1-4: project overview and runtime flow.
- Section 5: module responsibilities.
- Section 6: key classes/functions.
- Section 7: command/tool layer.
- Section 8: bridge/daemon/extension protocol flow.
- Section 9: kernel/runtime/capture/native boundaries.
- Section 10: dependency and repository-boundary navigation.
- Sections 11-15: build/test map, maintenance playbooks, architecture principles.

Do not create duplicate architecture or workflow docs. Update the existing owner doc instead.

## Validation

Use `mise`; raw npm scripts are low-level maintenance helpers, not completion gates.

- Gate authority: `REPO_GOVERNANCE.md`.
- Release-readiness: `mise run verify`.
- Live bridge/daemon/extension behavior: `mise run smoke-browser`.
- Governance/workflow/doc-rule changes: `mise run dev-governance`.
- After editing `CODE_WIKI.md`, verify local Markdown links.
- When retiring stale docs/rules, check lingering references and update `.gitignore` if paths must stay local-only.

## Non-negotiable rules

- ESM throughout. Node-emitted TypeScript imports use `.js` extensions; bundled `src/bridge/extension/**` imports remain extensionless for the esbuild graph.
- Node 22+. TypeScript strict.
- Do not edit generated outputs: `dist/` or `bridge/browser_pilot_bridge/`.
- `src/kernels/*` are pure logic: no browser, Node, npm runtime, bridge, commands, or browser-runtime deps.
- `src/commands/commandCatalog.ts` is the authoritative public `browser_*` tool list.
- Page actions go through `browser_execute` or `browser_command`; there are no dedicated click/type tools.
- Hardcoded count/boundary assertions in tests often encode charter rules; investigate before changing them.
