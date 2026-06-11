# AGENTS.md

## Scope

- Applies to `D:/Pi/agent/extensions/pi-browser-tools/agent-audits` and all child
  paths.
- This directory is an audit inbox, not an implementation workspace.

## Audit-Only Rule

- You may read any repository file needed for the assigned audit.
- You may run bounded, non-destructive static or dynamic checks.
- You may write only audit reports under `agent-audits/runs/`.
- You must not edit project code, generated files, docs outside
  `agent-audits/`, tests, package metadata, lockfiles, or git history.
- You must not apply patches, auto-fix, reformat, commit, reset, or stage files.
- If you are assigned the fixer role instead, leave this directory's audit-only
  scope and use `skills/pi-browser-audit-fix/SKILL.md` from the repository root;
  fixer work happens in normal project files after independent verification.

## Report Contract

- Use `agent-audits/templates/run-report.md` for a run-level report.
- Use `agent-audits/templates/finding.md` for individual findings when adding to
  an existing run.
- Every finding must include concrete evidence: file/line references, command
  output or artifact path, reproduction steps, impact, confidence, and proposed
  verification.
- Findings are hypotheses until a maintainer independently verifies them.

## Dynamic Audit Safety

- Prefer local fixtures and existing checks.
- Do not perform destructive browser actions, external scanning, fuzzing against
  third-party targets, credential use, or network load unless the maintainer's
  prompt explicitly scopes it.
- Keep raw evidence local and bounded. Link artifact paths instead of copying
  secrets, cookies, tokens, or large payloads into reports.

## Handoff

- End with a concise triage table: finding id, severity, confidence, status, and
  next verification command.
- Do not claim a fix. The maintainer will analyze the report and perform any
  code changes in a separate workstream.
