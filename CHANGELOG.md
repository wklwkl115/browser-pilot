# Changelog

## Unreleased

- 优化工具结果 token 路径：默认 summary 蒸馏、artifact 可追溯、`details` 紧凑化。
- 新增 artifact 局部读取内部约束：相对路径限定 `.pi/browser-artifacts/`，其他文件需绝对路径。
- 拆分 summary 逻辑并新增 `check:summaries` / `check:artifact` 契约验证。
- 收敛错误归一化与诊断契约，新增 `check:errors`。
- 完成真实浏览器 smoke：tabs/create/loadState/scan artifact/network/screenshot/close 通过；截图写入 `.pi/browser-artifacts/smoke-screenshot.png`。
- 收敛性能维护项：artifact 文本读取流式化、network 摘要增强、scan 噪声规则外置、预算表驱动、check:bridge 拆分。
- 补齐原始数据蒸馏覆盖：execute/wait/hook/frame/html fallback 统一经过 `resultMiddleware`，默认保留 preview 并支持 artifact。
- 新增 `browser_pick` 与 `browser_content`：参考 `badlogic/pi-skills/browser-tools` 的交互点选和正文提取能力，复用现有 bridge/CDP/蒸馏/artifact 体系。
- 借鉴 Curio 补齐 `browser_query` / `browser_click` / `browser_type` 一等 DOM 工具，并增强 `browser_execute` 对 Map/Set/Error/BigInt/DOM/循环引用的结果序列化。
- 性能质量收敛：smoke 覆盖新工具链、query visibleOnly 单次摘要、exec 序列化预算、统一 page-script 契约、结构化元素错误、artifact 原子写入、工具文档漂移检查。
- 文档职责重分层：`AI_INSTALL.md` 负责安装/环境 SOP，README 作为项目入口，Pi skill 只面向正式浏览器使用场景。
- 借鉴 Codex Chrome 补齐 `browser_download` / `browser_upload`：下载回传 Chrome 本地路径，上传经文件选择器和显式确认。
- 补齐上传/下载全量测试：纯参数校验、bridge runtime 模拟、summary、错误映射、cleanup 与显式 transfer smoke。
- 修复 media 下载真实浏览器超时：先提取媒体 URL，再用 Chrome downloads API 下载并回传稳定路径。
- 收敛测试/正式文件边界：契约测试迁到 `tests/contracts/`，smoke 迁到 `tests/smoke/`，`scripts/` 仅保留生成器/loader，并新增 `check:boundaries`。
- 统一过滤翻译类插件噪声：Read Frog、Google Translate、Immersive Translate 等 wrapper/overlay/属性不再污染 scan/content/html summary/元素摘要。
- 完成重载后的最终全量真实浏览器回归，覆盖所有浏览器工具、上传下载和翻译噪声过滤；结果写入 `.pi/browser-artifacts/final-full-browser-smoke-results.json`。
- 修复审查发现：`browser_execute` 禁止绕过 `browser_upload` 校验，遗漏契约纳入 `npm run check`，click 下载优先 tab-scoped 关联，`browser_pick`/`wait.selector` 补齐翻译噪声过滤。
- 重载 smoke 后继续收敛：工具错误结果默认不再返回 stack，`browser_pick` 命中翻译 wrapper 时归一到最近真实父元素。
- 最终 smoke 发现并修复 `browser_execute` 生成脚本中 `/\s+/` 被模板字符串误转成 `/s+/` 的问题，保留返回字符串的 `s` 与换行。
- 最终全量真实浏览器 smoke 通过：tabs/wait/scan/content/html/artifact/execute/query/type/click/pick/network/hook/evidence/frame/screenshot/download/upload；结果写入 `.pi/browser-artifacts/final-smoke/results.json`。
- 修复复审发现：`browser_content` 导航返回 `ok:false` 时立即失败并清理嵌套 stack，Pi extension 启动失败后清空 `startPromise` 以允许重试。
- 新增 Visible / Semantic DOM 节点层：`browser_dom_snapshot` 返回当前视口可见语义节点与短期 `nodeId`，`browser_dom_click` / `browser_dom_type` 基于 DOM selector/framePath 执行动作，不使用屏幕坐标；动作摘要保留 framePath/root-relative bbox，拒绝跨 tab 复用 nodeId，DOM 失效错误会解包为 `DOM_NODE_*` 且默认剥离 nested stack。
- 修复 semantic DOM 复审问题：`browser_dom_type` 使用 native value setter + `InputEvent` 兼容受控输入，`browser_dom_click` 重算 clickability 并对纯语义节点返回 `DOM_NODE_NOT_CLICKABLE`。
- 完成 semantic DOM 修复后的完整真实浏览器回归：tabs/wait/scan/content/html/artifact/execute/query/type/click/dom/pick/network/hook/evidence/frame/screenshot/download/upload 全通过，结果写入 `.pi/browser-artifacts/final-smoke/results.json`。
- 按 skill-creator 要求收口文档：全局 skill 保持 runtime-only 触发契约，`AI_INSTALL.md` 聚焦安装/reload/check/smoke/诊断，README 保持项目入口与维护指针。
- 修复 `browser_dom_snapshot` iframe 可见性：同源 iframe 内节点按祖先 iframe 可视区域裁剪，不再返回 iframe 当前不可见的子节点。
- 修复 wait/hook 复审问题：`wait.navigation` 注册 webNavigation/tabs/CDP 完成/失败监听，避免空 URL 误匹配 targetUrl，并加入 current URL / readyState 轮询兜底；`hook.getPerformanceEntries` 返回解包后的 `entries`，`hook.add/removeEventListener` 实际保存并移除页面 handler。
- 修复工具参数与契约漂移：native/evidence/transfer/screenshot 将 `timeoutMs` 写入 bridge command，`browser_scan` textOnly 遵守 `maxNodes` 且截断时保留已收集文本，`browser_html` 支持 `fragment` / `raw` mode 别名。
- 修复 `exec.js` 序列化对 scan/content 大文本字段的 1000 字符嵌套截断：`content` / `markdown` / `html` 使用全局字符预算，确保 artifact 能保存完整抽取结果。
- 修复 CDP/download/port 配置复审问题：`frame.evaluate` 使用正确 `grantUniversalAccess`，click 下载不再用全局下载 fallback 误配其它 tab，bridge 默认 host/port 改为生成配置并加入漂移检查。

## 0.3.0 - 2026-05-16

- 发布 `Pi Native Browser Bridge`（`version_name: 0.3.0-pi-native`）。
- 切换 Pi 工具到原生桥：tabs/execute/scan/wait/network/hook/frame/html/screenshot。
- 拆分桥模块：`cdp.js`、`runtime.js`、`network.js`、`frame.js`、`html.js`、`screenshot.js`、`compat.js`、`transport.js`、`hook_dispatcher.js`。
- 新增静态契约、scan 回归、fake WS 测试。
