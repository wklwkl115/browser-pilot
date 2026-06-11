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

### Generated / mechanically synced

These may be partially script-maintained:
- archive index blocks in `ARCHIVE.md`
- archive link blocks in `ROADMAP.md`
- top-level structure links in `TODO.md`

Use:
- `npm run docs:sync-indexes`
- `npm run check:doc-structure`

## Structural rules

- `CURRENT.md` should stay compact and should not re-expand into per-TODO historical diaries.
- `ARCHIVE.md` should stay summary-first and should not re-accumulate full 180-240 style execution logs after those logs are migrated to `*.full.md` files.
- `ROADMAP.md` should contain future-facing items, not active execution details.
- `TODO.md` should remain a navigation page, not a second roadmap or archive.
- Detailed historical records should prefer dedicated files under `docs/archive/` once a phase is closed and stable.

## Validation

`npm run check` includes document-structure validation through:
- `npm run check:doc-structure`

That validation is intended to catch:
- missing summary/full archive pairs
- archive index drift
- structural regressions where current files start carrying large historical logs again
- missing links between top-level doc layers
