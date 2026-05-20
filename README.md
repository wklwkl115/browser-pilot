# Pi Browser Tools

Pi 原生浏览器工具扩展，提供真实浏览器 tab 控制、GA-style 简化 DOM 扫描、JavaScript/CDP 执行、正文提取、网络证据、上传下载、截图、artifact 局部读取、Web 探测/请求重放和原生 bridge 命令。

## 职责划分

- 安装、环境变量、浏览器扩展加载、reload、check/smoke、排障：见 `AI_INSTALL.md`。
- Pi 正式使用场景、工具选择、输出风格、诊断约定：见全局 skill `D:/Pi/agent/skills/pi-browser-tools/SKILL.md`。
- 本 README 只作为项目入口、工具清单和维护入口。

## 工具清单

- `browser_tabs`：list / switch / create / close / selectBrowser；list 返回 `tabId`、browser-scoped `id` 与 `browserId`，可区分多浏览器相同数值 tabId；create 省略 URL 时创建并持续列出 `about:blank`；`selectBrowser` 优先使用该浏览器上报的 `active:true` tab 作为隐式目标，无活动 tab 时清空隐式目标并返回 `NO_TAB`，避免省略 `tabId` 时落到后台 tab 或跨浏览器回落。
- Tab-scoped 工具自动化场景应显式传 `tabId`；省略时使用当前 selected/latest fallback，断开或关闭后优先回退到同 browser 的 `active:true` tab，再用有效 latest；显式 stale `tabId` 会本地返回 `TAB_NOT_FOUND`，不会回落到其它 browser socket；结果会暴露 `target.source` 与 `selectionVersion` 便于诊断并发切 tab。
- `browser_execute`：执行 JavaScript 或发送 bridge command；只有显式 `command` 或含 `cmd` 的 JSON object string 会走 command 模式，其他 JSON-looking string 保持 JavaScript source；batch bridge command 会保留 `tabs.create/switch/close/list` 的 method 语义；常规点击、输入、复杂页面操作默认在这里用 JS/CDP 一次性完成；可选 `monitor:true` 在保留 `data/target/newTabs/acknowledged` 顶层执行结果的同时追加执行前后 scan diff；上传必须使用 `browser_upload`。
- `browser_scan`：GA-style 简化 DOM/text 扫描，可包含同源 iframe；返回 `actionables` 候选表（selector/action/label/point/hitOk）与 `list_hints` 重复列表提示，用于生成后续执行脚本；抽取结果走 direct CDP value 通道，`outputPath` 保存脚本声明预算内的真实 scan envelope，不再受 `exec.js` 20 万字符 serializer 截断。
- `browser_pick`：用户交互点选页面元素，返回 selector 和摘要；`focus:false` 时由工具层持有用户 `timeoutMs` 总 deadline，到期返回结构化 `{cancelled:true, reason:"timeout"}` 并通过页面 cleanup handle 清理 overlay/listeners，不把后台 tab timer throttle 暴露成 CDP `Runtime.evaluate` 超时。
- `browser_content`：提取当前页或指定 URL 的正文 Markdown；带 URL 导航复用 `browser_wait` 的 durable wait supervisor，并在详情中保留 supervisor 元数据；抽取阶段严格使用 `timeoutMs`，小于 100ms 的显式超时返回参数错误；selector 未命中返回 `SELECTOR_NOT_FOUND`，无效 selector 返回 `INVALID_SELECTOR`，命中空节点返回结构化 `empty:true`；抽取结果走 direct CDP value 通道，`outputPath` 保存脚本声明预算内的真实 Markdown envelope，不再受 `exec.js` 20 万字符 serializer 截断。
- `browser_download`：通过 selector click、media selector 或 URL 下载并回传 Chrome 本地路径；`mode` 只允许 `click|media|url`，selector 目标仅接受省略/`click`/`media`，URL 目标仅接受省略/`url`，冲突或未知值返回 `INVALID_RULE`；click 会优先用可提取 URL 或 tab-scoped 下载事件关联；主结果保留完整 bridge envelope（id/tabId/acknowledged/target/newTabs），摘要只压缩 payload。
- `browser_upload`：通过文件选择器上传绝对本地文件路径，要求 `confirm:true`。
- `browser_wait`：导航、selector、load state、network idle 等等待；`timeoutMs` 是总 deadline，传 `0` 会执行一次 immediate probe，`wait.navigation` 仅在当前 URL 与声明状态已匹配时成功，否则返回 `TIMEOUT`；`any/all` 复合等待要求非空 `waits/conditions`，子条件可直接使用 `wait.loadState` / `wait.selector` / `wait.navigation` 等完整 native command 名；`networkIdle.includeUrls/ignoreUrls` 使用有界 pattern 匹配；迟到的租约成功会转为 `WAIT_TIMEOUT`/`WAIT_STATE_LOST`；底层 lease 瞬时超时时会节流重试并记录 `retryDelayMs`；`navigateAndWait.timeoutMs` 覆盖导航+后续等待总耗时；长等待由 TS 端短租约 supervisor 跨 MV3 Service Worker 重启续证，结果暴露 `supervisor.workerRestarts/historyLost/leases`；`diagnose` 为只读目标 tab 诊断，不触发 hook auto reinstall，过滤目标 tab 的 listeners/CDP/debugger 数据，并通过 `querySelectorAll('iframe')` + `window.frames.length` 返回 `frameCount/iframeCount` 与 iframe 的 `id/name/src/visible/rect`。
- `browser_network`：Network recorder 的 start/list/get/body/exportHar/wait；默认对 XHR/Fetch/Document 的 JSON/text/html 响应有界即时抓取 body，并默认保留有界 request `postData`；可用 `captureBodies:false`、`bodyMimeAllow`、`maxBodyBytes`、`resourceTypes`、`captureRequestPostData:false` 控制采集；`network.get/list/body/exportHar` 暴露 `bodyAvailability/bodyUnavailableReason`，`network.body` 缺 body 时返回可诊断 `BODY_UNAVAILABLE`；`network.wait timeoutMs:0` 执行一次 immediate check；显式 `sessionId` 不回退 default，`list.nextOffset` 在末页为 `null`，缺失 request 返回 `REQUEST_NOT_FOUND`，二进制 body 截断保持 base64 可解码，`exportHar(format:"json", includeBody:true)` 只导出过滤命中的 body。
- `browser_hook`：页面事件 hook 的 install/collect/status/uninstall/evaluate 等；`options.redact_patterns` 使用有界安全正则，危险 pattern 降级为 literal 替换；status/collect/list_sessions 等只读命令不隐式重装 dispatcher，显式 `tabId` 的 list_sessions 只返回目标 tab scope；显式 `sessionId/session_id` 会严格匹配当前 dispatcher session，collect 不写入 lifecycle 自噪声，clear_buffer 保持全局 `seq` 单调递增；event listener registry 使用 `tabId::listenerId` 作用域，同名 listener 可跨 tab 并存，remove/uninstall/tab cleanup 只清目标 tab 并返回页面监听清理诊断；`performance` 显式 `entryType` 只读 `performance.getEntriesByType(entryType)`，空结果返回 `count:0`，未指定时默认 `resource`。
- `browser_evidence`：聚合 hook/network/performance 证据；顶层 `timeoutMs/timeout_ms` 会透传到 hook status/collect 的页面 evaluate 与 performance 子源，performance 支持 `entryType/nameContains` 与下划线别名；summary 会保留 `hook_status` 的 `state/session_id/installed_at/dispatcher_version/pi_browser_version/install_epoch/buffer_used/buffer_count`。
- `browser_frame`：frame 列表、frame 内执行、新文档脚本；`frame.list` 返回 `{ tabId, frameTree, frames, count }`，`frame.evaluate` 返回目标 `tabId/frameId` 元数据；`addNewDocumentScript` 支持顶层 `runImmediately/worldName/includeCommandLineAPI` 覆盖 `options`，并返回稳定 `identifier/sessionKey/cdpSessionName/tabId`；`removeNewDocumentScript` 只接受已登记 identifier，未知 id 返回 `SCRIPT_NOT_FOUND`，已知但 Chrome 已清理的 id 返回稳定 `alreadyRemoved:true`。
- `browser_html`：HTML/text snapshot；selector 未命中返回 `SELECTOR_NOT_FOUND`，无效 selector 返回 `INVALID_SELECTOR`，不再把普通 selector miss 报为 timeout；顶层 `maxChars` 只控制工具返回预算，不再写入 bridge 采集 `maxChars`，只有 `params.maxChars/max_bytes` 显式限制采集；`detailLevel:"full"` 或 `outputPath` 先抓原始 HTML/text 再由 resultMiddleware 落 artifact；summary 优先使用 bridge 截断前结构元数据统计 links/buttons/inputs/forms/images/text/original bytes。
- `browser_screenshot`：截图并保存 artifact；visible-tab fallback 只使用 Chrome 支持的 png/jpeg，并按实际捕获格式返回 `format/mime` 与默认文件扩展名。
- `browser_artifact`：按行、JSON path、关键词或抽样读取 artifact；text/search/sample 为流式读取，UTF-8 `chars` 按真实字符计数，空/越界结果不返回非法行区间，sample 小文件/重叠区段会去重并在 summary 标记，末页 `nextOffset:null`，长单行截断仍返回可读前缀；JSON `jsonPath` 未命中返回显式 `{exists:false, notFound:true, value:null}`，`pick` 每个请求路径都返回 `{exists,value}` 或 notFound 占位；search 的 `regex:true` 使用有界安全正则，危险 regex 明确拒绝。
- `browser_recon_probe`：小范围 URL/路径/端口/scheme 探测，返回 status/title/header/tech hints/fingerprint/redirect/body hash/favicon sha256/mmh3/simHash/TLS 证书摘要。
- `browser_crawl`：有界同源 crawl，提取 links/forms/known files/JS endpoint hints，展开 OpenAPI endpoints 与 schema 参数摘要；默认 `activeGraphqlIntrospection:true` 仅对疑似 GraphQL URL/content-type 主动 POST 标准 introspection，设为 `false` 时只做被动 GraphQL 解析；解析 service worker cache routes 与版本摘要、source map 内容与反向源文件归档，并归档结构化结果。
- `browser_fuzz_paths`：有界 path/file/route/extension fuzzing，支持 matcher/filter/rate、multi-FUZZ tuple、递归目录深度、auto/exact/cluster baseline、响应聚类和 artifact 归档。
- `browser_fuzz_vhosts`：有界 Host header / virtual-host fuzzing，支持 Host/SNI 模式、多 baseline host、HTTPS 证书摘要、baseline cluster 过滤和响应聚类。
- `browser_sqli_probe`：从 URL/raw/captured request 模板执行 SQLi boolean/error/time/union oracle 探测，输出 DBMS 指纹、ORDER BY/UNION 列数 hint、UNION 回显位和布尔盲注抽取证据，并支持在确认命中后按参数短路后续 probe。
- `browser_sqlmap_bridge`：通过 Pi-native bridge 调用 `sqlmap`，支持 URL/raw/captured/HAR 请求输入、bounded HAR URL filter、浏览器态 cookie 绑定、显式 launcher 或 PATH/module auto-detect、结构化 findings，并将 request/stdout/stderr 注册为可由 `browser_artifact` 直接读取的 artifact 描述符。
- `browser_nuclei_bridge`：通过 Pi-native bridge 调用 `nuclei`，支持 scoped URL/raw/captured/HAR 请求输入、bounded HAR URL filter、模板/工作流/ID/tag/severity 选择器、浏览器态 cookie 绑定、显式 launcher 或 PATH auto-detect、结构化 matches，并将 request/stdout/stderr 注册为可由 `browser_artifact` 直接读取的 artifact 描述符。
- `browser_template_check`：对 scoped target 或 captured request 执行 HTTP 模板检查；省略 `templateIds/templates/templatePath` 时运行小型内置 exposure/API baseline，显式 `templateIds` 可选择子集或 `all`，inline/file templates 覆盖内置默认；支持 YAML/JSON 模板文件、DSL matcher/extractor、变量替换、结果去重和证据归档；模板 regex matcher/extractor 使用有界安全正则和响应文本匹配预算。
- `browser_callback_oast`：启动/触发/收集/停止本地 HTTP/HTTPS/DNS callback listener，生成 correlation ID、外部 metadata，并持久化请求日志与事件状态。
- `browser_cookie_analyze`：Cookie/Set-Cookie/JWT/JWE/PASETO/签名或加密 session 解析、secret candidate 验证、claim mutation token 生成与有界 claim replay 校验；浏览器态 cookie 绑定保留不同 path/store/partition scope 的同名 cookie，非 HTTP(S) 页面稳定返回空 cookie；覆盖现代 Rails AES-GCM encrypted cookie、legacy Rails AES-CBC signed wrapper、Marshal/binary 明文证据保留、direct key signed cookie 的解密/验证、metadata 暴露与 mutation 重加密。
- `browser_fuzz_params`：从 URL/raw/captured request 模板做 query/JSON/form/multipart/header 参数 fuzzing，支持 nested JSON path、set/add/delete、JSON values、multipart 文件字段矩阵、同名多文件字段、嵌套 multipart、Content-Type boundary variants、parser 差异聚类和 diff classifier。
- `browser_http_replay`：从 raw/captured/HAR request 重放 HTTP 请求，支持 method/header/body mutation、multipart/binary body、multipart 文件字段变体矩阵、请求序列变量提取/注入、更多 extractor 类型、变量作用域控制、HAR 依赖图、HAR URL bounded safe-regex/substring filter、响应 diff 聚类、baseline diff 与浏览器 cookie 绑定。

## Web 安全层内部边界

- 单包内固定分层：`src/tools/webSecurity/register`、`src/tools/webSecurity/browserNative`、`src/tools/webSecurity/bridges`、`src/tools/webSecurity/shared`
- Tool 注册/schema/shell 放在 `register`；外部 TypeBox 参数先收口到具名 ToolParams，shell 以泛型约束 run/augment 参数；Pi-native 核心执行层保留在 `browserNative`；成熟引擎适配只放进 `bridges`
- WebSecurity 响应摘要按能力族拆入 `src/tools/summaries/webSecurity`，共享脱敏、artifact 与表格裁剪 helper，summary 只做压缩展示，完整证据继续走 artifact
- 这里收敛的是实现分层、维护面和成熟替代接入方式；不在工具层增加能力弱化默认值、风险分级闸门或安全收缩文案

## Bridge JS 内部边界

- `manifest.json` 当前指向 `dist/service-worker.js` module service worker；`background.js` / 多文件 `importScripts` 只作为 TODO 192 前的 legacy fixture 保留。`build:bridge` 生成 dist 时仍按旧顺序拼接 service worker 源：共享 pattern/runtime 先加载，wait 子系统顺序为 `wait_cdp.js -> wait_coordinator.js -> wait_navigation.js -> wait_network_idle.js -> wait_selector.js -> wait.js`，`network_model.js` 必须在 `network.js` 前加载。
- `wait_cdp.js` 持有 wait/network 共用的 CDP domain refcount、CDP event subscription、tab cleanup 与 diagnostics；`wait_coordinator.js` 持有 wait registry、timeout/id、orphan cleanup、tab-scoped event subscription registry 和通用 wait cleanup。
- `wait_navigation.js` 持有 navigation/load-state/current-state probe；`wait_network_idle.js` 持有 networkIdle filter/inflight/quiet-window；`wait_selector.js` 持有 selector probe/polling；`wait.js` 只保留 composite wait、command dispatch、hook/evidence helper 与 diagnose glue。
- `network_model.js` 只持有 Network recorder 的状态、配置归一化、过滤、record/body 存储与 summary clone helper；`network.js` 只持有 CDP 事件、生命周期、list/get/body/exportHar/wait 和命令分发。
- `manifest.json` content scripts 使用 `dist/disable_dialogs.js` 与 `dist/content.js`；hook 注入使用 `PI_BROWSER_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js'`，`chrome.scripting.executeScript({ files })` 与 CDP fallback 仍加载同一个生成文件。旧 `hook_dispatcher.js` 只作为 TODO 192 前的 legacy fixture 保留。边界见 `docs/hook-dispatcher-boundary.md`。
- 旧 `bridge-globals.d.ts` / `tsconfig.bridge.json` 已删除；`check:bridge:types` 只检查 `bridge_src/**/*.ts`，内部边界由 ESM source graph 和契约锁定，不再依赖 importScripts ambient 黑盒声明。
- Bridge ESM + TypeScript bundler 终态与阶段 gate 见 `docs/bridge-esm-bundler-plan.md`；runtime 已切到 dist，TODO 192-193 继续删除旧入口并完成最终行为审计。

## Pi 命令

- `/browser-status`：查看 bridge server、扩展连接、tabs、pending 请求。
- `/browser-install`：输出浏览器扩展安装路径。
- `/browser-reload`：请求浏览器扩展 reload 并等待重连。

## Token 预算约定

- 默认 `detailLevel:"summary"` 使用确定性预算裁剪和表格化数组，减少重复 JSON key；`preview` 同样返回 compact envelope，避免泄露大 raw payload；`full` 在超预算时返回 `fullResult:"saved_to_artifact"` 与 `saved.path`。
- `outputPath` 与自动落盘 artifact 优先保存可复原的原始调用 envelope / `artifactValue`；`browser_content`、`browser_scan`、`browser_html` 等 text 工具的返回仍可保持紧凑文本/summary，但 artifact 不再只保存截断纯文本。
- 通用 bridge summary 会上浮 `tabId/frameId/sessionId/requestId/waitId/listenerId/count/total/nextOffset` 与 target source，便于跨 tab/session/frame 对账，无需打开完整 artifact。
- 操作流程保持 GA-style：`browser_scan` 观察页面 → `browser_execute` 执行定制 JS/CDP → `browser_wait` 等待 → 再 `browser_scan`/`browser_execute` 复查；长 wait 成功后检查 `supervisor` 元数据，若返回 `WAIT_STATE_LOST` 则重新观察页面/网络证据。
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
npm run build:bridge   # 生成 manifest 当前使用的 dist runtime
npm run smoke:browser
npm run smoke:browser:isolated
npm run smoke:browser:transfer
```

`build:bridge` 现在从 `bridge_src/service_worker/` 生成完整 service worker bundle，并从 `bridge_src/page_scripts/` 生成独立 content/hook-dispatcher/disable-dialogs 页面 bundle；产物位于 `bridge/pi_browser_bridge/dist/` 且由脚本生成。当前 manifest 指向 dist runtime；修改 `bridge_src/**` 后先运行 `npm run build:bridge` 再 reload 扩展。

`npm run smoke:browser` 与常驻 Pi agent/bridge 共用 MV3 固定端口 `127.0.0.1:18765`，本地并行时会显式失败并在 `.pi/browser-artifacts/smoke-browser-results.json` 写入 `bridge.port.reason`：`agent_occupies`、`orphan_socket` 或 `unknown_owner`。脚本会先写入 `build.runtime`（dist target、entries、service worker sha256），只诊断 PID/命令行，不自动关闭用户进程。

`npm run smoke:browser:isolated` 会复制临时扩展目录、patch dist bridge 端口、启动独占 Chrome profile，并写入 `.pi/browser-artifacts/smoke-browser-isolated-results.json`；用于本地常驻 agent 占用 18765 时的 runtime 验证，不修改用户当前扩展目录。

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
