# Tasks

- [x] Task 1: 调研 Readability 依赖与最小 content provider 方案
  - [x] SubTask 1.1: 检查 `@mozilla/readability` package 入口、license、browser/MV3 compatibility、bundle size、DOM clone 要求与运行 API。
  - [x] SubTask 1.2: 梳理现有 observe content plane、content/text/html provider status、artifact hints 与 legacy content projection 接入点。
  - [x] SubTask 1.3: 选择触发方式：显式 content/readability option、bounded optional provider policy、或 legacy content projection enhancement；默认 no-mode observe 不用 Readability 替代主结构。
  - [x] SubTask 1.4: 记录方案、预算、风险与是否新增依赖。
  - Decision: 选择 bounded optional provider policy，后续实现应作为 canonical no-mode `browser_observe` 的显式可选 content-plane provider 触发，例如 `content:"readability"` / `readability:true` / nested params alias；默认 no-mode observe 不运行 Readability，不替代 ABML/scan 主结构；legacy `mode=content` 可后续作为兼容投影增强但不作为首选触发面。
  - Findings: `@mozilla/readability@0.6.0` 为 Apache-2.0，npm `main:index.js`、`types:index.d.ts`，当前包为 CJS 入口、无运行依赖，unpacked size 约 154,574 bytes、14 files；浏览器中可直接对 DOM `document` 运行，`parse()` 会修改 DOM，因此必须传 `document.cloneNode(true)`；API 返回 `title/content/textContent/length/excerpt/byline/dir/siteName/lang/publishedTime`，另有 `isProbablyReaderable(document, options)` 预检；README 明确输出 HTML 面向不可信输入时需 sanitizer/CSP 防护。
  - Integration notes: 现有接入点是 `src/commands/observe/contentRunner.ts` + `src/content/buildContentScript.ts`/`capture-src/entries/contentTemplate.ts` 的 legacy content projection、`src/commands/observe/scanRunner.ts` 的 canonical PageObservation/artifactValue/providerFailures/providerStatuses、`src/commands/observe/scanProjection.ts` 的 content/text/html/evidence provider diagnostics 与 artifact hints；`src/commands/observe/axeDiagnosticsRunner.ts` 是最接近的显式 optional provider/fail-closed/artifact-only 模式。
  - Budget/Risk: 建议独立小超时、maxElemsToParse、max inline text/content chars、artifact-only raw HTML、fail-closed fallback 到现有 scan-backed content/text；新增依赖应只进入 content/provider runner 路径，不进入 `src/kernels/*`、command catalog、bridge/native protocol 或 extension service worker 常驻 bundle；主要风险为 CJS bundling/MV3 注入方式、Readability 输出 HTML 未消毒、DOM clone 成本与 boilerplate/null 结果。

- [x] Task 2: 实现 bounded Readability runner
  - [x] SubTask 2.1: 若选择新增依赖，更新 `package.json` 与 lockfile，并确认不手改 `dist/` 或 `bridge/browser_pilot_bridge/` generated outputs。
  - [x] SubTask 2.2: 在 browser-compatible content provider 路径中加载/运行 Readability，支持 DOM clone、超时、最大 inline 字符数和 fail-closed fallback。
  - [x] SubTask 2.3: 将结果规范化为 bounded summary：title、byline、excerpt、textLength、contentLength、siteName、artifact path。
  - [x] SubTask 2.4: 确保 Readability runner 不在 `src/kernels/*`、command catalog 或 bridge protocol 中引入不必要依赖。

- [x] Task 3: 接入 content plane 与 artifact 输出
  - [x] SubTask 3.1: 将 Readability 结果写入本地 artifact，遵循现有 artifact privacy/redaction/readCommands 约定。
  - [x] SubTask 3.2: 在 PageObservation content plane、artifact hints 或选定 projection 输出中表达 Readability provider 状态：executed、skipped、failed 或 degraded。
  - [x] SubTask 3.3: 当 Readability 未请求、返回 null、失败或超预算时，保留现有 scan-backed content/text fallback。
  - [x] SubTask 3.4: 避免将 scripts/styles、长 raw HTML、敏感 token/cookie/authorization 值放入 inline summary。

- [x] Task 4: 保护 content-plane-only 边界
  - [x] SubTask 4.1: 确认 Readability 结果不会创建、删除或重排 actionables、refs、entities、relations、collections。
  - [x] SubTask 4.2: 确认 Browser Pilot scan/ABML、AX/DOM fusion、hit-test、editable、visibility 仍为结构和执行权威。
  - [x] SubTask 4.3: 增加测试覆盖 Readability 输出不影响 canonical PageObservation structural model。

- [x] Task 5: 增加测试与 benchmark 覆盖
  - [x] SubTask 5.1: 增加 runner success/null/failure/timeout 或 provider unavailable focused tests。
  - [x] SubTask 5.2: 增加 summary bounding、artifact shape、redaction、script/style stripping 与 provider diagnostics honesty 测试。
  - [x] SubTask 5.3: 增加 article/document fixture，验证 readable content 提取优于 boilerplate-heavy fallback。
  - [x] SubTask 5.4: observe regression benchmark 增加 content-plane provider status 记录 case，用离线 PageObservation 验证 Readability 不进入 structural authority；默认 structural benchmark 仍不运行真实 Readability provider，避免浏览器、extension、network 或外部站点依赖。

- [x] Task 6: 构建、实测与文档同步
  - [x] SubTask 6.1: 运行 extension/content provider 相关构建检查，确认 MV3 bundle 可用且体积变化可接受。
  - [x] SubTask 6.2: 在 Edge 当前页面或测试页运行 bounded Readability content provider，确认 artifact、content digest 和 provider diagnostics 正常。
  - [x] SubTask 6.3: 确认 no-mode `browser_observe` 默认路径不被 Readability 替代结构，canonical PageObservation 未明显退化。
  - [x] SubTask 6.4: 更新 `CODE_WIKI.md` 中 content plane、provider status、artifact hints 与 dependency/runtime boundary 说明。
  - [x] SubTask 6.5: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P5 记录为调研/试点状态并写明后续关注项。

- [x] Task 7: 运行验证门禁
  - [x] SubTask 7.1: 运行新增 Readability content focused tests。
  - [x] SubTask 7.2: 运行 `mise run affected`。
  - [x] SubTask 7.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 7.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 3。
- Task 5 depends on Task 2-4。
- Task 6 depends on Task 1-5 的实际变更。
- Task 7 depends on Task 1-6。
