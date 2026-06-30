# Tasks

- [x] Task 1: 调研现有 AX runtime 与 observe 融合入口
  - [x] SubTask 1.1: 阅读 `CODE_WIKI.md` 中 ABML、Runtime、Capture、依赖边界相关章节。
  - [x] SubTask 1.2: 梳理 `readAxEntities()`、`mergeAxIntoDomEntities()`、`createBrowserAbmlIntegration()`、`runScanObservation()` 的当前调用链。
  - [x] SubTask 1.3: 确认现有 scan 数据中可用于 fusion 的字段：ref、selector、backendNodeId、rect、actionability、list hints、entity refs。
  - [x] SubTask 1.4: 记录最小融合策略和不做范围：不新增专用 public command、不做业务数据抽取、不引入站点 hardcode。

  Findings:
  - `CODE_WIKI.md` 当前定义 ABML 为 `browser_observe` canonical 页面模型，Runtime 可做 CDP/scan I/O 并把结果输入 kernel，`src/kernels/*` 仍必须保持纯逻辑，Capture template 只负责页面世界采集。
  - `runScanObservation()` 是 observe 入口：执行 scan script，随后通过 `createBrowserAbmlIntegration()` 调用 `readStructure()`；在可复用 scan 数据时以 `prefetchedScan` 传入 ABML runtime，并用页面 fingerprint 形成 `axCacheKey`。
  - `createBrowserAbmlIntegration()` 只是 command runtime 到 browser ABML runtime 的薄集成层：创建 `createBrowserAbmlRuntime()`，`readStructure()` 转发到 runtime `read({ plane: "structure" })`，并在有 baseline 时补 native diff。
  - `readAxEntities()` 在 browser runtime 中读取 `Accessibility.getFullAXTree`，用 `DOMSnapshot.captureSnapshot` 获取 backendNodeId 几何与 paint order，必要时 fallback 到 `DOM.getBoxModel`；返回 AX entities、relation anchors、snapshot geometry/paint order entries 与 diagnostics。
  - `createBrowserAbmlRuntime().read()` 当前先取得 scan 数据和 observation snapshot，再调用 `readAxEntities()`；之后用 `bootstrapScanBackendNodeIds()` 给 scan 数据补 `backendNodeId`，再 `registerScanEntityRefs()`、`summarizeScanData()`、`scanEntitiesForEnvelope()`，最后通过 `mergeAxIntoDomEntities()` 合并 AX/DOM entity，并继续生成 relations、collections、diagnostics 等 ABML 输出。
  - `mergeAxIntoDomEntities()` 只是 runtime 包装；真正纯逻辑合并在 kernel 的 `mergeDomAndAxEntities()`：Pass 0 按 backendNodeId 精确匹配，Pass 1 按 box IoU/point 等 geometry-backed 匹配，Pass 2 仅在无歧义时允许 role/name geometry-less 匹配；未匹配 AX entity 会单独注册 ref 后追加，避免错误覆盖 DOM sibling。
  - 现有 scan fusion 可用字段包括：`actionables[].selector`、`rect`、`point`、`hitOk`/`disabled`/`focused`/`checked`/`current`/`editable` 等 actionability/state 字段，`backendNodeId`/`backendNodeIdBootstrap`，`list_hints[].selector`/`containerLabel`/`firstItemPreview`/`hiddenCount`，`references`、`controls_pairs`，以及 `registerScanEntityRefs()` 写入的 `ref`/`refSlot`。
  - 最小策略应延续现有边界：DOM scan 的 selector/ref/actionability/evidence 作为执行权威；AX 仅做 bounded semantic/state/structure enrichment 与关系补充；匹配优先 backendNodeId，其次保守 geometry，歧义则 skip/degrade 或 append AX-only，不污染 DOM ref。
  - 不做范围：不新增专用 public command，继续走 `browser_observe`/ABML canonical 输出；不做业务数据抽取；不引入站点 hardcode；不让 kernel 引入 CDP/browser/bridge/page DOM 依赖。

- [x] Task 2: 设计并实现 bounded fusion 模型
  - [x] SubTask 2.1: 定义 DOM scan entity 与 AX entity 的匹配优先级：backendNodeId/ref descriptor 优先，geometry overlap 作为保守 fallback。
  - [x] SubTask 2.2: 实现 AX role/name/description/states 到现有 ABML-compatible entity 字段的安全映射。
  - [x] SubTask 2.3: 保留 DOM scan 的 selector/ref/actionability/evidence 权威，不让 AX enrichment 覆盖执行所需 ref。
  - [x] SubTask 2.4: 对 ambiguous match、missing geometry、provider partial failure 返回 skipped/degraded diagnostics。

- [x] Task 3: 接入 browser_observe canonical 输出
  - [x] SubTask 3.1: 在 observe scan/ABML 读取路径中使用 fusion 结果，确保 no-mode PageObservation 能呈现 AX-enriched entities。
  - [x] SubTask 3.2: 在 provider diagnostics 中区分 scan-backed、ax-enriched、ax-only、degraded、skipped。
  - [x] SubTask 3.3: 确保 artifact 与 summary 输出不破坏既有 schema，新增字段保持 bounded。
  - [x] SubTask 3.4: 确保 render cache / axCacheKey 行为不会复用过期 AX tree。

- [x] Task 4: 保留语义安全与架构边界
  - [x] SubTask 4.1: 复用或等价应用现有 semantic sanitizer，阻止 SVG/path、HTML-like、selector-like、long item/card preview、editable value 进入 semantic names。
  - [x] SubTask 4.2: 保持 `src/kernels/*` 纯逻辑，不引入 CDP/browser/bridge/page DOM 依赖。
  - [x] SubTask 4.3: 限制 AX fusion 的 CDP 调用次数与 fallback geometry 调用上限。
  - [x] SubTask 4.4: 确保 CDP/AX 失败时 observe 降级为当前 scan-only 行为。

- [x] Task 5: 增加测试与 regression benchmark 覆盖
  - [x] SubTask 5.1: 增加纯逻辑 fusion tests，覆盖 backendNodeId match、safe enrichment、ambiguous match skip。
  - [x] SubTask 5.2: 增加 AX states tests，覆盖 expanded/selected/checked/disabled/level/posinset/setsize 等状态映射中的代表项。
  - [x] SubTask 5.3: 增加 provider failure/degraded diagnostics tests。
  - [x] SubTask 5.4: 更新 observe regression benchmark，加入 AX fusion fixture 或 diagnostics expectation。

  Findings:
  - `tests/bootstrap/kernelRuntimeHelpers.test.ts` 的 AX helper 覆盖已扩展到 backendNodeId 成功融合、DOM locator/ref 保权、stateSource 标记、scanBacked/axEnriched/axOnly/degraded/skipped diagnostics，以及 ambiguous backend/geometry/semantic skip 和 unsafe semantic degraded。
  - AX state/structure 代表项覆盖包括 checked、disabled、focused、expanded、selected、current、level、posinset、setsize、sort，确保 AX enrichment 只写入 bounded ABML state/structure 字段。
  - `tests/memory/observeRegressionBenchmark.test.ts` 已增加 degraded AX fusion fixture，并断言 provider `ax=degraded`、`axFusion.degraded=true`、`axOnly` 与 `skipped.ambiguousSemantic` 计数，确保 canonical PageObservation diagnostics 不丢失 degraded 原因。
  - Focused validation passed: `node --test --import tsx tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts`（18 tests pass）和 `npm run typecheck` 均通过。

- [x] Task 6: 构建、实测与性能检查
  - [x] SubTask 6.1: 运行 focused tests，确认新增 AX fusion 测试通过。
  - [x] SubTask 6.2: 运行 `npm run build:bridge`，确认扩展构建仍通过。
  - [x] SubTask 6.3: 在 Edge 当前页面运行 no-mode observe，确认扩展连接、AX provider、scan provider 与 artifact 输出正常。
  - [x] SubTask 6.4: 检查 artifact：AX diagnostics 存在、无 `<path`/`<svg` 污染、collection names/actionables 未明显退化。
  - [x] SubTask 6.5: 记录 CDP call count、AX node count、fusion count、timing 等诊断指标是否在可接受范围。

  Findings:
  - Focused validation passed: `node --test --import tsx tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts`（18 tests pass）。
  - Bridge build passed: `npm run build:bridge`，buildId `6a7106bad795433ed9cc6acda7add6004cb3804bd5364e02772b51bb7c4e12ae`，输出 `bridge/browser_pilot_bridge/dist/*`。
  - Edge no-mode observe passed after restarting the stale daemon so it loaded the current source: `npm --silent run cli -- connect --wait --json` reported extension connected and build matched; `npm --silent run cli -- observe --json --target-ref tabh_3c8177956af247fb8a1a0311_b798f0c5042d4d72_g1` produced canonical PageObservation artifact `D:/browser-pilot/.browser-pilot/artifacts/observe-scan-1782749949401.json` for `https://linux.do/latest`.
  - Artifact diagnostics showed scan providers healthy and AX provider degraded by bounded ambiguity/unsafe skips, not failed: `providers.ax=degraded`, `axFusion.scanBacked=94`, `axFusion.axEnriched=1`, `axFusion.axOnly=1607`, `skipped.ambiguousSemantic=5`, `skipped.unsafeSemantic=10`。
  - AX runtime diagnostics were present and bounded: `axDiagnostics.nodeCount=3090`, `interestingNodeCount=1618`, `cdpCalls=61`, `geometryCdpCalls=59`, `bounded.maxGeometryCdpCalls=64`, `geometryFallbackTruncated=false`, `axMs=710`；observe timings included `abmlMs=788`, `pageScriptMs=3128`, `renderMs=44`, `transportMs=3920`。
  - Artifact pollution check passed: raw artifact search found no `<path` or `<svg` substrings in persisted semantic output; actionables still retained DOM selector/ref authority in `data.actionables`, and collection names remained bounded/disambiguated rather than SVG/path-derived.

- [x] Task 7: 文档与长期优化记录同步
  - [x] SubTask 7.1: 更新 `CODE_WIKI.md` 中 Runtime、Capture/ABML 或依赖边界说明。
  - [x] SubTask 7.2: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P2 标记为已进入实现/试点并记录后续关注项。
  - [x] SubTask 7.3: 不新增重复架构文档，遵守现有 owner 文档规则。

  Findings:
  - `CODE_WIKI.md` 已补充 ABML structure 读取路径中的 DOM scan + CDP AX tree/DOMSnapshot fusion 边界，明确 runtime 承担 browser I/O、bounded CDP fallback、diagnostics 与 ref/resource 注册，纯合并策略仍归 ABML kernel。
  - `CODE_WIKI.md` 已明确 DOM scan 的 selector/ref/actionability/evidence 是执行权威，AX 仅做 role/name/description/state/structure enrichment 或追加 AX-only entity；backendNodeId 优先、保守 geometry 其次、无歧义 semantic fallback 最后，歧义/缺失几何/unsafe semantic name 进入 skipped/degraded diagnostics。
  - `.trae/notes/abml-observe-long-term-optimization.md` 的 P2 已标记为已进入实现/试点，并记录 runtime/kernel 接入点、diagnostics 覆盖、focused tests/regression benchmark 覆盖，以及后续关注项：大页面 latency、AX-only 输出预算、ambiguous skip 比例、`getPartialAXTree` 局部优化和 semantic pollution 防回归。
  - 未新增重复架构文档；本次只更新现有 owner 文档与当前 spec 的 `tasks.md`。

- [x] Task 8: 运行验证门禁
  - [x] SubTask 8.1: 运行新增 AX fusion focused tests。
  - [x] SubTask 8.2: 运行 `mise run affected`。
  - [x] SubTask 8.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 8.4: 修复验证中发现的失败，直到相关检查通过。

  Findings:
  - AX fusion focused tests passed: `node --test --import tsx tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts`（18 tests pass）。
  - First `mise run affected` exposed a scoped-lint configuration failure: memory scope passed `tests/memory`, but the flat ESLint config globally ignores `tests/**`, so ESLint 10 treated that target as an all-ignored error.
  - Fixed affected-gate failure by keeping memory scoped lint on lintable source directories only: `src/commands/observe`、`src/commands/memory`、`src/kernels/abml`、`src/kernels/memory`；memory tests remain covered by `scripts/run-tests.mjs memory` rather than ESLint.
  - `mise run affected` passed after the fix（243 tests pass）。
  - `mise run verify` passed, including reachability audit、main typecheck、extension typecheck、protocol drift check、all tests（243 tests pass）、full ESLint and build。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 2-3。
- Task 5 depends on Task 2-4。
- Task 6 depends on Task 3-5。
- Task 7 depends on Task 1-6 的实际变更。
- Task 8 depends on Task 1-7。
