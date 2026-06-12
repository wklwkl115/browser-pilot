---
name: pi-kernel-audit
description: "Run a read-only kernel governance audit for pi-browser-tools pure kernels. Use for periodic or operator-invoked audits of src/abml-core, src/distill-core, src/memory-core, and capture-core boundaries: consumption surface, spec/doc drift, dataflow liveness, determinism, caps/redaction, performance, and direct test coverage. Auditors write reports under agent-audits/runs and never modify project code."
---

# Pi Kernel Audit

Use this skill as an audit-only procedure. It does not launch subagents by itself; the user or operator chooses whether to run one agent or several read-only agents.

## Hard Boundary

- Work in `D:/Pi/agent/extensions/pi-browser-tools`.
- Read `AGENTS.md`, `CURRENT.md`, `TODO.md`, `docs/archive/governance-mechanisms-plan.full.md`, and `agent-audits/AGENTS.md` first.
- Write only `agent-audits/runs/YYYY-MM-DD-kernel-<scope>.md`.
- Do not edit source, tests, docs outside `agent-audits/runs/`, generated files, package metadata, git state, or lockfiles.
- Treat every finding as a hypothesis until a maintainer/fix agent independently verifies it.

## Audit Dimensions

Inspect the active kernel set:

- `src/abml-core/`
- `src/distill-core/`
- `src/memory-core/`
- capture-core boundary files when the issue involves page-world sensing or generated capture bundles

For each kernel, check:

- Consumption surface: exported symbols are consumed, internal, test-harness-only, or explicitly reserved with a promotion bar.
- Spec/doc drift: contract docs with `Doc-class: contract` match current code and reserved claims stay explicit.
- Dataflow liveness: expensive projections, scan entities, and envelope entities are computed once then threaded, not recomputed in slices.
- Determinism: pure kernels do not read clock, random, locale, process env, browser globals, or Node I/O.
- Caps/redaction: model-facing output remains bounded, local artifacts hold full evidence, and raw/sensitive paths stay local.
- Performance: high-entropy fixtures do not reintroduce obvious duplicate serialization or O(N^2) hot loops.
- Test coverage: each kernel module has a direct importing test or a shrink-only grandfather decision.

## Procedure

1. Pick a narrow report path under `agent-audits/runs/`.
2. Record commit/worktree basis, scope, commands, and whether checks were static-only or dynamically reproduced.
3. Prefer existing gates before ad hoc scripts:
   - `npm run check:spec-truth`
   - `npm run check:surface-liveness`
   - `npm run check:compute-once`
   - `npm run check:purity-vocabulary`
   - `npm run check:kernel-test-map`
   - `npm run check:env-flags`
   - relevant focused unit or contract tests
4. For each suspected issue, include file:line evidence, reproduction steps, expected behavior, actual behavior, impact, confidence, and the verification gate that would fail after a fix.
5. Record rejected leads with the evidence that rejected them so they are not re-litigated.

## Graduation Rule

If an audit-class finding recurs a second time, do not leave it as another report-only item. The consuming maintainer workstream must either:

- add or extend a static gate using the G1-G6 governance patterns, or
- reject the recurrence with concrete evidence showing it is not the same defect class.

This rule is mandatory because repeated audit-only findings are evidence of an ungated dimension.
