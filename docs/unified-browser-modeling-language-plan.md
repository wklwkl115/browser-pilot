# 统一浏览器建模语言(ABML)设计计划 / Unified Browser Modeling Language Plan

> 状态:REVIEWED，评审债已关闭；允许进入执行计划，runtime 仍受 phase gate 约束
> 作用域:重构 pi-browser-tools 的 agent ↔ 浏览器交互面，把现有的"扫描 + 蒸馏中间件 + 各类工具"收敛为一门 **以 JS 为底座、以 MCP 动词为正式入口、读写同构、无盲区** 的 agent 面向建模语言。
> 工作命名:**ABML**(Agent Browser Modeling Language)。名字可改，本文用它指代这门语言。

---

## 0. TL;DR(给评审 agent 的 30 秒摘要)

我们要把"给 agent 一堆并列工具/模式让它自己挑"这一形态，替换为**一门统一语言**:

- agent 永远只做两件事——`read`(感知)与对**实体**施加**动词**(交互)，全程用同一种 `ref` 指认目标、同一种 envelope 接收结果。
- JS 够不着的能力(canvas 语义、可信事件、closed shadow、OOPIF、文件框……)被**折算进同一套名词/动词**，对 agent 不可见地由 CDP/AX 在动词内部兜底。**agent 不需要判断"该用哪个模式/工具"——这个判断从根上消失。**正式 surface 只走 MCP 动词，组合需求走 MCP `batch/transaction`，不引入 in-page `pi.*` 回桥。
- 视觉是**地板**(最后兜底)，不是支柱。本轮**不做**记忆/技能结晶。
- 不另起炉灶:**蒸馏中间件就是这门语言输出侧与引用侧的脊梁**，scan 是名词侧的雏形，CDP 通道是动词侧的地基。本计划是把缺失的半边长到现有脊梁上。

第一步(本计划 Phase 1)= **冻结基础语言规格**。P1 细化规格见 `docs/abml-p1-spec.md`，覆盖统一 ref、actionability、错误 taxonomy、redaction/session 不变量。

---

## 1. 背景与动机

### 1.1 问题:JS 有一道"再聪明也写不出来"的硬墙

纯页面 JS 存在结构性盲区，无法靠"写更聪明的 JS"绕过:

| JS 写不出来 | 根因 | 唯一能补它的通道 |
|---|---|---|
| canvas 里画的内容 | 像素，无 DOM 节点 | 视觉;若暴露 ARIA，则 AX 树 |
| "假"点击被无视 | 合成事件 `isTrusted=false` | CDP `Input.dispatchMouseEvent`(真事件) |
| 被遮挡 / pointer-events | JS 点逻辑元素，响应的是覆盖层 | CDP 坐标点击(打视觉最上层) |
| 跨进程 iframe(OOPIF) | 同源策略，页面 JS 进不去(见 `bridge_src/service_worker/cdp.ts:17` 注释) | CDP 按 target 接 / 视觉兜底 |
| closed shadow DOM | `{mode:'closed'}` 拿不到 shadowRoot | CDP DOM/AX 穿透 |
| 文件框 / 原生弹窗 / basic auth | 安全限制 | CDP(`DOM.setFileInputFiles` / 拦截 file chooser) |
| 需真实轨迹的拖拽 | 合成 drag 序列不被认 | CDP Input 拖拽序列 |

> 注:GenericAgent(本项目浏览器层的设计源头)同样是 JS 中心，**它也翻不过这道墙**。补足这道墙正是本项目超越其源设计的机会。

### 1.2 现状:项目里已有两个"建模语言雏形"，出身不同、彼此不知道是同一件事

| 雏形 | 出身动机 | 在建模什么 | 已吐出的"引用" | 关键文件 |
|---|---|---|---|---|
| **scan / simphtml** | 感知、省 token | 页面**实体**(元素/区域) | 每个 actionable 的 `selector` + `point` | `src/scan/buildScanScript.ts` |
| **蒸馏中间件** | token 经济(管入也管出) | 工具**结果**(envelope + 分层披露) | `browser-result://uuid` + `jsonPath` 切片句柄 | `src/tools/resultMiddleware.ts`、`mcp/resourceStore.ts`、`mcp/handleResolver.ts` |

两者本质都是"把浏览器现实重新表达成 agent 面对的样子"。**ABML 就是把这两条线合并、补全、闭包成一门完整语言。**

### 1.3 设计哲学的传承与超越

继承 GenericAgent 的"极简原语 + agent 母语(JS)"哲学;超越点在于:
1. **统一度量衡**:把异构的"单位制"(selector / backendNodeId / 像素 / CDP method)折算成一套。
2. **闭包性**:模型里不能有"洞"——JS 盲区被建模为一等名词/动词，agent 永不需要"逃逸"出语言。
3. **读写同构**:读到的 ref 就是下手的 ref。

---

## 2. 设计原则(评审请据此打分)

1. **JS 为底座、MCP 为正式入口(JS-substrate, MCP-canonical)**:不发明 agent 要现学、我们要现教的新语法。ABML 复用 JS 作为页面读写底座与 `eval` 动词，但正式可调用契约只暴露 MCP 动词；不注入 in-page `pi.*` 公共 API。多步组合走 MCP `batch/transaction`，避免 page→worker 回桥。
2. **读写同构(read/write isomorphism)**:同一个 `ref` 同时支持:① 读摘要、② 展开细节、③ 施加动作。
3. **闭包/完备(closure)**:§1.1 表中每一项 JS 盲区，必须落到某个名词或动词上(见 §8 完备性矩阵)。模型无洞。
4. **后端无关(backend-agnostic)**:DOM-JS / CDP / AX / 视觉都在抽象边界之下。`source` 字段是溯源，**不是 agent 要选的模式**。
5. **视觉是地板**:仅当某实体连 DOM+AX+CDP 都建模不出时才落到视觉。绝不围绕它设计。
6. **token 经济由构造保证**:ABML 继承蒸馏中间件纪律，输出天然 layered + 句柄化。语言不能让 token 回潮。
7. **稳定优先于精确**:ref 要扛得住 SPA 重渲染——抓手不能一刷新就失效。
8. **动作可靠性优先(actionability)**:所有写动词内建隐式可操作性等待;`wait` 是显式条件等待,不是动作前置条件的替代品。
9. **失败也闭包(failure closure)**:每个动词必须返回统一错误 taxonomy + 恢复语义,不能只在成功路径无洞。
10. **安全不变量贯穿 ref**:任何 ref/handle 解析都必须重新执行 redaction、session scope、etag/TTL 校验,不得成为绕过原始载荷保护的新通道。
11. **不另起炉灶**:最大化复用 `resultMiddleware` / `resourceStore` / `handleResolver` / `cdp` 单一收口点。
12. **本轮非目标**:记忆/技能结晶、视觉作为主感知、推翻现有协议契约治理(见 §13)。

---

## 3. 架构总览:六根支柱

```
                          ┌──────────────────────── ABML SURFACE ────────────────────────┐
   agent ──(verb + ref + params)──▶  read / click / type / scroll / pierce / extract / eval ...
                          └───────────────────────────────┬──────────────────────────────┘
                                                          │  (MCP 动词 face；JS 仅为内部底座/eval 动词)
        ┌─────────────────────────────────────────────────▼─────────────────────────────────────────┐
        │                                    ABML RUNTIME (chokepoint)                                │
        │                                                                                             │
        │   入口:  handleResolver  ── 把 params 里的 ref 展开成 RefDescriptor (泛化自 Phase 6)        │
        │                                                                                             │
        │   ┌──────────────┐   ┌─────────────────────┐   ┌────────────────────────────────────────┐  │
        │   │  REF REGISTRY │   │   BACKEND ROUTER    │   │           NOUN MODELER                 │  │
        │   │ (泛化         │   │  每个动词:           │   │  把 DOM / AX / vision 产出归一成        │  │
        │   │ resourceStore)│   │  默认后端 + 降级梯  │   │  统一 Entity 形状 + 合并/去重           │  │
        │   │ RefDescriptor │   │  + 后置校验          │   │                                        │  │
        │   └──────┬───────┘   └──────────┬──────────┘   └───────────────────┬────────────────────┘  │
        │          │                       │                                 │                        │
        │   出口:  distiller ── 把 Entity/结果包成统一 envelope (复用 resultMiddleware)               │
        └──────────┼───────────────────────┼─────────────────────────────────┼────────────────────────┘
                   │                       │                                 │
          ┌────────▼────────┐   ┌──────────▼───────────┐   ┌─────────────────▼─────────────────┐
          │  page JS (eval) │   │ CDP (piPersistentCdp │   │ AX (Accessibility.*) / 视觉(截图) │
          │  DOM 读 / 简单写 │   │ Send: Input/DOM/...) │   │                                   │
          └─────────────────┘   └──────────────────────┘   └───────────────────────────────────┘
```

六根支柱:
1. **REF(统一引用)** — §4,圆心。
2. **NOUN(实体模型)** — §5。
3. **VERB(动作集)** — §6。
4. **ENVELOPE(编码)** — §7.1,复用蒸馏中间件。
5. **RUNTIME(注册/路由/解析)** — §7.2,住在现有 chokepoint。
6. **SURFACE(MCP 入口)** — §7.3。

---

## 4. 统一 REF(圆心 / 本计划 Phase 1 的产物)

### 4.1 要求(为什么 ref 是命门)

- 跨后端:DOM 元素、AX 节点、canvas 区域、frame、网络条目，统一一种引用。
- 活+快照二相:① **活身份**(对当前页面下手、刷新后还认得)+ ② **快照绑定**(读取当时捕获的细节，不必再碰页面)。
- 抗重渲染:SPA virtual DOM 重渲染后仍能重新定位。
- 对 agent 不透明(就是个 token)，对 runtime 可解析。
- **向后兼容**:能平滑吃下现有 `browser-result://uuid`(数据句柄)与 scan 的 `selector+point`。

### 4.2 核心思想:ref 不是指针，是"重解析配方"

ref 对 agent 是一个不透明 token(形如 `pi-ref://element/9f3a…`);runtime 侧存一个 **RefDescriptor**:

```ts
type Locator =
  | { by: "backendNodeId"; value: number }     // CDP 快路径
  | { by: "axNodeId"; value: string }
  | { by: "css"; value: string }
  | { by: "xpath"; value: string }
  | { by: "textAnchor"; value: string; role?: string }   // 语义锚:角色+可见文本
  | { by: "attrSignature"; value: Record<string,string> } // 稳定属性指纹(data-testid 等)
  | { by: "point"; x: number; y: number };               // 几何兜底(视觉/canvas)

type RefDescriptor = {
  refId: string;                 // agent 持有的不透明 id
  kind: "element" | "ax" | "region" | "frame" | "network-entry" | "event" | "signal" | "data-slice";

  // —— 活身份:有序冗余定位器，按优先级重解析 ——
  locators: Locator[];
  frameRef?: string;             // 所属 frame 的 refId(OOPIF/iframe 寻址)
  owner?: { browserSessionId?: string; tabId?: number; topLevelOrigin?: string };
  policy?: { redaction: "default" | "disabled"; shareableAcrossSessions?: boolean };

  // —— 快照绑定:读细节而不重碰页面;复用 resourceStore ——
  snapshot?: { observationId: string; jsonPath?: string; resourceUri?: string; etag?: string };

  // —— 缓存:让 agent 无需再读即可推理 / 让坐标动词/视觉直接用 ——
  semantic?: { role?: string; name?: string; value?: string; state?: Record<string, boolean> };
  geometry?: { box?: {x:number;y:number;w:number;h:number}; point?: {x:number;y:number} };

  // —— 生命周期/可信度 ——
  observationId: string;
  documentEpoch?: string;        // URL/navigation/mutation 版本语义,供缓存一致性判断
  createdAt: number;
  ttlMs: number;
  stabilityScore?: number;       // 定位器冗余度/历史命中率,供降级与告警
};
```

### 4.3 重解析(re-resolution)——抗重渲染的关键

任何动词作用于 ref 时，runtime 不假设指针仍有效，而是**按 `locators` 优先级重新定位活实体**:
`backendNodeId`(同 documentupdate 内最快) → `attrSignature`/`css` → `xpath` → `textAnchor`(语义锚最抗结构变化) → `point`(几何兜底)。
- 命中即用;全部失配则按 `kind` 决定:可降级到视觉重定位(地板)或返回 `REF_STALE` 让上层 `read` 刷新。
- **冗余定位器是稳定性的来源**:scan/AX 在建模时尽量为每个实体多备几把"钥匙"，`stabilityScore` 据此评估。

### 4.4 读写同构:一个 token，三种用途

```
            ┌── read(ref)            → 重解析活实体, 返回子树/最新 Entity   (感知)
  refId ────┼── resolve(ref.snapshot)→ 取 observationId/jsonPath 的细节切片 (读细节)
            └── verb(ref, ...)       → 重解析后施加 CDP/JS 动作              (交互)
```

同一 `refId` 由感知吐出、被动作消费、又能展开细节。**这就是"读写同构"，命门即此。**

### 4.5 与现有系统的并轨(不另起炉灶)

- `browser-result://uuid` + `jsonPath`(`mcp/resourceStore.ts`)→ 成为 `kind:"data-slice"` 的 ref，其 `snapshot` 即现有资源。**`pi-ref://` 命名空间是 `browser-result://` 的超集**;resourceStore 泛化为 RefDescriptor 存储后端(沿用 TTL/etag/redaction)。
- scan 的 `selector` + `point` → 成为某 Entity ref 的两条 `locators` + `geometry` 缓存。
- `mcp/handleResolver.ts` 的 ingress 展开(Phase 6)→ 泛化为"任意动词 params 里的 ref 在执行前展开"。

### 4.6 ref 正确性不变量(稳定性之外)

- **消歧**:重解析返回候选集,按 locator 命中强度、frame、role/name、几何邻近度排名;不能唯一命中时返回 `REF_AMBIGUOUS`,不得静默取第一个。
- **缓存一致性**:`geometry/semantic` 只是提示。写动词必须重解析活实体;`documentEpoch`/URL/navigation 变化时强制刷新几何与状态。
- **归属隔离**:ref 默认绑定 `browserSessionId + tabId + frameRef`;跨 session/tab 使用返回 `REF_SCOPE_VIOLATION`,除非显式复制为新的 ref。
- **隐私继承**:解析 snapshot/payload 时继承并重新执行 resourceStore 的 TTL/etag/redaction;`pi-ref://` 不能绕过 `browser-result://` 的脱敏边界。

> **Phase 1 交付物以 `docs/abml-p1-spec.md` 为 source of truth**：本节只保留设计摘要。P1 必须冻结 RefDescriptor/Locator/RefPolicy/ResolveResult、重解析算法、消歧/缓存/归属/隐私不变量、与 resourceStore/handleResolver 的并轨契约、错误 taxonomy。先文档、契约、纯函数测试，不碰运行时。

---

## 5. 名词:统一 Entity 模型

> **决策(甲):名词空间是"模态复数"的。** 语言不仅建模"页面长什么样"(结构),也建模"页面正在发生什么"(网络、事件、性能)。`network/hook/evidence` 因此是**一等名词**,与 DOM 实体**同形、同 ref 寻址、同读写同构**,而非边缘工具。见 §5.5、附录 B。

### 5.0 一个模型,多个平面(planes)

`read` 返回的不是一棵 DOM 树,而是**一个页面模型的多个平面**,全部用同一套 `ref` 寻址、同一种 `Entity` 形状:

| 平面 | 名词族 | 典型 kind | 来源 | 几何 | 典型动作 |
|---|---|---|---|---|---|
| **结构平面** | 空间实体 | element/control/text/region/frame | dom/ax/vision | 有 | click/type/scroll |
| **网络平面** | 流实体 | network-entry | hook/CDP Network | 无 | replay/inspect/extract |
| **事件平面** | 流实体 | event/signal(监听器/console/性能/DOM 变更) | hook/evidence | 无 | inspect/extract |

**纪律(护 token):默认只投递结构平面**;网络/事件平面以 `sections` 句柄惰性披露,agent 按需 `read(planeHandle)` 展开。复用蒸馏中间件的 layered delivery,**甲不会造成 token 回潮**(见 §12 决议)。

### 5.1 形状(模态复数、形态单一)

空间实体与流实体共享同一基底,差异仅在"几何 vs 时序/载荷"两组可选字段——**形态单一,agent 不分辨来自哪个平面**:

```ts
type Entity = {
  ref: string;                   // pi-ref://...
  kind: "element" | "control" | "text" | "region" | "media" | "frame"   // 结构平面
      | "network-entry" | "event" | "signal";                            // 流平面
  role: string;                  // button|link|textbox|... | request|listener|console|perf...
  name?: string;                 // 可访问名 / 标签 | 方法+URL / 事件类型
  value?: string;
  state: { visible:boolean; occluded:boolean; disabled:boolean; focused:boolean;
           checked?:boolean; expanded?:boolean; editable:boolean; inViewport:boolean };
  source: "dom" | "ax" | "vision" | "network" | "hook" | "evidence";   // 溯源, 非 agent 选择项
  // —— 结构平面专属(空间实体)——
  geometry?: { box:{x:number;y:number;w:number;h:number}; point:{x:number;y:number} };
  // —— 流平面专属(流实体)——
  stream?: { at:number; method?:string; url?:string; status?:number;       // 网络
             eventType?:string; phase?:string;                             // 事件
             payloadHandle?:string };                                      // 大载荷→句柄(body/堆栈)
  children?: Entity[] | { handle: string; count: number };  // 内联或句柄展开(虚拟化)
  hints?: { listContainer?: boolean; hiddenCount?: number; [k:string]: unknown };
};
```

### 5.2 闭包性靠"形态单一"

一个 canvas 控件(由 AX 或视觉建模)与一个 `<button>`(由 DOM 建模)**字段同形、调用同法**。agent 分辨不出，也不需要分辨——`source` 仅供 runtime 调试与可信度。**这就是"无洞"。**

### 5.3 多后端如何折叠进同一棵树(完备性的实现)

NOUN MODELER 的归一流程:
1. **DOM 源**:今日 `buildScanScript.ts` 的产出 → DOM Entities(已有命中测试/actionable 打分,直接复用)。
2. **AX 源**:`Accessibility.getFullAXTree`(经 `piPersistentCdpSend`)→ 为 DOM 漏掉的(canvas+ARIA、closed shadow)补 Entities，几何用 `DOM.getBoxModel(backendNodeId)` 补。
3. **视觉源(地板)**:某 region 是 canvas 且无 DOM/AX → 先只产一个 `kind:"region"` 的 canvas Entity;**仅按需**对该 region 跑视觉，产出 `source:"vision"`、定位器仅 `point` 的子 Entities。
4. **合并/去重**:同一逻辑控件若 DOM 与 AX 都命中 → 合并为一个 Entity，**叠加多条 locators(ref 更稳)**。

### 5.4 token 经济

整棵 Entity 树经蒸馏中间件 layered 投递:Layer 0 摘要(top-N actionables + landmarks)、Layer 1 子树 `children.handle`、Layer 2 原始。继承 §2 原则 6。

### 5.5 流实体(决策甲的展开)

`network/hook/evidence` 不再是"另一类工具",而是网络/事件平面上的一等名词:

- **网络实体(`network-entry`)**:由 `hook`/CDP Network 产出。`stream.{method,url,status,at}` 进 Entity;请求/响应 body 等大载荷走 `stream.payloadHandle`(即一个 `data-slice` ref,复用现有 `browser-result://` + jsonPath)。**读写同构在此最有价值**:读到一个 network-entry ref → 直接 `replay(ref)`(见 §6)。
- **事件/信号实体(`event`/`signal`)**:监听器、console、性能条目、DOM 变更等。`stream.{eventType,phase,at}` 进 Entity,堆栈/详情走 `payloadHandle`。
- **与结构平面的关联**:一个流实体可携带 `hints.originRef` 指回触发它的结构实体(如"这个 XHR 由这个 button 的 click 触发"),让 agent 在两个平面间跳转——**统一 ref 让跨平面关联成为可能**。
- **边界澄清**:安全层的 `http_replay` 从"独立工具"重新定位为**核心动词 `replay` 的特化客户**——二者共用 network-entry ref 作为货币。这说明甲不仅扩张名词,还**反向加固了与边缘安全层的接缝**(见 §9)。

### 5.6 流平面的时序语义

- `read({plane:"network"|"event"})` 返回**已捕获窗口的快照**,默认不建立实时订阅。
- 捕获窗口是一等 ref/session:开始捕获→产出 recorder/signal ref→稍后 `read`/`inspect`;停止后成为不可变快照。
- `network-entry` / `event` ref 指向具体 exchange/event 的不可变证据;`replay` 产出新的 exchange Entity,不改写原始 ref。
- 实时等待仍由 `wait`/recorder wait 表达;不把持续订阅混入普通 `read` 的同步语义。

---

## 6. 动词:统一动作集

### 6.1 契约(所有动词共享)

P1 规范详见 `docs/abml-p1-spec.md`。摘要:

- **输入** = `(ref?, params)`;params 里的 ref 由 ingress 展开(§4.5),并执行 scope/redaction/etag/TTL 校验。
- **输出** = 统一 envelope(§7.1),成功/失败都带结构化 evidence、错误码、可恢复建议。
- **内部** = ref 重解析 + actionability 等待 + 后端路由 + 降级梯 + **后置校验**。
- **actionability 默认门槛(写动词)**:唯一目标、attached、visible、enabled、可编辑(按需)、滚入视口、几何稳定(无动画/位移)、hit-test 能接收事件、未被遮挡;超时返回 `ACTIONABILITY_TIMEOUT` 或具体阻断码。
- **后置校验三态**:`verified` / `failed` / `inconclusive`;`inconclusive` 不是成功,必须在 envelope 中暴露证据与下一步。

### 6.2 动词表

| 动词 | 签名 | 默认后端 | 降级梯 / 兜底 | 后置校验 |
|---|---|---|---|---|
| `read` | `read(ref?, {plane?,depth,filter})` | DOM scan + AX(默认结构平面) | 视觉(region) | 节点计数/截断标记 |
| `click` | `click(ref, {button,count})` | DOM dispatch | → CDP Input 真事件@point → 视觉重定位@point | 命中/导航/DOM 变化 |
| `type` | `type(ref, text, {clear})` | focus+CDP `Input.insertText` | → 逐键 `dispatchKeyEvent` | value/编辑态变化 |
| `key` | `key(ref?, keys)` | CDP `Input.dispatchKeyEvent` | — | — |
| `select` | `select(ref, value)` | DOM(原生 select) | → CDP 坐标展开+点选 | value 变化 |
| `scroll` | `scroll(ref|region, {to,steps})` | JS 滚动 | **虚拟滚动采集:滚动→read→按 ref 去重→直到 scrollHeight 稳定** | 采集计数 |
| `hover` | `hover(ref)` | CDP `Input` move | — | — |
| `drag` | `drag(fromRef,toRef)` | CDP Input 序列 | — | 位置变化 |
| `pierce` | `pierce(ref)` | CDP DOM/AX 穿透 shadow | OOPIF→CDP target | 返回子 Entities |
| `frame` | `frame(ref)` | CDP frameTree/per-target | 视觉兜底 | — |
| `extract` | `extract(ref|query)` | page JS 读框架 state/网络条目 | — | 结构化数据 |
| `replay` | `replay(ref, {mutate?})` | 流平面:重放 network-entry(`http_replay` 是其特化客户) | — | 新 exchange 实体 |
| `inspect` | `inspect(ref)` | 流平面:取 network/event 实体的 `payloadHandle`(body/堆栈) | — | 细节切片 |
| `eval` | `eval(js)` | page JS(`exec.ts`) | CDP `Runtime.evaluate`(CSP 兜底) | 序列化结果 |
| `screenshot` | `screenshot(ref?)` | CDP `Page.captureScreenshot` | `chrome.tabs.captureVisibleTab` | 图像句柄 |
| `wait` | `wait(cond)` | 现有 `BrowserWaitSupervisor` | — | — |

### 6.3 "基于 JS、补强 JS" 如何在动词内部落地

- JS 能干的(`read`/`eval`/简单 `scroll`)默认走 page JS。
- JS 干不faithful的(`click` 真事件 / `type` 可信输入 / `pierce` OOPIF / canvas)默认走 CDP/AX——**但 agent 调用方式完全相同**。盲区在动词**内部**被填掉，对 agent 不可见。**统一度量衡即此。**
- `eval` 仍在(GA `web_execute_js` 的等价物)，但它从"唯一的工具"降级为"动词之一"，且其结果也过 envelope。

### 6.4 `eval` 边界(防止逃生舱侵蚀语言)

- `eval` 用于一次性读取、调试、页面局部计算和无法结构化的新场景验证;常规交互必须优先用动词。
- `eval` 结果过同一 envelope/redaction/token 预算;不能直接铸造可写 live ref。
- 若 `eval` 返回 selector/point/DOM 摘要,必须经 `read`/NOUN MODELER 重新建模后才生成 actionable ref。
- `eval` 的副作用不享受 actionability/后置校验;若需要可靠动作,必须使用对应动词或 MCP `transaction`。

### 6.5 失败闭包:统一错误 taxonomy(首版)

| 错误 | 含义 | 恢复语义 |
|---|---|---|
| `REF_NOT_FOUND` / `REF_STALE` | ref 无法解析或生命周期过期 | `read` 刷新模型 |
| `REF_AMBIGUOUS` | 重解析命中多个候选 | 返回候选摘要,要求更窄 ref/filter |
| `REF_SCOPE_VIOLATION` | session/tab/frame 不匹配 | 切换目标或重新 `read` |
| `ACTIONABILITY_TIMEOUT` / `TARGET_OCCLUDED` | 动作前置条件未满足 | 等待/滚动/关闭遮挡/重读 |
| `BACKEND_UNAVAILABLE` / `CROSS_ORIGIN_BLOCKED` | 后端能力不可达 | 降级到允许后端或视觉地板 |
| `VERIFY_FAILED` / `VERIFY_INCONCLUSIVE` | 动作后校验失败或不确定 | 返回证据和可尝试的下一动词 |
| `PRIVACY_BLOCKED` / `HANDLE_ETAG_MISMATCH` | redaction/etag/TTL 不变量阻断 | 重新捕获或显式允许更高权限 |

---

## 7. 编码、运行时、入口

### 7.1 ENVELOPE — 复用 `resultMiddleware.ts`

复用 `DistilledEnvelope`。扩展:
- `summary` 可承载 Entity 模型(§5)。
- 所有引用统一为 `pi-ref://`(吸收 `sections[].handle` / `artifact_hints`)。
- `nextActions` 从 `"browser_artifact path=..."` 升级为**动词调用建议**(如 `click(pi-ref://...)`)。
- 既有 4 级预算压缩、redaction、artifact 落盘**原样保留**——token 经济不回潮。

### 7.2 RUNTIME — 住在现有 chokepoint

- **REF REGISTRY** = 泛化 `mcp/resourceStore.ts`:存 RefDescriptor，沿用 TTL/etag/prune;新增重解析入口。
- **BACKEND ROUTER** = 每个动词的"默认后端 + 降级梯 + 后置校验"，统一在此而非散落各 `register*Tool`。
- **入口** = 泛化 `mcp/handleResolver.ts`:执行前展开 params 中的 ref,并统一执行 scope/redaction/etag/TTL 检查。
- **出口** = `distilledJsonResult/distilledTextResult` 单一收口(已是 chokepoint)。

### 7.3 SURFACE — MCP canonical face(D3 已关闭)

**正式入口只有 MCP 动词 face**:agent 把 `click(ref)` 当工具调。14 个旧工具退化为动词/薄别名(见 §9、§11)。

验证结论:不实现 in-page `pi.*` JS face，不把 page→worker 异步回桥纳入 ABML。

- 当前桥接方向是 worker→page:`runtime.ts` 通过 `Runtime.evaluate` 调 `window.__PI_BROWSER_HOOKS__.dispatch`；page script 自身被契约约束为无 `chrome.*`、无 import。
- 当前 `content.ts` 只做 wake/清理，没有 page→content→worker 命令 relay；新增 relay 会成为新的权限、队列、租约、redaction、错误传播面。
- 若 agent 需要一次往返内组合多步动作，优先扩展 MCP `batch` 为 `transaction`，而不是把核心动词投影进页面。
- 未来若确需 page-local API，必须另开独立 RFC/eval，不能作为本计划尾巴或兼容债。

---

## 8. 完备性矩阵(向评审证明"模型无洞")

§1.1 每一行都必须落到某名词/动词;落不到的，显式声明由视觉地板兜底。

| JS 盲区 | 落到 ABML 的哪里 | 兜底 |
|---|---|---|
| canvas 内容 | `read` 经 AX 源产 Entity;无 ARIA 则 region Entity | 视觉(`source:"vision"`) |
| 假点击被无视 | `click` 默认 CDP 真事件 | — |
| 被遮挡元素 | `click` 降级梯坐标点击 + `state.occluded` | 视觉重定位 |
| OOPIF | `frame`/`pierce` 经 CDP target | 视觉 |
| closed shadow | `pierce` 经 CDP DOM/AX | — |
| 文件框/原生弹窗 | 专用动词(`upload` 经 `DOM.setFileInputFiles`)/ CDP 拦截 | — |
| 真实轨迹拖拽 | `drag` CDP Input 序列 | — |
| 虚拟滚动长列表 | `scroll` 采集循环 + `hints.hiddenCount` | — |

**评审重点:有没有第 9 类盲区没被这张表覆盖?**

---

## 9. Surface 收敛:14 工具如何变成动词

- 目标:**杜绝"该用哪个工具"的判断**。对外收敛为极小动词面(感知 `read` + 动作动词),其余按需披露(契合 memory 中"渐进式披露:原生 MCP + on-demand"方向)。
- 现有工具映射:`browser_observe`→`read`;`browser_execute`→`eval`;`browser_command` 的交互类→对应动词;**`browser_network/hook/evidence`→核心名词(网络/事件平面),经 `read(plane)` 感知、`replay`/`inspect`/`extract` 操作(决策甲,§5.5)**;`browser_screenshot`→`screenshot`;`browser_wait`→`wait`;`browser_upload/download`→文件动词。
- **边缘安全层接缝**:`http_replay`→`replay` 动词的特化客户;`sqli` 等继续吃 request ref 作为 ingress。安全层整体仍为独立按需 MCP(INTEROP),仅在边界共用 ref+envelope。
- **迁移期**:旧工具保留为薄别名(deprecated)，内部转调动词，保证不破坏现有契约测试(§11、§14)。

---

## 10. 分阶段路线图(每阶段独立可验证)

| 阶段 | 内容 | 交付/验证 | 依赖 |
|---|---|---|---|
| **P1 · 基础语言规格(圆心)** | 冻结 `docs/abml-p1-spec.md`:RefDescriptor/Locator/RefPolicy/ResolveResult、重解析/消歧、actionability、VerificationResult、AbmlError、redaction/session/etag/TTL 不变量、eval 边界、流平面时序。**纯文档 + 纯函数 + 契约,不碰运行时** | P1 Gate Review 通过 + `normalizeRef`/重解析/消歧纯函数单测 + 错误/redaction/actionability 契约 | — |
| **P2 · REF REGISTRY** | 泛化 `resourceStore` 为 RefDescriptor 存储;`browser-result://` 作为 data-slice 子类并轨 | `check:mcp-*` 契约 + 注册/解析单测 | P1 |
| **P3 · NOUN 归一(DOM)** | 现有 scan 产出转成 Entity 形状 + 双 locators(selector+point)写入 ref | scan 快照测试 + Entity schema 校验 | P1,P2 |
| **P4 · 动词 + ROUTER 骨架** | `read`/`click`/`type`/`scroll` 走"actionability + 默认后端 + 后置校验";`click`/`type` 接 CDP Input 真事件(`cdp.ts:214`) | `check:bridge` + 烟测真事件点击 + actionability fixtures | P3 |
| **P5 · NOUN 归一(AX)** | AX 源 Entity + `DOM.getBoxModel` 补几何 + 与 DOM 去重合并 | 烟测一个 canvas+ARIA 页(如 Docs) | P3 |
| **P5S · NOUN 归一(流平面,决策甲)** | `network/hook/evidence` 产出转 Entity(network-entry/event/signal)+ `payloadHandle`;`replay`/`inspect` 动词;惰性平面披露 | 流实体 schema 校验 + `replay` 烟测 + token 不回退 | P2,P3 |
| **P6 · 虚拟滚动采集 / `pierce` / `frame`** | `scroll` 采集循环;`pierce` 穿 closed shadow;`frame` 接 OOPIF | 烟测虚拟表 + 跨域 iframe | P4 |
| **P7 · 视觉地板** | region Entity 的按需视觉子建模;`screenshot` 回传闭环(用 Claude 自带视觉给坐标→坐标动词) | 烟测纯 canvas 页 | P4 |
| **P8 · ENVELOPE 升级 + nextActions 动词化** | envelope 承载 Entity;`nextActions` 输出动词调用 | `check:token-economy` 不回退 | P4 |
| **P9 · Surface 收敛 + 旧工具别名** | 动词面定稿;14 工具转薄别名(deprecated) | 全量契约 + `quality:local` | P4–P8 |
> **已删除原 P10 in-page `pi.*`**。组合能力若被验证为刚需，作为 MCP `transaction` 动词另行设计；不进入 page→worker 回桥路线。

> **关键:P1 先行且独立**。`docs/abml-p1-spec.md` 是 P2/P3/P4 的前置闸门；未通过 P1 Gate Review 不得改 `resourceStore` / `handleResolver` / runtime。其余阶段在现有 chokepoint 上增量生长，**无大爆炸重写**。

---

## 11. 迁移与向后兼容

- **协议单一真源**:新动词/`accessibility.tree`/`input.*` 等命令走 `bridge/native_command_schema.json` + `npm run sync:protocol`(遵守 CLAUDE.md 约定),不手改生成文件。
- **旧工具不删**:转为内部调动词的薄别名，标 deprecated;现有契约测试继续绿。
- **ref 兼容**:`browser-result://` 继续可用(data-slice 子类);旧 `selector`/`point` 仍在 Entity 内可见。
- **envelope 兼容**:`DistilledEnvelope` 是扩展非重写,既有字段保留。

---

## 12. 评审结论与已关闭风险(review decisions)

本节关闭原 open questions；后续只剩实现期 gate，不再保留评审债。

| # | 议题 | 评审结论 | 实现期 gate |
|---|---|---|---|
| 1 | P1 spec Gate | **通过**。`docs/abml-p1-spec.md` 足以冻结 ref/actionability/error/privacy 基础语义。 | P2 前写执行计划并映射测试。 |
| 2 | actionability 门槛 | **通过**。写动词必须内建 actionability；`wait` 不是替代品。 | P4 actionability fixtures 全绿。 |
| 3 | 失败闭包 | **通过**。`AbmlError` 为统一失败 envelope；失败必须携带 recovery/evidence。 | P2/P4 错误映射与 contract 测试。 |
| 4 | redaction/ref 安全 | **通过**。`pi-ref://` 必须复用 resourceStore freshness/redaction；raw 访问只允许同 session + 显式敏感访问。 | P2 redaction/session/etag/TTL 契约测试。 |
| 5 | ref 稳定性上限 | **决议**：不承诺无语义/无稳定属性/每帧随机 DOM 的魔法稳定；正确行为是 `REF_AMBIGUOUS` 或 `REF_STALE`，而非误命中。 | P1/P3 重渲染、随机 class、多同名 fixture。 |
| 6 | 活 ref vs 快照一致性 | **决议**：写动词永远重解析 live target；snapshot 只读且受 etag/TTL；geometry/semantic 只作 hint。 | P2/P4 epoch 与 stale 测试。 |
| 7 | 消歧与后置校验 | **通过**。`ResolveResult` 禁止静默取首个；`VerificationResult` 三态，`inconclusive` 非成功。 | P1 纯函数 + P4 verification fixture。 |
| 8 | `eval` 逃生舱 | **通过**。`eval` 保留为探索/调试，不 mint actionable ref，不享受 actionability。 | P8/P9 docs、skill、contract 同步。 |
| 9 | CDP 会话成本 | **决议**：不是架构阻塞；实现必须批量化/复用 session，成本超限返回 `BACKEND_UNAVAILABLE`，不得静默降质。 | P4/P5 性能与 session-limit smoke。 |
| 10 | OOPIF 可达性 | **决议**：不承诺完整跨 target 控制；CDP 能到哪步用到哪步，不能到则返回 `CROSS_ORIGIN_BLOCKED` 或视觉地板。 | P6 跨域 iframe capability smoke。 |
| 11 | Surface 收敛破坏面 | **决议**：旧工具保留薄别名；不删除契约；deprecation 只在全量 contract/skill/doc 绿后生效。 | P9 全量 contract + skill/docs sync。 |
| 12 | ref 归属与并发 | **通过**。ref 默认绑定 session/tab/frame；跨域跨 session 返回 `REF_SCOPE_VIOLATION`；写动作遵守 tab lease。 | P2/P4 scope + `TAB_LEASE_CONFLICT` 测试。 |
| 13 | 流平面时序 | **通过**。普通 read 是快照；捕获窗口是一等 CaptureRef，状态为 active/stopped/expired/lost。 | P5S recorder lifecycle tests。 |
| 14 | 命名 | **通过**。ABML 是设计/RFC 名；`pi-ref://` 是 opaque ref scheme；公开工具名继续遵守 `browser_*` 现有命名。 | P2 protocol drift check。 |

---

## 13. 非目标(本轮明确不做)

- 记忆 / 技能结晶(L3/L4 SOP)——交由 Claude Code 自身 memory，本轮不在语言内实现。
- 视觉作为**主**感知通道——仅地板。
- 推翻协议契约治理 / 多会话隔离 / 租约模型——这些是优势,保留并复用。
- 跨浏览器引擎(仅 Chromium CDP)。

---

## 14. 验证与护栏

1. **完备性测试矩阵**:§8 每一行一个 fixture/烟测,证明"无洞"。
2. **ref 重解析/消歧单测**:构造重渲染、多同名元素、随机 class、导航 epoch 变化,断言命中/ambiguous/stale 正确。
3. **actionability fixture**:动画位移、遮挡、disabled、不可编辑、虚拟滚动、hydration 延迟,断言动词自动等待或返回结构化错误。
4. **失败 taxonomy 契约**:每个动词的错误码、恢复建议、证据字段固定。
5. **redaction/session 护栏**:ref/handle resolve 不能绕过 redaction/etag/TTL/session scope。
6. **eval 边界测试**:eval 结果过 envelope,不能直接 mint actionable ref。
7. **token 经济护栏**:沿用 `.pi/browser-artifacts/token-economy-summary.json` 9-fixture 硬门(Layer0 < raw)+ 软护栏(中位率);新 Entity envelope 不得回退。
8. **契约测试**:`tests/contracts/`(protocol / tools / boundaries)对新命令、新 envelope 字段、ref 句柄做契约锁定。
9. **真事件烟测**:对一个"忽略合成 click"的页面,断言 ABML `click` 触发真实处理器。
10. **`quality:local`**:build + 全检 + pack dry-run 作为合并门。

---

## 附录 A · 关键现有锚点(供实现者直接定位)

| 关注点 | 文件 |
|---|---|
| 输出蒸馏脊梁 / envelope | `src/tools/resultMiddleware.ts` |
| 蒸馏分发注册 | `src/tools/distillerRegistry.ts`、`src/tools/summaries/*` |
| 资源/句柄存储(→ ref registry) | `mcp/resourceStore.ts` |
| ingress 句柄展开(→ ref 入口) | `mcp/handleResolver.ts`、`mcp/handleFields.ts` |
| MCP 适配/分层投递 | `mcp/index.ts`、`mcp/middleware.ts` |
| DOM 名词雏形(selector+point) | `src/scan/buildScanScript.ts` |
| 观察入口 | `src/tools/registerObserveTool.ts`、`src/tools/observeRunners.ts` |
| CDP 通道(真事件/AX/DOM 地基) | `bridge_src/service_worker/cdp.ts`(`piPersistentCdpSend`) |
| 命令分发 | `bridge_src/service_worker/runtime.ts` |
| 协议单一真源 | `bridge/native_command_schema.json` + `npm run sync:protocol` |
| 入参规范化 / detailLevel | `src/tools/toolAdapter.ts`、`src/utils/params.ts` |

---

## 附录 B · 决策记录(Decision Log)

| # | 决策 | 选择 | 影响 | 状态 |
|---|---|---|---|---|
| D1 | 语言对 MCP 工具的覆盖范围 | **分层成员资格**:核心(IS,页面交互)/ 次级(SPEAKS,流平面)/ 边缘(INTEROP,安全+传输)。统一 HOW(ref+envelope),不统一 WHAT(领域意图) | 杜绝"用哪个工具"判断,同时避免把扫描器/传输硬塞成动词造成抽象泄漏 | Reviewed; §12.11/P9 gate 覆盖破坏面 |
| D2 | `network/hook/evidence` 的身份 | **甲:一等名词(流平面)**,与 DOM 实体同形、同 ref、读写同构(network-entry→`replay`) | 名词空间从"页面长什么样"扩张到"页面正在发生什么";`http_replay` 降为 `replay` 客户,加固安全层接缝 | Reviewed; §12.13/P5S gate 覆盖时序语义 |
| D2 纪律 | 流平面默认不投递 | `read` 默认只给结构平面,网络/事件平面以 `sections` 句柄惰性披露 | 决策甲不造成 token 回潮 | Reviewed; token-economy gate 覆盖 |
| D3 | 双重化身 `pi.*` in-page(P10) | **砍掉，不进入 ABML**。验证依据:现有 page script 无 `chrome.*`/import，当前桥接方向是 worker→page `Runtime.evaluate`，`content.ts` 无命令 relay，新增 page→worker 回桥会引入独立权限/队列/租约/redaction/error model；组合收益由 MCP `batch/transaction` 承接 | 关闭原 P10；评审不再审 page→worker 回桥，只审 MCP 动词 surface | Reviewed; closed |
| D4 | `eval` 的身份 | 保留为 escape hatch 与调试/探索动词,但不能直接 mint actionable ref;可靠写操作必须走动词/actionability | 防止"用 eval 还是动词"变成新工具选择负担 | Reviewed; §12.8/§6.4 closed |
| D5 | P1 范围 | P1 不只冻结 ref,还冻结 `docs/abml-p1-spec.md` 中的 actionability、失败 taxonomy、redaction/session/etag/TTL 不变量 | 把可靠性/失败闭包/安全边界提前到可评审规格,避免后补 | Reviewed; P1 Gate passed |

---

*— 文档结束。评审结论:Approve for execution planning。§12 原 open questions 已全部关闭；后续问题必须进入执行计划、phase gate 或实现缺陷处理，不再作为设计评审债保留。*
