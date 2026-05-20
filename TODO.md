# TODO

## 当前状态

- 当前主链路：`browser_tabs` -> `browser_scan` / `browser_content` / `browser_html` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎优先以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- 当前收敛的是实现路线与职责分层，不是工具能力收缩，也不是工具层安全边界收缩；扩展工具层能力第一，安全边界由 Pi 平台/安全层负责。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。

## 历史整理归档（1-162 已完成）

- 1-26：原生 Pi Browser Bridge、协议 schema、工具注册拆分、resultMiddleware/artifact/detailLevel、`browser_pick`/`browser_content` 基础能力完成。
- 27-73：历史动作拆分与 semantic DOM 工具已复审撤回；当前工具面收敛为 scan/content/execute/wait/network/hook/evidence/frame/html/screenshot/artifact 等组合能力，复杂交互走 `browser_scan` + `browser_execute`。
- 74-102：Web 执行面已落地并归档：recon/crawl/path-vhost-param fuzz/http replay/cookie/sqli/template/OAST/sqlmap/nuclei；单包分层、budget、summary、artifact、raw/HAR/captured request 链路与成熟引擎 bridge 契约完成。
- 103-126：Bug report C/H/M/L 批次已处理；覆盖 BrowserBridge session/tab、WS origin/retry、upload/download、transport/tab_sync、network/wait/hook/html/screenshot、JSON/router 等边界修复与契约。
- 127-129：默认 tab 竞态可观测化、MV3 长等待短租约 supervisor、Bridge JS `checkJs` 类型栅栏已完成。
- 130-156：桌面审计报告 Bug 1-26 已完成；覆盖 wait deadline、BrowserBridge/tab 路由、native 命令、内容/下载/截图、ReDoS/安全预算、契约与 README/CHANGELOG/skill 同步。
- 157-162：Bug 28+ 当前基线复核完成；已覆盖项与 callable 子集证据已归档，剩余未覆盖/部分覆盖项全部转入 TODO 163-174。
- 历史归档不再作为执行队列；Bug 审计队列已收口，后续只从未完成 TODO 175 起推进，必要时回看 git diff、桌面报告与对应契约文件。

## 163. 当前代码缺陷审计报告剩余项执行索引（清晰基线）

- [x] 当前剩余范围已从桌面审计报告压缩版重新核对并随 TODO 164-173 收敛：当前未覆盖/待修 Bug 已清零；部分覆盖已清零；另有真实浏览器 smoke gate 仍需在可独占 bridge 端口时执行。
- [x] 执行规则：从 TODO 164 开始顺序推进；每项先做事实复核，再改代码；每项完成时必须更新对应 TODO 勾选状态、README、CHANGELOG、桌面审计报告，触及全局 skill 时同步更新 `D:/Pi/agent/skills/pi-browser-tools/SKILL.md`。
- [x] 验收规则：每项至少补静态/动态契约测试并运行相关局部 check；提交最终状态前运行 `cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"`。触及全局 skill 后运行 `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`。
- [x] 文档规则：已覆盖项不得只写“已修”；必须写清事实是否成立、修复边界、契约证据。若复核发现报告不成立，也必须补防回归契约或说明无需代码修改的证据。

## 163A. 实战反馈：browser_network 原始响应证据保真（当前插队）

- [x] 事实复核：确认当前 recorder 虽支持 `captureBodies/captureRequestPostData/maxBodyBytes/resourceTypes`，但默认不开启 body/postData，`network.body` 缺 body 时只返回泛化 `BODY_UNAVAILABLE`，无法区分未请求、过滤、CDP 失败、过期、过大或二进制。
- [x] 修复边界：`network.start` 默认对 XHR/Fetch/Document 的小型 JSON/text/html 响应立即尝试 `Network.getResponseBody` 并保留 `bodyRef/bodyPreview`；保留 `captureBodies:false` 显式关闭和 `bodyMimeAllow/maxBodyBytes/resourceTypes/bodyTimeoutMs` 有界控制。
- [x] 请求证据：`captureRequestPostData` 默认有界开启，`network.get/exportHar` 保留 `request.postData/postDataTruncated/postDataOriginalLength`，便于直接输入 `browser_http_replay`。
- [x] 缺失诊断：`network.get/list/body/exportHar` 暴露 `bodyAvailability` 与 `bodyUnavailableReason`，`network.body` 无 body 时仍返回稳定错误细节，而不是裸 `BODY_UNAVAILABLE`。
- [x] 契约：补 fake CDP network recorder 测试，覆盖默认 JSON body 捕获、显式关闭、mime/binary 过滤、CDP expired/failed、maxBodyBytes 截断和 request postData。
- [x] 文档：README、CHANGELOG、skill 同步网络证据保真语义；TODO 本项完成后再回到 Bug 27 队列。

## 164. Bug 27：browser_download mode 枚举校验

- [x] 事实复核：确认当前 `bridge/pi_browser_bridge/transfer.js` 的 page 下载仍通过 `msg.mode === 'media' ? 'media' : 'click'` 静默降级；确认 `src/tools/transferValidation.ts` 的 `buildTransferDownloadCommand()` 对非法 `mode` 没有工具层拒绝。
- [x] 修复边界：`browser_download.mode` 只允许 `click | media | url`；省略 `mode` 时 selector 目标默认为 `click`，url 目标默认为 `url`；显式非法值一律返回 `INVALID_RULE`，不得执行 click、media extraction、CDP wait 或 Chrome downloads API。
- [x] 兼容决策：`url` 目标仅接受省略或 `mode:"url"`；selector 目标仅接受省略、`click` 或 `media`；`selector + mode:"url"`、`url + mode:"click/media"` 都是参数冲突并返回稳定错误。
- [x] 实现位置：在 `transferValidation.ts` 增加纯函数校验/归一化，`registerTransferTools.ts` 在 `ensureStarted()` 前调用；bridge 端 `transfer.js` 也做同等防线，防止 `browser_execute command={cmd:"transfer.download"}` 绕过工具层。
- [x] 契约：`check-transfer-runtime.mjs` 覆盖非法 mode 不调用 `Runtime.evaluate`/`chrome.downloads.download`；`check-transfer-tools.mjs` 静态锁定不再出现 `msg.mode === 'media' ? 'media' : 'click'`；必要时 `check-tools-contract.mjs` 锁定工具层预校验。
- [x] 文档：README、CHANGELOG、skill、桌面审计报告同步说明 mode 枚举和冲突语义。

## 165. Bug 33/34/35：hook sessionId、collect 自噪声、clear_buffer 单调序号

- [x] 事实复核：确认 `hook.status/collect/clear_buffer/pause/resume/uninstall` 未把 `msg.sessionId/session_id` 传给页面 dispatcher；确认 dispatcher `collect()` 仍调用 `setState()` 写入 `hook.lifecycle`；确认 `clearBuffer()` 仍执行 `seq = 0`。
- [x] Session 契约：本项目保持“单 tab 单 dispatcher session”，但调用方显式传 `sessionId/session_id` 时必须严格匹配当前 `session_id`；不匹配返回 `SESSION_NOT_FOUND` 或 `INVALID_SESSION`，不得回退到当前 session。
- [x] Bridge 实现：`hook.js` 对 status/collect/clear/pause/resume/uninstall 统一转发 `session_id`；`hook_dispatcher.js` 增加 `requireSession(op, expectedSessionId)` 并用于这些操作。
- [x] Collect 语义：只读 collect 不得向事件 buffer 写入 lifecycle 自噪声；如仍需状态观测，写入独立控制面字段/diagnostics，不混入 `events`。
- [x] Clear 语义：`clear_buffer` 只清 buffer、overflow 和派生统计，不重置全局单调 `seq`；`since_seq` 在 clear 前后仍可稳定分页，新事件 seq 必须继续递增。
- [x] 契约：`check-pi-browser-bridge.mjs` 增加 fake dispatcher/runtime 测试：错误 sessionId 返回稳定错误；空闲 collect 不产生 lifecycle 事件；clear 后新事件 seq 大于 clear 前 last seq。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告记录 hook session 严格匹配、collect no self-noise、seq monotonic。

## 166. Bug 37/38：hook.addEventListener 注册表作用域与 uninstall 页面监听清理

- [x] 事实复核：确认 `WaitCoordinator.eventSubscriptions` 仍以裸 `listenerId` 为 key；确认 `hook.uninstall`/`cleanupPiBrowserTab()` 未主动移除页面 `window.__piBrowserListeners` 中的真实 DOM listener。
- [x] 注册表契约：event listener registry key 改为 tab-scoped 复合 key（如 `tabId::listenerId`）；不同 tab 可使用相同 listenerId 且互不覆盖；同 tab 重复 listenerId 才替换同 tab 旧监听。
- [x] Remove 契约：`hook.removeEventListener` 必须只删除目标 tab 的 listener；跨 tab 同名 listener 不影响；返回结构保留 `registry_removed/page_removed/listenerId/tabId`。
- [x] Cleanup 契约：`hook.uninstall`、tab removed、cleanupPiBrowserTab 必须尝试清理页面 `window.__piBrowserListeners` 及真实 DOM listener；失败时返回/记录 cleanup warning，不静默吞掉。
- [x] 契约：`check-pi-browser-bridge.mjs` 覆盖两 tab 同 listenerId 并存、按 tab diagnose/list/remove、uninstall 后页面 store 和 registry 均为空。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步 listener tab scope 与 uninstall cleanup 语义。

## 167. Bug 39：browser_pick focus:false 后台 tab 超时语义

- [x] 事实复核：确认 `registerPickTool.ts` 把用户 `timeoutMs` 同时作为 CDP `Runtime.evaluate` 超时，而页面 picker 依赖页面 `setTimeout` 结算；后台 tab timer throttle 时 CDP 可先超时。
- [x] 修复决策：TS 工具层拥有用户声明的总 deadline；页面脚本只负责交互状态。`focus:false` 时不得把“页面 timer 被节流”暴露成 `Runtime.evaluate timed out`，必须返回结构化 `{ cancelled:true, reason:"timeout" }` 或稳定 `PICK_TIMEOUT`。
- [x] 实现方案：将 picker 执行改为可轮询/可清理模型，或给 CDP evaluate 增加受控 grace 并在 TS deadline 到达时主动注入 cleanup；无论哪种实现，都要保证用户超时边界和 overlay/listener cleanup。
- [x] 契约：新增/扩展 `check-content-pick.mjs` 或专门 pick contract，模拟后台 timer 延迟，断言结果不是 CDP timeout，且 cleanup 脚本被调用。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告说明 `focus:false` 的 deadline 与 cleanup 行为。

## 168. Bug 41/42/52：performance entries 与只读 hook timeout 透传

- [x] 事实复核：确认 `getPerformanceEntries()` 对指定 `entryType` 空结果仍 fallback 到 `performance.getEntries()`；确认 `evidence.collect includePerformance` 未透传 `timeoutMs/timeout_ms`；确认 `hook.status` 到 `callPagePiBrowser/piBrowserEval` 的只读路径未透传命令 timeout。
- [x] Performance 契约：显式 `entryType` 只返回 `performance.getEntriesByType(entryType)`；空结果就是 `count:0`，不得 fallback 全量 entries。未指定 entryType 时默认 `resource`，并在返回中标记 `explicit_entry_type:false`。
- [x] Timeout 契约：`browser_evidence` 的 performance 源会把顶层 `timeoutMs/timeout_ms` 和 performance params 传给 `getPerformanceEntries()`；`hook.status`/`hook.collect`/`hook.evaluate` 与 `callPagePiBrowser`/`piBrowserEval` 会把命令 timeout 传入 CDP `Runtime.evaluate`。
- [x] 契约：`check-pi-browser-bridge.mjs` 覆盖 missing entryType 返回空数组、不 fallback `performance.getEntries()`、evidence performance timeout/entryType/nameContains 透传、hook.status 与 `callPagePiBrowser` timeoutMs 透传到 evaluate options。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步 performance entryType 与 timeout 行为。

## 169. Bug 43/44/48：frame new-document script 生命周期

- [x] 事实复核：确认 `frame.addNewDocumentScript` 仍只传 `msg.options`，忽略顶层 `runImmediately/worldName/includeCommandLineAPI`；确认 `removeNewDocumentScript` 对未知 identifier 仍幂等成功且成功结果结构不稳定。
- [x] Add 契约：顶层 `runImmediately`、`worldName`、`includeCommandLineAPI` 与 `options` 合并，顶层显式值优先；返回稳定 `{ identifier, sessionKey, cdpSessionName, tabId }`。
- [x] Registry 契约：bridge 维护 tab/session scoped new-document identifier registry；只允许 remove 已知 identifier。未知 identifier 返回 `SCRIPT_NOT_FOUND`，不得伪装成功。
- [x] Remove 契约：已知 identifier 正常 remove 和 Chrome 已清掉的 known identifier 都返回同一结构 `{ identifier, removed, alreadyRemoved, sessionKey, cdpSessionName, method }`；未知 identifier 是错误。
- [x] 契约：`check-pi-browser-bridge.mjs` 覆盖顶层 option 透传、runImmediately 生效参数、未知 id 错误、known alreadyRemoved 稳定结构。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步 frame script lifecycle。

## 170. Bug 45/55：wait.diagnose frame 探测与 evidence hook_status 摘要字段

- [x] 事实复核：确认 `wait.diagnose` frame probe 仍使用 `document.frames`；确认 `summarizeEvidenceData()` 的 `hook_status` summary 仍未保留 `state/session_id/installed_at/dispatcher_version/install_epoch`。
- [x] Diagnose 契约：frame 探测改用 `document.querySelectorAll('iframe')` 与 `window.frames.length`；返回每个 iframe 的 index、id/name/src、可见基础信息和 `frameCount/iframeCount`，不依赖非标准 `document.frames`。
- [x] Evidence summary 契约：`hook_status` 摘要保留最小现场判断字段：`state`、`session_id`、`installed_at`、`dispatcher_version/pi_browser_version`、`install_epoch`、`buffer_used/buffer_count`；继续避免事件明细和敏感内容膨胀。
- [x] 契约：`check-pi-browser-bridge.mjs` 覆盖 diagnose iframe fixture；`check-summaries.mjs` 覆盖 hook_status 字段不丢失。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步 diagnose/evidence summary 字段。

## 171. Bug 58/68/70：browser_html 采集预算、artifact 与结构统计分离

- [x] 事实复核：确认 `registerHtmlTool.ts` 仍把工具返回预算 `maxChars` 写入 bridge `body.maxChars`；确认 `summarizeHtmlSnapshot()` 仍基于可能已截断的 `html` 字符串计算 links/buttons/forms/images。
- [x] 预算契约：区分“采集预算”和“返回预算”。工具层 `maxChars` 只控制返回文本预算；只有用户在 `params.maxChars/max_bytes` 显式声明采集限制时，才传给 bridge 截断采集内容。
- [x] Artifact 契约：`detailLevel:"full"` 或显式 `outputPath` 时，必须先抓足够原始 HTML/text，再由 resultMiddleware 决定落 artifact；不得因小返回预算导致 artifact 只保存 80 字符级截断结果。
- [x] Summary 契约：bridge 侧在截断前计算并返回结构元数据（links/buttons/inputs/forms/images/text length/original bytes）；summary 优先使用这些元数据，不再从截断 HTML 反推结构计数。
- [x] 契约：`check-pi-browser-bridge.mjs` 覆盖 html.get 结构元数据；`check-tools-contract.mjs` 锁定工具层不把普通 `maxChars` 写成 bridge `body.maxChars`；`check-summaries.mjs` 覆盖截断 HTML summary 仍保留真实 link count。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步采集预算与返回预算区别。

## 172. Bug 61/65/66：browser_artifact sample 去重与 JSON 缺失路径显式信号

- [x] 事实复核：确认 `sampleText()` 小文件 head/middle/tail 可返回完全重叠内容；确认 `readJson()` 对缺失 `jsonPath` 返回 `type:"undefined"` 且 `value` 被 JSON 序列化丢失；确认 `pick` 缺失路径导致 summary 与 value 不对齐。
- [x] Sample 契约：sample sections 现在只返回非重叠片段；小文件退化为唯一 `head` 片段，并在 summary 暴露 `sample.dedupedSections`。
- [x] JSON path 契约：单个 `jsonPath` 缺失时返回稳定成功结构 `{ exists:false, notFound:true, jsonPath, value:null }`，便于 agent 继续检查其它路径。
- [x] Pick 契约：`pick` 返回与请求路径一一对应；每个 path 包含 `{ exists:boolean, jsonPath, value:any|null }`，缺失项不会因 `undefined` 序列化被删除。
- [x] 契约：`check-artifact-reader.mjs` 覆盖小文件 sample 去重、jsonPath missing、pick mixed existing/missing、summary keyCount 与 value 对齐。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步 artifact JSON missing 与 sample 去重语义。

## 173. Bug 83/85：content/scan 超大结果绕过 exec.js MAX_CHARS

- [x] 事实复核：确认 `browser_content` / `browser_scan` outputPath 场景虽把采集预算提高到 500000，但结果仍经过 `bridge/pi_browser_bridge/exec.js` 的 `MAX_CHARS=200000` smart serializer，导致 artifact 保存的已经是被 bridge 压缩后的内容。
- [x] 架构决策：采用 direct CDP `Runtime.evaluate returnByValue` 作为 content/scan 抽取结果通道，继续复用 TS 端 `resultMiddleware` 落 artifact；不扩大普通 `browser_execute` serializer 全局预算，也不引入 bridge 侧文件写入边界。
- [x] Content 契约：`browser_content outputPath` 对超过 200k 的正文保存脚本声明预算内的真实 Markdown/envelope；artifact 长度、summary `markdownChars/originalLength/truncated` 与文件内容一致，不出现 serializer 追加的 `…` 伪截断。
- [x] Scan 契约：`browser_scan outputPath` 对超过 200k 的 content 保存真实 scan envelope；`contentChars/truncated` 与 artifact 一致，不被 `exec.js` 总字符预算提前截断。
- [x] 契约：`check-content-pick.mjs` 增加 fake direct-CDP 大文本 fixture，覆盖 content/scan >200k outputPath artifact 长度、脚本截断标记和无 serializer ellipsis；静态锁定 content/scan 使用 `evaluatePageScriptDirect()`。
- [x] 文档：README/CHANGELOG/skill/桌面审计报告同步大结果通道和 artifact 保真边界。

## 174. 剩余 Bug 完成后的真实运行与收口 gate

- [x] 全量静态/契约验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"` 已通过；`PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools` 已通过。
- [x] 真实浏览器 smoke 尝试：`npm run smoke:browser` 已执行但 `127.0.0.1:18765` 被现有 bridge 占用；占用进程为 `node.exe` PID 26612（`@earendil-works/pi-coding-agent/dist/cli.js`），按规则未关闭用户现有 bridge；结果写入 `.pi/browser-artifacts/smoke-browser-results.json`。
- [x] Callable 子集：reload 后真实 runtime callable 子集已通过，覆盖 download invalid mode、hook session/listener cleanup、evidence/performance、frame add/remove、html artifact、artifact missing/sample、content/scan >200k artifact；汇总证据写入 `.pi/browser-artifacts/todo174-runtime-callable-summary-reload.json`。
- [x] 文档收口：桌面审计报告当前总览已更新为 Bug 1-89 全部覆盖；TODO 中 164-173 全部勾选；runtime smoke 阻塞原因已记录。

## 175. WebSecurity TS 注册层门面化拆分（支柱一 / 第一阶段）

- [x] 性质判定：这是 prerequisite refactor debt，不是功能新增；目标是降低 `src/tools/registerWebSecurityTools.ts` 单体风险，保持 12 个 `browser_*` 安全工具的 tool name、schema、预算、artifact、summary 和错误语义不漂移。
- [x] 拆分边界：新增 `src/tools/webSecurity/register/`；每个复杂工具拥有独立 `register*.ts`，共享 shell/helper/schema 片段进入 `register/shared.ts`；原 `src/tools/registerWebSecurityTools.ts` 只保留 facade re-export/聚合注册兼容层。
- [x] 风格修复：同步展开 `src/tools/registerTools.ts` 中 webSecurity import/call，恢复一行一注册；不要把多个注册调用堆在一行制造 diff 噪声。
- [x] 表驱动决策：不为了“看起来短”改表驱动；仅当能减少重复、保留类型推断、降低漏注册风险时，在拆分后引入 `{ name, schema, run, summarize }` 级别的局部表驱动。
- [x] 契约：扩展/复跑 `tests/contracts/check-web-security-tools.mjs` 与 `check-tools-contract.mjs`，锁定全部 12 个工具仍注册、schema 必填字段/默认值不变、`ensureStarted`/cookie provider/outputPath/detailLevel 行为不变。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"` 已通过；本项为内部注册重排，README 仅更新内部边界，CHANGELOG/TODO 记录架构收口，skill 不新增能力叙述。

## 176. WebSecurity 摘要层按能力拆分（支柱一 / 第二阶段）

- [x] 性质判定：这是 behavior-preserving refactor；目标是拆解 `src/tools/summaries/webSecurity.ts` 单体，同时保持 `src/tools/summaries/index.ts` 对外导出不变。
- [x] 拆分边界：新增 `src/tools/summaries/webSecurity/`；按能力族拆分 `recon/crawl/fuzz/sqli/bridges/template/oast/cookie/replay` 等 summary 模块；原 `webSecurity.ts` 降级为兼容 facade。
- [x] 共享逻辑：Cookie/Auth/header 脱敏、表格裁剪、数组摘要、artifact hint 等通用函数只保留一份共享实现，禁止各子模块复制后分叉。
- [x] 证据原则：summary 继续“压缩展示，不替代证据”；不得丢失 artifact 路径、body/postData availability、fingerprint、oracle、match/extractor 等现场判断字段。
- [x] 契约：扩展/复跑 `tests/contracts/check-summaries.mjs`，用代表性 fixture 锁定每个安全工具 summary 关键字段、脱敏规则和大结果裁剪语义。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"` 已通过；本项为 behavior-preserving summary 拆分，README/CHANGELOG 更新内部边界，skill 不新增能力叙述。

## 177. WebSecurity 参数与 shell 类型收口

- [x] 性质判定：这是内部类型强化；解决 `WebSecurityToolParams` 依赖 `[key: string]: unknown` 的扩散问题，不能改变外部 JSON schema 兼容性。
- [x] 收口路径：保留外部 TypeBox schema 的宽入口，在每个 register 模块内 normalize 到强类型 params；shell helper 使用泛型约束每个工具的 `augmentParams/run/details/distill`，避免核心实现层继续接收松散 `Record<string, unknown>`。
- [x] Cookie/browser-state 绑定：`tabId/detailLevel/outputPath/timeoutMs/maxChars/maxBodyBytes/bindBrowserSession` 等共享参数保留统一解析函数；浏览器 cookie provider 的输入输出类型显式化。
- [x] Core 边界：`webSecurityCore.ts` 的纯再导出命名问题不单独大改；如拆分后仍混淆，随本项改为目录 `webSecurity/index.ts` 或更明确 facade 名，保持 import 兼容迁移。
- [x] 契约：TypeScript 编译必须捕获错拼字段/签名漂移；补静态 contract 检查注册模块和 run* 参数映射，不依赖运行时才发现。
- [x] 验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"` 已通过；本项未改变工具 schema/summary/runtime 能力，README/CHANGELOG 更新内部类型边界，skill 不新增能力叙述。

## 178. Bridge JS 超大文件拆分评估与第二阶段执行

- [x] 性质判定：`bridge/wait.js`、`hook_dispatcher.js`、`network.js` 已超过健康阈值，但它们处在 MV3 service worker / 页面注入高风险边界；本项作为 Bridge JS 子阶段，不与 TODO 175-177 的 TS 层重构混在同一 diff。
- [x] 拆分顺序：已做只读依赖图和全局符号图：`background.js` 通过 MV3 `importScripts` 顺序加载；`tsconfig.bridge.json` 覆盖同目录 `*.js`；`check-pi-browser-bridge.mjs` 对 `wait.js/network.js` 使用 VM 组合执行；`hook_dispatcher.js` 是页面注入文件，不按 SW 全局脚本方式拆。
- [x] 执行边界：本阶段先拆低风险 `network.js`，新增 `bridge/pi_browser_bridge/network_model.js` 承载 recorder 状态、配置归一、过滤、record/body 存储与 summary clone helper；`network.js` 收敛为 CDP 事件、生命周期、list/get/body/exportHar/wait 和命令分发。
- [x] 行为边界：未改变 service worker 生命周期、长等待租约、hook session/listener cleanup、network body/postData 捕获、错误码和 artifact 注册语义；`background.js` 明确保持 `patterns.js -> wait.js -> network_model.js -> network.js` 加载顺序。
- [x] 契约：`check-bridge-files.mjs` 与 `check-pi-browser-bridge.mjs` 已纳入 `network_model.js` 必备文件、加载顺序和 VM 组合源码；`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"` 已通过。
- [x] 真实浏览器 runtime：`npm run smoke:browser` 未运行，因为会抢占现有 `127.0.0.1:18765` bridge；已由当前会话内真实扩展 runtime 子集补测覆盖，结果写入 `.pi/browser-artifacts/runtime-bridge-validation-results.json`，截图证据为 `.pi/browser-artifacts/screenshot-1779252971729.png`。
- [x] 文档：README/CHANGELOG/TODO 只记录内部可维护性；无用户可见 schema/summary/runtime 能力变化，未更新 skill 当前能力描述。

## 179. WebSecurity/Bridge 重构收口 gate

- [x] 完成 TODO 175-177 后，确认 `registerWebSecurityTools.ts` 与 `summaries/webSecurity.ts` 只承担 facade/兼容导出：当前分别为 14 行和 1 行；`check-web-security-tools.mjs`、`check-summaries.mjs`、`check-tools-contract.mjs` 已锁定 thin facade、按工具/能力族拆分、共享 shell/脱敏 helper 不回流。
- [x] 完成 TODO 178 任一子阶段后，记录拆分文件、保留的全局加载顺序、reload runtime artifact 路径和未拆剩余风险：`network_model.js` + `network.js` 已拆；加载顺序为 `patterns.js -> wait.js -> network_model.js -> network.js`；真实扩展 runtime 子集通过，artifact 为 `.pi/browser-artifacts/runtime-bridge-validation-results.json`，覆盖 bridge/tabs/wait/scan/content/html/frame/hook/network/screenshot/close，其中 network 返回 `bodyAvailability:"captured"`；未拆风险保留在 `wait.js` 和页面注入 `hook_dispatcher.js`，后续需单独 TODO 与 bundling/注入设计。
- [x] 契约收口：`check-bridge-files.mjs` 新增 Network split 边界，锁定 `network_model.js` 不承载 CDP/命令逻辑、`network.js` 不回吸 recorder model helper，并限制拆分后文件体量。
- [x] 全量验证：`cmd.exe /c "cd /d D:\Pi\agent\extensions\pi-browser-tools && npm run check"` 已通过；本轮未触及全局 skill，未运行 skill quick validate。
- [x] 收口更新：TODO 勾选、README/CHANGELOG 记录架构维护项；本轮无 schema/summary/runtime 用户可见能力变化，未更新 skill 当前能力描述。

## 下一步建议顺序

1. 已完成 TODO 175：WebSecurity 注册层 facade 拆分，并修复 `registerTools.ts` 一行多调用风格。
2. 已完成 TODO 176：summary 按能力族拆分，并保留脱敏/证据字段契约。
3. 已完成 TODO 177：在拆分后的较小模块内收口参数类型，避免一次性强类型化大单体。
4. 已完成 TODO 178：Bridge JS 先拆 Network recorder 子阶段，保留 MV3/importScripts 与 VM 契约边界。
5. 已完成 TODO 179：重构收口 gate、契约和文档维护完成；当前 TODO 队列无未完成项，新增工作需先按 TODO Workflow 写清范围、决策、契约和验证。
