# Pi Browser Tools

Pi 原生浏览器工具扩展，提供真实浏览器 tab 控制、GA-style 简化 DOM 扫描、JavaScript/CDP 执行、正文提取、网络证据、上传下载、截图、artifact 局部读取、Web 探测/请求重放和原生 bridge 命令。

## 职责划分

- 安装、环境变量、浏览器扩展加载、reload、check/smoke、排障：见 `AI_INSTALL.md`。
- Pi 正式使用场景、工具选择、输出风格、诊断约定：见全局 skill `D:/Pi/agent/skills/pi-browser-tools/SKILL.md`。
- 本 README 只作为项目入口、工具清单和维护入口。

## 工具清单

- `browser_tabs`：list / switch / create / close / selectBrowser。
- `browser_execute`：执行 JavaScript 或发送 bridge command；常规点击、输入、复杂页面操作默认在这里用 JS/CDP 一次性完成；可选 `monitor:true` 返回执行前后 scan diff；上传必须使用 `browser_upload`。
- `browser_scan`：GA-style 简化 DOM/text 扫描，可包含同源 iframe；返回 `actionables` 候选表（selector/action/label/point/hitOk）与 `list_hints` 重复列表提示，用于生成后续执行脚本。
- `browser_pick`：用户交互点选页面元素，返回 selector 和摘要。
- `browser_content`：提取当前页或指定 URL 的正文 Markdown。
- `browser_download`：通过 selector click、media selector 或 URL 下载并回传 Chrome 本地路径；click 会优先用可提取 URL 或 tab-scoped 下载事件关联。
- `browser_upload`：通过文件选择器上传绝对本地文件路径，要求 `confirm:true`。
- `browser_wait`：导航、selector、load state、network idle 等等待。
- `browser_network`：Network recorder 的 start/list/get/body/exportHar/wait。
- `browser_hook`：页面事件 hook 的 install/collect/status/uninstall/evaluate 等。
- `browser_evidence`：聚合 hook/network/performance 证据。
- `browser_frame`：frame 列表、frame 内执行、新文档脚本。
- `browser_html`：HTML/text snapshot。
- `browser_screenshot`：截图并保存 artifact。
- `browser_artifact`：按行、JSON path、关键词或抽样读取 artifact。
- `browser_recon_probe`：小范围 URL/路径/端口/scheme 探测，返回 status/title/header/tech hints/fingerprint/redirect/body hash/favicon sha256/mmh3/simHash/TLS 证书摘要。
- `browser_crawl`：有界同源 crawl，提取 links/forms/known files/JS endpoint hints，展开 OpenAPI endpoints 与 schema 参数摘要，主动/被动结构化 GraphQL introspection，解析 service worker cache routes 与版本摘要、source map 内容与反向源文件归档，并归档结构化结果。
- `browser_fuzz_paths`：有界 path/file/route/extension fuzzing，支持 matcher/filter/rate、multi-FUZZ tuple、递归目录深度、auto/exact/cluster baseline、响应聚类和 artifact 归档。
- `browser_fuzz_vhosts`：有界 Host header / virtual-host fuzzing，支持 Host/SNI 模式、多 baseline host、HTTPS 证书摘要、baseline cluster 过滤和响应聚类。
- `browser_sqli_probe`：从 URL/raw/captured request 模板执行 SQLi boolean/error/time/union oracle 探测，输出 DBMS 指纹、ORDER BY/UNION 列数 hint、UNION 回显位和布尔盲注抽取证据，并支持在确认命中后按参数短路后续 probe。
- `browser_sqlmap_bridge`：通过 Pi-native bridge 调用 `sqlmap`，支持 URL/raw/captured/HAR 请求输入、浏览器态 cookie 绑定、显式 launcher 或 PATH/module auto-detect、结构化 findings，并将 request/stdout/stderr 注册为可由 `browser_artifact` 直接读取的 artifact 描述符。
- `browser_nuclei_bridge`：通过 Pi-native bridge 调用 `nuclei`，支持 scoped URL/raw/captured/HAR 请求输入、模板/工作流/ID/tag/severity 选择器、浏览器态 cookie 绑定、显式 launcher 或 PATH auto-detect、结构化 matches，并将 request/stdout/stderr 注册为可由 `browser_artifact` 直接读取的 artifact 描述符。
- `browser_template_check`：对 scoped target 或 captured request 执行内置/自定义 HTTP 模板、YAML/JSON 模板文件、DSL matcher/extractor、变量替换、结果去重和证据归档。
- `browser_callback_oast`：启动/触发/收集/停止本地 HTTP/HTTPS/DNS callback listener，生成 correlation ID、外部 metadata，并持久化请求日志与事件状态。
- `browser_cookie_analyze`：Cookie/Set-Cookie/JWT/JWE/PASETO/签名 session 解析、secret candidate 验证、claim mutation token 生成与有界 claim replay 校验。
- `browser_fuzz_params`：从 URL/raw/captured request 模板做 query/JSON/form/multipart/header 参数 fuzzing，支持 nested JSON path、set/add/delete、JSON values、multipart 文件字段矩阵、同名多文件字段、嵌套 multipart、Content-Type boundary variants、parser 差异聚类和 diff classifier。
- `browser_http_replay`：从 raw/captured/HAR request 重放 HTTP 请求，支持 method/header/body mutation、multipart/binary body、multipart 文件字段变体矩阵、请求序列变量提取/注入、更多 extractor 类型、变量作用域控制、HAR 依赖图、响应 diff 聚类、baseline diff 与浏览器 cookie 绑定。

## Web 安全层内部边界

- 单包内固定分层：`src/tools/webSecurity/browserNative`、`src/tools/webSecurity/bridges`、`src/tools/webSecurity/shared`
- Pi-native 核心执行层保留在 `browserNative`；成熟引擎适配只放进 `bridges`
- 这里收敛的是实现分层、维护面和成熟替代接入方式；不在工具层增加能力弱化默认值、风险分级闸门或安全收缩文案

## Pi 命令

- `/browser-status`：查看 bridge server、扩展连接、tabs、pending 请求。
- `/browser-install`：输出浏览器扩展安装路径。
- `/browser-reload`：请求浏览器扩展 reload 并等待重连。

## Token 预算约定

- 默认 `detailLevel:"summary"` 使用确定性预算裁剪和表格化数组，减少重复 JSON key；`preview/full` 与 artifact 保留原始结果。
- 操作流程保持 GA-style：`browser_scan` 观察页面 → `browser_execute` 执行定制 JS/CDP → `browser_wait` 等待 → 再 `browser_scan`/`browser_execute` 复查。
- 复杂站点优先在单段脚本内完成定位、可见性判断、点击/输入和结果读取，避免拆成固定 selector 动作工具。

## GA-style 执行脚本模板

```js
(() => {
  const el = document.querySelector('selector-from-scan');
  if (!el) return { ok: false, reason: 'not found' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return { ok: false, reason: 'covered' };
  el.click();
  return { ok: true, text: el.innerText || el.value || '' };
})()
```

输入类页面优先用页面真实事件：`focus()`、native value setter、`InputEvent`、必要时 CDP `Input.insertText`。复杂卡片点击优先用 scan 返回的 `point` 发 CDP `Input.dispatchMouseEvent`。

CDP 输入最小闭环：先用 `browser_execute` JS 定位并 `focus()`，再用 command `{cmd:'persistent_cdp',action:'send',cdpMethod:'Input.insertText',params:{text:'...'}}` 输入，最后 JS 读取状态；清空用 `Ctrl+A` + `Backspace` 的 `Input.dispatchKeyEvent`。需要 GA-style 自动变化摘要时，给 JS 模式传 `monitor:true`。

## 维护入口

- 契约测试：`tests/contracts/`
- 真实浏览器 smoke：`tests/smoke/`
- 最终全量 smoke 结果：`.pi/browser-artifacts/final-smoke/results.json`
- 全局 skill 验证：`PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`
- 生成器/loader：`scripts/`

```bash
npm run check
npm run smoke:browser
npm run smoke:browser:transfer
```

当前最终 smoke 覆盖 tabs/wait/scan/content/html/artifact/execute/pick/network/hook/evidence/frame/screenshot/download/upload。

`bridge/native_command_schema.json` 是命令协议单一事实来源。修改协议后执行：

```bash
npm run sync:protocol
npm run check
```

## 参考

- 安装 SOP：`AI_INSTALL.md`
- 迁移说明：`docs/browser-usage.md`
- 资产同步：`docs/asset-sync.md`
