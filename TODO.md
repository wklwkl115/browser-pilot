# TODO

## 1-14. 原生桥迁移与模块化收敛
- [x] 完成 Pi Browser Bridge 原生扩展迁移，保留 tabs/execute/scan/wait/network/hook/frame/html/screenshot 能力。
- [x] 拆分 bridge 模块与协议入口，移除 `browser_pro` 兼容路径。
- [x] 将 `bridge/native_command_schema.json` 作为协议单一事实来源，并生成浏览器侧协议文件。
- [x] 将 `registerTools.ts` 收敛为薄组合入口，按工具域拆分注册文件。
- [x] 将 `transport.js` 缩成 WebSocket 连接、探测、重连、keepalive 与 envelope 处理入口。
- [x] 增加静态契约，防止 bridge/transport/tools 回退为业务大文件。
- [x] 运行 `npm run check` 验证。

## 15. Pi token 消耗优化（保持能力不变）
- [x] 工具结果 `details` 改为紧凑 metadata，不再隐式携带完整 `result`。
- [x] 对 `details` 做递归紧凑化，限制大字符串、数组和深层对象进入模型上下文。
- [x] 修复 `browser_scan`/`browser_html`/`browser_evidence` 已保存 artifact 后仍在返回体夹带大 payload 的路径。
- [x] 为 `browser_network` 大结果增加 artifact 输出路径，默认返回摘要 + 路径。
- [x] 更新 README 的 token 预算约定。
- [x] 增加 `check:token` 静态/单元契约，防止大 payload 回流到工具结果。
- [x] 运行 `npm run check` 验证。

## 16. 确定性结果蒸馏中间件
- [x] 新增 `src/tools/resultMiddleware.ts`，在工具执行后、`toolResult` 前统一处理原始结果。
- [x] 增加 `detailLevel: summary | preview | full`，默认 `summary` 降低上下文占用。
- [x] 对 `browser_scan`、`browser_html`、`browser_evidence`、`browser_network` 做确定性摘要。
- [x] 保留可追溯 artifact：大结果或显式 `outputPath` 落盘，返回摘要 + 路径。
- [x] 扩展 `check:token` 覆盖蒸馏中间件契约。
- [x] 运行 `npm run check` 验证。

## 17. Artifact 局部读取工具
- [x] 新增 `browser_artifact` 工具，按路径读取浏览器工具生成的 artifact。
- [x] 支持 `text`、`json`、`search`、`sample` 模式。
- [x] 更新 README 与静态工具名单契约。
- [x] 扩展 `check:token` 覆盖 artifact 局部读取。
- [x] 运行 `npm run check` 验证。

## 18. 内部质量与 token 路径收敛（不新增功能）
- [x] 将参数归一化 helper 收敛到无 TypeBox 依赖的共享模块。
- [x] 为结果蒸馏与 artifact 读取补显式返回类型，稳定工具边界。
- [x] 收紧相对 artifact 路径读取策略：默认只允许 `.pi/browser-artifacts`。
- [x] 扩展 token/artifact 边界覆盖。
- [x] 运行 `npm run check` 验证。

## 19. 契约与可维护性收敛（不新增功能）
- [x] 将 scan/html/network/evidence 摘要逻辑拆到 `src/tools/summaries/`。
- [x] 新增 `check:summaries` 与 `check:artifact`。
- [x] 为 `artifactReader` 增加文件大小上限与结构化错误。
- [x] 工具结果默认预算改为集中表驱动。
- [x] 运行 `npm run check` 验证。

## 20. 可观测性与故障诊断收敛（不新增功能）
- [x] 新增 `src/utils/errors.ts`，统一工具侧错误归一化为 `code/message/details`。
- [x] 给 `BrowserBridgeServer` 超时错误增加紧凑诊断摘要。
- [x] 新增 `check:errors`。
- [x] README 增加故障诊断最短路径。
- [x] 运行 `npm run check` 验证。

## 21. 发布前收口
- [x] 跑真实浏览器 smoke：tabs/create/loadState/scan artifact/network/screenshot/close。
- [x] README 增加 token 友好自动化流程示例。
- [x] CHANGELOG 记录 smoke 结果。
- [x] 运行 `npm run check` 验证。

## 22. HTML/scan 噪声过滤收敛（不新增功能）
- [x] 增强 `buildScanScript`，过滤已知浏览器扩展浮层、自身 bridge 标记和扩展 URL 注入节点。
- [x] 修正 `textOnly` 路径，避免 `innerText` 把已忽略浮层重新带回上下文。
- [x] 增强 HTML summary 文本预览，去掉已知扩展噪声块。
- [x] 扩展 `check:scan` / `check:summaries` 覆盖噪声过滤契约。
- [x] 运行 `npm run check` 验证。

## 23. Scan 性能收敛（不新增功能）
- [x] 优化 `buildScanScript.push()`，用累计字符数替代每次 `lines.reduce()`。
- [x] 让 DOM 模式与 textOnly 模式共用同一套输出预算状态。
- [x] 扩展 `check:scan`，禁止恢复 `lines.reduce()`。
- [x] 运行 `npm run check` 验证。

## 24. 性能与维护性批量收敛（不新增功能）
- [x] `artifactReader` 的 `text/search/sample` 改为流式读取。
- [x] 完善 `browser_network wait/list` 摘要蒸馏。
- [x] 将 scan 噪声规则外置为 TS 常量。
- [x] 新增可选真实浏览器 smoke 脚本 `scripts/smoke-browser.mjs`。
- [x] 拆分 `check:bridge` 为 bridge-files/protocol/tools 三类契约。
- [x] 运行 `npm run check` 验证。

## 25. 原始数据蒸馏覆盖检查
- [x] 审计所有 `register*Tool`，确认大原始数据输出都经过蒸馏中间件或 artifact 局部读取。
- [x] 补齐 execute/wait/hook/frame/html fallback 蒸馏覆盖。
- [x] 扩展契约测试，禁止需要蒸馏的工具绕过 `resultMiddleware`。
- [x] 运行 `npm run check` 验证。

## 26. 补齐 browser-pick / browser-content 高价值能力
- [x] 参考 `badlogic/pi-skills/browser-tools`，新增 `browser_pick` 交互选择工具。
- [x] 新增 `browser_content` 可选导航并提取正文 Markdown。
- [x] 添加 summary、artifact、检查脚本和文档入口。
- [x] 运行 `npm run check` 验证。

## 27. 借鉴 Curio 补齐高价值 DOM 操作
- [x] 新增 `browser_query` / `browser_click` / `browser_type`。
- [x] 增强 `browser_execute` 复杂结果序列化与预算。
- [x] 增加结构化元素错误与契约检查。
- [x] 运行 `npm run check` 验证。

## 28. 性能质量收敛
- [x] smoke 覆盖 content/query/type/click/pick-lite。
- [x] query visibleOnly 单次摘要，减少重复计算。
- [x] 统一 page-script 契约与 exec 序列化预算。
- [x] artifact 写入改为临时文件 + rename。
- [x] 新增工具文档漂移检查。
- [x] 运行 `npm run check` 验证。

## 29. SOP / Skill / README 职责划分
- [x] 新增/更新安装 SOP：只负责项目安装、浏览器扩展安装、环境变量、reload、check/smoke 与故障排查。
- [x] 重写 Pi skill：面向正式使用场景，描述何时触发、如何选择工具、输出和安全约束，不包含项目开发测试流程。
- [x] 精简 README：作为项目入口，说明职责边界并链接 SOP 与全局 skill，保留工具清单和协议入口。
- [x] 将 `docs/browser-usage.md` 降级为迁移指引。
- [x] 更新文档契约检查。
- [x] 运行 skill validate 与 `npm run check` 验证。

## 30. 借鉴 Codex Chrome：上传/下载一等工具
- [x] 参考 Codex Chrome 的 file chooser 与 download 思路，补 `browser_upload` / `browser_download`。
- [x] 为浏览器扩展增加 `downloads` 权限和 transfer native commands，支持下载完成后的本地路径回传。
- [x] `browser_download` 支持 selector click、media selector、direct URL 三种触发方式。
- [x] `browser_upload` 使用 CDP `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` + `DOM.setFileInputFiles`。
- [x] 上传前要求显式 `confirm: true`，工具侧校验绝对路径、存在且为文件。
- [x] 扩展协议、注册入口、预算、README、skill、SOP 和契约测试。
- [x] 运行 `npm run sync:protocol`、skill validate 与 `npm run check` 验证。

## 31. 上传/下载全量测试补齐
- [x] 增加 Pi 工具层单测：注册、参数校验、确认门、绝对路径/存在性校验、sendCommand 形状、summary 输出。
- [x] 增加浏览器 bridge transfer 运行时单测：direct URL 下载、selector/media 下载、完成路径回传、上传成功、多文件限制、file access 错误映射、cleanup。
- [x] 增加协议/文档/脚本契约覆盖：transfer 命令、downloads 权限、工具文档漂移、可选真实浏览器 transfer smoke。
- [x] 将新测试纳入 `npm run check`，保留真实浏览器下载/上传为显式 smoke，不阻塞普通 check。
- [x] 运行 `npm run check`、skill validate，必要时运行 transfer smoke。
- [x] 真实浏览器手动 transfer smoke 通过：URL 下载、selector click 下载、media 下载、上传测试文件并验证页面回显。

## 32. 测试/正式文件边界收敛
- [x] 将契约测试从 `scripts/check-*.mjs` 迁移到 `tests/contracts/`，保留 `scripts/` 只放生成器/loader。
- [x] 将真实浏览器 smoke 从 `scripts/smoke-browser.mjs` 迁移到 `tests/smoke/`。
- [x] 更新 `package.json`、README、SOP 中的测试入口路径。
- [x] 增加 `check:boundaries`，防止正式代码依赖 `tests/`、`scripts/check-*` 回流或 legacy bridge 混入正式扩展。
- [x] 明确 `bridge/tmwd_cdp_bridge/` 为 legacy/reference，或从正式检查路径中隔离。
- [x] 运行 `npm run check` 与 skill validate 验证。

## 33. 翻译类插件噪声统一过滤
- [x] 建立统一噪声规则：Read Frog、Google Translate、Immersive Translate 等翻译插件 wrapper/overlay/属性。
- [x] 将统一规则接入 `browser_scan`、`browser_content`、`browser_html` summary、`browser_query/click/type` 元素摘要。
- [x] 元素摘要保留真实目标元素，但过滤翻译 wrapper 文本和 `data-read-frog-*` 等噪声属性。
- [x] 扩展契约测试，覆盖翻译 wrapper、overlay、HTML summary 和元素摘要。
- [x] 运行 `npm run check` 与真实浏览器抽样验证。
- [x] 重载后跑最终全量真实浏览器回归：tabs/wait/scan/content/html/artifact/execute/query/type/click/pick/network/hook/evidence/frame/screenshot/download/upload 全覆盖。
- [x] 清理本地 fixture 目录和本轮 smoke 下载文件。

## 34. 审查发现修复轮
- [x] 封堵 `browser_execute` 直接发送 `transfer.upload` 绕过确认与路径校验的路径。
- [x] 修复并纳入遗漏的 `check-pi-browser-bridge` 契约，增加 orphan contract 检查。
- [x] 收紧 click 下载匹配，优先用可提取 URL 或 tab-scoped CDP download 事件关联下载。
- [x] 将翻译插件噪声过滤补齐到 `browser_pick` 与 `wait.selector` 输出。
- [x] 扩展契约测试并运行 `npm run check` 验证。

## 35. 重载后 smoke 发现的错误 token 与 pick 收敛
- [x] 工具错误结果默认不返回 stack，避免错误路径放大模型上下文。
- [x] 扩展错误契约覆盖，确认 `errorResult` 只返回 code/message/details/name。
- [x] `browser_pick` 命中翻译 wrapper 时归一到最近真实父元素，避免返回 wrapper HTML。
- [x] 重新运行 `npm run check` 并复测 `browser_execute -> transfer.upload` 拒绝路径。

## 36. 最终全量 smoke 与复审
- [x] 修复 smoke 发现的 `browser_execute` 字符串序列化误把 `/\s+/` 生成为 `/s+/` 的问题。
- [x] 运行重载后的真实浏览器 smoke：tabs/wait/scan/content/html/artifact/execute/query/type/click/pick/network/hook/evidence/frame/screenshot/download。
- [x] 在获得 exact path 上传确认后运行 `browser_upload` smoke。
- [x] 运行 `npm run check` 与结构化复审。
- [x] 清理 smoke 临时 server、下载文件和测试 tab。

## 37. 发布前文档与 skill 验证
- [x] 确认 README / AI_INSTALL / CHANGELOG 记录最终验证入口与结果路径。
- [x] 确认全局 skill 仍只包含正式浏览器使用流程，不混入项目安装/测试步骤。
- [x] 运行 `npm run check` 与 skill validate。

## 38. 复审 important 修复
- [x] `browser_content` 在 `wait.navigateAndWait` 返回 `ok:false` 时立即失败，不继续抽取旧页。
- [x] `browser_content` 导航错误详情去除嵌套 stack，避免错误路径回流大上下文。
- [x] Pi extension 启动失败后清空 `startPromise`，允许后续 `/reload` 或工具调用重试。
- [x] 增加契约覆盖并运行 `npm run check`。

## 39. Visible / Semantic DOM 节点层
- [x] 复审修复：`browser_dom_type` 复用 native value setter + InputEvent，兼容 React/Vue 受控输入。
- [x] 复审修复：`browser_dom_click` 校验 clickable，不对纯语义节点误报点击成功。
- [x] 新增 `browser_dom_snapshot`：提取当前视口内可见语义/交互元素，返回 snapshotId、nodeId、文本、role、tag、aria-label、可点击性、可编辑性、selector/path、bounding box。
- [x] 新增 `browser_dom_click(nodeId)`：基于最近或指定 snapshot 的 nodeId 定位 DOM 元素并点击，底层使用 selector/framePath，不按屏幕坐标。
- [x] 新增 `browser_dom_type(nodeId, text)`：基于 nodeId 定位可编辑 DOM 并输入文本，支持 clear/submit。
- [x] 设计 nodeId 生命周期：只在 Pi 当前进程内的 snapshot 会话有效，DOM 变化后要求重新 snapshot。
- [x] 增加摘要、预算、README、skill、契约测试与真实浏览器 smoke。
- [x] 运行 `npm run check` 与必要的真实浏览器复测。

## 40. semantic DOM 修复后完整真实浏览器回归
- [x] 准备 fixture 页面与最终 smoke artifact。
- [x] 覆盖 tabs/wait/scan/content/html/artifact/execute/query/type/click/dom/network/hook/evidence/frame/screenshot/download。
- [x] 上传 smoke 仅在用户批准精确本地文件路径后执行。
- [x] 清理临时 tab/server/download/upload fixture。
- [x] 更新最终 smoke 结果与状态文档。

## 41. 文档/SOP/Skill release 收口
- [x] 按 skill-creator 要求复核全局 skill：frontmatter 触发契约、职责边界、runtime-only、工具路由、安全与输出。
- [x] 更新 SOP `AI_INSTALL.md`：安装/环境/reload/check/smoke/诊断，不混入 runtime tool routing。
- [x] 更新 README/CHANGELOG：入口、工具清单、最终 smoke 结果路径与 semantic DOM 状态。
- [x] 运行 `npm run check` 与 skill validator。

## 42. semantic DOM iframe 可见性修复
- [x] 修复 `browser_dom_snapshot`：同源 iframe 内节点必须按祖先 iframe 可视区域裁剪，不返回 iframe 当前不可见的子节点。
- [x] 增加契约覆盖，防止回归。
- [x] 运行 `npm run check` 与必要 smoke。

## 43. wait/hook 复审修复
- [x] 修复 `wait.navigation`：注册 webNavigation/tabs/CDP 导航成功/失败监听，正常导航不再只等 timeout。
- [x] 修复 `wait.navigation` 复测发现的空 URL 误匹配 targetUrl，避免导航开始前被旧 lifecycle 事件提前完成。
- [x] 增加 `wait.navigation` current URL / readyState 轮询兜底，覆盖事件遗漏场景。
- [x] 修复 `hook.getPerformanceEntries`：解包 Runtime.evaluate `result.value`，返回 `{ entries, ... }` 给 evidence summary。
- [x] 修复 `hook.addEventListener` / `hook.removeEventListener`：保存 handler/target 并实际移除页面监听。
- [x] 增加契约覆盖并运行 `npm run check`。

## 44. 工具参数/scan/html 复审修复
- [x] 修复 native/evidence/transfer/screenshot 工具：把 `timeoutMs` 写入 bridge command，保证浏览器侧使用用户传入超时。
- [x] 修复 `browser_scan` textOnly：同样应用 `maxNodes` 计数与截断，避免大 DOM 全量遍历。
- [x] 修复 `browser_html` mode 合约：实现 `fragment/raw` 别名或修正文案。
- [x] 增加契约覆盖并运行 `npm run check`。

## 45. scan/content 大文本序列化复测修复
- [x] 修复 `exec.js` 结果序列化：`content` / `markdown` / `html` 字段使用全局字符预算，不被嵌套字符串默认 1000 字符截断。
- [x] 增加契约覆盖并运行 `npm run check`。
- [x] 浏览器重载后复测 `browser_scan` textOnly artifact 能保留超过 1000 字符且仍受 `maxNodes` 控制。

## 46. CDP/download/port 配置复审修复
- [x] 修复 `Page.createIsolatedWorld` 参数拼写为 `grantUniversalAccess`，并补 `frame.evaluate` 契约。
- [x] 修复 click 下载匹配：优先 tab/CDP download event；无精确匹配时报 ambiguous，不再使用全局下载 fallback。
- [x] 收敛 bridge 端口默认值：抽到生成配置并加漂移检查。
- [x] 运行 `npm run check`。
- [x] 浏览器重载后复测 `frame.evaluate` 与 click download 关键路径。
