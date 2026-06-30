# ABML / Observe Long-term Optimization Notes

## 背景
ABML / observe 是 Browser Pilot 的页面理解层，长期目标是把真实 Web 页面转换为稳定、可执行、可解释、适合 Agent 使用的 PageObservation / ABML 模型。该能力面对开放 Web，包含 DOM、AX Tree、CSS/layout、SVG/icon、虚拟列表、iframe、shadow DOM、懒加载、多语言和业务组件差异，因此会是长期优化过程。

## 总体策略
不要试图一次性引入一个大型项目替代 observe。更可控的路线是：

- 开源库负责标准子问题：accessible name、role mapping、accessibility diagnostics、readability。
- Browser Pilot 自己保留核心模型：PageObservation、ABML、refs、collections、relations、evidence、actionability、artifact、runtime integration。

## 优先级路线

### P0: 建立 observe regression benchmark
建立固定页面样本集和指标，避免 heuristic 优化互相回归。

建议样本：
- Krill AI pricing
- LINUX DO latest
- GitHub repo page
- GitHub PR page
- Stripe docs
- Ant Design table/form page
- shadcn dashboard sample
- Gmail-like nested UI mock
- virtualized list page
- iframe / shadow DOM page

建议指标：
- `containerName` uniqueness
- markup pollution count: `<path`, `<svg`, raw HTML-like
- long name count / max name length
- unnamed control ratio
- collection count stability
- actionables precision
- list/collection evidence sample preservation
- no-mode canonical PageObservation stability

### P1: 调研并试点 `dom-accessibility-api`
目标：减少手写 accessible name 维护成本。

候选库：
- https://github.com/eps1lon/dom-accessibility-api

状态：已进入试点并接入 browser-side scan naming pipeline。

已落地：
- 通过 `src/scan/domAccessibilityApiBundle.ts` 将 `dom-accessibility-api` 打包为 page-world 可用 bundle。
- `src/scan/buildScanScript.ts` 在 scan script 中注入 accessible-name provider。
- `capture-src/entries/scanTemplate.ts` 中 `labelOf(el)` / `containerLabelOf(el)` 优先尝试 bounded `computeAccessibleName(el)`。
- provider 调用受 `ACCESSIBLE_NAME_LIMIT` 限制，不全 DOM 无限制调用。
- computed name 继续经过 safe semantic label / concise container label 过滤，并保留原有 fallback。

后续关注项：
- bundle size / extension dist size
- scan latency on large pages
- Krill / LINUX DO / GitHub 命名改善
- icon-only button 命名改善
- aria-labelledby / label / title / alt / hidden 处理质量
- 是否需要进一步引入 AX tree fusion 来补足 computed name 无法覆盖的状态/层级信息

### P2: 引入 CDP Accessibility tree 与 DOM scan fusion
目标：用浏览器原生 AX tree 改善 role/name/state 可靠性。

状态：已进入实现/试点，接入 `browser_observe` canonical ABML structure 输出。

已落地：
- `src/browser-runtime/abml/axRuntime.ts` 读取 CDP `Accessibility.getFullAXTree` 与 `DOMSnapshot.captureSnapshot`，并在 bounded 上限内使用 geometry fallback。
- `src/browser-runtime/abml/runtime.ts` 在 structure 读取路径中复用 scan 数据、bootstrap backendNodeId，并将 AX diagnostics/provider 状态写入 PageObservation。
- `src/kernels/abml/ax.ts` 保持纯逻辑融合：backendNodeId 优先，保守 geometry 其次，仅在无歧义时允许 semantic fallback。
- DOM scan 的 selector/ref/actionability/evidence 保持执行权威；AX enrichment 只补充 role/name/description/states/structure 或追加 AX-only entity。
- ambiguous match、missing geometry、unsafe semantic name、provider partial failure 均进入 skipped/degraded diagnostics。
- focused tests 与 observe regression benchmark 已覆盖 scan-backed、ax-enriched、ax-only、degraded/skipped 等代表路径。

推荐融合模型：
- DOM scan: selector、ref、rect、hit-test、event handlers、visibility、execution target
- AX tree: role、name、description、states、setsize、posinset、level、expanded、selected、checked、disabled
- Layout: visible bounds、viewport、occlusion
- Content/readability: readable text、article sections
- ABML kernel: entities、collections、relations、evidence、refs

可调研 CDP API：
- `Accessibility.getFullAXTree`
- `Accessibility.getPartialAXTree`
- `DOMSnapshot.captureSnapshot`

后续关注项：
- 大页面 AX latency、node count、geometry fallback call count 与 bounded truncate 行为。
- AX-only entity 数量与输出预算，避免 artifact 被低价值节点稀释。
- ambiguous semantic/geometry skip 比例，持续用 regression benchmark 防回归。
- `getPartialAXTree` 是否可用于后续局部 observe/pierce 优化。
- 不让 SVG/path、HTML-like、selector-like、long preview 或 editable value 污染 semantic names。

### P3: 引入 `aria-query` 辅助 role mapping
候选库：
- https://github.com/A11yance/aria-query

用途：
- 替换或补强手写 `roleOf()`。
- 提供 HTML element -> ARIA role mapping。
- 提供 ARIA role metadata。

注意：
- 它不解决 actionability 和 hit-test。
- 仍需 Browser Pilot 自己判断 clickable/editable/control semantics。

### P4: 引入 `axe-core` 作为 diagnostics，不作为主 observe 路径
候选库：
- https://github.com/dequelabs/axe-core

用途：
- detect unnamed buttons
- missing labels
- bad ARIA
- landmark issues
- accessibility diagnostics artifact

建议接入形式：
- debug/diagnostics mode
- `browser_observe` diagnostics section
- `browser_doctor` 或后续 accessibility diagnostics command

不建议：
- 每次 observe 默认完整跑 axe。

### P5: 引入 Mozilla Readability 改善 content plane
候选库：
- https://github.com/mozilla/readability

用途：
- article/document main content extraction
- boilerplate removal
- readable content artifact

不适合：
- actionables
- collection modeling
- form/control semantics

### P6: 借鉴 Playwright / Testing Library / browser-use / Stagehand
这些项目更适合作为架构参考或测试 oracle，不建议直接替代 Browser Pilot runtime。

参考点：
- Playwright: locator、getByRole、ARIA snapshot、auto-wait、accessibility snapshot
- Testing Library DOM: user-centric query priority
- browser-use: LLM-friendly DOM element extraction
- Stagehand: observe/action/extract API 分层

## 推荐实施顺序
1. 建 observe regression benchmark。
2. 试点 `dom-accessibility-api`，先用于 actionables 和 container label。
3. 设计 CDP AX tree + DOM scan fusion spec。
4. 引入 `aria-query` 补强 role mapping。
5. 将 `axe-core` 作为 diagnostics 能力。
6. 将 Readability 用于 content plane。
7. 持续参考 Playwright / Testing Library / browser-use / Stagehand 的设计。

## 重要边界
- 不把业务数据提取塞进 `browser_observe`；精确业务数据仍由 `browser_execute` 或 artifact reads 完成。
- 不引入站点特定 hardcode。
- 不让长 item/card preview、SVG/path、HTML-like、selector-like 字符串进入用户面对的 semantic names。
- 保持 `src/kernels/*` 纯逻辑边界。
- 引入依赖前评估 bundle size、runtime latency、extension compatibility、license。
