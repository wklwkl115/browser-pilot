# Agent Development Handbook

This handbook is the development-harness operating contract for agents changing this package.

## Dev Loop

Start from the active entry in `CURRENT.md`, then run the narrowest gate that proves the edited surface. Close with `npm run check`, whose DAG artifact is `.pi/browser-artifacts/check-dag-summary.json` plus per-run copies under `.pi/browser-artifacts/check-dag/`.

Narrow gates are iteration evidence, not closure evidence. A workstream closes only after `npm run check` exits 0 and the DAG summary artifact has been read.

Capture the gate exit code before piping or post-processing logs. In PowerShell, read `$LASTEXITCODE` immediately after the gate; do not let a later `Select-String`, `Out-Null`, `tee`, or JSON-inspection command replace the check's exit status.

Use `npm run check:smart -- --dry-run --changed-file=<repo/path>` to inspect impact selection. Before renaming exported symbols, local identifiers pinned by contracts, error text, or marker strings, run `npm run query:markers -- --needle <text>` and, when file impact matters, `npm run query:markers -- --file <repo/path>`.

## Writing A Check

Register every new check in `package.json` and `CHECK_GROUPS` in `scripts/check-graph.mjs`, or document why it belongs in `GRAPH_SCRIPT_EXCLUSIONS`. Prefer `npm run new:check -- --name <x> --group <group> --dry-run` before hand-editing the wiring.

Failure messages must name the repair target: the file to edit, ledger field to classify, or command to run. If a node is not parallel-safe, fix the shared state first; otherwise add it to `NON_PARALLEL_NODE_IDS` with the reason.

## Contract Test Conventions

Red-first (`red-first`) is mandatory for every contract: prove the old or intentionally perturbed state fails before accepting the green result. For byte-identity checks, normalize run-incidental fields and prime the fixture into its delta-established state before comparing.

Source-text markers may pin runtime-stable strings such as tool names, error codes, env vars, file paths, doc headings, and user-facing remediation text. They must not pin local identifier names or exact code fragments unless the source site carries a `// contract: tests/contracts/...` breadcrumb explaining the coupling. Prefer importable single-source manifest modules for shared facts.

When a fragile source-text pin is intentionally kept, put the breadcrumb at the pinned source site before committing so a rename agent sees the contract before changing the identifier.

## Ledgers And Ratchets

The core ledgers are `tests/contracts/drift/kernel-export-inventory.json`, `tests/contracts/drift/input-surface-budget.json`, `tests/contracts/drift/kernel-test-map.json`, `tests/contracts/drift/file-ceilings.json`, and `docs/compaction-ledger.json`; token economy also has an explicit `--update` flow. Use each gate's `--propose` mode when available, but commit baseline growth only with an in-diff justification.

## Workstream Plans

For multi-step workstreams (optimization, architecture, major refactor), create a plan doc before writing code:

1. Copy `docs/templates/workstream-plan-template.md` to a named plan file under the docs directory, using the suffix `-plan.md`.
2. Fill in the status header, execution order, per-item Problem/Design/Verification, and governance-gate impact.
3. Add an activation entry to `CURRENT.md` (decision, boundary, path to the plan doc, focused verification gates).

The plan is the single source of truth for the workstream's scope. Single-step tasks (bug fixes, one-file optimizations, doc corrections) skip both the plan file and CURRENT.md — just make the change and close with `npm run check`.

## Closing A Workstream

Record the activation entry before implementation: decision, boundary, contract, verification, and when useful a `Scope:` line. Closing requires full `npm run check`, reading the DAG summary artifact, and explaining any non-empty `scope.outOfScope` in the completion record.

For workstreams that used a plan doc: after `npm run check` exits 0, move the plan to the docs archive with a `.full.md` suffix and add a compressed summary to `ARCHIVE.md`. Remove the activation entry from `CURRENT.md`.

When touching generated doc indexes, generated contract docs, or managed blocks, run `npm run docs:sync`. When touching `skills/pi-browser-tools/SKILL.md`, validate it with `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools`.

When touching maintainer/playbook/reference docs that cite repo paths or package scripts, run `check:doc-paths` to catch stale backticked paths and gate names.

## Multi-Agent Parallel Work

Assume the worktree may contain another agent's changes. Check `git status --short` before edits, avoid broad rewrites, and verify branch/status before commit. Query markers before rename work so another agent's contract pins are visible before the diff is made.

## Change-path Playbooks

Use the generated table first to see the current impact-map gates for each scenario, then run
`npm run check:smart -- --dry-run --changed-file=<repo/path>` for the exact diff. The table is
regenerated by `npm run docs:sync`; the ordering and landmine notes below are hand judgment.

<!-- BEGIN GENERATED: change-path-playbook-gates (npm run docs:sync) -->
| Playbook | Listed files | Impact-map checks |
| --- | --- | --- |
| Envelope/summary field | `src/tools/summaries/outputSchemas.ts`<br>`src/tools/summaries/registerBuiltinDistillers.ts`<br>`src/tools/summaries/`<br>`src/tools/resultMiddleware.ts`<br>`tests/contracts/tools/check-summaries.mjs` | `bench:distill`<br>`check:abml-contracts`<br>`check:abml-core-boundary`<br>`check:bridge`<br>`check:code-map`<br>`check:compaction-ledger`<br>`check:content-pick`<br>`check:distill-core-boundary`<br>`check:distiller-coverage`<br>`check:memory-core-boundary`<br>`check:memory-plane`<br>`check:output-schema-conformance` |
| Native bridge command | `bridge/native_command_schema.json`<br>`scripts/sync-native-protocol.mjs`<br>`tests/contracts/protocol/check-pi-browser-bridge.mjs`<br>`tests/contracts/protocol/check-bridge-build.mjs` | `check:bridge`<br>`check:input-surface`<br>`check:pi-browser-bridge`<br>`check:tool-docs`<br>`check:transfer` |
| Environment flag | `tests/contracts/drift/check-env-flags.mjs`<br>`src/tools/observe/renderCache.ts`<br>`src/frontend/usageLog.ts`<br>`src/driver/BrowserBridgeServer.ts` | `check:abml-contracts`<br>`check:abml-core-boundary`<br>`check:bridge`<br>`check:code-map`<br>`check:compaction-ledger`<br>`check:content-pick`<br>`check:distill-core-boundary`<br>`check:fake-ws`<br>`check:governance`<br>`check:lifecycle`<br>`check:memory-core-boundary`<br>`check:paths` |
| Recovery/error text | `src/tools/resultMiddleware.ts`<br>`src/utils/errors.ts`<br>`tests/contracts/tools/check-errors.mjs`<br>`tests/contracts/drift/check-recovery-boundary.mjs` | `bench:distill`<br>`check:abml-contracts`<br>`check:abml-core-boundary`<br>`check:code-map`<br>`check:compaction-ledger`<br>`check:content-pick`<br>`check:distill-core-boundary`<br>`check:errors`<br>`check:fake-ws`<br>`check:lifecycle`<br>`check:memory-core-boundary`<br>`check:memory-plane` |
| Kernel export rename | `src/abml-core/`<br>`src/abml/`<br>`src/abml-core/index.ts`<br>`tests/contracts/drift/kernel-export-inventory.json`<br>`tests/contracts/drift/check-surface-liveness.mjs` | `check:abml-contracts`<br>`check:abml-core-boundary`<br>`check:code-map`<br>`check:compaction-ledger`<br>`check:distill-core-boundary`<br>`check:governance`<br>`check:memory-core-boundary`<br>`check:recovery-boundary` |
| New tool | `src/tools/toolRegistry.ts`<br>`src/tools/registerTools.ts`<br>`src/tools/registerNativeActionTools.ts`<br>`src/tools/toolAdapter.ts`<br>`docs/generated/browser-tool-contract.generated.md` | `check:abml-core-boundary`<br>`check:bridge`<br>`check:code-map`<br>`check:compaction-ledger`<br>`check:content-pick`<br>`check:distill-core-boundary`<br>`check:input-surface`<br>`check:memory-core-boundary`<br>`check:pi-browser-bridge`<br>`check:recovery-boundary`<br>`check:session-delta-long-conversation`<br>`check:task-conditioned-salience` |
<!-- END GENERATED: change-path-playbook-gates -->

### Envelope/summary field

Start with `src/tools/summaries/outputSchemas.ts`, the producing summary module under
`src/tools/summaries/`, and the envelope wrapper in `src/tools/resultMiddleware.ts`. The common
landmine is `tests/contracts/tools/check-summaries.mjs`: it pins scan field keys plus the
sha256/length budget golden. Update the schema, producer, result envelope, and the contract in one
pass; use `npm run query:markers -- --needle <fieldName>` before renames.

### Native bridge command

The source of truth is `bridge/native_command_schema.json`; do not patch generated protocol files by
hand. Run `npm run sync:protocol`, then verify `check:protocol`, `check:pi-browser-bridge`,
`check:bridge:files`, and `verify:bridge:dist`. New service-worker modules must also satisfy the
ordered file/module assumptions in `tests/contracts/protocol/check-pi-browser-bridge.mjs` and
`tests/contracts/protocol/check-bridge-build.mjs`.

### Environment flag

Add the source read first, then register the flag in the env registry guarded by
`tests/contracts/drift/check-env-flags.mjs`, and document only stable operator-facing flags. Keep
kill switches explicit and cheap; if a flag changes an envelope field, also follow the
Envelope/summary field playbook.

### Recovery/error text

Recovery wording is a contract. Search with `npm run query:markers -- --needle <codeOrPhrase>`,
then update producer code and `tests/contracts/tools/check-errors.mjs` together. If the text is
also part of high-level recovery routing, check `tests/contracts/drift/check-recovery-boundary.mjs`
before renaming codes or categories.

### Kernel export rename

Rename in `src/abml-core/`, then update `src/abml-core/index.ts`, the matching `src/abml/` shim,
and `tests/contracts/drift/kernel-export-inventory.json`. Run `check:abml-core-boundary`,
`check:surface-liveness`, and the narrow ABML behavior gate named by
`npm run query:markers -- --file <repo/path>`.

### New tool

Add the registrar and group metadata through `src/tools/toolRegistry.ts`; keep
`src/tools/registerTools.ts` as composition only. Implement schema and execution in the registrar
module, reuse `src/tools/toolAdapter.ts`, and make summary/artifact output go through
`src/tools/resultMiddleware.ts`. Then run `npm run docs:sync` so README and
`docs/generated/browser-tool-contract.generated.md` refresh from live registration metadata.
