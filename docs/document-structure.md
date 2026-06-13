# Document Structure

## Goal

Keep project documentation layered, predictable, and cheap to maintain.

## Canonical layers

### `CURRENT.md`

Use for:
- current runtime/tooling state
- active execution queue
- latest completed workstream summaries
- current engineering rules that still affect implementation

Do not use for:
- long historical execution diaries
- withdrawn work details
- large archived TODO streams already summarized elsewhere

### `ROADMAP.md`

Use for:
- future work
- RFC-only or delayed items
- explicit non-active directions
- archive entry references

Do not use for:
- current execution logs
- completed implementation diaries

### `TODO.md`

Use for:
- top-level navigation
- where active queue, archive, and roadmap live
- minimal maintenance rules

Do not use for:
- detailed design text
- long historical context

### `ARCHIVE.md`

Use for:
- compressed completed-work summaries
- completed phase indexes
- links to detailed archive files

Do not use for:
- full execution diaries once dedicated archive files exist
- current queue management

### `CHANGELOG.md`

Use for:
- recent, active changelog entries (reverse-chronological, newest first)

Do not use for:
- unbounded history — the active file is byte-capped by `maxBytes` in `tests/contracts/drift/file-ceilings.json` (enforced by `npm run check:file-ceilings`)

When the ceiling trips, run `npm run changelog:rotate` to roll the oldest entries into `docs/changelog-history.md`. This is a standalone maintenance command, not part of `npm run docs:sync`.

### `docs/changelog-history.md`

Use for:
- older changelog entries rolled out of `CHANGELOG.md` (append-only, no size ceiling)

Do not use for:
- new entries — always add new entries to the top of `CHANGELOG.md`

### `docs/archive/*.md`

Use for:
- phase summaries by domain/workstream

### `docs/archive/*.full.md`

Use for:
- detailed historical execution logs migrated out of `ARCHIVE.md`

### `docs/playbooks/*.md`

Use for:
- task-specific browser/Web security execution playbooks
- route steps, inputs, evidence requirements, pivots, and stop conditions

Do not use for:
- callable tool contracts
- long payload catalogs or vulnerability encyclopedias
- historical implementation logs

### `docs/reference/*.md`

Use for:
- long-lived methodology maps, matrices, payload references, and report templates
- material loaded on demand after a playbook selects the needed topic

Do not use for:
- short runtime routing instructions that belong in the global skill
- generated callable tool contracts

### `docs/<name>-plan.md` (active workstream plans)

Use for:
- active multi-step workstreams: optimization plans, architecture changes, major refactors
- items that have an execution order, a boundary, focused verification gates, and a governance-gate impact table

Do not use for:
- completed plans (archive them)
- single-step tasks (record directly in `CURRENT.md`)
- design notes without an execution sequence

Lifecycle:
1. **Create** using `docs/templates/workstream-plan-template.md`; place in `docs/` root
2. **Activate** by adding an entry to `CURRENT.md` (decision, boundary, plan doc path, verification); the plan must exist before implementation starts
3. **Execute** items in the plan; update item status in place as they complete
4. **Close** with full `npm run check`; then move the plan to `docs/archive/<name>.full.md` and add a compressed summary to `ARCHIVE.md`

### `agent-audits/`

Use for:
- audit-only reports written by other agents during static or dynamic code review
- templates and local rules that keep audit agents from changing project code
- maintainer triage input before normal implementation workstreams

Related skill:
- `skills/pi-browser-audit-fix/SKILL.md` defines the asynchronous audit-agent and fix-agent roles.

Do not use for:
- active implementation plans
- source changes, patches, generated outputs, or committed raw runtime evidence
- replacing `CURRENT.md`, `TODO.md`, `ROADMAP.md`, or `ARCHIVE.md`

## Naming rules

- Summary archive: `docs/archive/<name>.md`
- Detailed archive: `docs/archive/<name>.full.md`
- Summary and full-detail files should exist as pairs for major historical streams.
- Active plans: `docs/<name>-plan.md`
- Plan template: `docs/templates/workstream-plan-template.md`
- Agent audit reports: `agent-audits/runs/YYYY-MM-DD-<scope>.md`

## Generated vs manual content

### Manual

These stay human-authored:
- `CURRENT.md`
- `ROADMAP.md`
- `README.md`
- `AI_INSTALL.md`
- skill text
- explanatory design docs

Manual docs that serve as living contracts may add:
- `> Doc-class: contract`

Only docs registered in `tests/contracts/drift/spec-claims.js` are gated as contract docs.

### Generated / mechanically synced

These may be partially script-maintained:
- archive index blocks in `ARCHIVE.md`
- archive link blocks in `ROADMAP.md`
- top-level structure links in `TODO.md`
- managed generated blocks in `README.md` and `CLAUDE.md`

Use:
- `npm run docs:sync`
- `npm run docs:sync-indexes`
- `npm run check:doc-structure`

## Structural rules

- `CURRENT.md` should stay compact and should not re-expand into per-TODO historical diaries.
- `ARCHIVE.md` should stay summary-first and should not re-accumulate full 180-240 style execution logs after those logs are migrated to `*.full.md` files.
- `ROADMAP.md` should contain future-facing items, not active execution details.
- `TODO.md` should remain a navigation page, not a second roadmap or archive.
- Detailed historical records should prefer dedicated files under `docs/archive/` once a phase is closed and stable.
- `CHANGELOG.md` stays a bounded recent window: its byte ceiling lives in `tests/contracts/drift/file-ceilings.json` and overflow rolls into `docs/changelog-history.md` via `npm run changelog:rotate` (a standalone maintenance command, not part of `docs:sync`).

## Validation

`npm run check` includes document-structure validation through:
- `npm run check:doc-structure`

That validation is intended to catch:
- missing summary/full archive pairs
- archive index drift
- structural regressions where current files start carrying large historical logs again
- missing links between top-level doc layers
