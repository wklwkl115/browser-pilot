# MCP 标准化 + 渐进式披露 + I/O 信息边界中间件(完整重设计 v3)

> v3 在 v2 基础上把"结果蒸馏"升级为一个**对称的 server 侧 I/O 信息边界中间件**:**出=蒸馏、进=解析**,两侧都只吃协议机制、把决策全留给 agent。它**强化而非替代** MCP 原生机制(structuredContent/outputSchema/resources)。已并入评审强化(typed 句柄/资源生命周期/outputSchema 零漂移/分层量化/门控互补)与 FastMCP 借鉴(中间件分两层、不引框架)。
> 立意:**渐进式披露 = 一个原则、两条轴,所有权不同**——**工具轴归宿主(client/host)**,**结果轴归 server**;server 这半边由一个 **I/O 中间件**统一承载(出 + 进)。
> 关联:落地 [[tool-surface-progressive-disclosure-direction]];annotations 与门控**互补**;不回退 `tool-parameter-contract.md`;延续"薄表面 / brain-hand"主题。

---

## 0. 关键事实(已核实,带版本/来源)

**MCP 规范(2025-06-18 起,2025-11-25 为最新):**
- **结构化工具输出**:Tool 可声明 `outputSchema`(JSON Schema);`tools/call` 结果可带顶层 `structuredContent`。规范:声明 outputSchema 就 MUST 返回 structuredContent,并 SHOULD 同时在 `content` 放序列化 TextContent 做兼容。
- **工具渐进披露归属**:规范明确"哪些工具 schema 进 LLM 上下文、何时加载是 **client/host 的职责**";server 侧**无**惰性 schema/工具搜索原语,只能 `tools/list`(cursor 分页)+ `notifications/tools/list_changed`。
- **工具 annotations**(hint、非安全边界、untrusted unless trusted server):`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`。
- **Resources**:`resources/list`、`resources/templates/list`(RFC6570 + completion 补全)、`resources/read`、`resources/subscribe` + `notifications/resources/updated`、`resource_link` content type、embedded resource、resource annotations。

**已装 SDK 1.29.0 全部支持**:outputSchema、structuredContent、content type resource_link/resource、ListResourceTemplates、Subscribe/Unsubscribe、ResourceUpdated、Tool/ResourceListChanged、Progress、Logging、Complete;Server 方法 sendToolListChanged/sendResourceListChanged/sendResourceUpdated/sendLoggingMessage;capabilities 子项 tools.listChanged、resources.{subscribe,listChanged}、prompts.listChanged、logging、completions。

**项目现状:**
- 核心层(`src/driver`/`tools`/`utils`)平台无关;MCP 适配 `mcp/` 目前只 `{tools:{}}` + ListTools/CallTool,丢 onUpdate/ctx,无 resources。
- **蒸馏中间件已存在**:`distillerRegistry`(registerDistiller/registerCommandDistiller + 查表分发,fallback generic);summarizers 产紧凑结构;`distilledJson/TextResult` 三档;`fitSummaryBudget` 四级压缩(`SUMMARY_BUDGET_CHARS=8000`/`SUMMARY_MAX_CHARS=12000`);超阈值/敏感落 `.pi/browser-artifacts/` + `saved:{path,bytes,chars,mime}` + `nextActions` 引导 `browser_artifact`(text/json/search/sample + 分页)。

---

## 1. 立意:两条轴 + 一个 I/O 中间件

| 轴 | 谁负责渐进披露 | 备注 |
|---|---|---|
| **工具轴**(哪些工具 schema 进上下文) | **client/host**(规范定死) | server 只保持干净 `tools/list` + 精确 annotations + 薄 schema |
| **结果轴**(结果数据怎么进上下文) | **server** | 由下面的 I/O 中间件承载 |

**server 这半边 = 一个对称的 I/O 信息边界中间件**,管两个方向:
- **出(egress)= 结果蒸馏**:原始数据 → 蒸馏 → 结构化内联(`structuredContent`,最少 token)+ 详情/原始变成**句柄**(resource URI)。
- **进(ingress)= 引用解析**:agent 在需要 payload 处**直接传句柄**,中间件 server 侧解析 → 取回 → 展开成真实 typed 输入 → 正常校验 → 执行。

**统一原则:机制全归中间件,决策全留 agent。** 两侧对称——结果是句柄,句柄又能当输入——agent 活在"句柄 + 决策"层,不碰 payload、不写协议管道。这是 brain-hand 在 I/O 层的落地,也把"最少 token 最多价值"做到两个方向。

---

## 2. 架构:Ports & Adapters + core 内 I/O 中间件

```
                      ┌──────────── 核心(domain,平台无关) ────────────┐
   agent 决策 + 句柄 ──▶│  I/O 信息边界中间件                              │
                      │   ├─ ingress: resolveHandle(uri) → typed 输入   │
                      │   │            + 机制归一/默认 + 最廉价前置        │
                      │   ├─ 工具核心 execute(纯能力)                    │
                      │   └─ egress: distill → DistilledResult {        │
                      │        structured(summary+outputSchema),         │
                      │        raw, sections, meta }                     │
                      └───────────────────┬─────────────────────────────┘
                                          │ HostPort
              ┌───────────────────────────┴───────────────────────────┐
        ┌─────▼──────────────────────┐          ┌────────────────────▼─────┐
        │ MCP Adapter                 │          │ Pi Adapter (index.ts)     │
        │ 句柄 ↔ resource URI          │          │ 句柄 ↔ artifact path        │
        │ 出: structuredContent +      │          │ 出: 现状 envelope + 本地文件 │
        │     outputSchema + 兼容 text │          │     + browser_artifact     │
        │     + resource_link;         │          │ 进: 解析 artifact path/     │
        │     resources/read=          │          │     operation id            │
        │     artifactReader           │          │ progress → onUpdate/ctx.ui  │
        │ 进: 解析 resource URI         │          │ (行为与现状等价)             │
        └─────────────────────────────┘          └───────────────────────────┘
```

- **中间件在 core**(平台无关),两个 adapter 都受益;**句柄空间由 adapter 映射**(MCP=resource URI,Pi=artifact path/operation id)。
- `HostPort` 接口:`present(distilledResult)`、`publishResource(id, producer, {kind, ttl?, immutable?}) → handle`、`revokeResource(id)`、`resolveHandle(handle, {expectKind?}) → {value, meta}`、`reportProgress(token, update)`。核心不再泄漏 `ctx.ui`/`onUpdate`/`PiTextToolResult` 形状/文件路径。
- **资源生命周期**(评审风险2):资源是 **durable artifact 之上的 session 级句柄**;`ttl`/`revokeResource` 提供回收;实时资源(network 录制/OAST)绑操作生命周期,操作终态即定格。注:`.pi/` artifact 今天本就无回收策略,统一保留策略是真 TODO(部分既有债,不阻塞)。
- **中间件分两层**(吸收 FastMCP 的中间件模型):
  - **核心语义中间件**(distill / resolve)——平台无关、在 core、两个 adapter 都吃;是 V3 主体(§3)。
  - **MCP-adapter 协议中间件**——只在 MCP 路、纯协议 cross-cutting(auth / rate-limit / MCP logging / `on_list_tools` 过滤),采用 **FastMCP 风格 hook 命名**(`on_message`/`on_call_tool`/`on_read_resource`/`on_list_tools`/`on_initialize`)。详见 §5。
- **prior art / 背书**:FastMCP(Python,gofastmcp.com)的 MCP-Native Middleware 是这套"语义 I/O 中间件"的生产级事实标准——**印证 V3 押注正确,其 hook 分类法可直接借鉴**。但**不引入框架**:Python 旗舰用不了,TS 端口(punkpeye/fastmcp)成熟度低,且框架"server 拥有一切"的假设与本项目"core 平台无关 + 双 adapter"冲突。`skillful-mcp` 是"按需工具发现"的现成先例(参 §4.3)。

---

## 3. I/O 信息边界中间件:出(蒸馏)+ 进(解析)

> 强化、不替代 MCP 原生:出侧用 `structuredContent`/`outputSchema`/`resources` 原生承载,中间件只是**喂**它们;进侧句柄只是普通 string 参数(URI),解析在 server 侧、对协议不可见——笨客户端传原始 payload 照样能用。

### —— 出侧(egress):结果蒸馏 ——

#### 3.1 蒸馏中间件(保留并强化)
现有 `distillerRegistry` + summarizers 就是"中间件先处理原始数据"。保留,职责升级为**决定 Layer 0(内联高信号)与深层(可钻取)的切分**。蒸馏 = 语义压缩,非截断。

#### 3.2 结构化内联:`outputSchema` + `structuredContent`(最少 token、可校验、可渲染)
- `outputSchema` **单一来源、零漂移**(评审风险3):让 **summarizer 的返回值本身是 TypeBox 类型**(与输入参数已用 TypeBox 完全一致),`outputSchema` = 该 schema,运行时蒸馏结果对它校验。**禁止人工维护两份**。CI 加 outputSchema-conformance gate(真实工具输出对照 outputSchema)。caveat:个别 summarizer 输出是动态表格 → 允许"稳定核心强类型 + 开放尾部",由 conformance 兜。
- 返回 `structuredContent = 蒸馏 summary 对象`(不再 JSON.stringify 进 text 的 envelope);按规范 SHOULD 附序列化 text 兼容(忽略 structuredContent 的客户端仍拿到文本 → 低风险)。
- 收益:不再双重编码、宿主按 schema 紧凑渲染/校验、字段语义化 → **"最少 token"的协议级抓手**。`detailLevel` 在 MCP 路弱化。

#### 3.3 分层蒸馏("min token, max value")
| 层 | 载体 | 内容 |
|---|---|---|
| **Layer 0** | `structuredContent` 内联 | 计数、top-N 样本、状态分布、diagnostics、深层 section 句柄、nextActions |
| **Layer 1** | resource(模板钻取) | 分段详情(network failed/全量 entries、scan 全节点、evidence 全事件) |
| **Layer 2** | resource(raw) | 完整原始 payload |

**量化切分准则**(评审风险5,不靠拍脑袋):
- **Layer 0 = 让 agent 决定下一步所需的有界聚合**:计数 + 分布 + 每类 top-N(沿用现有 20/12/8/5 预算档)+ diagnostics + 钻取句柄;**必须塞进 8K(`SUMMARY_BUDGET_CHARS`)**。
- **Layer 1 = 各 section 完整集合**;**Layer 2 = raw body/payload**。
- 例:network failed → L0 放计数 + top-N(3–5 条),L1 放完整失败列表;scan → L0 放计数 + top actionables,L1 放全节点。
- **现有 summarizers 已经在产 Layer 0 形状**(top-N + 计数),本步主要是形式化既有纪律 + 加 section 句柄链接,非新造。

关键:**Layer 0 内带 Layer 1/2 的句柄(URI/模板)**,agent 不用猜怎么取详情——awareness 常驻、payload 按需。

#### 3.4 resources 渐进加载
- 结果带 `resource_link`;`resources/read` 后端**复用 `artifactReader`**(text/json/search/sample、offset/limit/jsonPath、脱敏全留)。
- `resources/templates/list` 暴露钻取模板 `browser-result://{id}/{section}?offset=&limit=&jsonPath=&search=`;`completion/complete` 补全模板参数。
- `resources/list` = **本 session 产物目录**(补上缺失的资源索引)。
- `resources/subscribe` + `updated`:**实时结果**(network 录制、OAST 回调、长 wait),可订阅而非轮询重跑——新能力。
- **MCP 路退役 `browser_artifact` 工具**(resources/read 取代),artifactReader 留作后端;Pi 路保留。

#### 3.5 脱敏(保留)
`containsSensitiveEvidence` 双层脱敏不变;敏感内容强制走 Layer 2 资源、读取时脱敏。

### —— 进侧(ingress):引用解析 + 机制归一 ——

#### 3.6 句柄/引用解析(进侧核心,出侧 resources 的对偶)
- 在 request/body/cookie/wordlist/mutations 等**需要 payload 的位置接受句柄**(`browser-result://...`、`browser-artifact://...`,或 operation/snapshot/request id)。
- **typed 句柄,带类型查找而非盲取**(评审风险1):资源创建时带 `kind`(http-request / scan / network-entry...);入侧参数 schema 声明它接受的 kind(如 `x-handle-kind: "http-request"`);`resolveHandle(handle, {expectKind})` 校验 kind 匹配 → 拦住**语义混淆**(本该是 request 的句柄指向了 scan 结果),不只是 JSON 类型不匹配。
- server 侧:解析句柄 → 类型校验 → fetch → 展开成真实 typed 输入 → **走正常 schema 校验** → 执行。
- **回显 + 时效**(评审风险1):解析后回显资源 meta(`kind/size/createdAt/etag`)供 agent 确认;结果快照**内容寻址、不可变**,实时资源带 etag/version、解析时回显时效,避免 TOCTOU。
- **示例(少写协议代码)**:今天 `browser_network` 抓包 → 读 artifact → 抽 request → 序列化粘进 `browser_sqli` → 跑;句柄化后 `browser_sqli({ request: "browser-result://net-42/entries/3" })` —— 中间件解析展开校验跑,agent 只做一个决策 + 穿一个句柄,协议代码≈0。

#### 3.7 机制归一化 + 默认值(复用 `tool-parameter-contract.md`)
- 机制参数(timeout/maxChars/detailLevel...)填默认/容错;**意图参数仍响亮失败,不静默 coerce**。
- 最廉价的确定性前置(AGENTS.md 第 39 行,有界):省略 tabId 回退当前活动 tab、ensureStarted。**仅此**。

#### 3.8 进侧边界与纪律(否则它会变成 agent 的大脑)
- ✅ 吃**机制/管道**:序列化、句柄穿引、默认值、分页游标、超时旋钮。
- ❌ 不吃**编排/决策**:不替 agent 决定"做哪步/打哪/要不要升级",**不做多工具串联达成目标**(skill/eval 的事——AGENTS.md 第 42 行),不藏昂贵/危险/不可逆步骤(第 39、60 行)。
- **机制归中间件、意图/决策归 agent**——和参数那条同一条线,升到整个交互。
- **透明可重放**:每次入侧变换(句柄解析成了啥、填了什么默认)回显 diagnostics,不做黑盒。
- **不旁路校验**:句柄先作 URI 字符串校验,展开后 payload 再走正常 schema 校验——不回退参数可靠性。

---

## 4. 工具轴设计(宿主职责——server 保持干净)

### 4.1 标准 `tools/list` + 精确 `annotations`
- server 暴露全部工具(标准 tools/list,可 cursor 分页);schema 进上下文的时机交给宿主(Claude Code 的 ToolSearch/deferral 对任何 server 工具生效)。
- annotations:`readOnlyHint`→observe/tabs/screenshot/artifact-read;`destructiveHint`+`openWorldHint`→fuzz/sqli/template/http_replay/oast。宿主据此 defer/filter/排序。
- schema 越薄,宿主 deferral 与模型选择越准 → 与 `tool-parameter-contract.md` 协同。
- **token 经济不依赖 deferral**(评审风险4):薄 schema + 精确 annotations + **description 一句话功能摘要前缀**,让无 deferral 的宿主至少能靠 description 粗筛——这些是 Phase 1 就该做的事,不是等宿主支持 deferral。

### 4.2 annotations + 门控:互补,而非取代(评审风险4 修正)
- **deferral-capable 宿主**(Claude Code 等):进攻性工具用 `destructiveHint/openWorldHint` 标注,宿主按注解 filter/defer——细粒度、运行时、宿主驱动。
- **非 deferral / token 受限宿主**(当前 MCP 生态多数):**保留 `PI_BROWSER_TOOL_PROFILE` 门控作为粗粒度 deploy-time 开关**(不退役)——否则 21 个工具 schema 全灌上下文。门控与 annotations 互补:一个粗(部署期)、一个细(运行期)。
- **诚实边界**:annotations 是 hint、非安全边界;真安全仍靠工具自身 guard(`allowPrivateTargets` 默认 false、scope、`assertAllowedTargetUrl`)。

### 4.3 (Fallback,非主线)无 deferral 宿主
才退到 server 端 `list_changed` + 轻量发现工具的动态列表。capability-gated、明确次要、很可能用不到,留作后续 RFC。**prior art:`skillful-mcp` 把 Server 包成 Skills 做按需工具发现,可参考其做法**。

---

## 5. MCP server 标准化(基底)
1. capabilities 全声明:`{ tools:{listChanged:true}, resources:{subscribe:true,listChanged:true}, logging:{}, completions:{} }`。
2. `onUpdate` → `notifications/progress`(`_meta.progressToken`)。
3. 实现 resources 全套(list/templates/read/subscribe+updated),后端复用 artifactReader。
4. tools 返回 `structuredContent` + `outputSchema` + 兼容 text。
5. 独立可移植:`package.json` exports 暴露 MCP server 为库;MCP 路零 `@earendil-works/*` runtime 依赖;补 `initialize` 元数据。
6. 对真实标准 MCP 客户端跑 conformance。
7. **MCP-adapter 协议中间件层**(借 FastMCP hook 模型):按 `on_call_tool`/`on_read_resource`/`on_list_tools`/`on_message`/`on_initialize` 承载 auth/rate-limit/logging/工具过滤,可镜像其内置 Logging/RateLimiting/Timing/ErrorHandling。与"核心语义中间件"(§2)分层:协议 cross-cutting 在此,蒸馏/解析在 core。
8. **减样板:优先官方 SDK 高层 `McpServer` API**(`registerTool` + zod、自动 schema),而非低层 `Server`+`setRequestHandler` 或第三方框架——本地、低风险地拿到 FastMCP 式"少写协议"体验。

---

## 6. 能力协商与降级(横切,每阶段都带)
- `initialize` 读 client capabilities。
- `structuredContent` 自带兼容 text → 低风险。
- 无 `resources` → 回退内联 summary + 保留 `browser_artifact` + 文件路径(现状形态);**进侧句柄解析退化**为"只接受内联 payload"。
- 无 `resources.subscribe` → 实时结果退化为轮询/重跑。
- 无工具 deferral 宿主 → 全量 tools + profile 粗门控(§4.2)(+ §4.3 可选 fallback)。
- Pi 路始终走 Pi adapter,行为不变。**无降级不发布。**

---

## 7. 分阶段实施

```
Phase 0  抽 HostPort + 核心产出 DistilledResult(structured/raw/sections)     ← 等价落地, 先行
         + 由 summarizer TypeBox 返回类型派生各工具 outputSchema(单一来源)
Phase 1  MCP 标准化基底:capabilities 全声明 / progress / 独立打包 / conformance
         + token 经济(不依赖 deferral):description 摘要前缀 + annotations 先行 + 保留 profile 粗门控
Phase 2  出·结构化内联:structuredContent + outputSchema + 兼容 text
         + tool annotations(readOnly/destructive...)
Phase 3  出·resources 全套:resource_link / read(artifactReader)/ templates+completion /
         list(会话目录)/ subscribe+updated;MCP 路退役 browser_artifact
Phase 4  出·分层蒸馏强化:显式 Layer0/1/2 切分 + structuredContent 内带 section 句柄
Phase 5  进·句柄解析中间件:typed 句柄(kind 校验)+ 解析回显 meta + 展开后正常校验;
         机制归一/默认/最廉价前置;严守 §3.8 边界(机制非决策、透明可重放、不旁路校验)
Phase 6  MCP-adapter 协议中间件(FastMCP hook 风格):auth/rate-limit/logging/on_list_tools 过滤
Phase 7  (横切)能力协商与降级,贯穿每阶段
Phase 8  (stretch)无 deferral 宿主的 list_changed fallback(参 skillful-mcp);slash → MCP prompts
```

> 顺序依据:进侧句柄解析(Phase 5)依赖出侧 resources(Phase 3)已产出句柄空间,故置后。每阶段后 `npm run quality:local` + 对应 contract/smoke;MCP 路额外跑 conformance。

---

## 8. 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| **进侧滑成编排器/决策层** | 变回 agent 的大脑,撞 AGENTS.md 39/42/60 | §3.8 边界钉死:只吃机制、不串联、不藏风险;每次变换透明可重放 |
| **不能假设宿主有 deferral**(多数 MCP 客户端无) | 弱宿主上下文被全量工具占据 | 不押 deferral:Phase1 薄 schema+annotations+description 摘要;**保留 profile 门控当粗开关**(§4.2);server 动态列表仅末位 fallback(§4.3) |
| 句柄类型混淆 / 时效(TOCTOU) | 展开数据非 agent 预期 | typed 句柄 kind 校验 + 解析回显 meta(kind/size/etag);快照不可变、实时资源带 etag(§3.6) |
| 资源生命周期未定义 | 句柄悬空/泄漏 | session 级句柄 over durable artifact;ttl/revoke;实时资源绑操作生命周期(§2) |
| 客户端不支持 resources | 出侧渐进 + 进侧句柄都退化 | §6 降级回内联 + browser_artifact;structuredContent 自带兼容 text |
| outputSchema 与 summarizer 形状漂移 | 违反自声明 schema | schema 由 summarizer TypeBox 返回类型派生(单一来源)+ conformance 测试 |
| HostPort 抽象过度 | 核心改造面大 | 接口最小化;Phase 0 先等价落地 |
| 退役 browser_artifact 破坏现有流程 | 引用/契约失效 | 仅 MCP 路退役,Pi 路保留;降级路径保留 |
| 破坏 Pi 路 | 现网回归 | 双 adapter 并存,Phase 0 等价验证,两路都跑 smoke |
| 误引第三方 MCP 框架 | 语言/架构不匹配、锁定 | 不引 FastMCP(Python/不成熟 TS 端口);只借其 hook 分类法;减样板用官方 `McpServer` |

---

## 9. 不做的事
1. **进侧不做编排/决策**:只吃协议机制,不替 agent 串联工具、选策略、藏升级。
2. **工具轴不做 server 端 lazy/meta-tool 当主线**:规范定死是宿主职责。
3. **不把工具合并成 dispatcher**(退化参数校验 + 撞反模式)。
4. **不破坏核心 Pi-free**:核心只依赖 HostPort,绝不让 `@earendil-works/*` 或 `@modelcontextprotocol/sdk` 进核心。
5. **不引入第三方 MCP 框架**(FastMCP 等):语言/架构不匹配;只借设计与 hook 分类法,减样板用官方 SDK 高层 API。
6. **不移除 Pi 路**:双 adapter 永久并存。
7. **不一次性重写**:Phase 0 地基先行,每阶段独立可验证、可回退。
8. **annotations / 句柄解析都不当安全边界与校验旁路**:真安全靠工具 guard,校验靠框架 + 展开后 schema。
9. prompts/slash 映射、无-deferral fallback 列为 stretch。

---

## 10. 一句话
工具轴交给宿主(标准 MCP 本分:干净 tools/list + annotations + 保留 profile 粗门控);server 这半边建一个**对称的 I/O 信息边界中间件**——**出**侧蒸馏成高信号结构、经 `outputSchema`+`structuredContent` 内联(最少 token)、分段与原始作为 `resources` 按需 `read`(复用 artifactReader、退役 browser_artifact、subscribe 支持实时);**进**侧让 agent 在 payload 位置直接传 **typed 句柄**,中间件类型校验+解析+展开再正常校验。中间件分两层(核心语义 + MCP 协议,后者借 FastMCP hook 风格但**不引框架**);Ports&Adapters 隔离、双 adapter 并存、能力协商降级兜底,机制全吃决策全留,不回退参数可靠性、不让进侧变成编排器。
