# Workstreams A-E Summary

This file records the current completion boundary for the browser tools interface-governance workstream sequence.

## Scope

A-E improved tool-selection governance, result diagnostics, Web Security internal composition, register schema maintainability, and ACI eval readiness. The sequence did not add callable tools and did not restore removed orchestration or DOM action tools.

## A. Tool Boundary & Semantic Singleton Audit

Delivered:

- `docs/tool-boundaries.md` with one row per callable browser tool.
- README and global `pi-browser-tools` skill wording aligned to the boundary model.
- Contract checks for tool docs, removed tool absence, and boundary coverage.

Boundary:

- Removed tools remain absent: `browser_query`, `browser_click`, `browser_type`, `browser_dom_snapshot`, `browser_dom_click`, `browser_dom_type`, `browser_orchestrate`.
- Tool descriptions define selection boundaries; they do not add orchestration behavior.

## B. Unified Output & Diagnostics Envelope

Delivered:

- Additive result envelope fields: `diagnostics`, `target`, `limits`, `privacy`, `nextActions`.
- Normalization and sanitization helpers in `src/tools/resultMiddleware.ts`.
- Summary/token/tool contract coverage for the additive envelope.

Boundary:

- Existing `tool`, `command`, `browserSessionId`, `detailLevel`, `summary`, `saved`, and artifact paths remain compatible.
- Model-facing output remains redacted by default.

## C. Web Security Internal Primitive Refactor

Delivered:

- `src/tools/webSecurity/shared/requestTemplate.ts` for raw/captured request parsing and replay request building.
- `src/tools/webSecurity/shared/har.ts` for HAR candidate selection and safe filtering.
- `src/tools/webSecurity/shared/baseline.ts` for baseline, response delta, and classifier helpers.
- `src/tools/webSecurity/browserNative/crawlExtractors.ts` for passive crawl extraction helpers.
- `src/tools/webSecurity/browserNative/oastWorkerManager.ts` for OAST worker lifecycle and persisted state helpers.
- Compatibility re-exports in `src/tools/webSecurity/shared/replay.ts`.

Boundary:

- The 12 Web Security callable tools kept their names, schema meanings, output shape, and artifact behavior.
- Extraction stayed internal; no new Web Security workflow tool was added.

## D. Schema Builder Consolidation

Delivered builders:

- `browserCookieBindingParams(...)`
- `harReplayParams(...)`
- `rawRequestParams(...)`
- `requestSequenceParams(...)`
- `boundedExecutionParams(...)`
- `redirectControlParams(...)`
- `rateLimitPerSecondParam(...)`
- `maxCasesParam(...)`
- `maxCandidatesParam(...)`
- `maxDepthParam(...)`
- `maxPagesParam(...)`
- `maxTemplatesParam(...)`

Updated:

- Web Security register files using the safe builders.
- `scripts/generate-tool-docs.mjs` and generated tool docs.
- Tool contract checks for hidden builder fields.

Final decisions:

- Do not implement `targetScopeParams()` for the current tools because target fields encode different seed/base/FUZZ/replay/template semantics.
- Do not implement `artifactResultParams()` because existing shared params already cover result/artifact fields.

## E. Realistic ACI Eval Set

Delivered:

- `evals/browser-workflows/README.md`
- `evals/browser-workflows/eval-plan.md`
- `evals/browser-workflows/spec-template.md`
- 10 independent eval specs.
- Synthetic local fixtures under `evals/browser-workflows/fixtures/`.
- `manifest.json` for suite metadata.
- `manual-result-template.json` and `result-schema.json` for compact manual result records.
- `results/README.md` for optional hand-run result storage rules.
- `future-runner.md` to freeze opt-in runner/server boundaries before implementation; the opt-in runner landed later and keeps those boundaries.
- `tests/contracts/tools/check-eval-workflows.mjs` and `check:eval-workflows` in `npm run check`.
- Package file coverage for `evals/`.

Boundary:

- The spec suite is static and check-locked; an opt-in runner (`npm run eval:browser-workflows -- --fixture-server`) landed later (2026-06-04) with a local-only ephemeral fixture server bound to `127.0.0.1`.
- Neither the static suite nor the default runner starts a browser, accesses external networks, or runs sqlmap/nuclei/OAST.
- The runner stays explicitly opt-in and separately scoped; scanner/OAST/external-network execution is never run by default.

## Verification

Current required verification:

- `npm run check:tool-docs`
- `npm run check:tools`
- `npm run check:boundaries`
- `npm run check:web-security`
- `npm run check:summaries`
- `npm run check:token`
- `npm run check:package`
- `npm run check:eval-workflows`
- `npm run check`

Latest full validation passed. The esbuild direct-eval warning from `bridge_src/service_worker/exec.ts` is pre-existing and not introduced by A-E.

## Next phase

No mandatory A-E work remains. Future work should start from `ROADMAP.md` and update `CURRENT.md` before implementing new behavior.

Current post-A-E follow-up now includes cross-tool evidence correlation metadata hardening: distilled envelopes expose `operationId` / `snapshotId` / `requestId` / `waitId` / `listenerId` / `selectionVersion*` / `sourceMode`, `browser_artifact` surfaces correlation hints plus `correlationPaths`, browser workflow evals now include `21-cross-tool-correlation-chain.md` plus a sample result record, and runtime smoke now includes `smoke:browser:correlation-chain` to keep the chain bounded and evidence-first without reintroducing orchestration.
