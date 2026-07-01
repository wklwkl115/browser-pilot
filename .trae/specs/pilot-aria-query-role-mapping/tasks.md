# Tasks

- [x] Task 1: 调研依赖与最小 role provider 方案
  - [x] SubTask 1.1: 检查 `aria-query` package 入口、ESM/CJS 形态、license、browser/MV3 compatibility 与 bundle size。
  - [x] SubTask 1.2: 比较 `aria-query` 与当前已注入的 `dom-accessibility-api.getRole(el)` 能力重叠。
  - [x] SubTask 1.3: 选择最小可行方案：新增 `aria-query` provider、复用 `dom-accessibility-api.getRole`、或先建立可替换 role provider abstraction。
  - [x] SubTask 1.4: 记录是否需要新增依赖，以及选择该方案的原因和风险。
  - 调研记录：当前项目已在 `package.json` 依赖 `dom-accessibility-api@^0.7.1`，`src/scan/buildScanScript.ts` 将 `src/scan/domAccessibilityApiBundle.ts` 注入 page-world scan template；该 bundle 已导出 `computeAccessibleName` 与 `getRole`，source file 约 16.0 KB、gzip 约 5.1 KB。当前 `capture-src/entries/scanTemplate.ts` 的 `roleOf(el)` 仍只使用 explicit `role` 与 Browser Pilot legacy tag/type fallback，尚未调用 `BrowserPilotDomAccessibilityApi.getRole(el)`。
  - 调研记录：`aria-query@5.3.2` npm 元数据为 Apache-2.0、`main: lib/index.js`、未声明 `module`/`exports`/`browser` 字段、无公开 dependencies，unpacked size 约 176 KB。它更适合提供 ARIA role/element schema 数据与约束表；若直接引入 scan page-world，需要新增依赖、构建 provider bundle，并验证 CJS 入口/tree-shaking、MV3 注入体积与运行兼容性。
  - 能力比较：`dom-accessibility-api.getRole(el)` 已提供实际 DOM 元素的 explicit/implicit role 计算，覆盖 `<a href>`、input type、select、summary、landmark/structural tags、`img alt=""` presentation 等 Task 5 目标 fixture 的核心 role 映射；`aria-query` 提供更底层、更完整的 role/element 元数据，但不会直接替代 Browser Pilot 的 visibility、hit-test、clickable、editable、handler 等 actionability 判断。
  - 方案结论：Task 2 起采用最小可行方案“建立可替换 role provider abstraction，并首个 provider 复用已注入的 `dom-accessibility-api.getRole(el)`”；暂不新增 `aria-query` 依赖。原因是现有 bundle 已满足 implicit role 试点需求、避免重复 role 数据源和 bundle 体积增长，并能保持 `src/scan/*` 注入边界，不触碰 `capture-src/entries/*` npm import、`src/kernels/*`、command catalog 或 bridge protocol。
  - 风险记录：`getRole` 可能返回 `null`、`generic`、`presentation`/`none` 或 structural landmarks，后续 Task 3 需在 `roleOf(el)` 中过滤低价值结果并保留 legacy fallback；Task 4 需保证 provider role 不自动扩大 clickable roles；若后续需要 ARIA schema 校验或 role constraint metadata，再单独评估引入 `aria-query` provider。

- [x] Task 2: 建立 scan role provider 注入边界
  - [x] SubTask 2.1: 在 `src/scan/*` 构建链路中新增或调整 role provider bundle/wrapper，不在 `capture-src/entries/*` 直接 import npm 包。
  - [x] SubTask 2.2: 确保 provider 初始化 fail closed，异常或缺失时不影响 scan script 执行。
  - [x] SubTask 2.3: 若新增依赖，更新 `package.json` 与 lockfile，并确认不手改 `dist/` 或 `bridge/browser_pilot_bridge/` generated outputs。
  - [x] SubTask 2.4: 避免将 role provider 依赖引入 `src/kernels/*`、command catalog 或 bridge protocol。

- [x] Task 3: 补强 `roleOf(el)` 路径
  - [x] SubTask 3.1: 将 `roleOf(el)` 调整为 safe explicit role、provider implicit role、legacy fallback 的顺序。
  - [x] SubTask 3.2: 保留 `button`、`input`、`select`、`textarea` 等关键控件 fallback。
  - [x] SubTask 3.3: 处理 provider 返回的 `null`、`generic` 或低价值 structural role，避免扩大 actionable 误报。
  - [x] SubTask 3.4: 确保 role 输出继续服务 actionables、reference targets、controls_pairs 与 scan summary，不改变公开 `browser_observe` command surface。

- [x] Task 4: 保护 Browser Pilot actionability 边界
  - [x] SubTask 4.1: 确认 `clickable(el, style)`、editable、hit-test、visibility 与 event-handler 判断仍由 Browser Pilot 逻辑决定。
  - [x] SubTask 4.2: 不因 provider role metadata 自动加入新的 clickable roles，除非已有 Browser Pilot 证据支持。
  - [x] SubTask 4.3: 为 `<a>` without `href`、structural landmarks、role-only non-interactive elements 增加不退化断言。

- [x] Task 5: 增加 focused tests 与 observe benchmark 覆盖
  - [x] SubTask 5.1: 更新 scan script builder 或 provider wrapper 测试，确认 role provider 注入/可用性或 fallback 存在。
  - [x] SubTask 5.2: 增加 implicit role fixture，覆盖 `<a href>`、`<a>` without `href`、`input type=search`、`input list`、`img alt=""`、`summary/details`、`nav/main/section/form/header/footer`。
  - [x] SubTask 5.3: 增加 fallback fixture，验证 provider 不可用或返回低价值结果时仍使用 legacy role fallback。
  - [x] SubTask 5.4: 更新 observe regression benchmark，保护 canonical PageObservation 不因 role provider 变化污染 actionables 或 collections。

- [x] Task 6: 构建、实测与文档同步
  - [x] SubTask 6.1: 运行 extension/scan 相关构建检查，确认 MV3 bundle 可用且体积变化可接受。
  - [x] SubTask 6.2: 在 Edge 当前页面运行 no-mode observe，确认扩展可连接、scan 可完成、artifact 中 role/actionables 未明显退化。
  - [x] SubTask 6.3: 更新 `CODE_WIKI.md` 中 scan provider 注入、role mapping pipeline 与依赖边界说明。
  - [x] SubTask 6.4: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P3 记录为调研/试点状态并写明后续关注项。
  - Build/scan validation passed: `npm run build:bridge` produced buildId `6a7106bad795433ed9cc6acda7add6004cb3804bd5364e02772b51bb7c4e12ae` under `bridge/browser_pilot_bridge/dist/*`; `npm run typecheck` passed; focused scan/role/benchmark tests passed with `node --test --import tsx tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts`（20 tests pass）。
  - Size check: `src/scan/domAccessibilityApiBundle.ts` 16,357 bytes / gzip 5,211 bytes；generated `content.js` 5,881 bytes / gzip 1,908 bytes；generated `service-worker.js` 434,409 bytes / gzip 98,100 bytes。未新增 `aria-query` runtime dependency。
  - Edge no-mode observe attempted but blocked by environment: `npm --silent run cli -- connect --wait --json` waited 32961ms and returned `CLI_EXTENSION_NOT_CONNECTED`; `doctor --json` showed daemon/bridge up but `extensionConnected=false`; `tabs --action list --json` returned `NO_BROWSER_EXTENSION`。因此本轮无法产出真实 observe artifact，需在 Browser Pilot Bridge extension installed/enabled and a tab reloaded 后重试 no-mode observe。
  - Docs synced: `CODE_WIKI.md` 已补充 scan role provider 注入、`roleOf()` 顺序、actionability 边界与 `aria-query` 候选依赖边界；长期优化记录已将 P3 标记为调研/最小 provider 试点并写明后续关注项。

- [x] Task 7: 运行验证门禁
  - [x] SubTask 7.1: 运行新增 role provider/scan/benchmark focused tests。
  - [x] SubTask 7.2: 运行 `mise run affected`。
  - [x] SubTask 7.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 7.4: 修复验证中发现的失败，直到相关检查通过。
  - 验证结果：focused tests `node --test --import tsx tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts` 通过（20 tests，0 fail）；`mise run affected` 通过（126 tests，0 fail，并完成相关 lint）；`mise run verify` 通过（245 tests，0 fail，lint/build 均 ok）。本轮未发现验证失败，无需生产代码修复。

- [x] Task 8: 重试 Edge no-mode observe 实测
  - [x] SubTask 8.1: 确认 Browser Pilot Bridge extension 已安装、启用，并在目标 tab reload 后连接到 daemon。
  - [x] SubTask 8.2: 运行 no-mode observe，产出 artifact。
  - [x] SubTask 8.3: 检查 artifact 中 role/actionables 未明显退化，成功后勾选 checklist 对应检查点。
  - 阻塞记录：本轮按 Browser Pilot CLI 工作流重试仍被扩展连接阻塞。`npm --silent run cli -- connect --wait --json` 等待 30027ms 后返回 `CLI_EXTENSION_NOT_CONNECTED`，daemon/bridge 已运行（bridge port 18765），但 `extension.connected=false`、`tabCount=0`；`npm --silent run cli -- tabs --action list --json` 返回 `NO_BROWSER_EXTENSION`，提示 Browser Pilot Bridge extension 未连接；`npm --silent run cli -- doctor --json` 确认 `readiness="bridge-up"`、`extensionConnected=false`、`activeTab=null`；`npm --silent run cli -- observe --json` 返回 `NO_TAB`，无法产出 observe artifact。因此未检查 role/actionables，checklist 的 Edge no-mode observe 实测项保持未勾选。下一步需在 Edge/Chrome 中确认 Browser Pilot Bridge extension 已安装并启用，打开或 reload 任一 tab 使 service worker 连接 bridge，再重跑 connect/list/observe。
  - 补测记录：扩展重新加载后 `npm --silent run cli -- connect --wait --json` 通过，`extension.connected=true`，reported build 与 expected build 均为 `6a7106bad795433ed9cc6acda7add6004cb3804bd5364e02772b51bb7c4e12ae`，`buildManifestPath=D:\browser-pilot\bridge\browser_pilot_bridge\dist\build-manifest.json`。创建 `https://example.com/` 测试 tab 后，no-mode `observe --json --target-ref tabh_fbd73d6cb82840d58b85241b_7091d35afc1f4e02_g1` 成功产出 artifact `D:\browser-pilot\.browser-pilot\artifacts\observe-scan-1782818427366.json`，canonical PageObservation 正常，`abmlIntegrated=true`。artifact 检查显示 `data.actionables` 仅 1 项：`Learn more` 链接，`role="link"`、`href="https://iana.org/domains/example"`、`clickable=true`；`data.references` 与 `data.list_hints` 均为空，未见 role/actionables 明显退化或结构项污染。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 3。
- Task 5 depends on Task 2-4。
- Task 6 depends on Task 1-5 的实际变更。
- Task 7 depends on Task 1-6。
- Task 8 depends on Edge/Chrome extension installed/enabled and a live tab reload。