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
- provider budget telemetry stability at `pageObservation.diagnostics.providerBudgetTelemetry`, including truthful status, bounded duration/count/budget fields, truncation/degradation markers, fallback reason, and artifact pointers without structural drift

### Cross-cutting telemetry guardrail
Provider budget/latency follow-up from P1-P5 is consolidated under the canonical provider budget telemetry summary. The stable JSON path is `pageObservation.diagnostics.providerBudgetTelemetry` in saved observe artifacts and `summary.pageObservation.diagnostics.providerBudgetTelemetry` in the command/result summary. The summary is diagnostics-only: it may report `provider`, normalized `status`, `requested`, `durationMs`, compact `counts`, compact `budget`, `truncated`, `degraded`, `reason`, `errorCode`, and artifact read pointers, but it must never create, delete, reorder, or rename actionables, refs, entities, relations, collections, content-plane output, or structural authority. Artifact pointers must remain bounded references to saved observe artifact sections such as `data.html`, `envelope`, `pageObservation.content`, `pageObservation.text`, `axe`, and `readability`; large/raw provider payloads stay artifact-only and are read through `browser_artifact` by stable JSON path.

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
- scan latency on large pages, reported through provider budget telemetry rather than ad-hoc diagnostics
- Krill / LINUX DO / GitHub 命名改善
- icon-only button 命名改善
- aria-labelledby / label / title / alt / hidden 处理质量
- 是否需要进一步引入 AX tree fusion 来补足 computed name 无法覆盖的状态/层级信息

### P2: 引入 CDP Accessibility tree 与 DOM scan fusion
目标：用浏览器原生 AX tree 改善 role/name/state 可靠性。

状态：已进入实现/试点，接入 `browser_observe` canonical ABML structure 输出。

已落地：
- `src/browser-runtime/abml/axRuntime.ts` 读取 CDP `Accessibility.getFullAXTree` 与 `DOMSnapshot.captureSnapshot`，并在 bounded 上限内使用 geometry fallback。
- `src/browser-runtime/abml/axRuntime.ts` 同时提供 bounded `Accessibility.getPartialAXTree` helper，仅面向已有可靠 `backendNodeId` 的局部 enrichment，输出 plain AX-like data 与 `provider:"partial-ax"` diagnostics，不进入 kernel。
- `src/browser-runtime/abml/runtime.ts` 在 structure 读取路径中复用 scan 数据、bootstrap backendNodeId，并将 full AX diagnostics/provider 状态写入 PageObservation；local read refinement 可在 target/ref scope 内尝试 partial AX，失败时回落 scan-only。
- `src/browser-runtime/abml/pierceRuntime.ts` 在 local pierce 中优先尝试 partial AX enrichment，fallback 到现有 full AX 过滤路径，且不扩展 page-wide 输出。
- `src/kernels/abml/ax.ts` 保持纯逻辑融合：backendNodeId 优先，保守 geometry 其次，仅在无歧义时允许 semantic fallback。
- DOM scan 的 selector/ref/actionability/evidence 保持执行权威；full AX enrichment 只补充 page-wide role/name/description/states/structure 或追加 AX-only entity。
- partial AX 只补充请求 target/ref scope 内的局部 role/name/state hints；默认 `fetchRelatives:false`、短 timeout、小 `maxNodes` 上限，不能创建 scope 外 page-wide AX-only entities，也不替代 canonical no-mode observe 的 full AX fusion。
- ambiguous match、missing geometry、unsafe semantic name、provider partial failure 均进入 skipped/degraded diagnostics；partial AX 的 missing backend、empty、unsupported/error、over-budget 分别进入 skipped/degraded/failed/degraded diagnostics。
- focused tests 与 observe regression benchmark 已覆盖 scan-backed、ax-enriched、ax-only、degraded/skipped 等代表路径。

推荐融合模型：
- DOM scan: selector、ref、rect、hit-test、event handlers、visibility、execution target
- AX tree: role、name、description、states、setsize、posinset、level、expanded、selected、checked、disabled
- Layout: visible bounds、viewport、occlusion
- Content/readability: readable text、article sections
- ABML kernel: entities、collections、relations、evidence、refs

可调研 CDP API：
- `Accessibility.getFullAXTree`：canonical no-mode observe 的 page-wide semantic enrichment 来源。
- `Accessibility.getPartialAXTree`：local read/pierce refinement 的 scoped optimization，只在已有可靠 backendNodeId 时触发。
- `DOMSnapshot.captureSnapshot`

后续关注项：
- 大页面 full AX latency、node count、geometry fallback call count 与 bounded truncate 行为，统一通过 provider budget telemetry 观察。
- partial AX 已评估并试点用于 local read/pierce refinement；后续只优化 target/ref scope 内 enrichment 的命中率、latency、unsupported/error 解释与 budget 默认值，不扩大到默认 no-mode page-wide observe。
- AX-only entity 数量与输出预算，避免 artifact 被低价值节点稀释；partial AX 不应引入 scope 外 AX-only entity。
- ambiguous semantic/geometry skip 比例，持续用 regression benchmark 防回归。
- 不让 SVG/path、HTML-like、selector-like、long preview 或 editable value 污染 semantic names。

### P3: 引入 `aria-query` 辅助 role mapping
候选库：
- https://github.com/A11yance/aria-query

状态：已完成调研并进入最小 role provider 试点；当前暂不新增 `aria-query` 依赖，先复用已注入的 `dom-accessibility-api.getRole(el)` 建立可替换 provider 边界。

已落地：
- `capture-src/entries/scanTemplate.ts` 中 `roleOf(el)` 调整为 safe explicit role、provider implicit role、legacy fallback 顺序。
- 首个 provider 通过 `BrowserPilotDomAccessibilityApi.getRole(el)` 提供 implicit role，过滤 `generic`、`presentation`、`none` 等低价值结果并 fail closed。
- Provider role 只补强 scan/actionables/reference/control relation 语义，不改变 clickable/editable/hit-test/actionability 权威逻辑。
- Focused tests 与 observe regression benchmark 已覆盖 `<a href>`、无 href anchor、search/list input、summary/details、landmarks、provider 缺失与低价值 fallback。

用途：
- 替换或补强手写 `roleOf()`。
- 提供 HTML element -> ARIA role mapping。
- 提供 ARIA role metadata。

注意：
- 它不解决 actionability 和 hit-test。
- 仍需 Browser Pilot 自己判断 clickable/editable/control semantics。

后续关注项：
- 继续观察 provider role 对 actionables precision、collection names 与 reference target role 的影响。
- 结合真实页面 no-mode observe artifact 持续检查 role/actionables 是否退化；2026-06-30 Edge live 补测已通过 `example.com` canonical no-mode observe，对照显示 `Learn more` link role/actionable 正常，未见结构项污染。
- 若需要 ARIA role constraint、required props 或更完整 schema metadata，再单独评估引入 `aria-query` provider 的 bundle size、CJS/ESM 兼容性、MV3 注入体积和 license。

### P4: 引入 `axe-core` 作为 diagnostics，不作为主 observe 路径
候选库：
- https://github.com/dequelabs/axe-core

状态：已完成调研并进入最小 diagnostics 试点，作为显式 `browser_observe` diagnostics-only add-on 接入；新增运行时依赖 `axe-core`，不进入 `src/kernels/*`、command catalog 或 bridge protocol。2026-06-30 已完成 Edge live bounded diagnostics 对照验证。

已落地：
- `src/commands/observe/axeDiagnosticsRunner.ts` 按需加载 `axe-core/axe.min.js`，通过现有 page runtime/CDP evaluation 注入页面并运行 `axe.run(document, ...)`。
- 仅在 canonical no-mode observe 显式传 `diagnostics:"axe"`、`diagnostics:"accessibility"`、`debug:"axe"`、`axe:true` 或 `axeDiagnostics:true` 时运行；默认 observe 不跑 axe。
- runner 使用独立小超时、最大 inline sample 数和 fail-closed fallback；失败/超时只把 axe provider 标记为 failed/degraded，不阻断核心 observe。
- `PageObservation.diagnostics.providers.axe` 表达 executed/skipped/failed/degraded 真实性，`diagnostics.axe` 只放 counts、impact/rule counts、安全 sample 与 artifact pointer。
- 完整 axe 原始结果只进入 saved observe artifact 的 `axe` 节点；inline summary 不包含 axe node/html/snippet 大段原文。
- focused tests 覆盖默认未请求、显式执行、timeout 降级、artifact shape 与 axe issue 不改变 canonical PageObservation structural model。
- Edge 149 live 试点页 `https://example.com/` 上，显式 `--axe` observe 产出 `PageObservation.diagnostics.axe`、`providers.axe` 和 saved artifact `axe` 节点；默认 no-mode `--fresh` observe 不含 `axe` provider，canonical PageObservation 结构未明显退化。

用途：
- detect unnamed buttons
- missing labels
- bad ARIA
- landmark issues
- accessibility diagnostics artifact

后续关注项：
- MPL-2.0 合规和发布包体积增加；当前 `axe.min.js` 约 573 KB，依赖按需读取但 npm 包会增加发布体积。
- 真实 Chrome/Edge 页面上的 CSP/isolated world 差异与跨 frame 覆盖。
- 大页面 latency、timeout 命中率和 incomplete/degraded 解释；本轮 `example.com` live 试点因页面/扩展环境存在 incomplete，provider 以 degraded 诚实表达但不阻断 observe，并通过 provider budget telemetry 暴露 duration/count/budget/reason/artifact pointer。
- 是否需要后续单独 accessibility diagnostics command 或 doctor 健康提示。
- 如纳入 observe regression benchmark，应保持离线/纯逻辑 fixture，不让默认 benchmark 依赖真实浏览器执行 axe。

不建议：
- 每次 observe 默认完整跑 axe。
- 让 axe issue 改变 actionables、refs、entities、relations、collections 或 actionability 权威。

### P5: 引入 Mozilla Readability 改善 content plane
状态：已完成调研并进入最小 content-plane 试点，作为显式 `browser_observe` add-on 接入；新增运行时依赖 `@mozilla/readability`，不进入 `src/kernels/*`、extension service worker 常驻 bundle、command catalog 或 bridge/native protocol。2026-06-30 已完成 Edge live bounded Readability 对照验证。

已接入：
- `src/commands/observe/readabilityRunner.ts` 按需加载 `@mozilla/readability/Readability.js` 与 `Readability-readerable.js`，通过现有 page runtime 在 `document.cloneNode(true)` 上运行。
- 仅在 canonical no-mode observe 显式传 `content:"readability"`、`readability:true` 或 nested params alias 时运行；默认 observe 不跑 Readability。
- runner 使用独立小超时、`maxElemsToParse`、最大 inline/content 字符数和 fail-closed fallback；失败/超时只把 Readability provider 标记为 failed/degraded，不阻断核心 observe。
- 输出进入 `PageObservation.diagnostics.readability`、`providers.readability`、artifact hints/preferred reads 的 `Readability article`，以及 saved observe artifact 的 `readability` 节点。
- Readability HTML 会移除 script/style/noscript/template 等不安全片段并经过现有 redaction；inline summary 只保留 bounded title/byline/excerpt/text preview/length/site/lang 等摘要。
- 强 CSP 页面要求 runner 避免页面内字符串 eval；当前实现把 Readability CJS 源码作为同一 CDP evaluation 表达式执行，避免 `unsafe-eval` 阻断。
- Focused tests 与 observe regression benchmark 已覆盖 success/null/failure/timeout、bounding/redaction、artifact shape、provider diagnostics honesty，以及 Readability 不进入 structural authority。
- Edge 149 live 试点页 `https://linux.do/t/topic/2502552` 上，显式 `--content readability` observe 产出 `providers.readability:"executed"`、`readability.summary` 与 `Readability article` artifact hint；默认 no-mode `--fresh` observe 不含 `readability` provider，canonical PageObservation 结构未明显退化。

用途：
- article/document main content extraction
- boilerplate removal
- readable content artifact

不适合：
- actionables
- collection modeling
- form/control semantics

后续关注：
- 大页面 DOM clone 成本、latency、timeout/degraded 命中率和 maxElemsToParse 默认值，统一通过 provider budget telemetry 暴露并保持 inline bounded。
- Readability 对 forum/thread、docs/blog/news 等不同页面类型的提取质量与误抽取样式。
- artifact raw HTML 的 sanitizer/CSP 风险；继续保持 artifact-only、bounded inline 和 redaction。
- 如扩展到 legacy `mode=content`，仍应保持 canonical no-mode 默认不运行 Readability，且不替代 ABML/scan 主结构。

### P6: 借鉴 Playwright / Testing Library / browser-use / Stagehand
这些项目已沉淀为 Browser Pilot repository-local design reference oracle / guardrail，不作为 runtime dependency，也不替代现有 `browser_*` 工具、ABML runtime 或 PageObservation 模型。

参考点与已落地边界：
- Playwright locator / getByRole：转化为 query priority 与 locator/ref stability oracle，优先保护 role/name/label/textAnchor 等面向用户的稳定语义，过滤 selector-like、framework/generated class、long preview、SVG/path、HTML-like 噪声。
- Playwright ARIA / accessibility snapshot：作为 role/name/state 高信号 evidence 与 regression fixture 参考，不把 ARIA snapshot 变成 canonical PageObservation 输出，也不让 accessibility diagnostics 阻断 observe。
- Playwright auto-wait：只借鉴 action target 应接近执行时解析并防 stale refs 的设计，不给 `browser_observe` 增加隐式等待；未来 action-runtime wait/actionability 工作必须留在现有 command boundary 内。
- Testing Library DOM query priority：转化为 user-centric query priority guardrail，不用 test-id、CSS class 或站点私有结构替代用户可见语义。
- browser-use DOM extraction：借鉴 LLM-friendly element inventory、bounded text、visibility 与 viewport hints；Browser Pilot 仍保留自己的 refs、resources、evidence、artifacts、redaction 与 ABML relations/collections。
- Stagehand observe/action/extract：转化为 observe/action/extract boundary oracle；`browser_observe` 负责 sensing、task entry points、refs、relations、content/artifact hints、diagnostics 与 evidence，不默认执行业务数据抽取；精确业务值应通过 `browser_execute` 或 artifact reads 定向获取，页面动作仍走 `browser_execute` 或 `browser_command`。

已落地：
- P6 reference mapping 已覆盖 Playwright、Testing Library、browser-use 与 Stagehand 的可采纳点、不采纳点和 future scope。
- Focused oracle 已保护 query priority、concise user-facing locator/ref semantics、observe/action/extract boundary，以及不新增 Playwright、Testing Library、browser-use 或 Stagehand runtime dependencies。
- `CODE_WIKI.md` 已同步 P6 design reference oracle、query priority、locator/ref stability 和 observe/action/extract boundary。

后续关注项：
- 后续 action runtime 若实现 actionability wait，应沿用 existing command/program boundary，并避免改变 `browser_observe` 的 sensing-only 语义。
- 继续把外部项目仅作为 fixture/oracle 设计参考，新增依赖前仍需评估 bundle size、runtime latency、extension compatibility 与 license。
- 持续防止 query/ref 语义被 CSS selector、generated class、backendNodeId、坐标、SVG/path、HTML-like 或长 preview 污染。
- 如扩展 extract/content 能力，应保持 artifact/read boundary，不把站点特定业务抽取硬塞进 canonical PageObservation。

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
