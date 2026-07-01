# Tasks

- [x] Task 1: 盘点现有 observe provider diagnostics 与 budget 字段
  - [x] SubTask 1.1: 梳理 scan / DOM accessibility / role provider / full AX / partial AX / axe / Readability 的 status、timing、count、budget、fallback 字段。
  - [x] SubTask 1.2: 梳理 PageObservation diagnostics、artifact hints、saved artifact 与 CLI envelope 中已有输出路径。
  - [x] SubTask 1.3: 选择最小统一 telemetry 形态，保持兼容并避免破坏现有 provider-specific diagnostics。
  - [x] SubTask 1.4: 记录字段映射、缺口、预算策略和风险。

  Inventory notes:
  - Output paths already available: canonical `summary.pageObservation.diagnostics`, result `details.diagnostics`, saved observe artifact `pageObservation.diagnostics`, saved provider artifacts `axe` / `readability`, artifact hints for `pageObservation`, `data`, `pageObservation.content`, `pageObservation.text`, and optional `readability`.
  - `diagnostics.providers` currently records structure/content/text/html/evidence/tabs and optional ax/axe/readability as provider statuses. It does not include partial AX in canonical page-wide providers.
  - Scan output exposes `data.truncated`, `data.node_count`, `actionables` counts via `focus.actionablesTruncation`, `diagnostics.actionablesTruncated`, `diagnostics.actionablesScanned`, `diagnostics.actionablesReturned`, and timing via `diagnostics.observeTimings.pageScriptMs` / `nodeCount`.
  - DOM accessibility and role providers are embedded in the scan script. Current observable metadata is indirect: bounded accessible-name calls (`ACCESSIBLE_NAME_LIMIT = 240`) and role/name enrichment appear on scan actionables, but no provider-specific status/count/fallback is emitted.
  - Full AX output is surfaced through `abmlRead.data.axDiagnostics`, `diagnostics.observeTimings.axMs` / `axNodeCount` / `axCdpCalls` / `axGeometryCdpCalls` / `axCacheHit`, `diagnostics.axFusion`, and provider `ax`. Budgets include `bounded.maxGeometryCdpCalls` and `bounded.geometryFallbackTruncated`.
  - Partial AX output is surfaced only in local read/pierce/runtime data as `partialAx` diagnostics with provider/status/backendNodeId/fetchRelatives/timeoutMs/maxNodes/cdpCalls/nodeCount/elapsedMs/reason/error. It is intentionally absent from canonical page-wide provider statuses.
  - axe output is explicit-only and surfaces through `diagnostics.axe`, `diagnostics.providers.axe`, provider failures, saved artifact `axe`, and bounded metadata `bounded.maxInlineResults`. Counts include violations/incomplete/passes/inapplicable plus impact/rule counts; failure/fallback is captured via `timedOut`, `degraded`, and `error`.
  - Readability output is explicit-only and surfaces through `diagnostics.readability`, `diagnostics.providers.readability`, provider failures, saved artifact `readability`, and `Readability article` artifact hint. Budgets include timeout, `maxInlineChars`, `maxContentChars`, `maxElemsToParse`; truncation currently degrades summary status but saved bounded metadata only records `maxInlineChars`.
  - Existing gaps for Task 2: no compact cross-provider summary; scan DOM-accessibility/role provider lacks explicit status/timing/counts; full AX has rich diagnostics but no normalized provider row; partial AX uses `ok` rather than `executed`; Readability normalized summary should expose truncation/budget reason without copying article content; axe/readability skipped defaults are available from runners but omitted from canonical diagnostics unless requested.
  - Minimum telemetry shape selected for Task 2: add a bounded diagnostics-only array or object derived at observe projection/runtime layer, e.g. provider name, normalized status (`executed`/`scan-backed`/`skipped`/`failed`/`degraded`), optional `requested`, `durationMs`, compact counts, compact budget fields, `truncated`/`degraded`, `reason`/`errorCode`, and optional artifact reference. Preserve all provider-specific diagnostics and do not alter actionables, refs, entities, relations, collections, content plane, public command surface, or `src/kernels/*`.

- [x] Task 2: 实现 compact provider budget telemetry summary
  - [x] SubTask 2.1: 在 observe diagnostics/projection 层新增或派生 compact telemetry summary，不进入 `src/kernels/*`。
  - [x] SubTask 2.2: 汇总 executed/skipped/failed/degraded provider 状态、duration/timing、counts、budgets、truncated/degraded markers 和 fallback reason。
  - [x] SubTask 2.3: 保持 inline output bounded，不复制 axe/readability/full AX 大型原始结果。
  - [x] SubTask 2.4: 保留现有 provider-specific diagnostics 和 artifact links，不改 public command surface。

- [x] Task 3: 保护 diagnostics-only 边界
  - [x] SubTask 3.1: 确认 telemetry 不改变 actionables、refs、entities、relations、collections 或 content plane 输出。
  - [x] SubTask 3.2: 确认 skipped/failed/degraded 不会被误报为 executed。
  - [x] SubTask 3.3: 确认默认 no-mode observe 输出仍稳定，explicit axe/readability provider 仅在请求时进入 telemetry。

- [x] Task 4: 增加测试与 benchmark 覆盖
  - [x] SubTask 4.1: 增加 focused tests，覆盖 executed/skipped/failed/degraded provider telemetry。
  - [x] SubTask 4.2: 增加 focused tests，覆盖 budget/truncation/fallback reason 和 inline bounding。
  - [x] SubTask 4.3: 更新 observe regression benchmark 或 fixture，保护 telemetry shape 且不依赖 live browser-only provider。
  - [x] SubTask 4.4: 增加或强化边界测试，确认 telemetry 不造成 structural output drift。

- [x] Task 5: 同步文档和长期优化记录
  - [x] SubTask 5.1: 更新 `CODE_WIKI.md`，说明 provider budget telemetry summary、字段含义、diagnostics-only boundary 和 artifact 关系。
  - [x] SubTask 5.2: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P1-P5 的 budget/latency 后续关注沉淀为统一 telemetry guardrail。
  - [x] SubTask 5.3: 如新增稳定 JSON path，更新相关 owner 文档或测试说明。

- [x] Task 6: 运行验证门禁
  - [x] SubTask 6.1: 运行新增/相关 focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 2-3。
- Task 5 depends on Task 1-4 的实际结论。
- Task 6 depends on Task 1-5。

- [x] Task 7: 修复 `mise run affected` 门禁失败
  - [x] SubTask 7.1: 调查 `BrowserBridgeServer advances to the next configured port when the requested port is busy` 在 `mise run affected` 中失败但 `mise run verify` 通过的原因。
  - [x] SubTask 7.2: 修复或稳定该端口占用场景测试，确保 `mise run affected` 可重复通过。
  - [x] SubTask 7.3: 重新运行 `mise run affected` 并在通过后勾选 checklist 对应检查点。

  Validation note:
  - 2026-07-01: focused tests 通过；`mise run verify` 通过；`mise run affected` 失败，失败点为 `BrowserBridgeServer advances to the next configured port when the requested port is busy`，其余可见测试通过。
  - 2026-07-01: 重新运行端口推进 focused test：`node --import tsx --test tests/bootstrap/bridgeServerPorts.test.ts` 通过。随后重新运行 `mise run affected` 通过；当前源码无需额外端口逻辑修改，先前失败按一次性环境/端口占用竞争处理。
