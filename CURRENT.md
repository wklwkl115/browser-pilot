# CURRENT

## 当前状态

- 当前主链路：`browser_tabs list` / `browser_tabs switch|create` -> 显式 `tabId` -> `browser_scan` / `browser_content` / `browser_html` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎仅以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- 下一阶段核心遵循文件：`NEXT_PHASE.md`。执行工具边界治理、统一输出诊断、Web Security 内部 primitive 抽取、schema builder 收敛、ACI eval 前，先按该文件更新本文件中的具体决策与验证计划。
- TODO 200-215 工程治理期已完成；后续新增能力必须先在本文件补决策、边界文档、契约与验证计划。
- 已撤回 `browser_orchestrate` / orchestration coordinator / target resolver 工具面；默认浏览器自动化恢复为 `browser_tabs` first + 显式 `tabId`。
- 后续仍保持能力完整性：不新增工具层安全闸；安全边界继续由 Pi 平台/安全层负责；新增高层状态管理必须先证明比显式 tab 流程更低模型负担。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。

## 当前执行：Workstreams A-E 收尾完成

决策：`NEXT_PHASE.md` Workstreams A-E 当前主线已完成。A-D 完成工具边界治理、输出诊断 envelope、Web Security 内部 primitive 抽取与 schema builder 收敛；E 完成 static/manual realistic ACI eval suite。收尾摘要见 `WORKSTREAMS_A_E_SUMMARY.md`。后续新增行为、runner/server 或 runtime eval 必须先按 `ROADMAP.md` 开新阶段并更新本文件。

边界：

- 已新增 `src/tools/webSecurity/shared/requestTemplate.ts` 承载 raw/captured request parsing 与 `buildReplayRequest`。
- 已新增 `src/tools/webSecurity/shared/har.ts` 承载 HAR entry selection、safe URL filtering 与 HAR dependency graph。
- 新增 `src/tools/webSecurity/shared/baseline.ts` 承载 baseline strategy、status/body match、response delta/classifier、nearest baseline 与 HTTP baseline cluster helper。
- `shared/replay.ts` 保留 replay variable、sequence、mutation、send replay request 等编排 helper，并 re-export 兼容入口。
- `webSecurityCore.ts` 继续导出 `buildReplayRequest`、`parseRawHttpRequest`；现有 imports 可小步迁移但不要求一次性改所有调用方。
- `fuzzPaths`、`fuzzVhosts`、`fuzzParams`、`httpReplay`、`cookieAnalyze` 只迁移重复 baseline/delta 计算；保留原输出字段名和值语义。
- 新增 `src/tools/webSecurity/browserNative/crawlExtractors.ts` 承载 HTML/JS URL 抽取、manifest/service-worker/source-map hints、form inventory、OpenAPI/Swagger parsing、passive GraphQL schema parsing、source-map archive details 与 service-worker cache/version summary。
- `crawl.ts` 保留 crawl orchestration、fetch、browser cookie binding、active GraphQL POST probe、artifact root lifecycle、queue/scope/depth/maxPages 控制与结果组装。
- 新增 `src/tools/webSecurity/browserNative/oastWorkerManager.ts` 承载 callback OAST session artifact path/state lock、state load/update/save、worker process spawn/stop、session refresh/list/info/event filtering/wait helpers。
- `callbackOast.ts` 保留 raw option normalization、HTTP/HTTPS/DNS trigger packet/request logic、action dispatch 与 callable result shape。
- 新增 register-layer schema builder 只能返回同等 TypeBox field object；不得泛化描述或合并不同语义的 tool-specific 字段。
- 已完成：`browserCookieBindingParams(description, options)` 替换重复的 `bindBrowserSession` / `cookieMode` 参数定义；不同描述保持调用点显式传入，非 `cookieMode` 工具显式 `includeCookieMode:false`。
- 已完成：`harReplayParams({ harDescription, harPathDescription })` 替换 `httpReplay` / `sqlmapBridge` / `nucleiBridge` 的 `har` / `harPath` / `harEntryIndex` / `harUrlPattern` / `harMaxEntries` 定义；HAR 对象与路径描述保持调用点显式传入，bounded safe-regex 文案逐字保留。
- 已完成：`rawRequestParams({...descriptions})` 替换 `sqliProbe` / `sqlmapBridge` / `nucleiBridge` 的 `url` / `baseUrl` / `rawRequest` / `request` / `method` / `headers` / `body` / `bodyBase64` / `mutations` / `defaultScheme` 定义；每个差异描述保持调用点显式传入，暂不迁移 `httpReplay`、`fuzzParams`、`templateCheck` 的特殊 raw request 语义。
- 已完成：`requestSequenceParams({ requestsDescription, sequenceDescription })` 替换 `httpReplay` / `sqlmapBridge` / `nucleiBridge` 的 `requests` / `sequence` 定义；每个工具的 replay/bridge-specific 描述保持调用点显式传入，不迁移非 sequence 工具。
- 已完成：`boundedExecutionParams({ timeoutSecondsDescription })` 替换 `sqlmapBridge` / `nucleiBridge` 的 `timeoutSeconds` 定义；保留 sqlmap/nuclei per-request timeout 描述差异，不迁移 `timeoutMs`、`maxBodyBytes`、redirect、rate-limit、case/candidate/page 等语义不同字段。
- 已完成：`redirectControlParams({ followRedirectsDescription, maxRedirectsDescription })` 与 `rateLimitPerSecondParam(description)` 替换当前已显式暴露 `followRedirects` / `maxRedirects` / `rateLimitPerSecond` 的工具字段；每个工具的 default true/default false/replay determinism/stable matching/nuclei CLI `-rl` 描述保持调用点显式传入。
- 已完成：`maxCasesParam(description)` / `maxCandidatesParam(description)` / `maxDepthParam(description)` / `maxPagesParam(description)` / `maxTemplatesParam(description)` 替换当前已显式暴露对应字段的工具；保留 fuzz params、SQLi、crawl、fuzz paths/vhosts、template 的 default/hard-cap 与业务语义，不迁移 SQLi 专属 union/extract/baseline、cookie/OAST、nuclei/sqlmap CLI retries/concurrency/bulkSize 等单工具或工具特定字段。
- 收尾决策：不实现 `targetScopeParams()`；`url` / `urls` / `paths` / `defaultScheme` / `ports` / `schemes` 在 recon、crawl、fuzz、replay、template、nuclei 中分别承载 seed/base/FUZZ/candidate/raw request/template expansion 等不同语义，抽象会降低工具描述精度。
- 收尾决策：不实现 `artifactResultParams()`；`detailLevel` / `outputPath` / `maxChars` 已由 `sharedTabScopedToolParams()`、`sharedWebSecurityParams()`、`sharedWebSecurityBrowserSessionParams()`、`sharedWebSecurityResultParams()` 覆盖，再抽会制造重复共享入口。

Workstream E 当前完成状态：

- 已创建 `evals/browser-workflows/`。
- 已覆盖 `NEXT_PHASE.md` 的 10 个 realistic ACI eval tasks。
- 已拆分为 10 个独立 spec 文件，每个 eval 记录目标、fixture、推荐工具序列、成功条件、关键 artifact/diagnostics 证据、失败恢复点与评估指标。
- 已补 `spec-template.md`、`fixtures/README.md`、synthetic local fixtures、`manifest.json`、`manual-result-template.json`、`result-schema.json`、`results/README.md`、`future-runner.md`。
- 已新增 `tests/contracts/check-eval-workflows.mjs` 与 `check:eval-workflows`，并接入 `npm run check`。
- `package.json` 已把 `evals/` 纳入 package files，`check-package-files` 锁定 eval specs/fixtures 被打包。

Workstream E 边界：

- 当前 suite 是静态 ACI eval 规范、fixture、manifest 与手工结果 schema 体系，不新增 callable tool。
- 不启动浏览器、不启动 fixture server、不访问外部网络、不执行 sqlmap/nuclei/OAST。
- `manifest.json` 声明 `externalNetwork:false`、`runsBrowser:false`、`runsScanners:false`；`future-runner.md` 冻结后续 runner/server 必须单独设计并显式 opt-in。

验证计划：

- `npm run check:eval-workflows`
- `npm run check:package`
- `npm run check:tools`
- `npm run check`

## 工程治理期执行原则（TODO 200-215，已完成）

- 能力冻结：除阻断性 bugfix 外，不新增 callable tool、不新增默认扫描/自动化决策流、不扩大默认网络/文件/外部进程行为；新增能力必须由后续 TODO 显式解除冻结并给出迁移/回滚边界。
- 稳定优先：所有改动必须保持工具名、参数 schema、错误码、summary/artifact envelope、runtime smoke 证据链兼容，除非 TODO 明确迁移并提供回滚。
- 本地优先：质量门禁、依赖审计、发布验收、runtime fixtures 均先做本地脚本；不引入 GitHub Actions、Dependabot、Sentry、SonarQube、自动 registry 发布作为当前主线。
- 风险导向：测试补强优先覆盖多浏览器、MV3 重启、pending cleanup、长等待、network/hook/transfer 证据保真；不追求固定覆盖率数字。
- 审计优先：错误、artifact、redaction、发布包、协议生成都要可复现、可追踪、可本地验证；禁止 silent fallback、模糊默认和只靠文档声明的完成状态。

## 当前执行队列

### TODO 216: 原生多 browser session / 并发路由

状态：阶段 1-6 已完成；runtime smoke 已通过；跨 Pi 进程 bridge 端口争用修复已完成。

决策：

- 在 `pi-browser-tools` 侧原生支持多并发、多 browser session 接入；OMO 只是调用方，不作为浏览器隔离模型前置依赖。
- 对外高级参数命名为 `browserSessionId`；普通 agent 不应手写，后续由调用上下文自动解析；显式参数仅用于调试、测试、编排和接管。
- 先做内部 `default` session 迁移，保持现有工具行为和旧测试兼容，再开放多 session API。
- 全局 tab inventory 继续记录真实 browser client/tab 事实；`selectedClient`、`defaultSessionId`、`latestSessionId`、`selectionVersion` 迁入 browser session state。
- `browser_tabs selectBrowser/switch` 只影响当前 browser session，不再作为全局唯一选中状态。
- 新 session 初始为空；调用方必须显式 `create` 或 `attachTab`，不自动继承主 agent tab，不自动创建 `about:blank`。
- 同一个真实 tab 可被多个 session 只读共享；写操作必须取得 tab lease；`pick/upload/focus/switch` 等真实 UI 操作走全局 UI lock。
- Session id 由系统生成稳定 uuid；调用方可传 `name` 便于诊断；显式指定完整 `browserSessionId` 仅用于测试/调试。
- 写操作先按保守边界分类：`browser_execute`、导航类 `browser_wait`、`tabs switch/create/close`、`browser_upload`、点击型 `browser_download`、`hook install/uninstall`、`network start/clear` 需要写 lease 或 UI lock。
- 读操作先包括：`browser_scan`、`browser_html`、`browser_content`、`browser_screenshot`、`network list/get/body/status`、`browser_evidence`、`browser_artifact`。
- Lease 冲突立即返回 `TAB_LEASE_CONFLICT`；不隐式等待。后续如需要等待，单独增加显式 wait-for-lease 能力。
- Session 生命周期先采用手动 close；断线状态保留到 server stop，不做 TTL 自动清理，避免后台证据丢失。
- `browserSessionId` schema 暴露分两阶段：阶段 1 不对外暴露，只迁移内部 `default`；阶段 2 全工具统一暴露高级参数。

边界：

- 不恢复历史动作拆分工具，不新增 orchestration coordinator。
- 不把 OMO task/call_omo_agent 作为浏览器 session 的实现前提。
- 第一阶段不要求 Pi/OMO 已提供 tool invocation identity；无上下文时解析到 `default` session。
- 不依赖 prompt 要求 agent 手写 `browserSessionId` 作为隔离机制。

实施顺序：

1. 已完成：新增 `BrowserSessionRegistry`，内置 `default` session，把现有全局选择状态迁入 session state，外部行为不变。
2. 已完成第一段：`BrowserTabSessionRouter` / `BrowserBridgeServer` 当前经内部 `default` session 计算 fallback target；后续扩展为显式多 session 入参。
3. 已完成：工具 schema 增加可选 `browserSessionId`，并统一经 resolver 传入 server；普通路径默认 `default`。
4. 已完成：增加 session 管理动作 `listSessions`、`createSession`、`selectSession`、`closeSession`、`attachTab`、`detachTab`、`leaseTab`、`releaseTab`。
5. 已完成：真实 tab 写 lease 与全局 UI lock 基础能力已接入；`browser_execute`、写类 native command、`switch`、`pick`、`upload` 进入冲突检测；per `(browserSessionId, tabId)` 写命令队列已接入并在 snapshot 暴露深度。
6. 已完成：distilled result envelope 记录 `browserSessionId`，native evidence/wait/network/hook 等经共享 result middleware 输出 session 维度；artifact 原始值中 tab-scoped bridge result 保留 `target.browserSessionId`。session hash 路径分区暂不需要。
7. 接入 Pi tool invocation context 后，把自动 session 分派接入 resolver。

补充修复：

- 已完成：Node bridge 启动时在 `18765-18784` 选择首个空闲端口，避免第二个 Pi 进程因 `EADDRINUSE` 进入 `browser:error`。
- 已完成：浏览器扩展 service worker 扫描同一端口范围并同时连接多个 Pi bridge server，不再只连 `18765`。
- 已完成：tab sync fan-out 到所有 open bridge sockets，多个 Pi 对话窗口共享同一扩展时都能收到 tabs_update。

验证计划：

- 已通过：每阶段运行 `npm run check`。
- 已通过：合同测试覆盖默认 session 兼容、多 session 独立 selection、显式 `browserSessionId` 路由、空 session、attach/detach、写 lease 冲突、UI lock 冲突、artifact/evidence session 字段、同 session 同 tab 写队列。
- 已通过：`npm run smoke:browser:isolated` 真实浏览器 smoke，覆盖两个 browser session 分别 execute/read、lease 冲突和 target.browserSessionId；artifact：`.pi/browser-artifacts/smoke-browser-isolated-results.json`。

- 已完成历史条目移入 `ARCHIVE.md`；后续建议与延后项移入 `ROADMAP.md`。

## 归档与路线入口

- 历史完成项：`ARCHIVE.md`。
- 后续路线/建议顺序：`ROADMAP.md`。
