# Browser Pilot Architecture Hardening Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the six-stage Browser Pilot architecture hardening design as independently verifiable software increments.

**Architecture:** Execute the six implementation plans below in order. Each stage preserves public contracts, lands its own tests and documentation, and leaves the repository in a state that passes `mise run affected`; the final stage owns the cross-program completion audit.

**Tech Stack:** Node.js 22, TypeScript 6, ESM, Node test runner, Chrome/Edge Manifest V3, WebSocket, mise, GitHub Actions.

---

## Ordered Plans

1. `2026-07-10-real-browser-smoke.md`
2. `2026-07-10-truthful-coverage.md`
3. `2026-07-10-import-graph-boundaries.md`
4. `2026-07-10-commands-subdomains.md`
5. `2026-07-10-security-behavior-contracts.md`
6. `2026-07-10-hotspot-integration-hardening.md`

## Program Invariants

- Preserve the current 21-tool public `browser_*` catalog and registrar order.
- Preserve all schema-derived native command names and generated-file ownership.
- Never edit `dist/` or `bridge/browser_pilot_bridge/` by hand.
- Preserve pre-existing user modifications and stage only files owned by the active task.
- Start every production behavior or refactor with a focused failing test.
- Run `mise run affected` after each plan and `mise run verify` after the final plan.
- Update canonical owner documentation in the stage that changes the behavior or rule.

## Final Audit

- [ ] Run `mise run verify` and require exit code 0.
- [ ] Run `mise run coverage` and require every measured domain to meet its checked-in ratchet.
- [ ] Run `mise run browser-smoke -- --browser chrome` and require the structured report to pass.
- [ ] Run `mise run browser-smoke -- --browser edge` and require the structured report to pass.
- [ ] Run `node scripts/check-markdown-links.mjs CODE_WIKI.md SECURITY.md src/kernels/abml/README.md` and require exit code 0.
- [ ] Run `node scripts/sync-native-protocol.mjs --check` and require exit code 0.
- [ ] Run `git diff --check` and require no output.
- [ ] Compare `git status --short` with the recorded pre-implementation state and confirm no unrelated user file was removed or reverted.
