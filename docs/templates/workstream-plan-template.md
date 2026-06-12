# <Plan Title>

> Status: DRAFT | ACTIVE | COMPLETE
> Scope: `<files or modules changed>`
> Boundary: `<what is NOT touched — runtime/driver/public surface/etc.>`
> Verification: `<focused gate(s)>`; closing gate `npm run check`

---

## Execution Order

| Order | Item | Why first | Focused verification |
|-------|------|-----------|---------------------|
| 1 | <name> | <dependency or risk reason> | `<gate>` |
| 2 | <name> | | `<gate>` |

Close with full `npm run check` (includes `lint:eslint` via the DAG gate).

---

## <N>. <Item Name>

### Problem

What is wrong or missing, and where exactly (`file:line`). Include the measurement or eval finding that establishes this as a real cost, not a code-reading pattern hunt.

### Design

The change. Be concrete about function signatures, data structures, and invariants. State what is byte-identical / output-identical and what changes intentionally.

### Verification

1. Unit test: what cases are covered, what is the oracle.
2. Bench or contract gate: `npm run <gate>` before/after; what delta to report.
3. G5: new test files must be added to `tests/contracts/drift/kernel-test-map.json`.
4. Gates: `<check:narrow>`, then `npm run check`.

---

## Governance Gate Impact

| Gate | Impact |
|------|--------|
| G1 `check:spec-truth` | None / <what changes> |
| G2 `check:surface-liveness` | None / <new exports added to kernel-export-inventory.json> |
| G3 `check:compute-once` | None / <new CALL_SITE_LIMITS entry> |
| G4 `check:purity-vocabulary` | None / <no banned APIs> |
| G5 `check:kernel-test-map` | None / <new test files mapped> |
| G6 `check:env-flags` | None / <new flag registered> |
