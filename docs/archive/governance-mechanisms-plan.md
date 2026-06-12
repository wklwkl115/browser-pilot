# Governance Mechanisms Plan

> Summary archive for `docs/archive/governance-mechanisms-plan.full.md`.

Governance mechanisms G1–G7 completed on 2026-06-12. The work grew out of the
2026-06-11 ABML and distill kernel audits which found ~20 defects clustered into
five structural causes — prose-contract drift, dead-surface accumulation, slice-scoped
recomputation, a purity ban-list lagging the requirement, and delta-only test gating.
All six static gates landed; G7 is an institutionalised quarterly audit procedure.

## Completed Outcome

- **G1 `check:spec-truth`**: claims registry in `tests/contracts/drift/spec-claims.js`
  bridges contract docs and code; `implemented` symbols grepped, `reserved` markers
  required; anchors cannot rot.
- **G2 `check:surface-liveness`**: kernel export inventory
  (`kernel-export-inventory.json`, 49 modules) with `consumed|internal|test-harness|reserved`
  statuses; new export without status fails; last-consumer loss forces explicit decision.
- **G3 `check:compute-once`**: source-text call-site ledger for five hot callees;
  `stableJson` serialization-count canary added to `resultMiddleware` unit coverage.
- **G4 `check:purity-vocabulary`**: shared banned-API list in `purity-vocabulary.js`
  consumed by ABML, distill, and memory pure kernel boundary checks.
- **G5 `check:kernel-test-map`**: committed module → test-file map, shrink-only
  grandfather baseline of 6; new kernel modules must ship mapped.
- **G6 `check:env-flags`**: committed `PI_BROWSER_*` flag registry; unregistered flag
  fails; `affectsOutput` flags must declare signature sites.
- **G7 `skills/pi-kernel-audit/SKILL.md`**: operator/cron read-only audit procedure;
  graduation rule: any recurring audit-class finding escalates to a G1–G6 static gate.

## Acceptance

All six gates green: `check:spec-truth`, `check:surface-liveness`, `check:compute-once`,
`check:purity-vocabulary`, `check:kernel-test-map`, `check:env-flags`. Full
`npm run check` and `npm run lint` exit 0 (2026-06-12).

## Evidence

- Full execution record: `docs/archive/governance-mechanisms-plan.full.md`
- Shared drift modules: `tests/contracts/drift/`
- Audit skill: `skills/pi-kernel-audit/SKILL.md`
