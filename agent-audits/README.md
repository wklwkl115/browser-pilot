# Agent Audit Inbox

This directory is the repo-local inbox for static and dynamic code audits run by
other agents.

The directory is intentionally **audit-only**:

- Audit agents may read the project, run non-destructive checks, and write audit
  reports under `agent-audits/runs/`.
- Audit agents must not edit project source, generated files, docs outside this
  directory, tests, package metadata, or git history.
- Audit agents must not commit, reformat, auto-fix, or apply patches.
- Maintainers analyze reports here, verify each claim against the current
  worktree, then perform fixes in normal code workstreams.

Agents assigned to this workflow should use `skills/pi-browser-audit-fix/SKILL.md`.
The user invokes the two roles asynchronously: one agent audits and writes reports
here; a later fixer agent reads those reports, verifies them, and changes code
through the normal project workflow.

## Directory Layout

- `AGENTS.md` — local rules for audit-only agents.
- `templates/run-report.md` — full audit run template.
- `templates/finding.md` — single finding template.
- `runs/` — audit reports produced by subagents.

Use report names like:

```text
agent-audits/runs/2026-06-11-memory-kernel-static.md
agent-audits/runs/2026-06-11-bridge-dynamic.md
```

## Audit Workflow

1. Start from the requested scope and record it in a run report.
2. Inspect code, docs, tests, and generated contracts relevant to the scope.
3. For dynamic audit, run only bounded, non-destructive commands. Prefer local
   fixtures and existing gates such as `npm run check:*`, targeted `tsx --test`
   files, or read-only smoke/eval commands.
4. Record each suspected issue with file/line evidence, reproduction steps,
   expected versus actual behavior, impact, confidence, and suggested
   verification.
5. Do not fix the issue. Leave the finding for maintainer triage.

## Fix Workflow

When consuming a report, the fixer/maintainer:

1. Treat every finding as untrusted until independently reproduced.
2. Check whether the evidence still applies to the current worktree.
3. Mark each finding `accepted`, `rejected`, `duplicate`, or `needs-more-info`
   in the report or in the follow-up workstream notes.
4. Fix accepted issues through normal project workflow, with tests and docs in
   the same workstream.

Large raw logs and screenshots should stay in `.pi/browser-artifacts/` or a temp
directory. Reports may link local artifact paths, but should not paste secrets,
cookies, tokens, or large generated payloads.
