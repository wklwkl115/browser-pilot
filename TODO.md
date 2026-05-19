# TODO

## 当前状态

- 当前主链路：`browser_tabs` -> `browser_scan` / `browser_content` / `browser_html` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎优先以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- 当前收敛的是实现路线与职责分层，不是工具能力收缩，也不是工具层安全边界收缩；扩展工具层能力第一，安全边界由 Pi 平台/安全层负责。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。

## 历史整理归档

### 1-26. 原生桥、token、artifact、content/pick 基础期（已完成）

- 原生 Pi Browser Bridge 迁移完成，保留 tabs/execute/scan/wait/network/hook/frame/html/screenshot。
- 协议单一事实源：`bridge/native_command_schema.json`；协议同步脚本与 bridge 契约已固化。
- 工具注册拆分完成，`registerTools.ts` 保持薄组合入口。
- 结果蒸馏、`detailLevel`、artifact 保存、`browser_artifact` 局部读取、错误归一化、token 预算契约已完成。
- `browser_pick` 与 `browser_content` 已补齐并纳入契约。

### 27-56. 动作拆分与 semantic DOM 探索期（已归档）

- 历史上实现过 `browser_query/click/type` 与 `browser_dom_*` nodeId 工具。
- 后续复审发现固定动作工具和 semantic nodeId 增加维护面、token 面和行为歧义。
- 已在 57 回归 GA-style 简化工具面；历史实现、测试、summary 已移除。
- 保留经验：复杂交互应通过 `browser_scan` 观察 + `browser_execute` 页面 JS/CDP 脚本完成。

### 57-73. GA-style 简化工具面与 scan/execute 强化期（已完成）

- 当前注册工具面固定为 tabs/scan/content/pick/download/upload/wait/network/hook/evidence/frame/html/screenshot/artifact/execute 与 Web 新增工具。
- `browser_scan` 已补 actionables、list_hints、top-layer、autofill 保护态和噪声过滤。
- `browser_execute` 已补 `monitor:true`，用于可选 before/after scan diff。
- upload/download、network、hook、frame、html、screenshot 均走 resultMiddleware / artifact 路径。
- 契约防止旧动作拆分工具和大 payload 回流。

## 74. CTF Web 方法论需要的下一阶段浏览器工具面

- [x] 新增 `browser_recon_probe`：live URL probing、title/status/header/tech、redirect chain、response-store artifact，支撑 Web 首轮指纹与目标列表探测。
- [x] 新增 `browser_crawl`：scoped crawl、known-file crawl、JS endpoint extraction、XHR endpoint inventory，优先复用真实浏览器会话与现有 network/artifact 能力。
- [x] 新增 `browser_fuzz_paths`：path/file/route/extension fuzzing，支持 matcher/filter、速率控制、结构化结果、artifact 归档。
- [x] 新增 `browser_fuzz_vhosts`：Host header / virtual-host discovery，支持 baseline filtering、状态/长度/标题差异摘要。
- [x] 新增 `browser_fuzz_params`：query、JSON、form、header 参数 fuzzing，支持从 captured request 生成模板；multipart 暂不作为首版。
- [x] 新增 `browser_http_replay`：raw request replay、method/header/body mutation、captured-request templates、browser-session/cookie 绑定。
- [x] 新增 `browser_cookie_analyze`：cookie/JWT/session decode、签名元数据、签名验证/secret candidate workflow、claim mutation token 生成与浏览器态 cookie 采集衔接。
- [x] 新增 `browser_sqli_probe`：SQLi oracle 分类、boolean/error/time/union 探测、请求/响应证据归档。
- [x] 新增 `browser_template_check`：模板/配置/CVE-shaped 验证，输入为 scoped target、captured request 或技术指纹，支持模板选择、匹配器和证据归档。
- [x] 新增 `browser_callback_oast`：callback listener、correlation ID、请求日志归档，用于 SSRF、盲注、反序列化等浏览器侧触发后的证据关联。
- [x] 与 `pi-ctf-protocol` 的 Web solver 保持 capability label 命名一致；能力未实现前不得在工具清单、skill 或 README 中宣称可调用。

## 75. 已实现 Web 工具补强任务

- [x] `browser_recon_probe`：补 scheme/port 扩展、TLS 证书元数据、响应 sha256、favicon sha256。
- [x] `browser_recon_probe`：继续原生补 tech hints / fingerprint 字段、favicon mmh3/相似 hash。
- [x] `browser_crawl`：补 source map、OpenAPI/Swagger、GraphQL、manifest、service worker、XHR/fetch 语义提取。
- [x] `browser_crawl`：补 source map 内容解析、OpenAPI endpoint 展开、GraphQL introspection 结果结构化、service worker cache route 提取。
- [x] `browser_crawl`：补 OpenAPI schema 参数摘要、GraphQL introspection 主动探测。
- [x] `browser_crawl`：继续原生补 source map 反向源文件归档、service worker cache 版本摘要。
- [x] `browser_fuzz_paths`：补多 FUZZ 位置、响应相似度聚类、自动 baseline、结果去重。
- [x] `browser_fuzz_paths`：继续原生补递归 fuzz、目录深度控制、baseline 聚类过滤策略。
- [x] `browser_fuzz_params`：补嵌套 JSON path、数组/对象参数、参数删除/新增矩阵、响应 diff classifier。
- [x] `browser_fuzz_params`：补 multipart 参数 fuzz、文件字段矩阵、content-type 边界变体。
- [x] `browser_fuzz_params`：补 multipart 多文件同名字段、嵌套 multipart、parser 差异聚类。
- [x] `browser_fuzz_vhosts`：补 Host/SNI 分离模式、多 baseline host、wildcard baseline 聚类、响应哈希、批量 host 归并。
- [x] `browser_fuzz_vhosts`：继续原生补 HTTPS fixture、SNI 证书差异摘要、baseline 聚类过滤策略调参。
- [x] `browser_http_replay`：补 HAR import、multipart 构造、二进制 body、请求序列 replay、baseline diff 输出。
- [x] `browser_http_replay`：补请求序列变量提取/注入、响应 diff 聚类。
- [x] `browser_http_replay`：补 HAR entry 依赖图、更多 extractor 类型、变量作用域控制。
- [x] `browser_http_replay`：继续原生补 multipart 文件字段变体矩阵。
- [x] `browser_cookie_analyze`：继续原生补 JWE、PASETO、Django/Flask/Rails 签名格式、浏览器态 claim replay 验证。
- [x] `browser_sqli_probe`：补 DBMS 指纹、ORDER BY 列数推断、UNION 列数 hint。
- [x] `browser_sqli_probe`：补 UNION 回显位枚举、布尔盲注抽取循环、DBMS-specific payload pack。
- [x] `browser_sqli_probe`：修改已完成功能文案与契约，去掉工具层能力弱化表述；保留原生 SQLi probe 能力，并把深度自动化分工明确给 `browser_sqlmap_bridge`。
- [x] 新增 `browser_sqlmap_bridge`：同包内可选 bridge；按 Pi package 可迁移方式深度适配现有工具架构，不依赖用户本机私有绝对路径或临时脚本；已按 `sqlmapPath` / `sqlmapArgs` 显式 launcher + PATH/module auto-detect 双路径落地，统一复用 raw request/HAR/cookies/session 输入链路，输出结构化 findings / artifacts，并补 smoke + callable-tool runtime 验证。
- [x] `browser_template_check`：补 YAML 模板、DSL matcher、extractor 输出 schema、template result 去重。
- [x] 通用解析：将 template YAML 的手写 parser 替换为 `js-yaml`，并补契约 / 回归。
- [x] `browser_template_check`：修改已完成功能文案与契约，去掉工具层能力弱化表述；保留原生 template/config/CVE-shaped check 能力，并把大规模模板生态与深度扫描分工明确给 `browser_nuclei_bridge`。
- [x] 新增 `browser_nuclei_bridge`：同包内可选 bridge；按 Pi package 可迁移方式深度适配现有工具架构，不依赖用户本机私有绝对路径或临时脚本；已按 `nucleiPath` / `nucleiArgs` 显式 launcher + PATH auto-detect 落地，输入 target/raw request/HAR/headers/cookies/template selectors，调用 `nuclei`，输出结构化 matches / artifacts，并补 smoke + callable-tool runtime 验证。
- [x] `browser_callback_oast`：继续原生补 DNS callback provider、HTTPS listener、external tunnel metadata、callback trigger helper、事件持久化恢复。
  - 已定执行方式：保持同包原生实现；用 detached 本地 worker + 落盘 session state 做 listener 持续化与 reload 后恢复，不引入外部 tunnel/provider 依赖。
  - 参数方向：补 HTTP/HTTPS/DNS 多 listener、external metadata、trigger action；保留现有 HTTP callback URL contract 不漂移。

## 76. Web 工具注册壳去重（当前优先）

- [x] 抽取 `registerWebSecurityTools.ts` 公共注册执行壳：统一 `ensureStarted`、budget、cookieProvider、artifact/distill、errorResult；保留每个工具显式 schema、summary 与 command，不做黑盒元注册。
- [x] 补契约：防止注册外壳重复回流；新增/增强 Web 工具时必须复用公共执行壳，同时保持 `registerTools.ts` 为薄组合入口。
- [x] 当前轮次已静态查证：未发现默认入口冲突、相邻工具描述漂移或实现职责重叠；后续若再次出现，再单独新开观察项收束。

## 77. 已定方向：单包分层、成熟替代直接适配（新增）

- [x] 固化单包分层：`browserNative` / `bridges` / `shared`；保留一个 Web 包，不拆成多个扩展，也不再新增并行 Web 包。
- [x] 固化核心原生层：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_params`、`browser_fuzz_vhosts`、`browser_http_replay`、`browser_callback_oast` 继续作为 Pi-native 浏览器态执行层。
- [x] 固化成熟替代接入：template YAML 直接改用 `js-yaml`；深度 SQLi 直接落到 `browser_sqlmap_bridge`；深度模板/指纹批量扫描直接落到 `browser_nuclei_bridge`；成熟替代必须适配成 Pi-native tool contract，而不是本地临时 glue。
- [x] 固化已完成工具职责分工：`browser_sqli_probe` 与 `browser_template_check` 保留原生能力优先，深度 SQLi / 深度模板扫描交给成熟引擎 bridge；同步修改 README、skill、contracts、solver 文案，删掉工具层能力弱化或追平成熟 CLI 的旧表述。
- [x] 固化 bridge 深适配要求：复用现有注册执行壳、budgets、artifact、summary/distill、cookie/HAR/raw-request 输入链路、runtime smoke + callable-tool runtime 验证；依赖管理必须可随 Pi package 迁移，不依赖用户本机私有路径或手工拼接脚本。
- [x] 固化工具层边界表述：这里收敛的是实现分层、维护面和成熟替代接入方式；不在工具层增加能力弱化默认值、风险分级闸门或安全收缩文案。

## 78. Web 安全核心拆分与类型收紧（新增）

- [x] 拆分 `src/tools/webSecurityCore.ts`：已落地 `src/tools/webSecurity/shared/*` 与分工具实现模块；`webSecurityCore.ts` 退化为薄导出层/兼容入口。
- [x] 保持拆分过程中的外部接口稳定：现有工具名、schema、artifact 路径、summary 字段、contracts、runtime smoke/actual test 入口未因模块拆分漂移。
- [x] 收紧内部类型：保留工具入口对外部输入的兼容性，在实现层前补 `NormalizedProbeOptions`、`NormalizedReplayOptions`、`NormalizedSqliProbeOptions`、`NormalizedTemplateCheckOptions` 等强类型归一化。
- [x] 梳理 `unknown` 使用边界：大块 `?: unknown` 已收口到工具输入 / 通用解析入口，runner 与核心执行路径不再依赖单文件大面积传播。
- [x] 补契约防回流：contracts 已检查 `webSecurityCore.ts` 薄导出层、`js-yaml` 解析入口与 `Normalized*Options` 约束，防止核心文件再次膨胀回总装文件。
- [x] 拆分顺序与前面路线绑定：已在 `browser_sqli_probe` / `browser_template_check` 文案修正与 `js-yaml` 替换后完成核心拆分；下一步进入 `browser_sqlmap_bridge` / `browser_nuclei_bridge`。

## 79. Web 安全 raw/normalized 输入边界收口（当前）

- [x] 将 `src/tools/webSecurity/shared/types.ts` 的工具入口参数显式命名为 `Raw*Options`；保留旧 `*Options` 别名仅作兼容，不再作为执行层主语义类型。
- [x] 为 `src/tools/webSecurity/browserNative/fuzzPaths.ts`、`fuzzVhosts.ts`、`cookieAnalyze.ts`、`callbackOast.ts` 补 `Normalized*Options`，并让 runner 在 normalize 后只消费规范化字段。
- [x] 补 contract，防止上述 4 个 runner 重新直接消费 raw `unknown`。

## 80. Bridge artifact 与 multipart 后续收口

- [x] `browser_sqlmap_bridge` / `browser_nuclei_bridge`：将 request/stdout/stderr 日志补成 `browser_artifact` 兼容 Artifact 描述符，包含 path、bytes、chars、lineCount、sha256，并在 summary 中暴露可直接读取的 artifact 表。
- [ ] `browser_http_replay` multipart：当前 builder 覆盖常规、同名多文件、嵌套 multipart 与 Content-Type 边界变体；后续仅在真实 CTF 样本暴露边界不兼容时，再按 fixture 补 raw multipart passthrough、固定嵌套 boundary、per-part header 保留、captured raw body 反解析后 mutation。

## 81. JSON path 原型链污染修复

- [x] `mutateParamRequest` / JSON path mutation：改为只读写 own property，`__proto__`、`constructor`、`prototype` 作为普通 JSON 数据键序列化，不再触达继承原型链。
- [x] `deleteJsonPath`：删除操作只遍历 own property，避免通过继承属性访问或删除原型对象字段。
- [x] 补契约：覆盖 `__proto__.polluted`、`constructor.prototype.polluted` set/delete，断言 `Object.prototype` 不被污染。

## 82. Callback OAST state 写入竞态修复

- [x] `callbackOast.ts` / `callbackOastWorker.mjs`：为共享 `state.json` 的读-改-写路径补跨进程 lock file，避免主进程 clear/stop 与 Worker append/shutdown 互相覆盖。
- [x] Worker 事件追加改为 locked fresh-state update，保留并发事件、单调 `nextSeq`、stop/ready 控制字段，不再用旧内存快照整体覆盖。
- [x] 补契约：并发 HTTP 回调 burst 后收集数量与 seq 唯一性稳定，clear 后状态保持为空。

## 83. JSON fuzz 畸形 body 静默重写修复

- [x] `mutateParamRequest` JSON 分支：非空 body 的 `JSON.parse` 失败时抛出明确错误，不再静默初始化 `{}` 并丢失原始 payload。
- [x] 有效但非 object/array 的 JSON body 直接失败，避免把 primitive JSON 静默替换为新对象。
- [x] 补契约：直接 JSON mutation 与 `browser_fuzz_params` malformed JSON case 均记录失败，不返回破坏性重写后的请求体。

## 84. Raw HTTP 重复 Header 解析覆盖修复

- [x] `parseRawHttpRequest`：重复 header 改为 case-insensitive 合并，不再由后一个同名 header 静默覆盖前值。
- [x] `Cookie` 使用 `; ` 合并，通用 header 使用 `, ` 合并，保留 folded continuation 到当前活动 header。
- [x] 补契约：覆盖重复 `Cookie`、大小写不同的重复 `X-Forwarded-For` 与 folded header continuation。

## 85. WebSocket 断连 pending Promise 快速失败修复

- [x] `PendingRequest` 记录承载请求的 WebSocket client，避免仅靠 `tabId` 推断连接归属。
- [x] `BrowserBridgeServer.unregisterClient` 断连时立即清理并 reject 该 client 上所有 pending 请求，不再等待 10~15 秒 timeout。
- [x] 补 fake WebSocket 契约：发送命令后断开连接，pending 立即以 `BRIDGE_CLIENT_DISCONNECTED` 失败且 `pending` 表清空。

## 86. Multipart 边界解析数据损坏修复

- [x] `parseMultipartBody`：移除全局 `raw.split("--boundary")`，改为仅识别行首 multipart delimiter / closing delimiter。
- [x] 删除对每个 segment 的无差别 `endsWith("--")` 裁剪，保留 part payload 中真实尾部横杠。
- [x] 补契约：覆盖 payload 以 `--` 结尾、payload 内包含 `--boundary` 文本时不损坏内容。
- [x] 补 raw request 边界：`parseRawHttpRequest` 只规范化 header 区，不再把 multipart body 的 CRLF 改写成 LF，避免新 parser 无法识别标准 delimiter。

## 87. 现代 Rails 加密 Cookie 支持补齐（原生完整实现）

- [x] `cookieTokens.ts`：原生补齐现代 Rails `MessageEncryptor` encrypted-cookie 识别、AES-GCM 解密/校验、metadata 解析、purpose/expiry 暴露与结构化结果输出。
- [x] 保持现有 signed-cookie 兼容，同时补齐 encrypted-cookie 的 key derivation 变体、claim mutation 重新加密、失败路径与无匹配 secret 证据输出。
- [x] 补 fixture / contract / docs / runtime verification：已完成现代 Rails AES-GCM cookie 成功/失败解密、mutation token、summary、docs/contract 与 actual callable-tool runtime artifact。

## 88. 质量评审剩余确认缺陷修复

- [x] `http.ts`：收敛空 Buffer `simHash64` 固定碰撞。
- [x] `callbackOastWorker.mjs`：修复 DNS QTYPE/QCLASS 16-bit 序列化截断。
- [x] `callbackOast.ts`：关闭派生 worker 后父进程持有的 stdout/stderr log FDs。
- [x] `cookieTokens.ts` / `cookieAnalyze.ts`：消除 Rails PBKDF2 同步阻塞主事件循环的路径。
- [x] `sqliProbe.ts`：为确认命中的 probe 增加可控短路终止，减少无意义后续发包。

## 89. Rails encrypted cookie 后续质量评审修复

- [x] `cookieTokens.ts`：严格区分 Rails metadata 内层 message 的 standard base64 与 base64url，mutation 不改写原编码族。
- [x] `cookieTokens.ts`：encrypted token 外层三段做 canonical round-trip 校验，未解密命中的三段值只作为 possible evidence，不计入已验证 token。
- [x] `cookieTokens.ts` / contracts：暴露 Rails encrypted key variant 测试计数，补大 wordlist 异步预算回归。
- [ ] 清理或确认 `.aceignore` / `AI_INSTALL.md` / `AGENTS.md` 等非本轮功能项是否纳入提交。

## 90. Rails legacy CBC / binary serializer / direct key 质量评审修复

- [x] `cookieTokens.ts`：补 Rails legacy AES-256-CBC encrypted cookie（外层 signed wrapper + 内层 `ciphertext--iv`）自动识别、解密、metadata/payload 输出与 mutation 重新加密重签。
- [x] `cookieTokens.ts`：解密成功但 plaintext 为 Marshal/二进制时保留 serializer、hex/base64/sha256/bytes 证据，不静默丢失 payload。
- [x] `cookieTokens.ts` / contracts：Rails signed direct hex/base64/base64url key candidate 与 mutation 重签使用同一 key source / key bytes。
- [x] contracts / docs / skill / CTF 方法层：已同步 legacy CBC、binary serializer 与 direct key 能力，并补本地验证和 reload 后 callable runtime 验证。

## 91. Rails cookie 逻辑按模块收敛

- [x] `src/tools/webSecurity/shared/cookieTokens.ts`：移除 Rails 专属解码/验签/加解密实现，仅保留 orchestrator、跨格式通用 helper 与结果聚合。
- [x] 新增 `src/tools/webSecurity/shared/railsCookieTokens.ts`：承接 Rails signed / AES-GCM / legacy AES-CBC / Marshal-binary / direct-key 相关实现，复用注入的通用 helper，避免逻辑重复与循环依赖。
- [x] contracts：更新模块边界检查，确保 Rails 专属实现不再回流 `cookieTokens.ts`，并保持 callable 行为不变。
- [x] verification：已跑 `npm run check`、`pi-ctf-protocol npm run check`、skill validate；本次仅内部重构，无额外 runtime reload 需求。

## 92. HAR 依赖图相对 URL 崩溃修复

- [x] `src/tools/webSecurity/shared/replay.ts`：`buildHarDependencyGraph` / `harDependencyResponseInfo` 对 HAR 相对 URL、相对 Referer、相对 Location 做安全规范化，不再对 `new URL(relative)` 直接抛异常。
- [x] `browser_http_replay` / contracts：已补相对 HAR URL + `baseUrl` 回放与 dependencyGraph 回归，redirect/referer/cookie 边保持可用。
- [x] docs：已在 `CHANGELOG.md` 记录本次 HAR 相对 URL 兼容性修复。

## 93. Callback OAST DNS query 名称长度校验修复

- [x] `src/tools/webSecurity/browserNative/callbackOast.ts`：`buildDnsQuery` 对 DNS label 字节长度（<=63）与整条 QNAME 线长（<=255）做显式校验，避免超长 label 生成畸形报文或单字节长度截断。
- [x] contracts：已补超长单 label 与超长总 QNAME 的失败回归，并保留合法 63-byte label 的 DNS trigger 行为。
- [x] docs/runtime：已在 `CHANGELOG.md` 记录该协议兼容性修复；已补本地 smoke 与 actual callable-tool runtime artifact。

## 94. Callback OAST IPv4-only DNS response 地址校验修复

- [x] `src/tools/webSecurity/browserNative/callbackOast.ts` / `callbackOastWorker.mjs`：已对 `dnsResponseAddress` 做 IPv4 合法性校验；当前 A 记录响应不接受 IPv6/非 IPv4 输入，不再静默回落到错误的 `0.0.0.0` 类响应。
- [x] contracts：已补 `dnsResponseAddress="::1"` 等非法输入失败回归，并保留合法 IPv4 DNS trigger / listener 行为。
- [x] docs/runtime：已在 `CHANGELOG.md` 记录该协议兼容性修复；reload 后 local smoke 与 actual callable-tool runtime artifact 已完成。

## 下一步建议顺序

1. 确认未跟踪 `AGENTS.md` 是否纳入版本控制；默认不要混入当前 Web 安全修复工作流。
2. 如后续出现真实 HAR 样本，再补无 `baseUrl` 场景下 hostless/相对 URL 依赖图的针对性 fixture。
