---
name: pi-browser-audit-fix
description: "Operate the asynchronous audit/fix workflow for pi-browser-tools. Use when Codex is assigned either role: (1) audit agent performing static or dynamic code review and recording suspected defects under agent-audits/runs without modifying project code, or (2) fix agent/maintainer consuming those audit reports, independently verifying each finding, and fixing accepted issues through normal repo workflow. Not for launching child agents; the user chooses which agent runs which role."
---

# Pi Browser Audit/Fix

This skill defines an asynchronous handoff between two user-invoked agents:

- **Audit agent**: finds suspected defects and writes reports only.
- **Fix agent**: reads reports, verifies claims, then fixes accepted issues.

Do not spawn or manage subagents from this skill. The user decides which agent runs the audit role and which agent runs the fix role.

## Shared Rules

- Work in `D:/Pi/agent/extensions/pi-browser-tools`.
- Read `agent-audits/README.md` and `agent-audits/AGENTS.md` before using this workflow.
- Keep audit evidence in `agent-audits/runs/`.
- Treat audit findings as hypotheses until independently reproduced.
- Do not use `CURRENT.md` / `TODO.md` as an audit backlog; they remain execution navigation.

## Audit Agent Mode

Use when the user asks this agent to audit, review, red-team, inspect, or look for defects.

Hard boundary:

- May read repo files and run bounded, non-destructive checks.
- May write only `agent-audits/runs/YYYY-MM-DD-<scope>.md`.
- Must not edit source, tests, generated files, package metadata, docs outside `agent-audits/`, git state, or lockfiles.
- Must not apply patches, auto-fix, format, stage, commit, reset, or rewrite history.

Procedure:

1. Choose a report path under `agent-audits/runs/`.
2. Copy the structure from `agent-audits/templates/run-report.md`.
3. Record scope, commit/worktree basis, commands run, and artifacts.
4. For each suspected issue, include file/line evidence, reproduction, expected behavior, actual behavior, impact, confidence, and a verification command.
5. Separate confirmed-looking findings from rejected leads and uncertainty.
6. End with a concise handoff table for the fix agent.

Dynamic audit constraints:

- Prefer existing local gates and fixtures: `npm run check:*`, targeted `tsx --test ...`, `npm run eval:browser-workflows -- --fixture-server`.
- Avoid third-party scanning, fuzzing, login, state-changing browser actions, credential use, or network load unless the user explicitly scopes it.
- Put large logs in `.pi/browser-artifacts/` and link paths from the report instead of pasting raw output.

## Fix Agent Mode

Use when the user asks this agent to verify/fix audit findings or consume reports from `agent-audits/runs/`.

Procedure:

1. Read the target audit report(s).
2. For each finding, independently inspect current code and rerun or reconstruct the reproduction.
3. Mark each finding in notes or final response as `accepted`, `rejected`, `duplicate`, or `needs-more-info`.
4. Fix only accepted findings.
5. Add or update focused regression coverage for each accepted fix.
6. Update affected docs/contracts/skills when the public workflow or contract changes.
7. Run the narrowest relevant gate first, then the final gate required by repo rules.

Fix boundaries:

- Do not blindly implement suggested fixes from audit reports.
- Do not preserve a finding as a lingering "watch" item. Either fix, reject with evidence, or mark `needs-more-info` with the missing concrete reproduction.
- Do not edit audit reports to make the code look fixed unless the user asks for report bookkeeping.
- Preserve unrelated dirty worktree changes.

## Severity Guide

- `P0`: exploitable security issue, data loss, code execution, irreversible destructive behavior, or public contract break.
- `P1`: high-confidence runtime failure, privacy leak, stale-state hazard, or serious agent workflow break.
- `P2`: correctness, maintainability, performance, or diagnostics issue with clear impact.
- `P3`: low-risk polish, docs mismatch, weak signal, or speculative improvement.

## Handoff Contract

Audit reports should be useful even when read days later:

- Include exact file paths and line references when possible.
- Include command strings and relevant output summary.
- Include whether the finding was static-only or dynamically reproduced.
- Include the expected verification gate after a fix.
- Avoid broad prescriptions; prefer small fix direction plus evidence.
