# Pi Browser Tools

Pi 原生浏览器工具扩展，提供真实浏览器 tab 控制、GA-style 简化 DOM 扫描、JavaScript/CDP 执行、正文提取、网络证据、上传下载、截图、artifact 局部读取、Web 探测/请求重放和原生 bridge 命令。

## 职责划分

- 安装、环境变量、浏览器扩展加载、reload、check/smoke、排障：见 `AI_INSTALL.md`。
- `.pi/public-export/` 仅允许作为本地导出/归档产物，不能作为第二开发仓库或第二真源；当前唯一正式源码仓库是本目录。
- Pi 正式使用场景、工具选择、输出风格、诊断约定：见全局 skill `D:/Pi/agent/skills/pi-browser-tools/SKILL.md`。
- 多步骤安全测试方法论：见 `docs/playbooks/README.md`；信号到工具路线映射见 `docs/reference/web-security-methodology-map.md`。
- 本 README 只作为项目入口、工具清单和维护入口。

## 工具边界

- 语义单例与选择边界：见 `docs/tool-boundaries.md`。
- 工具面治理计划：见 `docs/tool-surface-consolidation-plan.md`。该文件冻结 TODO 244-249：`browser_observe` 观察层合并、`browser_execute`/`browser_command` 拆分、recovery hints、bounded artifact multi-search、progress/streaming、explicit snapshots/operation metadata、Web Security capability profiles。
- 下阶段 Web Reversing / 安全原语规划：见 `docs/next-phase-web-reversing-and-security-primitives-plan.md`。当前“请求/响应拦截与热补丁原语”phase 1/2、“JS AST / 反混淆分析原语” phase 1、“DOM 事件链 / sink-flow 分析辅助” phase 1、“Wasm 逆向桥接” phase 1 与 “Stateful WebSocket replay/fuzz primitives” phase 1 均已完成。其余方向仍只作为规划文档，不代表这些能力已成为 callable tool。
- 当前主链路：`browser_tabs` 定位目标 → `browser_observe mode=scan|content|html|text|tabs` / `browser_screenshot` / `browser_frame` 观察 → `browser_execute` / `browser_command` / `browser_wait` 执行与等待 → `browser_network` / `browser_hook` / `browser_evidence` 取证 → `browser_artifact` 读取大证据。
- TODO 244-249 已完成：观察层已收敛到 `browser_observe`；`browser_execute` 已收敛为 JavaScript-only；`browser_command` 成为 bridge command surface；errors 带 factual recovery hints；`browser_artifact` 支持 bounded multi-artifact search；长 Web follow-up 工具支持 tool-level progress；`browser_observe`/`browser_tabs snapshot` 暴露 explicit snapshot 与 operation metadata；Web Security 可见工具面由显式 profile 控制。
- Web Security 工具只作为 scoped follow-up：先观察/捕获/重放基线，再按需要使用 recon/crawl/fuzz/template/cookie/SQLi/OAST/bridge 工具。默认 profile 为 `security`；如需缩减日常可见工具面，设置 `PI_BROWSER_TOOL_PROFILE=core` 后 `/reload`。
- Web Security affordance 只补接缝信息，不引入固定 workflow：工具可以返回并列 `possible/common follow-ups`、参数校验和结构化 recovery，但不会自动串联 `crawl -> fuzz -> sqli`、不会自动升级 mode/engine/action，也不会伪造请求模板。
- Web Security follow-up 工具的 HTTP 目标执行默认由 Node.js `fetch` 直接发起，而不是经浏览器桥；`bindBrowserSession:true` 仅用于可选注入浏览器 cookies，不改变请求发起位置。
- 参数契约当前采用双层模式：顶层工具参数由 TypeBox + 框架 `Value.Convert + Check` 保护，复杂对象继续由既有 Zod `validateOptionalParams()` 保护；本仓库不会把复杂对象 schema 全量迁回 TypeBox。
- jshookmcp 研究只作为能力发现来源；本包不迁移其源码、MCP 架构、工具名、schema、payload、fixture 或文档文本；TODO 241 闭环账本见 `docs/jshookmcp-native-absorption.md`。
- 当前拒绝新增 `browser_sources`、`browser_debugger`、`browser_intercept`、`browser_storage`、`browser_canvas` 公开工具；对应能力必须优先由 `browser_hook`、`browser_execute`、`browser_network`、`browser_http_replay`、`browser_crawl`、`browser_evidence`、`browser_artifact` 承载；任何新公开工具需单独 RFC 与 eval 证据。下阶段深水区能力规划也必须先走 internal primitive / bridge / artifact-first 路线，不能直接把 problem area 变成公开大工具。

## 工具清单

- `browser_tabs`：list / snapshot / switch / create / close / selectBrowser；list 返回 `tabId`、browser-scoped `id` 与 `browserId`，可区分多浏览器相同数值 tabId；`snapshot` 返回 bridge snapshot、capability profile、active operations，以及按 `snapshotId` 读取 explicit observation snapshot metadata（默认 stale fail-closed，可 `allowExpired:true` 只读旧证据元数据）；create 省略 URL 时创建并持续列出 `about:blank`；`selectBrowser` 优先使用该浏览器上报的 `active:true` tab 作为隐式目标，无活动 tab 时清空隐式目标并返回 `NO_TAB`，避免省略 `tabId` 时落到后台 tab 或跨浏览器回落。
- Bridge 默认监听 `127.0.0.1:18765-18784` 的首个空闲端口；浏览器扩展会扫描同一范围并同时连接多个 Pi bridge server，因此两个 Pi 对话窗口/进程可以共享同一个已加载扩展，状态分别显示 `browser:<实际端口>`，不再因固定 `18765` 争用进入 `browser:error`。
- 高级参数 `browserSessionId` 可把 selected/default/latest fallback 隔离到指定 browser session；普通 agent 默认省略，运行时使用当前 selected browser session，初始为 `default`。显式 `browserSessionId` 用于调试、测试、编排或外部运行时自动分派，不作为 prompt 手写隔离机制。
- `browser_tabs` 支持高级 session 管理动作：`listSessions/createSession/selectSession/closeSession/attachTab/detachTab/leaseTab/releaseTab`；新建 session 初始为空，不继承现有 tab，必须显式 `attachTab`、`selectBrowser` 或 `create` 后才有隐式目标；同一真实 tab 的写操作需要 lease，冲突立即返回 `TAB_LEASE_CONFLICT`；同一 `(browserSessionId, tabId)` 的写命令在 Node 侧串行排队，`snapshot.queues` 暴露队列深度。
- Tab-scoped 工具自动化场景应显式传 `tabId`；省略时使用当前 browser session 内的 selected/latest fallback，断开或关闭后优先回退到同 browser 的 `active:true` tab，再用有效 latest；显式 stale `tabId` 会本地返回 `TAB_NOT_FOUND`，不会回落到其它 browser socket；结果会暴露 `target.browserSessionId`、`target.source` 与 `selectionVersion` 便于诊断并发切 tab。
- `browser_execute`：只执行 JavaScript；command-like JSON string 会显式报错并给出 `browser_command` recovery hint；常规点击、输入、复杂页面操作默认在这里用 JS 一次性完成；可选 `monitor:true` 在保留 `data/target/newTabs/acknowledged` 顶层执行结果的同时追加执行前后 scan diff。
- `browser_command`：只发送 native bridge command object；保留 protocol validation、unsafe transfer guardrails、完整 result envelope 和 operation metadata。用于 `tabs` / `management` / `cdp` / `persistent_cdp` / 其它 bridge command，而不是页面 JS。
- `browser_observe`：观察层 canonical 工具。`mode=scan` 返回 GA-style 简化 DOM/text、Scan Manifest v2、actionables、forms/lists/text signals 与 `artifact_hints`；`mode=content` 返回正文 Markdown 并保留 durable navigation；`mode=html` 返回原始 HTML/text snapshot；`mode=text` 返回可见文本优先观察；`mode=tabs` 返回观察用 tab facts。不支持 `auto` 模式，不做 selector miss fallback。
- `browser_pick`：用户交互点选页面元素，返回 selector 和摘要；`focus:false` 时由工具层持有用户 `timeoutMs` 总 deadline，到期返回结构化 `{cancelled:true, reason:"timeout"}` 并通过页面 cleanup handle 清理 overlay/listeners，不把后台 tab timer throttle 暴露成 CDP `Runtime.evaluate` 超时。
- `browser_download`：通过 selector click、media selector 或 URL 下载并回传 Chrome 本地路径；`mode` 只允许 `click|media|url`，selector 目标仅接受省略/`click`/`media`，URL 目标仅接受省略/`url`，冲突或未知值返回 `INVALID_RULE`；click 会优先用可提取 URL 或 tab-scoped 下载事件关联；主结果保留完整 bridge envelope（id/tabId/acknowledged/target/newTabs），摘要只压缩 payload。
- `browser_upload`：通过文件选择器上传绝对本地文件路径，要求 `confirm:true`。
- `browser_wait`：导航、selector、load state、network idle 等等待；`timeoutMs` 是总 deadline，传 `0` 会执行一次 immediate probe，`wait.navigation` 仅在当前 URL 与声明状态已匹配时成功，否则返回 `TIMEOUT`；`any/all` 复合等待要求非空 `waits/conditions`，子条件可直接使用 `wait.loadState` / `wait.selector` / `wait.navigation` 等完整 native command 名；`networkIdle.includeUrls/ignoreUrls` 使用有界 pattern 匹配；迟到的租约成功会转为 `WAIT_TIMEOUT`/`WAIT_STATE_LOST`；底层 lease 瞬时超时时会节流重试并记录 `retryDelayMs`；`navigateAndWait.timeoutMs` 覆盖导航+后续等待总耗时；长等待由 TS 端短租约 supervisor 跨 MV3 Service Worker 重启续证，结果暴露 `supervisor.workerRestarts/historyLost/leases`；`diagnose` 为只读目标 tab 诊断，不触发 hook auto reinstall，过滤目标 tab 的 listeners/CDP/debugger 数据，并通过 `querySelectorAll('iframe')` + `window.frames.length` 返回 `frameCount/iframeCount` 与 iframe 的 `id/name/src/visible/rect`。
- `browser_network`：Network recorder 的 start/list/get/body/exportHar/wait；默认对 XHR/Fetch/Document 的 JSON/text/html 响应有界即时抓取 body，并默认保留有界 request `postData`；可用 `captureBodies:false`、`bodyMimeAllow`、`maxBodyBytes`、`resourceTypes`、`captureRequestPostData:false` 控制采集；`network.get/list/body/exportHar` 暴露 `bodyAvailability/bodyUnavailableReason`，`network.body` 缺 body 时返回可诊断 `BODY_UNAVAILABLE`；`network.wait timeoutMs:0` 执行一次 immediate check；显式 `sessionId` 不回退 default，`list.nextOffset` 在末页为 `null`，缺失 request 返回 `REQUEST_NOT_FOUND`，二进制 body 截断保持 base64 可解码，`exportHar(format:"json", includeBody:true)` 只导出过滤命中的 body。
- `browser_hook`：页面事件 hook 的 listTargets/installTargets/install/collect/status/uninstall/evaluate 等；`listTargets` 返回静态显式 hook target 清单，`installTargets` 只展开明确 target ids 并返回 `expanded_targets`、boundary 和拒绝策略 preset 诊断；`options.redact_patterns` 使用有界安全正则，危险 pattern 降级为 literal 替换；status/collect/list_sessions 等只读命令不隐式重装 dispatcher，显式 `tabId` 的 list_sessions 只返回目标 tab scope；显式 `sessionId/session_id` 会严格匹配当前 dispatcher session，collect 不写入 lifecycle 自噪声，clear_buffer 保持全局 `seq` 单调递增；event listener registry 使用 `tabId::listenerId` 作用域，同名 listener 可跨 tab 并存，remove/uninstall/tab cleanup 只清目标 tab 并返回页面监听清理诊断；`performance` 显式 `entryType` 只读 `performance.getEntriesByType(entryType)`，空结果返回 `count:0`，未指定时默认 `resource`。
- `browser_evidence`：聚合 hook/network/performance 证据；顶层 `timeoutMs/timeout_ms` 会透传到 hook status/collect 的页面 evaluate 与 performance 子源，performance 支持 `entryType/nameContains` 与下划线别名；summary 会保留 `hook_status` 的 `state/session_id/installed_at/dispatcher_version/pi_browser_version/install_epoch/buffer_used/buffer_count`。
- `browser_frame`：frame 列表、frame 内执行、新文档脚本；`frame.list` 返回 `{ tabId, frameTree, frames, count }`，`frame.evaluate` 返回目标 `tabId/frameId` 元数据；`addNewDocumentScript` 支持顶层 `runImmediately/worldName/includeCommandLineAPI` 覆盖 `options`，并返回稳定 `identifier/sessionKey/cdpSessionName/tabId`；`removeNewDocumentScript` 只接受已登记 identifier，未知 id 返回 `SCRIPT_NOT_FOUND`，已知但 Chrome 已清理的 id 返回稳定 `alreadyRemoved:true`。
- `browser_screenshot`：截图并保存 artifact；visible-tab fallback 只使用 Chrome 支持的 png/jpeg，并按实际捕获格式返回 `format/mime` 与默认文件扩展名。
- `browser_artifact`：按行、JSON path、关键词或抽样读取 artifact；text/search/sample 为流式读取，UTF-8 `chars` 按真实字符计数，空/越界结果不返回非法行区间，sample 小文件/重叠区段会去重并在 summary 标记，末页 `nextOffset:null`，长单行截断仍返回可读前缀；JSON `jsonPath` 未命中返回显式 `{exists:false, notFound:true, value:null}`，`pick` 每个请求路径都返回 `{exists,value}` 或 notFound 占位；search 的 `regex:true` 使用有界安全正则，危险 regex 明确拒绝；支持 bounded multi-artifact search：显式 `paths` 或受限 `root`/`glob`，并受 `maxFiles/maxBytes/maxMatchesPerFile/maxTotalMatches/maxChars` 约束；默认对 cookie/token/authorization/body/postData/websocket payload 脱敏，只有显式 `redact:false` 才返回本地原始证据。
- `browser_crawl`：统一 Web 信息收集入口。默认 `action:"crawl"` 做有界同源 crawl，提取 links/forms/known files/JS endpoint hints，展开 OpenAPI endpoints 与 schema 参数摘要；默认 `activeGraphqlIntrospection:true` 仅对疑似 GraphQL URL/content-type 主动 POST 标准 introspection，设为 `false` 时只做被动 GraphQL 解析；解析 service worker cache routes 与版本摘要、source map 内容与反向源文件归档。`action:"fingerprint"` 则做小范围 URL/路径/端口/scheme 探测，返回 status/title/header/tech hints/fingerprint/redirect/body hash/favicon sha256/mmh3/simHash/TLS 证书摘要。
- `browser_fuzz`：统一 fuzz 入口。`mode:"path"` 做有界 path/file/route/extension fuzzing，支持 matcher/filter/rate、multi-FUZZ tuple、递归目录深度、auto/exact/cluster baseline、响应聚类和 artifact 归档；`mode:"vhost"` 做 Host header / virtual-host fuzzing，支持 Host/SNI 模式、多 baseline host、HTTPS 证书摘要、baseline cluster 过滤和响应聚类；`mode:"param"` 从 URL/raw/captured request 模板做 query/JSON/form/multipart/header 参数 fuzzing，支持 nested JSON path、set/add/delete、JSON values、multipart 文件字段矩阵、同名多文件字段、嵌套 multipart、Content-Type boundary variants、parser 差异聚类和 diff classifier。
- `browser_sqli`：统一 SQLi 入口。默认 `engine:"builtin"` 从 URL/raw/captured request 模板执行 SQLi boolean/error/time/union oracle 探测，输出 DBMS 指纹、ORDER BY/UNION 列数 hint、UNION 回显位和布尔盲注抽取证据，并支持在确认命中后按参数短路后续 probe；`engine:"sqlmap"` 通过 Pi-native bridge 调用 `sqlmap`，支持 URL/raw/captured/HAR 请求输入、bounded HAR URL filter、浏览器态 cookie 绑定、结构化 findings，并将 request/stdout/stderr 注册为可由 `browser_artifact` 直接读取的 artifact 描述符；显式 `sqlmapPath` / `PI_SQLMAP_PATH` override 现在要求 `allowLauncherOverride:true`，否则只允许 PATH/module auto-detect。
- `browser_template`：统一模板检查入口。默认 `engine:"builtin"` 对 scoped target 或 captured request 执行 HTTP 模板检查；省略 `templateIds/templates/templatePath` 时运行小型内置 exposure/API baseline，显式 `templateIds` 可选择子集或 `all`，inline/file templates 覆盖内置默认；支持 YAML/JSON 模板文件、DSL matcher/extractor、变量替换、结果去重和证据归档；模板 regex matcher/extractor 使用有界安全正则和响应文本匹配预算。`engine:"nuclei"` 则通过 Pi-native bridge 调用 `nuclei`，支持 scoped URL/raw/captured/HAR 请求输入、bounded HAR URL filter、模板/工作流/ID/tag/severity 选择器、浏览器态 cookie 绑定、结构化 matches，并将 request/stdout/stderr 注册为可由 `browser_artifact` 直接读取的 artifact 描述符；显式 `nucleiPath` / `PI_NUCLEI_PATH` override 现在要求 `allowLauncherOverride:true`，否则只允许 PATH auto-detect。
- `browser_callback_oast`：启动/触发/收集/停止本地 HTTP/HTTPS/DNS callback listener，生成 correlation ID、外部 metadata，并持久化请求日志与事件状态；`sessionId` 现在限制为安全 slug，HTTPS 证书改为会话启动时动态生成，`maxRuntimeMs` 控制 worker 生命周期上限，`action:"trigger"` 使用 `triggerTimeoutMs` 控制回调事件等待时间。
- `browser_cookie_analyze`：Cookie/Set-Cookie/JWT/JWE/PASETO/签名或加密 session 解析、secret candidate 验证、claim mutation token 生成与有界 claim replay 校验；浏览器态 cookie 绑定保留不同 path/store/partition scope 的同名 cookie，非 HTTP(S) 页面稳定返回空 cookie；覆盖现代 Rails AES-GCM encrypted cookie、legacy Rails AES-CBC signed wrapper、Marshal/binary 明文证据保留、direct key signed cookie 的解密/验证、metadata 暴露与 mutation 重加密。
- `browser_http_replay`：从 raw/captured/HAR request 重放 HTTP 请求，支持 method/header/body mutation、multipart/binary body、multipart 文件字段变体矩阵、请求序列变量提取/注入、更多 extractor 类型、变量作用域控制、HAR 依赖图、HAR URL bounded safe-regex/substring filter、响应 diff 聚类、baseline diff 与浏览器 cookie 绑定。

## Web 安全层内部边界

- 单包内固定分层：`src/tools/webSecurity/register`、`src/tools/webSecurity/browserNative`、`src/tools/webSecurity/bridges`、`src/tools/webSecurity/shared`
- Tool 注册/schema 放在 `register`；公共执行协议由 `src/tools/toolAdapter.ts` 中的 `runBrowserTool()` 提供，WebSecurity 领域适配由 `runWebSecurityTool()` 承接；外部 TypeBox 参数先收口到具名 ToolParams，注册模块不能直接调用 driver、bridge runtime、`chrome.*` 或 cookie native command。
- `shared.ts` 是唯一 browser-session cookie provider 入口；`webSecurity/shared/diagnostics.ts` 统一 domain=`webSecurity` 失败 envelope、cookie/authorization/token/secret 脱敏和 stack suppress；summary 只输出压缩诊断，完整证据继续走 artifact。
- Pi-native 核心执行层保留在 `browserNative`，只能消费 `shared` 的 HTTP/replay/artifact/type adapter；成熟引擎适配只放进 `bridges`，并以 bounded `spawnSync`、timeout/maxBuffer、request/stdout/stderr artifact 接入 sqlmap/nuclei。
- `webSecurityCore.ts` 只作为兼容 re-export 层，不注册工具、不依赖 `BrowserBridgeServer`/`ensureStarted`/bridge runtime；`toolRegistry.ts` 维护声明式工具注册表，`registerTools.ts` 只消费注册表并组合入口，不直接导入实现层。
- WebSecurity 响应摘要按能力族拆入 `src/tools/summaries/webSecurity`，共享脱敏、artifact 与表格裁剪 helper，summary 只做压缩展示，完整证据继续走 artifact
- `npm run check:web-security` 锁定 register/browserNative/bridges/shared 分层、cookie/HAR/raw-request/artifact/browser-native adapter、domain failure envelope 与 sqlmap/nuclei bridge artifact/timeout 边界。
- `.github/workflows/check.yml` 现直接复用 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts` 与 `npm run check:lint`，并把 Node 安装/依赖安装/build 抽到 `.github/actions/setup-node-build`，确保 CI 与本地 grouped runner 入口一致。
- 这里收敛的是实现分层、维护面和成熟替代接入方式；不在工具层增加能力弱化默认值、风险分级闸门或安全收缩文案

## Bridge JS 内部边界

- `manifest.json` 当前指向 `dist/service-worker.js` module service worker；旧 `background.js` / 多文件 `importScripts` 入口已删除。支柱二终态已完成：`build:bridge` service worker build mode 是 `esm-import-graph`，TODO 197 shared/runtime/CDP/wait 基础层、TODO 198 command 层、TODO 199 router/transport/tab_sync 启动层均已通过真实 ESM import/export 进入 bundle，TODO 200 已开启 strict/noImplicitAny 并完成 page script 类型收口，TODO 202 已通过 build/check/pack/isolated-smoke gate。
- `wait_cdp.js` 持有 wait/network 共用的 CDP domain refcount、CDP event subscription、tab cleanup 与 diagnostics；`wait_coordinator.js` 持有 wait registry、timeout/id、orphan cleanup、tab-scoped event subscription registry 和通用 wait cleanup。
- `wait_navigation.js` 持有 navigation/load-state/current-state probe；`wait_network_idle.js` 持有 networkIdle filter/inflight/quiet-window；`wait_selector.js` 持有 selector probe/polling；`wait.js` 只保留 composite wait、command dispatch、hook/evidence helper 与 diagnose glue。
- `network_model.js` 只持有 Network recorder 的状态、配置归一化、过滤、record/body 存储与 summary clone helper；`network.js` 只持有 CDP 事件、生命周期、list/get/body/exportHar/wait 和命令分发。
- `manifest.json` content scripts 使用 `dist/disable_dialogs.js` 与 `dist/content.js`；hook 注入使用 `PI_BROWSER_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js'`，`chrome.scripting.executeScript({ files })` 与 CDP fallback 仍加载同一个生成文件。边界见 `docs/hook-dispatcher-boundary.md`。
- 旧 `bridge-globals.d.ts` / `tsconfig.bridge.json` 已删除；`check:bridge:types` 只检查 `bridge_src/**/*.ts`，内部边界由 ESM source graph 和契约锁定，不再依赖 importScripts ambient 黑盒声明。
- Bridge ESM + TypeScript bundler 终态与阶段 gate 见 `docs/bridge-esm-bundler-plan.md`；当前 service worker 已是真实 ESM import graph，`bridge_src/**/*.ts` 由 strict/noImplicitAny 检查，page script 类型收口、发布包 dist 验证与 isolated runtime smoke gate 已完成。

## Pi 命令

- `/browser-status`：查看 bridge server、扩展连接、tabs、pending 请求。
- `/browser-install`：输出浏览器扩展安装路径。
- `/browser-reload`：请求浏览器扩展 reload 并等待重连。
- `/browser-js-ast [path] [--output file]`：运行 internal-only JS AST / 反混淆摘要；输入必须是显式本地文件路径或编辑器中的显式 JS 文本，不新增公开工具面。
- `/browser-wasm <path> [--wat] [--output file]`：运行 internal-only Wasm 元数据摘要；`--wat` 时走成熟本地桥接生成 `.wat` artifact，不新增公开工具面。
- `/browser-ws open <url> [--session id] [--header Name:Value] [--protocol value] | send --text text | replay --step text [--step '{"text":...,"contains":...}'] [--steps-json '[...]'] | wait [--contains text|--regex pattern] | collect [--output file] | close`：运行 internal-only WebSocket session/transcript primitive；输入必须显式且有界，不新增公开工具面。

## Token 预算约定

- 默认 `detailLevel:"summary"` 使用确定性预算裁剪和表格化数组，减少重复 JSON key；`preview` 同样返回 compact envelope；summary envelope 保持 `tool/command/browserSessionId/detailLevel/summary/saved` 兼容，并可附加 `diagnostics/target/limits/privacy/nextActions` 作为恢复线索；其中 `nextActions` 仅表示 follow-up affordance / recovery hints，不表示工具将自动执行这些步骤。summary/full/details/error content 默认脱敏 cookie/token/authorization/body/postData/websocket payload，敏感完整证据改写入本地 artifact 并返回 `saved.path`。
- `outputPath` 与自动落盘 artifact 优先保存可复原的原始调用 envelope / `artifactValue`；保存结果带 `privacy.classification:"local_raw_evidence"`、默认根目录 `.pi/browser-artifacts/`、`localOnly:true` 与手动清理提示；`browser_observe` 的 scan/content/html/text 模式返回仍可保持紧凑文本/summary，但 artifact 不再只保存截断纯文本。
- 通用 bridge summary 会上浮 `browserSessionId`、`tabId/frameId/sessionId/requestId/waitId/listenerId/count/total/nextOffset` 与 target source，便于跨 browser session/tab/frame 对账，无需打开完整 artifact；需要原始敏感字段时只用 `browser_artifact redact:false` 对本地路径做定点读取，不把 artifact 上传外部服务。
- 下一步增强优先沿现有工具面补“cross-tool evidence correlation metadata”：在 distilled envelope 中继续统一 `operationId`、`snapshotId`、`sourceMode`、`selectionVersionAtDispatch/Resolve` 等对账线索，帮助 agent 把 observe → execute/command → wait → network/hook/evidence → artifact 串起来；不新增重叠公开工具，也不做黑盒自动编排。
- `browser_artifact` 的 JSON summary 现在会尽量上浮 artifact 内已有的 `operationId`、`snapshotId`、`requestId`、`waitId`、`listenerId`、`browserSessionId`、`selectionVersion*` 等对账线索，并给出 `correlationPaths`；优先按这些 `jsonPath` 做定点读取，不要一上来整份打开。
- 操作流程保持 GA-style：`browser_observe mode=scan` 观察页面 → `browser_execute` 执行定制 JS/CDP → `browser_wait` 等待 → 再 `browser_observe mode=scan|html` / `browser_execute` 复查；长 wait 成功后检查 `supervisor` 元数据，若返回 `WAIT_STATE_LOST` 则重新观察页面/网络证据。
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

CDP 输入最小闭环：先用 `browser_execute` JS 定位并 `focus()`，再用 `browser_command` 发送 `{cmd:'persistent_cdp',action:'send',cdpMethod:'Input.insertText',params:{text:'...'}}`，最后 JS 读取状态；清空用 `Ctrl+A` + `Backspace` 的 `Input.dispatchKeyEvent`。需要 GA-style 自动变化摘要时，给 JS 模式传 `monitor:true`。

## 维护入口

- 当前状态与执行队列：`CURRENT.md`
- Node 发布入口当前同时区分源码入口与分发入口：Pi runtime 仍通过 `pi.extensions: ["./index.ts"]` 加载源码入口；npm/package `main`/`types`/`exports` 与 `pi-browser-mcp` bin 则指向 `dist/` 编译产物。
- 历史完成归档：`ARCHIVE.md`
- 后续路线与建议：`ROADMAP.md`
- 兼容 TODO 入口：`TODO.md`
- 契约测试：`tests/contracts/`
- 真实浏览器 smoke：`tests/smoke/`
- 最终全量 smoke 结果：`.pi/browser-artifacts/final-smoke/results.json`
- 全局 skill 验证：`PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`
- 维护者入口图：`docs/maintainer-map.md`
- 生成器/build/check 脚本：`scripts/`
- 生成工具/协议契约文档：`docs/generated/browser-tool-contract.generated.md`
- 协议单源设计：`docs/protocol-single-source-plan.md`
- 生成 native 协议契约文档：`docs/generated/native-protocol.generated.md`
- Driver 内部边界：`src/driver/BrowserBridgeServer.ts` facade + `BrowserBridgeHttpServer.ts` / `BrowserBridgeClientRegistry.ts` / `BrowserTabSessionRouter.ts` / `BrowserBridgePendingRequests.ts` / `BrowserBridgeDiagnostics.ts`
- Tool Registry / Adapter 边界：`src/tools/toolRegistry.ts` 只维护工具注册顺序与 capability profile 分组；`src/tools/toolAdapter.ts` 只放共享参数、timeout/maxChars、错误包装、result middleware 与 artifact fallback；各 `register*Tool.ts` 仍保留 schema 组合和领域逻辑。
- driver 架构与三态状态机矩阵：`docs/driver-architecture.md`

```bash
npm run build            # 生成 outer dist/（index.ts + src/** + mcp/**）
npm run check
npm run check:all:bridge   # bridge + unit 分组门禁
npm run check:all:package  # package + docs 分组门禁
npm run check:all:contracts # contracts/runtime-fixture 分组门禁
node scripts/run-check-groups.mjs --json bridge contracts # 输出结构化摘要到 .pi/browser-artifacts/check-groups-summary.json
npm run quality:local   # 本地发布/合并前门禁：build:bridge + check + pack dry-run；不启动浏览器
npm run release:local   # 本地发布包验收：clean cwd pack dry-run/实际 pack/manifest dist/build manifest/回滚候选
npm run release:local:smoke # 本地发布包验收 + 当前包 isolated smoke + 上一包最小回滚 smoke
npm run check:lifecycle  # 本地生命周期 fixture：多浏览器/tab/pending/MV3 restart 长任务
npm run check:runtime-fixtures # 可重放 runtime fixture：network/hook/wait/transfer/frame/screenshot/callback
npm run check:web-security # WebSecurity 分层/domain envelope/bridge artifact 边界
npm run sync:protocol     # 从 bridge/native_command_schema.json 生成 native protocol/type/metadata/docs
npm run check:protocol    # native protocol 生成产物 drift + protocol contract
npm run docs:generate     # 从工具注册元数据与 native command schema 生成契约文档
npm run check:deps         # 本地依赖/lockfile/npm ls/生产 audit 检查
npm run check:token        # 结果预算与隐私脱敏契约
npm run check:artifact     # artifact 读取/脱敏/安全正则契约
npm run check:errors       # 错误 taxonomy、diagnostics、脱敏与去 stack 契约
npm run build:bridge   # 生成 manifest 当前使用的 dist runtime
npm pack --dry-run --json   # 验证发布包包含 manifest 指向的 dist runtime
npm run smoke:browser
npm run smoke:browser:isolated
npm run smoke:browser:scan-summary
npm run smoke:browser:debugger-evidence
npm run smoke:browser:transfer
```

`build:bridge` 现在从 `bridge_src/service-worker.ts` 真实 ESM entry 生成完整 service worker bundle，并从 `bridge_src/page_scripts/` 生成独立 content/hook-dispatcher/disable-dialogs 页面 bundle；产物位于 `bridge/pi_browser_bridge/dist/` 且由脚本生成。`dist/build-manifest.json` 记录 `serviceWorkerBuildMode:"esm-import-graph"`、`orderedConcatenation:false`、`foundationImported:true`、`commandImported:true`、`startupImported:true`，以及 metadata-only 模块清单字段。当前 manifest 指向 dist runtime；修改 `bridge_src/**` 后先运行 `npm run build:bridge` 再 reload 扩展。

`prepack` 会以 quiet 模式重新生成 dist；`package.json.files` 与 generated `dist/.npmignore` 明确让 npm package 包含 `dist/service-worker.js`、page bundles、source maps 与 `build-manifest.json`。`npm run check` 现在通过 `verify:bridge:dist` 只读验证当前 dist，不再隐式重建；防止只发布 `dist/.gitignore` 导致干净安装扩展不可运行的包级检查仍由 `check:package` 执行 `npm pack --dry-run --json` 完成。`npm run quality:local` 串联 `build:bridge`、`check`、`npm pack --dry-run --json`，作为本地发布/合并前默认门禁；它只打印可选 isolated smoke 下一步，不自动启动 Chrome/Edge。失败时先看命令输出与 `.pi/browser-artifacts/`；端口占用看 `.pi/browser-artifacts/smoke-browser-results.json` 的 `bridge.port` 后人工处理。

`npm run release:local` 在 `.pi/browser-artifacts/release-acceptance/work/pack-run` clean cwd 中执行 `npm pack --dry-run --json` 与实际 `npm pack --pack-destination`，解包校验 manifest 指向 `dist/service-worker.js`、dist/page bundles、native schema 与 `build-manifest.json` 的 `serviceWorkerBuildMode:"esm-import-graph"` / `orderedConcatenation:false`；摘要写 `.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`，当前包写 `current/pi-browser-tools-0.3.0.tgz`，上一轮成功包轮转到 `previous/`，本轮成功包保存到 `last-successful/` 作为后续回滚候选。

`npm run release:local:smoke` 在上述验收基础上对当前解包扩展运行 full isolated smoke，并对 `previous/` 上一包运行最小 tabs/wait/execute 回滚 smoke；artifact 为 `.pi/browser-artifacts/release-acceptance/current-smoke-browser-isolated-results.json` 与 `rollback-smoke-browser-isolated-results.json`。失败摘要包含 pack 文件列表、build manifest、Chrome profile、bridge port 和 smoke artifact；需要保留失败临时 profile/扩展时加 `--keep-temp-on-failure` 或 `PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE=1`。CI 可通过 `PI_BROWSER_CI_BROWSER_SMOKE=1` / `PI_BROWSER_CI_RELEASE_SMOKE=1` / `PI_BROWSER_CI_ROLLBACK_SMOKE=1` 显式启用最小 isolated smoke 或 release smoke。

`npm run docs:generate` 从实际 `pi.registerTool` 元数据、`bridge/native_command_schema.json` 与源码中的结构化错误码生成 `docs/generated/browser-tool-contract.generated.md`；其中 `Structured error taxonomy` 表保留公开 code，并列出 domain/category/retryable/source。`npm run check:tool-docs` 会执行 drift check，手改生成产物或 schema/tool 元数据未同步会失败。文档结构规则见 `docs/document-structure.md`；修改 archive/roadmap/todo 入口后先运行 `npm run docs:sync-indexes && npm run check`。

`npm run check:errors` 锁定错误归一化契约：`normalizeError` / `compactError` 保留 `code/message/details/name`，追加紧凑 `taxonomy` 与 `diagnostics`；覆盖 driver/tool/native/page/CDP/network/transfer/security/artifact/protocol 分类、nested bridge/native response、ArtifactReader、transfer、WebSecurity、stack strip、secret redaction 和 circular details。

`bridge/native_command_schema.json` 是 native command 协议单一事实来源。修改后运行 `npm run sync:protocol`，生成 `bridge/pi_browser_bridge/native_command_schema.json`、`bridge_src/service_worker/protocol.ts`、`src/protocol/nativeProtocol.ts`、`src/protocol/nativeActionMetadata.ts`、`src/protocol/nativeErrorCodes.ts` 与 `docs/generated/native-protocol.generated.md`；这些生成文件禁止手改。`npm run check:protocol` 会检查 drift、root/bridge schema 一致、runtime/Node validator、wait/network/hook/frame/html/screenshot/evidence/transfer metadata 消费与错误码表覆盖。仓库同时提供 `lefthook.yml` + `prepare` 自动安装的 pre-commit hook：当 `bridge/native_command_schema.json` 变更时会自动执行 `npm run sync:protocol` 并 stage 生成产物；CI 的 `check:protocol` 仍保留为最终兜底。

`src/tools/toolRegistry.ts` 是声明式工具注册表：core/security registrars 的顺序与 capability profile 分组在这里维护，`registerTools.ts` 只遍历注册表，不再手工逐个调用。`tests/unit/tools/toolRegistry.test.ts` 与 contracts 共同锁定 registry 数量、顺序、唯一性和 security gating。`src/tools/toolAdapter.ts` 是注册层共享中间层：`sharedTabScopedToolParams`、`runTool`、`jsonToolResult/textToolResult`、`bridgeNestedErrorResult`、`artifactFallbackName` 等由 `check:tools`、`check:web-security` 与 `check:tool-docs` 锁定。新增或修改工具时先更新 registry，再复用这些基础样板，不把 WebSecurity/cookie/transfer/native command 的领域逻辑上移到 adapter。

`src/tools/distillerRegistry.ts` 是 fallback 摘要分发的唯一注册表：`registerBuiltinDistillers()` 在 runtime 与 direct-import contract 两条路径都会初始化，避免新增 fallback 摘要器时静默退回 `summarizeGenericValue()`。对应 drift contract 为 `npm run check:distiller-coverage`。

`npm run check:deps` 校验 `package.json` 与 `package-lock.json` 根依赖一致、生产依赖 allowlist、`npm ls --json --all`、`npm audit --omit=dev --audit-level=high`。结果写 `.pi/browser-artifacts/dependency-audit-summary.json`；registry/DNS/timeout 不可用时记录 `npmAudit.status:"unavailable"` 并通过，普通离线开发不被阻塞。高危/严重生产漏洞、lockfile 漂移或依赖树问题会失败。当前生产依赖 allowlist 为 `@modelcontextprotocol/sdk`、`js-yaml`、`typebox`、`typescript`、`ws`、`zod`：其中 `typebox`/`typescript`/`zod` 由源码运行路径直接消费，不能机械降到 devDependencies。依赖升级需记录范围、兼容性风险、回滚方式，并通过 `npm run check`、`npm pack --dry-run --json`，必要时跑 isolated smoke。`npm run check` 现已通过 `scripts/run-check-groups.mjs` 拆成 bridge/unit、package/docs、contracts 三组，可按故障域局部复跑。

`BrowserBridgeServer.ts` 现在保持 facade：HTTP/upgrade/origin 在 `BrowserBridgeHttpServer.ts`，client registry/selected browser 在 `BrowserBridgeClientRegistry.ts`，tab/session/default/latest/selectionVersion 在 `BrowserTabSessionRouter.ts`，pending/ACK/timeout/disconnect 在 `BrowserBridgePendingRequests.ts`，timeout snapshot 诊断在 `BrowserBridgeDiagnostics.ts`；fake WS/lifecycle fixtures 锁定行为不漂移。

`npm run check:lifecycle` 使用 fake WebSocket bridge fixture 覆盖多浏览器同数值 `tabId`、`selectBrowser`、WS 断连/重连、MV3 service worker restart、pending cleanup、tab command queue，以及 wait/network/hook 长任务 pending 诊断；失败时写 `.pi/browser-artifacts/lifecycle-fixture-failure.json`，包含 bridge snapshot、pending、target selection、listener/CDP/network recorder 状态并按字段名脱敏 cookie/token/authorization/body/postData。该 fixture 已纳入 `npm run check` 与 `npm run quality:local`，不启动真实浏览器。

`npm run check:runtime-fixtures` 使用本地 HTTP/WS fixture、fake Chrome/CDP API 和可重放 bridge envelopes 覆盖 network body/postData/HAR、hook session/listener、wait immediate/MV3 相关状态、transfer download/upload、frame evaluate、screenshot visible-tab fallback、callback worker 状态文件与 stale lock recovery；成功摘要写 `.pi/browser-artifacts/fixtures/runtime-fixtures-summary.json`，失败诊断写 `.pi/browser-artifacts/fixtures/runtime-fixtures-failure.json` 并脱敏敏感字段。该 fixture 已纳入 `npm run check` 与 `quality:local`，不启动真实浏览器，也不引入 Playwright/Puppeteer。

`npm run smoke:browser` 默认使用 `127.0.0.1:18765-18784` 首个空闲 bridge 端口。端口范围都被占用时会显式失败并在 `.pi/browser-artifacts/smoke-browser-results.json` 写入 `bridge.port.reason`：`agent_occupies`、`orphan_socket` 或 `unknown_owner`。脚本会先写入 `build.runtime`（dist target、entries、service worker sha256），只诊断 PID/命令行，不自动关闭用户进程。

`npm run smoke:browser:isolated` 会复制临时扩展目录、patch dist bridge 端口、启动独占 Chrome profile，并写入 `.pi/browser-artifacts/smoke-browser-isolated-results.json`；用于本地常驻 agent 占用 18765 时的 runtime 验证，不修改用户当前扩展目录。

`npm run smoke:browser:scan-summary` 使用独占临时扩展目录和本地 `scan-high-entropy.html` fixture，验证 `browser_observe mode=scan` 的 high-entropy summary、`artifact_hints` 精确 `jsonPath` 后续动作、artifact 可读性，以及执行后 `text_signals` 状态变化；结果写 `.pi/browser-artifacts/smoke-browser-scan-summary-results.json`，对应 scan artifact 写 `.pi/browser-artifacts/scan-summary-smoke-scan-<ts>.json`。

`npm run smoke:browser:debugger-evidence` 使用独占临时扩展目录和本地 `debugger-evidence.html` fixture，验证 `persistent_cdp` 驱动的 `Debugger.enable`、`Runtime.evaluate` payload/exception evidence、`Debugger.getScriptSource` 以及 detach/disable cleanup；结果写 `.pi/browser-artifacts/smoke-browser-debugger-evidence-results.json`，详细证据写 `.pi/browser-artifacts/debugger-evidence-smoke-artifact-<ts>.json`。

`npm run smoke:browser:correlation-chain` 使用独占临时扩展目录和本地 `interactive.html` fixture，验证 observe → execute → wait → artifact 这条链路里的 `operationId`、`snapshotId`、`waitId`、`selectionVersion*` 是否在 summary/preview 与 artifact jsonPath 中稳定可对账；结果写 `.pi/browser-artifacts/smoke-browser-correlation-chain-results.json`。

`npm run smoke:browser:intercept-response` 使用独占临时扩展目录和本地 `intercept-response.html` fixture，验证 interception primitive 的 install/addRule/auto-applied fulfill/collect/status/uninstall 路径与 fulfilled response transcript；结果写 `.pi/browser-artifacts/smoke-browser-intercept-response-results.json`。

`npm run smoke:browser:intercept-replace-script` 使用独占临时扩展目录和本地 `intercept-script-loader.html` fixture，验证 interception primitive 的 `replaceScript` 路径：页面动态加载目标 JS 资源时，规则命中后自动替换脚本正文，页面最终运行 patched script；结果写 `.pi/browser-artifacts/smoke-browser-intercept-replace-script-results.json`。

`npm run smoke:browser:intercept-uninstall-fail-closed` 使用独占临时扩展目录和本地 `intercept-response.html` fixture，验证 interception primitive 在 `intercept.uninstall` 后的 fail-closed 行为：旧规则不再生效、后续命令返回 `SESSION_NOT_FOUND`、页面重新拿到原始服务端响应；结果写 `.pi/browser-artifacts/smoke-browser-intercept-uninstall-fail-closed-results.json`。

`npm run smoke:browser:intercept-request-mutate` 使用独占临时扩展目录和本地 `intercept-request-mutate.html` fixture，验证 interception primitive 的 `continueRequest` 请求改写路径：规则命中后在 send 前改写 method/header/body，服务端回显 patched request；结果写 `.pi/browser-artifacts/smoke-browser-intercept-request-mutate-results.json`。

`npm run smoke:browser:intercept-tab-close-cleanup` 使用独占临时扩展目录和本地 `intercept-response.html` fixture，验证 tab close 后 interception cleanup/fail-closed 诊断：tab 关闭后旧 session 不再可 collect/use；结果写 `.pi/browser-artifacts/smoke-browser-intercept-tab-close-cleanup-results.json`。

`npm run smoke:browser:intercept-lease-conflict` 使用独占临时扩展目录和本地 `intercept-response.html` fixture，验证不同 browser session 在同一 tab 上进行 interception 写操作时会命中 `TAB_LEASE_CONFLICT`，并在释放 lease 后恢复可安装；结果写 `.pi/browser-artifacts/smoke-browser-intercept-lease-conflict-results.json`。

`npm run smoke:browser:websocket-session` 使用独占临时扩展目录和本地 `WebSocketServer` fixture，验证 internal/native `ws.open` / `ws.send` / `ws.wait` / `ws.replay` / `ws.collect` / `ws.close` 路径，以及 replay failure 的 `stepIndex` / `partialTranscript` 诊断；结果写 `.pi/browser-artifacts/smoke-browser-websocket-session-results.json`。

当前最终 smoke 覆盖 tabs/wait/scan/content/html/artifact/execute/pick/network/hook/evidence/frame/screenshot/download/upload，以及 scan summary v2 的高信号摘要/精准 artifact 导航、debugger evidence workflow 的 Phase 1/2 runtime evidence，cross-tool correlation chain 的 runtime evidence，interception auto-fulfill 路径的 runtime evidence，`replaceScript` 路径的 runtime evidence，uninstall fail-closed 路径的 runtime evidence，以及 request-mutate / tab-close-cleanup / lease-conflict 路径的 runtime evidence。

`bridge/native_command_schema.json` 是命令协议单一事实来源。修改协议后执行：

```bash
npm run sync:protocol
npm run check:protocol
npm run check
```

## 参考

- 安装 SOP：`AI_INSTALL.md`
- 迁移说明：`docs/browser-usage.md`
- 资产同步：`docs/asset-sync.md`
