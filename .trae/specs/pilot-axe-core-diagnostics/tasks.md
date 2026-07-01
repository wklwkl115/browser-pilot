# Tasks

- [x] Task 1: 调研 axe-core 依赖与最小 diagnostics 方案
  - [x] SubTask 1.1: 检查 `axe-core` package 入口、license、browser/MV3 compatibility、bundle size 与运行 API。
  - [x] SubTask 1.2: 梳理现有 observe diagnostics、artifact、provider status、doctor/debug command 入口，确定最小接入点。
  - [x] SubTask 1.3: 选择触发方式：显式 diagnostics/debug option、现有 doctor/observe diagnostics path、或新增最小内部 runner；默认 no-mode observe 不完整运行 axe。
  - [x] SubTask 1.4: 记录方案、预算、风险与是否新增依赖。

  Task1 调研结论：当前 `package.json`/lockfile 未引入 `axe-core`；`npm view axe-core@4.12.1` 显示入口为 `axe.js`、license 为 MPL-2.0、无运行时 dependencies、Node engine `>=4`，`npm pack --dry-run` 显示 tarball 约 607 KB、unpacked 约 3.0 MB、`axe.min.js` 约 573 KB、`axe.js` 约 1.29 MB。包形态是浏览器可执行脚本，运行 API 以页面上下文 `axe.run(context?, options?)` 为核心，适合通过现有 CDP `Runtime.evaluate`/page-script 线路注入到目标页；MV3 边界上不应作为 extension service worker 常驻 bundle 默认加载。现有接入点中，canonical `browser_observe` 的 diagnostics/provider status/artifact 汇总集中在 `src/commands/observe/scanRunner.ts` 与 `src/commands/observe/scanProjection.ts`，统一 artifact/redaction/envelope 由 `src/commands/resultMiddleware.ts` 和 `src/artifacts/artifactFiles.ts` 处理；CLI `doctor` 位于 `src/apps/cli/cliLocalCommands.ts`，只报告 daemon/extension/artifactRoot/recovery，不掌握页面 DOM，适合作为后续健康提示而非首个 axe 执行入口。最小方案：Task2+ 优先新增 `axe-core` 依赖，并新增 browser-compatible bounded internal runner（建议在 `src/commands/observe/axeDiagnosticsRunner.ts` 或相邻 observe diagnostics helper，而非 `src/kernels/*`、command catalog、bridge protocol），仅在显式 observe diagnostics/debug option 请求时运行；默认 no-mode `browser_observe` 保持现状且不完整运行 axe。预算建议：加载脚本与 `axe.run` 使用独立小超时（例如 3-5s，可受 `timeoutMs` 上限约束）、限制 inline sample 数/字段、完整结果只进 artifact；失败/超时/provider unavailable fail-closed，输出 `accessibility`/`axe` provider 状态为 skipped/failed/degraded/executed 并保留正常 observe。风险：MPL-2.0 合规与发布包体积增加、页面注入 CSP/隔离世界差异、跨 frame/跨域覆盖不完整、运行延迟、axe node/html/snippet 可能包含敏感 DOM，后续实现必须做 bounded summary 与 redaction。

- [x] Task 2: 实现 bounded axe diagnostics runner
  - [x] SubTask 2.1: 若选择新增依赖，更新 `package.json` 与 lockfile，并确认不手改 `dist/` 或 `bridge/browser_pilot_bridge/` generated outputs。
  - [x] SubTask 2.2: 在 browser-compatible diagnostics 路径中加载/运行 axe，支持超时、最大结果数和 fail-closed fallback。
  - [x] SubTask 2.3: 将结果规范化为 bounded summary：issue counts、impact/rule counts、safe sample issues、artifact path。
  - [x] SubTask 2.4: 确保 axe runner 不在 `src/kernels/*`、command catalog 或 bridge protocol 中引入不必要依赖。

- [x] Task 3: 接入 diagnostics/artifact 输出边界
  - [x] SubTask 3.1: 将 axe 结果写入本地 artifact，遵循现有 artifact privacy/redaction/readCommands 约定。
  - [x] SubTask 3.2: 在 PageObservation diagnostics 或选定 diagnostics command 输出中表达 axe provider 状态：executed、skipped、failed 或 degraded。
  - [x] SubTask 3.3: 当 axe 未请求时，不暗示 axe 已执行；当失败或超预算时，核心 observe/doctor 输出仍可返回。
  - [x] SubTask 3.4: 避免将 axe node/html/snippet 大段原文或敏感值放入 inline summary。

- [x] Task 4: 保护 diagnostics-only 边界
  - [x] SubTask 4.1: 确认 axe 结果不会创建、删除或重排 actionables、refs、entities、relations、collections。
  - [x] SubTask 4.2: 确认 Browser Pilot actionability、hit-test、editable、visibility、AX/DOM fusion 仍为结构和执行权威。
  - [x] SubTask 4.3: 增加测试覆盖 axe issue 不影响 canonical PageObservation structural model。

- [x] Task 5: 增加测试与 benchmark 覆盖
  - [x] SubTask 5.1: 增加 runner success/failure/timeout 或 provider unavailable focused tests。
  - [x] SubTask 5.2: 增加 summary bounding、impact/rule counts、artifact shape 与 redaction 测试。
  - [x] SubTask 5.3: 增加 provider diagnostics honesty 测试：未请求、已执行、失败/降级状态。
  - [x] SubTask 5.4: 如影响 observe regression benchmark，增加 accessibility diagnostics case；否则记录不纳入默认 benchmark 的原因。

  Task5 记录：focused 覆盖集中在 `tests/memory/observeScanRunner.test.ts`，已覆盖默认 canonical observe 不运行/不暗示 axe、显式 axe success、timeout degraded、provider unavailable failed、incomplete degraded；success case 验证 inline summary bounding、impact/rule counts、artifact `axe.bounded` shape、inline sample 不含 html/snippet 与敏感 token redaction，并确认 axe diagnostics 不改变 canonical structural model。`tests/memory/observeRegressionBenchmark.test.ts` 继续作为离线确定性 structural regression benchmark；axe diagnostics 依赖页面运行时/CDP 注入与 artifact envelope，且默认 no-mode observe 不运行 axe，因此不纳入默认 benchmark case，避免 benchmark 引入真实浏览器/extension/runtime 依赖。

- [x] Task 6: 构建、实测与文档同步
  - [x] SubTask 6.1: 运行 extension/diagnostics 相关构建检查，确认 MV3 bundle 可用且体积变化可接受。
  - [x] SubTask 6.2: 在 Edge 当前页面或测试页运行 bounded axe diagnostics，确认 artifact 和 provider diagnostics 正常。
  - [x] SubTask 6.3: 确认 no-mode `browser_observe` 默认路径不完整运行 axe，且 canonical PageObservation 未明显退化。
  - [x] SubTask 6.4: 更新 `CODE_WIKI.md` 中 accessibility diagnostics、provider status、dependency/runtime boundary 说明。
  - [x] SubTask 6.5: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P4 记录为调研/试点状态并写明后续关注项。

  Task6 记录：构建检查已通过 `mise run dev`（250 tests pass）、`npm run build` 与 `npm run build:bridge`；bridge buildId 为 `6a7106bad795433ed9cc6acda7add6004cb3804bd5364e02772b51bb7c4e12ae`，MV3 bundle 主要入口体积为 service-worker 434409 bytes（424.2 KiB）、content 5881 bytes、offscreen 5912 bytes、hook_dispatcher 56810 bytes、disable_dialogs 1602 bytes。Edge 149 live 测试页为 `https://example.com/`，tabHandle `tabh_54644d8fc0264b64a0368d22_3c578ea695454682_g1`；显式 `browser-pilot observe --axe --json` 生成 artifact `D:\browser-pilot\.browser-pilot\artifacts\observe-scan-1782821401618.json`，`pageObservation.diagnostics.axe.requested=true`，axe-core 4.12.1，`providers.axe=degraded`，counts 为 violations=6、incomplete=1、passes=31、inapplicable=54，`axe.bounded.maxInlineResults=10`，完整结果位于 artifact `axe` 节点。默认 no-mode 对照使用 `browser-pilot observe --fresh --json` 生成 artifact `D:\browser-pilot\.browser-pilot\artifacts\observe-scan-1782821495842.json`，`pageObservation.diagnostics` 不含 `axe`，providers 不含 `axe`，PageObservation 仍为 canonical、abmlIntegrated=true、结构摘要正常。已同步 `CODE_WIKI.md` 与 `.trae/notes/abml-observe-long-term-optimization.md`。

- [x] Task 7: 运行验证门禁
  - [x] SubTask 7.1: 运行新增 axe diagnostics focused tests。
  - [x] SubTask 7.2: 运行 `mise run affected`。
  - [x] SubTask 7.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 7.4: 修复验证中发现的失败，直到相关检查通过。

  Task7 记录：新增 axe diagnostics focused tests 已通过 `node --import tsx --test --test-concurrency=1 tests/memory/observeScanRunner.test.ts`（8 tests pass）；`mise run affected` 已通过（131 tests pass，含 lint:memory）；`mise run verify` 已通过（250 tests pass，lint pass，build pass）。验证未发现需修复失败项。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 3。
- Task 5 depends on Task 2-4。
- Task 6 depends on Task 1-5 的实际变更。
- Task 7 depends on Task 1-6。
