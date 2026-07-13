# Browser Pilot Agent Interaction Plane 设计方案

> 状态：**已归档（Archived）**。实现与公共契约以 [CODE_WIKI.md](../../CODE_WIKI.md)、[REPO_GOVERNANCE.md](../../REPO_GOVERNANCE.md) 和 [AGENTS.md](../../AGENTS.md) 为准。
>
> 本文仅保留设计决策历史，**不是**运行时规则或第二权威。稳定结论已同步到 CODE_WIKI §14.7 与 REPO_GOVERNANCE Agent Interaction Plane 条款。
>
> 归档日期：2026-07-13

## 1. 执行摘要

Browser Pilot 现有底层已经具备可靠的浏览器连接、页面身份、可验证终态、ref 定位、渐进 artifact、CDP/Chrome API 执行和严格 schema。Agent 使用负担仍然偏高，不是因为这些能力不够，而是因为内部机械复杂度通过公共工具、参数、结果 envelope、恢复规则和 CLI/shell 细节直接泄漏给了 Agent。

本方案建议在现有 Commands/Runtime/Daemon 之上增加一个 **Agent Interaction Plane（Agent 交互控制面）**。它是面向 Agent 的防腐层，不替代底层权威协议，而是完成以下转换：

1. 把多个机械标识收敛为一个短期 **contextRef**。
2. 把 canonical PageObservationV3 投影成紧凑、确定性的 **AgentViewV1**。
3. 把 Agent 的语义动作编译成现有 trusted physical-input program 或 JavaScript escape hatch。
4. 把 connection、identity、ref、re-anchor、artifact read 和只读重试纳入有界恢复状态机。
5. 保留 browser-operation/v2 的完整机械真值，但把 Agent 默认决策收敛到少量 typed decision。
6. 通过 capability profile 让普通 Agent 默认只看到三个 façade 工具：
   - **browser_view**
   - **browser_act**
   - **browser_read**
7. 保留现有 core/security 命令作为 expert/security profile，不破坏高级能力。

核心原则是：

> Browser Pilot 自动承担机械复杂度，Agent 只承担业务目标、语义选择、敏感动作确认和最终业务成功判断。

产品一句话定位：

> **可审计的 Agent 浏览器操作面**——少工具、真终态、不盲着重放、机械状态可下钻。Browser Pilot 保证机械完成与可审计，不替调用方宣称业务成功。

交付策略一句话：

> **preview 可测 → opt-in 可集成 → GA 可默认**；技术 façade 完成不等于产品默认切换。CLI 人类路径在 v1 保持 expert-first，Agent 集成路径单独推进。

## 2. 问题定义

### 2.1 当前可量化的认知面

当前仓库的 Agent-facing 面具有以下规模：

| 项目 | 当前规模 | 对 Agent 的影响 |
|---|---:|---|
| 公共工具 | 19 个 | 普通浏览任务也会看到 security、network、hook、frame、command 等高级工具 |
| Core tools | 12 个 | Agent 必须先决定 observe/execute/tabs/artifact/command 等机械路径 |
| Web Security tools | 7 个 | 普通任务增加工具选择熵和误调用风险 |
| Compact command catalog | 约 10,002 UTF-8 bytes | 每次工具发现仍需消费较大协议上下文 |
| browser-pilot-cli skill | 155 行、约 13,076 bytes | 大量连接、identity、终态、artifact、shell 规则由 Agent 记忆 |
| PageObservationV3 顶层字段 | 约 28 个 | Agent 必须从 canonical truth 中自行提取当前决策面 |
| Write operation 终态 | 8 个 | Agent 必须理解 success/inconclusive/failure、continuation 和 replay 边界 |
| Execute program discriminator | 5 类 | Agent 需要把 click/fill/press 等意图编译为 eval/mouse/key/text/wait |

这些协议并非冗余；它们保障了 Browser Pilot 的正确性和可诊断性。问题在于它们同时成为普通 Agent 的默认工作语言。

### 2.2 当前 Agent 实际承担的角色

在普通页面任务中，Agent 同时承担：

1. 业务规划器。
2. 工具路由器。
3. daemon/extension readiness 管理器。
4. tab/target/session owner。
5. page identity 与 baseline 管理器。
6. PageObservation 解释器。
7. JavaScript/CDP 动作编译器。
8. operation 终态分类器。
9. continuation 恢复执行器。
10. artifact path/JSON path resolver。
11. PowerShell/Bash quoting adapter。

只有第 1 项应该始终属于 Agent。第 2 项应大幅收敛；第 3 至第 11 项应尽可能由运行时承担。

### 2.3 心智负担的根因

根因可以归为六类：

| 根因 | 当前泄漏 | 应由谁拥有 |
|---|---|---|
| 工具选择 | 19 个工具与 action schema | capability profile + façade |
| 机械状态 | browserSessionId、tabId、targetRef、generation、pageEpoch、baseline | mechanical context registry |
| 页面理解 | canonical observation 的全部 plane | deterministic AgentView projector |
| 动作表达 | JavaScript 或低层 physical frames | semantic action compiler |
| 恢复决策 | continuation、re-anchor、reacquire、artifact expansion | safe recovery automaton |
| 传输细节 | shell quoting、stdin、file reference | structured SDK/MCP transport |

## 3. 目标与非目标

### 3.1 目标

本方案的目标是：

1. 普通 Agent 默认只看到三个小工具。
2. Happy path 不要求显式 connect/status/doctor/schema。
3. Agent 只携带一个机械上下文句柄 contextRef；action ref 和 readRef 属于语义选择，不暴露内部 identity/path。
4. 一次 browser_act 公开调用包含 precheck、dispatch、settlement 和 post-action view。
5. 常见 activate/fill/press/select/scroll/navigation 不要求 JavaScript。
6. 临时 JavaScript 通过 structured transport 以内存传递，不经过 shell 或临时文件。
7. 所有自动恢复都有明确上限和 dispatch safety boundary。
8. 已 ACK 或可能已执行的 mutation 永不自动重放。
9. completed 仍是唯一成功；防腐层不得重写底层真值。
10. canonical PageObservationV3、browser-operation/v2 和完整 artifact 继续作为可审计真值。
11. Expert 用户可以随时下钻到现有 raw commands、trace 和 artifact。
12. 认知负担成为可测量、可回归的非功能指标。
13. 每个产品里程碑都有可演示的成功路径与失败体验，而不只有协议完成定义。
14. 发布通道显式分层：agent-preview → agent opt-in → agent default；不把“实现完成”等同于“默认切换”。

### 3.2 非目标

本方案不做以下事情：

1. 不在 daemon 内嵌第二个自主 LLM planner。
2. 不让 Browser Pilot 自动判断业务目标已经完成。
3. 不持久化用户目标、业务结论、密码、token 或跨任务语义记忆。
4. 不用模糊摘要替换 canonical observation。
5. 不把 effect_observed、deadline 或 ambiguous 包装成成功。
6. 不增加独立 browser_click、browser_type、browser_select 等工具。
7. 不自动重放已 ACK mutation。
8. 不用 URL 代替 PageIdentity。
9. 不把 Agent Interaction Plane 的策略放入 extension service worker。
10. 不移除现有 expert/security 能力。
11. 不在 Phase 1–3 借 façade 同步重构 package layout、SDK 或 MCP 服务进程。
12. 不以 skill 行数、工具数量或“看起来更短”替代任务成功率与 recall gate。

### 3.3 产品定位与用户分层

| 用户面 | 默认工具面 | 主要成功标准 | v1 默认策略 |
|---|---|---|---|
| Agent 集成（MCP/SDK/plugin） | agent profile：3 工具 | 无 skill 也能完成常规 browse/form；认知 SLO | preview → opt-in → default |
| 人类 CLI / 调试 | expert/admin 为主 | doctor、raw schema、trace 下钻 | **保持 expert-first**，不因 agent GA 改写人类主路径 |
| 安全研究 | security + expert | 现有 web security 能力不回归 | 仅显式启用 |
| 运行时运维 | admin | connect/status/doctor/daemon lifecycle | 不进入业务规划工具列表 |

差异化主张（对外可复用）：

1. 不是“再包一层 click/type API”，而是 **operation-truth 防腐层**。
2. 不是视觉坐标 Agent，而是 **canonical observation + trusted physical input**。
3. 不是 daemon 内嵌 planner，而是 **把机械角色从 Agent 迁回运行时**。

### 3.4 产品旅程（开箱到日常）

必须可演示、可文档化的路径：

~~~text
首次 30–60 秒
  install/load extension
       → browser_view（自动 ensure daemon/bridge/extension readiness）
       → 返回 contextRef + candidates + decision
       → 失败时给出 typed reason + doctor 提示，而不是原始机械 ID 堆叠

日常循环
  browser_view / browser_act / browser_read
       → Agent 仅携带 contextRef
       → act 一次调用包含 settlement + post-action view
       → decision=assess_goal / choose_action / confirm / blocked ...

能力边界触达
  custom combobox / closed shadow / cross-origin iframe / 证据不足
       → decision=blocked 或 inconclusive + 明确 reason
       → 指引 expanded / expert，而不是让 Agent 猜 selector

诊断降级
  traceRef → expert browser_observe/execute/artifact
       → raw PageObservationV3 / browser-operation/v2 可审计

崩溃与重启
  daemon restart → context expired
       → 新 browser_view 重建，不假装无感恢复
~~~

“第一次成功”产品验收句（M1 起适用）：

> 在扩展已加载的本机 Chrome/Edge 上，调用方无需先手写 connect/status/schema，一次 `browser_view` 即可得到可用 context 与候选动作；失败时能用 doctor/status 在 1–2 步内定位 readiness 问题。

## 4. 设计原则

### 4.1 渐进式披露

Agent 默认只接收当前决策所需的信息。详细结构、机械证据和完整 artifact 仍可按逻辑 readRef 或 traceRef 下钻。

### 4.2 防腐层而非第二套浏览器内核

Agent Interaction Plane 只组合和投影现有能力，不复制：

- 页面扫描。
- ref locator。
- operation settlement。
- target routing。
- artifact persistence。
- CDP/Chrome API。

### 4.3 机械自动化，语义显式

运行时可以自动完成确定性的机械恢复，但不得代替 Agent 做业务判断或敏感决策。

### 4.4 Canonical truth 不丢失

AgentView 是 PageObservationV3 的投影；AgentTurn 是 browser-operation/v2 加 post-action view 的 façade。底层原始契约必须通过 traceRef 或 expert surface 可审计。

### 4.5 自动恢复不等于自动重试 mutation

自动恢复分为：

- 连接/session/setup 恢复。
- identity/ref/read 恢复。
- idempotent read 重试。
- mutation 后的安全观察。

任何可能重复业务副作用的动作都不属于自动恢复。

### 4.6 Hidden state 必须可验证

Mechanical context 可以隐藏内部字段，但必须提供：

- contextRef。
- contextRevision。
- automaticActionsTaken。
- reanchorReason。
- trace descriptor。

隐藏机械细节不能变成不可诊断的魔法。

## 5. 目标架构

~~~text
                               Expert / Security profiles
                         ┌──────────────────────────────┐
                         │ existing browser_* commands │
                         └──────────────┬───────────────┘
                                        │
Default Agent profile                   │
┌───────────────────────┐               │
│ browser_view          │               │
│ browser_act           │               │
│ browser_read          │               │
└───────────┬───────────┘               │
            │                           │
            ▼                           ▼
┌──────────────────────────────────────────────────────┐
│              Agent Interaction Plane                 │
│                                                      │
│  AgentContextService                                 │
│  AgentViewProjector                                  │
│  SemanticActionCompiler                             │
│  SafeRecoveryAutomaton                              │
│  AgentEvidenceResolver                              │
│  AgentProfileRouter                                 │
│  AgentTraceRecorder                                 │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ Existing Commands / Runtime                          │
│                                                      │
│ browser_observe / PageObservationV3                  │
│ browser_execute / ProgramEngine                      │
│ withBrowserOperation / browser-operation/v2          │
│ browser_artifact / verified frontier                 │
│ SessionOperationRegistry / PageIdentity              │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
          Daemon → Bridge → Extension → CDP/Chrome APIs
~~~

### 5.1 依赖方向

拟议依赖方向：

~~~text
src/commands/agent
        │
        ├── src/browser-command-runtime
        ├── src/browser-runtime ports
        └── src/kernels/agent + src/kernels/session

src/apps/daemon
        └── owns AgentContextService / AgentTraceStore

src/bridge + src/bridge/extension
        └── unchanged in the first implementation phases
~~~

Agent façade 不得让 kernels 反向依赖 commands/runtime，也不得让 commands 直接导入 daemon 实现。Daemon-owned context 应通过明确 port 注入命令执行上下文。

## 6. Capability Profiles

### 6.1 Profile 划分

| Profile | 默认可见工具 | 用途 |
|---|---|---|
| agent | browser_view、browser_act、browser_read | 普通 Agent 浏览器任务 |
| expert | 当前 12 个 core commands | 调试、raw JS/CDP、复杂 recorder/frame 操作 |
| security | 7 个 Web Security commands | 用户明确授权的安全工作 |
| admin | connect/status/doctor/daemon lifecycle | 本地运行时诊断，不参与普通页面规划 |

人类 CLI 缺省行为对应 expert/admin 现有能力，不因 agent profile 存在而自动切换。Agent 集成面的 profile 选择与发布通道见 §22.2–22.4。

### 6.2 Profile 所有权

公共 browser_* 工具的定义仍必须来自 [src/commands/commandCatalog.ts](src/commands/commandCatalog.ts)。Profile 只决定一个调用表面暴露哪些 canonical definitions，不拥有第二份工具 schema。

建议新增单一 profile owner：

~~~text
src/commands/capabilityProfileCatalog.ts
~~~

它只保存 command name 集合和 profile metadata，不复制参数、help、schema 或执行逻辑。

### 6.3 公共契约迁移

browser_view、browser_act、browser_read 一旦成为公共工具，必须：

1. 注册进 commandCatalog.ts。
2. 使用 closed schema。
3. 进入 command contract hash。
4. 为 write action 提供 command-specific completion mapping。
5. 更新治理中硬编码的 tool count/contract tests。
6. 更新 CODE_WIKI.md、README.md、CHANGELOG.md 和 skill。

如果 profile metadata 需要进入 machine discovery root，则应发布新的 catalog contract version，而不是静默修改 browser-pilot-command-catalog/v3。

预览阶段只能由现有 daemon/command/CLI 入口之外的薄 adapter 过滤 tool name 集合；它不得修改 catalog v3 root、schema argv、hash 输入或 wire 语义。正式进入 machine discovery 时再显式升级契约。GA 的治理迁移是一个不可拆分的 checklist：

1. 将公共 tool-count characterization 从 19 显式改为 22；preview 期间不得提前修改 19-tool ratchet。
2. 同步 CLI catalog、main/doctor、daemon identity 与 package/README/governance 中所有 toolCount 断言。
3. 测量新增 schema 后的 catalog UTF-8 大小；25 KiB ratchet 默认保持，只有测量证明必要时才经治理变更单独放宽。
4. Profile metadata 一旦进入 discovery，升级 catalog/command contract version，不在 v3 上追加新语义。
5. 验证 commandContractVersion、commandContractHash 或 toolCount 不一致时，daemon lock/live identity 会触发受管 replacement，而不是复用旧 daemon。
6. 更新 `tests/cli/commandSchemaCatalog.test.ts`、`tests/cli/main.test.ts` 及所有硬编码工具枚举；不得只改生产 catalog 让测试追随失败。

## 7. Agent-facing 公共契约

本节所有名称和 JSON 都是拟议 schema sketch，不代表当前 CLI 已支持。

### 7.1 共同设计

三个 façade 工具共享以下约束：

1. 使用 closed schema，拒绝未知字段。
2. contextRef 必须 owner-isolated。
3. Agent-facing ref 不暴露 CSS、XPath、backendNodeId、tabId 或 artifact path。
4. 默认结果使用 AgentEnvelopeV1。
5. 任何 write 都复用 browser-operation/v2 的 completed-only success 语义。
6. 大型 canonical evidence 只通过 traceRef/readRef 暴露。
7. structured tool transport 直接传递字符串和对象，不要求 Agent 经过 shell。

### 7.2 BrowserAgentContext

~~~ts
interface BrowserAgentContextSummary {
  contextRef: string;
  contextRevision: number;
  state:
    | "anchored"
    | "transitioning"
    | "needs_reanchor"
    | "ambiguous"
    | "expired";
  pageChanged: boolean;
  reanchorReason?:
    | "document_changed"
    | "target_replaced"
    | "session_changed"
    | "identity_unproven"
    | "baseline_missing";
}
~~~

contextRevision 用于诊断和并发可见性。普通单 Agent 调用不要求显式回传 expectedRevision；每个 candidate ref/readRef 自带其创建 revision 和 PageIdentity 绑定，服务端会拒绝跨 revision 或跨 identity 使用。

高级并发客户端可以可选提供 ifContextRevision，进行 optimistic concurrency control。

### 7.3 AgentCandidate

~~~ts
interface AgentCandidate {
  ref: string;
  role: string;
  label?: string;
  description?: string;
  state?: {
    visible: boolean;
    enabled?: boolean;
    editable?: boolean;
    selected?: boolean;
    expanded?: boolean;
  };
  actions: Array<
    | "activate"
    | "fill"
    | "press"
    | "select"
    | "scroll"
    | "drag"
    | "submit"
  >;
  risk?: "normal" | "sensitive" | "irreversible";
}
~~~

AgentCandidate.ref 是 context-scoped alias。它不是 raw bp-ref URI，也不允许跨 context 使用。

Tab/target 选择使用独立的 context-scoped alias：

~~~ts
interface AgentTargetCandidate {
  tabRef: string;
  title?: string;
  url?: string;
  active: boolean;
  current: boolean;
  actions: ["view"];
}
~~~

tabRef 不暴露 browserSessionId、numeric tabId、targetRef 或 generation。
选择 target 通过 `browser_view({ contextRef, target: { tabRef } })` 完成，不进入 `browser_act` 的 mutation union。

其余 AgentView supporting types：

~~~ts
interface AgentNotice {
  kind:
    | "dialog"
    | "consent"
    | "error"
    | "warning"
    | "validation"
    | "target_change";
  message: string;
  candidateRefs?: string[];
}

interface AgentChangeSummary {
  kind: "none" | "same_document" | "document" | "target" | "unknown";
  summary?: string;
  addedCandidateRefs?: string[];
  changedCandidateRefs?: string[];
}

interface AgentReadOption {
  readRef: string;
  kind: "content" | "collection" | "diagnostics" | "operation_result";
  description: string;
  estimatedItems?: number;
}

interface AgentTraceDescriptor {
  available: boolean;
  traceRef?: string;
  unavailableReason?: string;
}
~~~

### 7.4 AgentViewV1

~~~ts
interface AgentViewV1 {
  schema: "browser-agent-view/v1";
  context: BrowserAgentContextSummary;
  page: {
    title?: string;
    url?: string;
    readyState?: string;
    changed: boolean;
  };
  summary: string;
  notices: AgentNotice[];
  candidates: AgentCandidate[];
  targets?: AgentTargetCandidate[];
  changes?: AgentChangeSummary;
  reads?: AgentReadOption[];
  decision: AgentDecision;
  limits: {
    cost: {
      chars: number;
      bytes: number;
      estimatedTokens: number;
    };
    truncated?: boolean;
  };
  trace: AgentTraceDescriptor;
}
~~~

### 7.5 AgentOutcome

~~~ts
interface AgentOutcome {
  classification: "success" | "inconclusive" | "failure";
  status:
    | "completed"
    | "effect_observed"
    | "no_effect"
    | "stalled"
    | "ambiguous"
    | "target_lost"
    | "failed"
    | "deadline";
  completionVerified: boolean;
  ok: boolean;
  completionSource?: string;
  code?: string;
  replay: "not_needed" | "do_not_retry";
  automaticActionsTaken: AgentAutomaticAction[];
}
~~~

映射必须保持：

| browser-operation/v2 | AgentOutcome |
|---|---|
| completed | success + completionVerified:true + ok:true |
| effect_observed | inconclusive |
| ambiguous | inconclusive |
| target_lost | inconclusive |
| deadline | inconclusive |
| no_effect | failure |
| stalled | failure |
| failed | failure |

该表不是 façade 自己维护的第二份分类规则：`AgentOutcome` 必须调用现有 `classifyBrowserOperationStatus()` 的纯 mapper 并逐字段复制结果。`target_lost` 固定映射为 `classification:"inconclusive"`、`code:"OPERATION_TARGET_LOST"`、`completionVerified:false`、`ok:false`；防腐层不得出现“inconclusive 或 failure”这样的本地选择，也不得以 post-action view 看起来合理为由，把非 completed 状态提升为 success。

### 7.6 AgentDecision

~~~ts
type AgentDecision =
  | {
      kind: "choose_action";
      candidateRefs: string[];
    }
  | {
      kind: "provide_input";
      candidateRef: string;
      inputKind: "text" | "choice" | "file";
    }
  | {
      kind: "confirm";
      confirmationRef: string;
      reason: string;
    }
  | {
      kind: "inspect";
      readRefs: string[];
    }
  | {
      kind: "assess_goal";
    }
  | {
      kind: "blocked";
      reason: string;
    };
~~~

Browser Pilot 不应返回 done 作为业务完成判断。即使机械动作 completed，是否达到用户目标仍由外部 Agent 判断；因此成功后的默认 decision 是 assess_goal 或 choose_action。

### 7.7 Agent-facing 失败体验目录

Façade 必须把常见失败收敛为 **稳定 code + 人类/Agent 可读 reason + 下一步 decision**，不得只抛底层异常文本。下列目录是 v1 公共体验合同的一部分；实现时用 closed enum，不得自由漂移。

| 场景 | 稳定 code（拟议） | Agent 可见结果 | 建议 decision / 下一步 | 人类 doctor 提示要点 |
|---|---|---|---|---|
| context 不存在或 daemon restart 后失效 | `CONTEXT_EXPIRED` | failure；无旧 bindings | 重新 `browser_view` 创建 context | daemon 是否重启、TTL 是否过期 |
| owner 不匹配 / contextRef 泄漏跨 owner | `CONTEXT_OWNER_MISMATCH` | failure；不泄露他方状态 | 使用本 owner 签发的 context | pairing/owner isolation |
| 并发 mutation | `CONTEXT_BUSY` | failure 或有界 queue 拒绝 | 等待后重试同一业务动作；不盲重放 | 是否有未结束 operation |
| ifContextRevision 不匹配 | `CONTEXT_REVISION_MISMATCH` | 返回 fresh view/decision | 基于新 revision 重选 action | 并发客户端冲突 |
| stale candidate ref（同 identity 可 relocate 失败） | `REF_STALE` | failure/inconclusive + fresh view | `choose_action` | ref 生命周期/同页 DOM 变更 |
| document/target identity 已变，旧 action 未 dispatch | `IDENTITY_CHANGED` | 不执行 mutation；fresh view | `choose_action` | reanchorReason |
| target lineage 多候选 | `TARGET_AMBIGUOUS` | state=ambiguous；targets 列表 | 显式 `browser_view({target:{tabRef}})` | 勿静默选 tab |
| 页面控件超出 v1 可操作边界 | `ACTION_UNSUPPORTED_SURFACE` | blocked | expert 或等待 expanded/scroll/re-view | 见 §14.6 |
| action 与 candidate.actions 不兼容 | `ACTION_NOT_ALLOWED` | failure | 换 action 或 re-view | role/state 不支持 |
| 需要确认但未提供/已失效 | `CONFIRMATION_REQUIRED` / `CONFIRMATION_MISMATCH` / `CONFIRMATION_CONSUMED` | 不执行 mutation | `confirm` 后 one-shot 重试 | consent coordinator 状态 |
| readiness 在预算内无法恢复 | `RUNTIME_NOT_READY` | failure | admin doctor/status；有界后勿死循环 | extension/daemon/bridge |
| operation 非 completed | 沿用 `OPERATION_*` / outcome.status | outcome-first；view 可 unavailable | `assess_goal` / `inspect` / `choose_action` | raw op 在 traceRef |
| post-view 投影失败 | `VIEW_UNAVAILABLE`（viewStatus） | **保留权威 outcome** | 可 `browser_view` 补观察 | projection/budget/timeout |
| readRef 失效或 artifact 丢失 | `READ_UNAVAILABLE` | 不伪造 path | 重新 view 获取新 readRef | verified frontier |
| 总 deadline 耗尽 | outcome.status=`deadline` | inconclusive；replay=do_not_retry | 观察后决定是否新动作 | 阶段预算是否过紧 |

规则：

1. code 对 Agent/CLI/SDK 稳定；message 可演进但不能是唯一分支依据。
2. 任何已 settle 的 mutation outcome 优先于 view/trace 可用性。
3. `blocked` / `inconclusive` 不得改写成 success 以“改善观感”。
4. doctor/status 对人类输出应映射上表，而不是要求用户理解 tabId/pageEpoch。

### 7.8 Agent schema 版本演进

公开 schema 名称：

- `browser-agent-view/v1`
- `browser-agent-turn/v1`
- `browser-agent-read/v1`

演进规则：

1. **v1 期间只允许 additive、可忽略字段**；不得改变既有字段语义、枚举成员含义或 success 判定。
2. 删除字段、收窄枚举、改变 outcome 映射或 decision 语义，必须升主版本（v2）并进入 command contract identity。
3. SemanticAction 新增 kind 必须同时新增 exact completion resolver 与 profile/schema 覆盖测试；不得先上 schema 后补 resolver。
4. Preview 阶段 schema 可在 agent-preview 内迭代，但一旦进入 opt-in/GA 冻结点，遵循上述规则。
5. 版本谈判以 schema 字符串与 contract hash 为准，不以 package version 暗示兼容。

## 8. browser_view

### 8.1 请求

~~~ts
type AgentTargetSelector =
  | { use: "active" | "current" | "list" }
  | { tabRef: string };

interface BrowserViewRequest {
  contextRef?: string;
  target?: AgentTargetSelector;
  focus?: {
    text?: string;
    roles?: string[];
    include?: Array<"notices" | "forms" | "navigation" | "content">;
  };
  detail?: "decision" | "expanded";
  maxChars?: number;
  timeoutMs?: number;
  ifContextRevision?: number;
}
~~~

规则：

1. contextRef 缺失时创建新 mechanical context。
2. contextRef 存在时优先使用 context 绑定 target，不因 active tab 变化静默迁移。
3. target.use=list 返回 context-scoped AgentTargetCandidate；选择其他 tab 使用互斥的 target.tabRef，不暴露 raw targetRef。
4. tabRef 只能来自相同 owner/context 的 target list，并在 tab replacement/close 后失效。
5. focus 只参与本次确定性排序，默认不持久化为业务记忆。
6. detail 默认 decision。
7. view 自动确保 daemon/bridge/extension readiness。
8. Identity 不匹配时自动 full re-anchor，不向 Agent暴露 baseline 操作。

### 8.2 响应

返回 AgentViewV1。默认不返回：

- browserSessionId。
- numeric tabId。
- targetGeneration。
- pageEpoch。
- baselineSnapshotId。
- provider 完整 telemetry。
- raw entity/relation graph。
- saved.path。
- JSON path。
- locator bundle。

这些信息保留在 trace/canonical artifact 中。

### 8.3 首次调用流程

~~~text
Agent
  │ browser_view
  ▼
AgentContextService.create()
  │ resolve stable target
  ▼
existing browser_observe
  │ PageObservationV3
  ▼
AgentViewProjector
  │ bind aliases + verified readRefs
  ▼
AgentViewV1
~~~

## 9. browser_act

### 9.1 SemanticActionV1

~~~ts
type SemanticActionV1 =
  | { kind: "activate"; ref: string }
  | { kind: "fill"; ref: string; value: string; replace?: boolean }
  | { kind: "press"; ref?: string; key: string; modifiers?: string[] }
  | { kind: "select"; ref: string; value: string }
  | {
      kind: "scroll";
      ref?: string;
      direction: "up" | "down" | "left" | "right";
      amount?: "small" | "page";
    }
  | { kind: "drag"; fromRef: string; toRef: string }
  | { kind: "submit"; ref: string }
  | {
      kind: "navigate";
      url: string;
      disposition?: "current" | "new_tab";
    }
  | { kind: "history"; direction: "back" | "forward" | "reload" };
~~~

v1 不覆盖 `evaluate`、download/upload/network/hook/security，也不包含 `switch_target`。Raw JavaScript 继续属于 expert `browser_execute` capability；target 选择属于 `browser_view` 的 context transition。它们不得与 activate/fill 同级出现在默认 Agent schema 或 candidate recommendation 中，避免第一版成为巨型 union，也避免 raw-JS SLO 被同级 escape hatch 绕过。

### 9.2 请求

~~~ts
interface BrowserActRequest {
  contextRef: string;
  action: SemanticActionV1;
  confirmationRef?: string;
  focusAfter?: BrowserViewRequest["focus"];
  maxChars?: number;
  timeoutMs?: number;
  ifContextRevision?: number;
}
~~~

### 9.3 响应

~~~ts
interface BrowserAgentTurnV1 {
  schema: "browser-agent-turn/v1";
  context: BrowserAgentContextSummary;
  outcome: AgentOutcome;
  viewStatus: "available" | "unavailable";
  view?: AgentViewV1;
  viewUnavailableReason?: string;
  decision: AgentDecision;
  trace: AgentTraceDescriptor;
}
~~~

同一次 browser_act 公开调用必须完成：

1. Context/ref validation。
2. Pre-dispatch safe recovery。
3. Semantic action compilation。
4. Operation listener arming。
5. Dispatch。
6. Settlement。
7. Safe post-dispatch recovery。
8. Post-action view 或 bounded page effect projection；失败时 outcome-first、view fail-open。
9. Context revision 更新。

Agent 不应再发独立 wait，也不应为了下一步机械调用 observe。

### 9.4 调用流程

~~~text
Agent
  │ browser_act(contextRef, semantic action)
  ▼
Context/ref/identity validation
  │
  ├─ stale but same identity → safe re-resolve
  ├─ document changed       → stop before dispatch, return fresh view
  └─ ambiguous target       → stop before dispatch, return blocked/choose
  ▼
SemanticActionCompiler
  │ existing trusted program / navigation primitive
  ▼
withBrowserOperation
  │ operation.begin → dispatch → settle
  ▼
browser-operation/v2
  ▼
SafeRecoveryAutomaton
  │ safe post-action observe/re-anchor, never replay mutation
  ▼
AgentViewProjector
  ▼
BrowserAgentTurnV1
~~~

### 9.5 操作分类与 deadline

Facade 必须先按状态影响分类，再选择 operation owner：

| 入口/动作 | 分类 | `withBrowserOperation` | 返回 | 必须完成的状态处理 |
|---|---|---|---|---|
| `browser_view` 普通观察 | read | 否 | AgentView | 不推进 browser mutation；只在实际 reanchor/binding rebuild 时推进 revision |
| `browser_view target.tabRef` | context transition | 否 | AgentView | 通过现有 target lineage/PageIdentity owner 重绑，清空旧 page bindings 并推进 revision |
| `browser_read` | read | 否 | AgentRead | 保持绑定 revision 校验，不改变页面 |
| activate/fill/press/scroll/select/drag/submit | browser write | 是 | AgentTurn | semantic-kind resolver + settlement + outcome-first post view |
| navigate/history | browser write | 是 | AgentTurn | navigation completion resolver + reanchor |
| expert `browser_execute` evaluate | expert browser write | 是 | 现有 operation v2 | 不进入默认 Agent façade |

`switch_target` 即使不产生页面 mutation，也会改变 context revision、target generation 与 binding 集合，因此不能被描述为 read；它被建模为 `browser_view` 的 control-plane/context transition。`navigate` 和 `history` 则始终是 write。

`browser_act.timeoutMs` 表示整个 façade 调用的单一 wall-clock deadline，而不是每个内部阶段各自获得一份完整预算。v1 初始默认值为 30,000 ms，最大值沿用 300,000 ms；transport timeout 继续由该总值按现有规则派生，而不是另造 façade transport 常量。阶段 cap、post-view reserve 与 fixture P95 见 §26.1。预算规则为：

1. readiness/preflight 和 compile/precheck 各有 cap，且共同消费总预算。
2. Dispatch 前预留一个 bounded post-view budget；如果剩余 operation budget 已不足安全执行，则在 dispatch 前失败。
3. `withBrowserOperation` 只接收扣除已消费时间和保留预算后的 remaining deadline，不能重置计时。
4. Operation 一旦 settle，其 `outcome` 成为权威结果。Post-view/projection/trace 失败不得丢弃或改写 outcome；返回 `viewStatus:"unavailable"` 与 typed reason 即可。
5. `viewStatus:"available"` 时必须有 `view`；`viewStatus:"unavailable"` 时不得伪造旧 view 为新 view。
6. v1 不提供 partial-result 或 streaming public contract。内部 progress callback 只用于 telemetry/诊断，不能成为 Agent 的决策输入，也不改变 terminal outcome 规则。

## 10. browser_read

### 10.1 目标

browser_read 将 verified artifact/frontier descriptor 转成 context-scoped readRef，Agent 不再处理本地路径或 JSON path。

### 10.2 请求

~~~ts
interface BrowserReadRequest {
  contextRef: string;
  readRef: string;
  offset?: number;
  limit?: number;
  maxChars?: number;
}
~~~

### 10.2.1 响应

~~~ts
interface BrowserAgentReadV1 {
  schema: "browser-agent-read/v1";
  context: BrowserAgentContextSummary;
  readRef: string;
  kind: "content" | "collection" | "diagnostics" | "operation_result";
  summary?: string;
  data: unknown;
  page?: {
    offset: number;
    returned: number;
    total?: number;
    hasMore: boolean;
  };
  limits: {
    cost: {
      chars: number;
      bytes: number;
      estimatedTokens: number;
    };
    truncated?: boolean;
  };
  trace: AgentTraceDescriptor;
}
~~~

browser_read 不返回本地 path 或未验证 JSON path。需要 raw path/debug 的调用方使用 expert browser_artifact。

### 10.3 ReadRef 绑定

Context 内部保存：

~~~ts
interface AgentReadBinding {
  readRef: string;
  contextRevision: number;
  pageIdentity?: PageIdentity;
  source:
    | "observation_frontier"
    | "operation_artifact"
    | "diagnostics"
    | "content";
  descriptor: VerifiedReadDescriptor;
  createdAt: number;
  expiresAt: number;
}
~~~

descriptor 可以包含 saved.path 和 verified jsonPath，但这些字段不出现在默认 Agent envelope。

### 10.4 规则

1. 只接受服务端签发的 readRef。
2. 不猜测 path 或 JSON path。
3. 不允许 readRef 跨 owner/context。
4. Artifact 丢失时返回 unavailable，不生成虚假替代路径。
5. 读取是 idempotent，可在明确 transient I/O failure 时有界重试。
6. 默认返回窗口化内容，避免整文件加载。
7. 完整 raw artifact 仍通过 expert browser_artifact surface 获取。

## 11. Mechanical Context

### 11.1 Context 只保存机械状态

拟议记录：

~~~ts
interface AgentCandidateBinding {
  ref: string;
  contextRevision: number;
  pageIdentity: PageIdentity;
  resourceRef: string;
  role: string;
  label?: string;
  allowedActions: AgentCandidate["actions"];
  createdAt: number;
}

interface AgentTargetBinding {
  tabRef: string;
  targetLineageRef: string;
  title?: string;
  url?: string;
  createdAt: number;
}

interface AgentContextRecord {
  id: string;
  owner: string;
  revision: number;
  state:
    | "anchored"
    | "transitioning"
    | "needs_reanchor"
    | "ambiguous"
    | "expired";

  pageIdentity?: PageIdentity;
  targetLineageRef?: string;

  observationId?: string;
  snapshotId?: string;
  baselineSnapshotId?: string;

  candidateBindings: Map<string, AgentCandidateBinding>;
  targetBindings: Map<string, AgentTargetBinding>;
  readBindings: Map<string, AgentReadBinding>;

  activeOperationId?: string;
  lastTraceRef?: string;

  createdAt: number;
  updatedAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}
~~~

`pageIdentity` 是对现有 PageIdentity value/owner 的引用，不是由 AgentContext 重新定义的相等语义；`targetLineageRef` 同样指向现有 target lineage owner。Context 不再平铺 `browserSessionId/tabId/targetGeneration/pageEpoch` 并自行比较，也不维护与 `SessionKernel`、observation snapshot registry、intent ref registry 或 operation registry 平行的 generation 计数器。

不得保存：

- 用户业务目标。
- 页面内容的长期总结。
- 用户密码/token。
- 完整表单值历史。
- cookies/authorization。
- 跨 daemon restart 的语义记忆。

### 11.2 建议边界

初始实现建议使用可测试的 provisional bounds：

| 项目 | 初始建议 |
|---|---:|
| Daemon 总 contexts | 128 |
| 单 owner contexts | 16 |
| Idle TTL | 10 分钟 |
| Absolute TTL | 60 分钟 |
| 单 context candidate bindings | 128 |
| 单 context target bindings | 64 |
| 单 context read bindings | 64 |
| 单 context retained traces | 32 |

最终数值应由 agent benchmark 和真实任务数据调整，并作为明确 ratchet 测试，而不是散落 magic numbers。

### 11.3 Owner isolation

Context key 必须包含 operation owner/pairing identity。即使 contextRef 泄漏，其他 owner 也不能读取或执行。

contextRef 应使用不可预测随机标识，不编码 tabId、path 或用户数据。

### 11.4 Daemon restart

Mechanical context 默认只在内存中：

- Daemon restart 后 contextRef 失效。
- browser_view 可以创建新 context 并重新 anchor。
- 不为了“无感恢复”把机械 context 持久化为跨进程隐式记忆。

## 12. Context 状态机

~~~text
                browser_view
     ┌─────────────────────────────┐
     │                             ▼
   [new] ─────────────────────> [anchored]
                                  │
                                  │ browser_act accepted
                                  ▼
                             [transitioning]
                              /     |      \
                             /      |       \
                    completed    page change  ambiguity
                       │             │          │
                       ▼             ▼          ▼
                  [anchored] [needs_reanchor] [ambiguous]
                                      │             │
                                      │ safe view   │ explicit choice/view
                                      ▼             ▼
                                 [anchored]     [anchored]

Any state ── TTL/owner loss ──> [expired]
~~~

### 12.1 Revision 规则

Identity transition 只有一个判定 owner。现有 observation baseline 流程先调用 `pageReanchorReason(previous, current)`，AgentContext 再消费同一个 decision：

~~~ts
applyAgentContextIdentityTransition(
  existingContext,
  currentPageIdentity,
  existingReanchorDecision
): AgentContextTransition
~~~

该函数不得重新比较 URL、tabId 或 epoch 来得出另一种结果。Observation、operation settlement、target replacement 和显式 target selection 都必须经过这个 shared transition owner，不能各自推进一套 context lifecycle。

以下事件推进 revision：

- 新 observation 被 anchor。
- page identity 变化。
- candidate/read bindings 重建。
- write operation 开始。
- write operation 终止。
- target lineage 重绑定。
- context 进入 ambiguous/expired。

必须永久成立的 ghost-state invariants：

1. Context 的 PageIdentity 与当前 canonical PageIdentity 不同或 identity 未证明时，state 不得为 `anchored`。
2. `pageReanchorReason()` 返回任何 reanchor reason 后，旧 candidate bindings 和 page-scoped read bindings 不得存活。
3. Dispatch 前 operation registry 的 target generation、当前 PageIdentity 与 context anchor 必须一致；任一不一致都在 dispatch 前停止。
4. Operation 推进 target generation 时，context 不能只推进 revision 而保留旧 identity；二者必须在一次原子 transition 中更新或进入 `needs_reanchor`。
5. AgentContext 不签发独立 snapshot/intent identity；它只引用现有 registry 的 snapshot/ref 生命周期。

### 12.2 并发规则

1. 每个 context 的 mutation 串行执行。
2. Mutation 开始后 state 为 transitioning。
3. 第二个 mutation 不排队盲执行；默认返回 CONTEXT_BUSY，或在调用者明确请求 queue 时有界排队。
4. Candidate ref 绑定创建 revision；前一 mutation 推进 revision 后，旧 ref 自动失效。
5. Read-only view/read 可以基于锁定 revision 并发，但结果必须标明其观察 revision。
6. ifContextRevision 不匹配时返回 CONTEXT_REVISION_MISMATCH 和 fresh decision，不自动执行 mutation。

## 13. PageIdentity 与 ref 生命周期

Mechanical context 继续使用现有身份：

~~~text
browserSessionId + tabId + targetGeneration + pageEpoch
~~~

URL 只是事实，不是相等键。

### 13.1 同 document 变化

SPA history/hash 变化不自动使 candidate refs 全部失效，但 observation mutation epoch 和可见性仍需在 dispatch 前校验。

### 13.2 Document change

Top-level document change：

1. 清空 candidate bindings。
2. 清空 page-scoped read bindings。
3. 丢弃 baseline。
4. 运行 full observe。
5. 推进 revision。
6. 在 automaticActionsTaken 中报告 reanchor。
7. 不执行携带旧 ref 的 mutation。

### 13.3 Target replacement

如果现有 router 能证明唯一 replacement lineage：

1. 更新 tabId/generation。
2. mint 新 page identity 或采用已证明 lineage。
3. re-anchor。
4. 不要求 Agent 重新选择同一逻辑 tab。

如果存在多个候选或 lineage 无法证明：

- state 进入 ambiguous。
- 返回候选 target summary。
- 不自动选择并 mutation。

### 13.4 Ref alias

Agent-facing alias 应类似：

~~~text
a_01
a_02
r_content_01
~~~

alias 只在 context 中解析，实际 binding 保存：

- source observation/revision。
- PageIdentity。
- semantic role/name。
- existing resource ref/locator descriptor。
- allowed semantic actions。
- stability/visibility/actionability facts。

## 14. AgentView 渐进式披露

### 14.1 四层披露

| 层级 | 入口 | 默认内容 | 不暴露内容 |
|---|---|---|---|
| L0 Decision | browser_view / browser_act 默认 | summary、notices、少量 candidates、decision | raw identity、paths、full graph、provider details |
| L1 Expanded | browser_view detail=expanded 或 focus | 更多相关 candidates、forms、changes | full artifact、raw locator |
| L2 Evidence | browser_read(readRef) | 经过验证的局部 content/diagnostics/collection window | 本地 path、未验证 JSON path |
| L3 Expert | existing raw commands + trace | PageObservationV3、operation v2、artifact、protocol diagnostics | 无额外隐藏 |

### 14.2 初始预算建议

| 项目 | L0 | L1 |
|---|---:|---:|
| 默认最大 chars | 6,000 | 16,000 |
| candidates | 12 | 32 |
| notices | 6 | 16 |
| read options | 6 | 16 |

Budget 是硬上限。实际 AgentView limits.cost 必须使用现有 CostVector owner 计算。

### 14.3 AgentViewProjector 输入

~~~ts
interface AgentViewProjectionInput {
  observation: PageObservationV3;
  context: AgentContextRecord;
  focus?: AgentFocus;
  priorOutcome?: BrowserOperationV2;
  budget: CostBudget;
}
~~~

### 14.4 确定性投影步骤

1. 验证 observation schema/canonical marker。
2. 验证 PageIdentity 与 context anchor。
3. 消费现有 `pageReanchorReason()` 的 page/target identity transition 结果。
4. 优先提取 blocking dialogs、errors、consent 和不可忽略 notices。
5. 按 `observation.actionables` 的 canonical 顺序构建 L0 AgentCandidate，不对同一集合重新打分。
6. 根据 role/state 推导允许的 SemanticAction，不猜具体下一动作。
7. 只按下述 pin precedence 插入 blocking/actionRef/diff/frontier 项；不得建立第二套 free-form relevance score。
8. 生成 context-scoped candidate aliases。
9. 将 frontier/artifact hints 转成 readRef。
10. 在预算内渲染 L0/L1。
11. 完整 canonical root 保留在现有 artifact/trace。

### 14.5 Canonical 映射与 pin precedence

AgentView 只投影既有 owner 的结果：

| 现有 canonical owner/fact | AgentView 用法 | 明确禁止 |
|---|---|---|
| `focus.primary_entities` → `compactActionables()` → `observation.actionables` | L0 candidate 的基础集合与基础顺序 | Projector 重新计算 salience/relevance |
| `sortEntitiesBySalience()` | Observe assembly 生成 canonical actionables；L1 若需要更多实体，复用同一函数或 assembly 产出的 immutable projection index | 在 façade 中复制权重或另写启发式 score |
| `relevanceScoring.ts` 的 relevance result | 只消费既有 score/order/facts；focus 扩展沿用该 owner | 用 label 模糊匹配覆盖 canonical rank |
| actionability model 与 CompactActionable `kind/name/state` | 生成 candidate role/state 与允许 action 的保守交集 | Projector 猜 hittable/editable/disabled |
| operation `actionRef` / pageEffect | 将与刚完成动作直接相关的 canonical actionable pin 到预算内 | 因 post-view 看似成功而改写 operation outcome |
| blocking dialog/consent/error facts | 以最高 pin precedence 纳入 notice 和对应 controls | 预算截断 blocking control |
| diff 新增/changed refs | 在 canonical eligible 集合内 pin；不改变其事实 | 仅凭 novelty 产生新 actionable |
| `resultNextActions.ts` | 映射 inspect/reacquire/assess 等 decision/read options | 把 nextActions 当成 candidate relevance score 或自动 mutation 指令 |
| verified frontier/artifact hints | 生成 readRef；visible/current-window item 可成为 candidate | 猜 path、自动滚动或把 offscreen item 伪装成当前 actionable |

预算冲突时的唯一插入优先级为：blocking controls → 当前 actionRef/pageEffect pin → diff/frontier 明确要求的 continuation pin → `observation.actionables` 原顺序。Pin 只能提升已经由 canonical facts 证明 eligible 的实体；除 blocking controls 的安全例外外，不得绕过 actionability blocker。Projector 不得根据排序第一项自动点击。

L1 expanded 不是一套更“聪明”的排序。它只是沿用相同 canonical order 扩大窗口，或消费 observe assembly 预先产生的 immutable projection index。

### 14.6 V1 actionability 边界

| 页面表面 | V1 façade 边界 |
|---|---|
| Native input/textarea/contenteditable | 只有现有 editable proof 和 ref precheck 均通过时允许 `fill` |
| Native select | 只有 option/value evidence 可验证时允许 `select` |
| Custom ARIA combobox/listbox | 不提供 generic `select`；在专门 canonical owner 出现前只暴露已证明的 `activate`/`press` |
| Virtual list | 只有当前 visible/window item 可 actionable；offscreen item 必须经 read/scroll continuation 后重新观察 |
| Open shadow root | 仅当现有 ref owner 能 resolve 且通过 precheck 时 actionable；Compiler 不新增 shadow locator |
| Closed shadow root | V1 unsupported/blocked |
| Same-origin iframe | 仅当现有 frame/ref route 能证明 scope 时 actionable |
| Cross-origin iframe | V1 blocked 或显式 expert/frame path；façade 不猜 frame scope |

Scan 能读取某些 open shadow/same-origin iframe 内容，不等于 trusted ref execution 已证明可操作。投影必须采用执行路径能力的交集，而不是采用扫描可见性的并集。

### 14.7 Golden-task 失败定义

Candidate budget 只有在 recall gate 通过时才可接受：

1. Golden task 标注一个或多个 `requiredActionable`；若它已存在于 canonical data、通过现有 eligibility/actionability 规则且是完成该步所必需，却未进入 L0，则该步失败。
2. Routine golden task 依靠 `detail=expanded`、expert 或 raw JS 找回漏项不算 L0 成功；这些行为单独计入 down-drill/escalation。
3. Blocking control recall 必须为 100%，不得以 char/candidate budget 为理由豁免。
4. 报告 `criticalActionableRecall`、`blockingControlRecall`、`expandedDownDrillRate` 和 `expertEscalationRate`，并按 native form/custom widget/virtual list/shadow/iframe 分层。
5. 若 12 candidates/6,000 chars 无法达到 recall gate，应先调整投影证据或预算 ratchet，不能通过 skill 提示 Agent 猜测漏掉的控件。

### 14.8 Summary 来源

Summary 应由 canonical gist、outline、notices、candidate facts 和 diff 进行纯规则组合，不调用内部 LLM。外部 Agent 仍负责自然语言理解和任务规划。

## 15. Semantic Action Compiler

### 15.1 位置

建议位置：

~~~text
src/browser-command-runtime/semanticActionCompiler.ts
~~~

它是基于既有 facts 和 primitive specs 的纯/近纯 planner。页面交互只输出 Program Engine 已支持的 trusted program plan；navigate/history 只引用现有 navigation primitive spec。Compiler 不直接调用 Chrome API，也不自行探测页面几何、焦点或可编辑性。

### 15.2 编译矩阵

| Semantic action | Preconditions | 拟议低层计划 |
|---|---|---|
| activate | ref 当前；actionability/ref precheck 证明可执行 | existing Program Engine mouse/key primitives |
| fill | canonical editable proof；ref precheck 通过 | existing focus/key/text primitives |
| press | key 合法；可选 ref 当前 | existing trusted key primitives |
| select | 仅 native select 且 option/value evidence 已验证 | existing trusted primitive composition；custom combobox 不进入 v1 generic select |
| scroll | scroll container 或 viewport 可用 | trusted wheel/program frame |
| drag | from/to refs 当前且现有 ref runtime 可解析端点 | existing trusted drag primitive composition |
| submit | form/submit compatible | activate or Enter path → operation resolver |
| navigate | URL policy 允许 | existing tabs/navigation primitive in one operation |
| history | current target anchored | existing reload/back/forward primitive |

### 15.3 Compiler 输出

~~~ts
interface CompiledSemanticAction {
  actionKind: SemanticActionV1["kind"];
  physical: boolean;
  targetBindings: AgentCandidateBinding[];
  execution:
    | { kind: "program"; program: TrustedProgramPrimitive[] }
    | { kind: "navigation"; plan: ExistingNavigationPrimitiveSpec };
  completionResolverId: SemanticActionCompletionResolverId;
  safety: {
    requiresConfirmation: boolean;
    confirmationReason?: string;
  };
  debugPlan: AgentDebugPlan;
}
~~~

debugPlan 不进入默认 AgentView，只通过 traceRef 提供。

### 15.4 预检查

Compiler 与 Program Engine 的职责必须分离：

1. ref 属于当前 context/owner。
2. ref 创建 identity 与当前 identity 一致。
3. action 在 candidate.actions 中。
4. Compiler 只基于 canonical facts 选择既有 trusted primitive 组合，不实现 `elementFromPoint`、坐标探测、editable detection、focus heuristic 或 selector fallback。
5. Stale ref precheck、relocation 与坐标解析强制经过现有 Program Engine 的 `precheckRefs()`、`resolveStaleRef()`、`resolveRefCoords()` 路径；只允许在同一已证明 document identity 内 relocate。
6. Hittable/visibility/disabled/readonly 等执行时判定复用现有 actionability model 和 `__actionablePoint()` owner，不在 commands/façade 层复制 hit-test。
7. 敏感动作完成 consent/confirmation。
8. 若某个 semantic action 缺少必要 precondition，先扩展 canonical actionability/ref runtime owner 与其测试；禁止在 Compiler 中添加局部“安全猜测”。

### 15.5 Expert evaluate 边界

`evaluate` 从默认 `SemanticActionV1`、agent profile schema 和 AgentCandidate recommendation 中移除。Expert profile 继续直接使用现有 `browser_execute`；如果未来需要 expert façade union，必须发布独立 capability/schema metadata，不能把 evaluate 静默加回 v1。

Structured expert transport 仍可直接传 source 字符串，从而保持临时 JavaScript memory-only：

~~~json
{
  "script": "return { title: document.title };"
}
~~~

不经过 shell quoting，不创建临时文件。CLI fallback 使用 stdin；这不是普通 Agent 主流程。Raw-JS 指标统计 expert escalation，不能把同级 evaluate 当成 routine 成功。

### 15.6 Semantic-action completion resolver

`browser_act` 不能使用一个“看见 mutation 就算完成”的通用 resolver。`src/commands/operationResolvers.ts` 继续是 command-specific completion 的 canonical owner，并在同一 owner 下新增 `SemanticActionCompletionResolverRegistry`；façade command 只能按 semantic kind 取 exact descriptor，不能在 `defineAgentAct.ts` 内猜 expectedEffects。

每个 `SemanticActionV1["kind"]` 必须在 registry 中恰好有一个 resolver descriptor，或在 façade operation 分类表中被声明为 non-write/context-only。Schema enum、registry keys 与治理枚举必须双向全覆盖。

| Semantic kind | `completed` 所需的 command-specific evidence | 不能视为成功的证据 |
|---|---|---|
| activate | navigation/download/new-tab/dialog completion，或与 actionRef 关联的 checked/pressed/expanded/selected 状态转换 | generic DOM mutation、仅 pointer ACK |
| fill | trusted input 已 dispatch，且同一 resolved target 的值以 privacy-safe match/length/hash 方式验证 | 仅 text frame ACK、把 secret 明文写入 trace |
| press | trusted key result 加该 key/target 预期的 state/navigation evidence | “key 已发送”本身 |
| scroll | resolved container/viewport 的 scroll offset 或 virtual window 发生可验证变化 | wheel ACK、无位置变化的 mutation |
| select | 同一 target 的 selected value/state 已验证 | option 被点击但 selected state 未证实 |
| drag | drop target 或 domain state 发生 action-linked transition | mouse move/up ACK；证据不足时为 inconclusive |
| submit | navigation/dialog 或 form/domain completion evidence | submit event/DOM mutation 本身 |
| navigate/history | 复用现有 navigation-completed evidence | URL 字符串改变但 identity/readiness 未达到 resolver 条件 |
| expert evaluate | 复用现有 script-resolved/navigation/download resolver，仍返回 primitive operation v2 | script ACK |
| `browser_view target.tabRef` | context transition，不创建 browser operation，无 completion resolver | 伪造 write outcome |

Resolver 只决定既有 operation signals 是否满足 `completed`，不重新执行动作。Evidence 不足必须落入现有 `effect_observed`/`ambiguous`/`no_effect` 等 classifier；不得为了 façade happy path 提升为 success。

## 16. Safe Recovery Automaton

### 16.1 Dispatch safety boundary

恢复状态必须明确区分：

~~~text
not_started
prepared
sent_unacked
acked
terminal
~~~

自动重试 mutation 的唯一安全情形是：

- 尚未 dispatch；或
- transport 能机械证明 not delivered。

sent_unacked 只有现有 durable/not-delivered 证据能证明未送达时才允许恢复。acked 或交付状态未知时永不重放。

### 16.2 恢复矩阵

| 条件 | 自动动作 | Agent-facing 结果 | Mutation replay |
|---|---|---|---|
| daemon 未启动，尚未 dispatch | ensure/start latest compatible daemon | automaticActionsTaken | 不涉及 |
| extension 短暂未 ready，尚未 dispatch | bounded wait/reconnect | automaticActionsTaken | 不涉及 |
| CDP attach/session setup failure，尚未 dispatch | 重新 attach/setup | automaticActionsTaken | 不涉及 |
| idempotent read transient failure | bounded retry | 通常隐藏，trace 可见 | 允许 |
| context ref stale，但同 PageIdentity 且可重定位 | re-resolve + precheck | automaticActionsTaken | 尚未 dispatch |
| PageIdentity 已变化，action 尚未 dispatch | 清 bindings + full re-anchor | fresh view + choose_action | 禁止执行旧 action |
| 唯一 target replacement，action 尚未 dispatch | rebind + re-anchor | fresh/current view | 尚未 dispatch |
| target lineage ambiguous | 停止 | blocked/choose target | 禁止 |
| mutation 已 ACK，连接丢失 | reacquire/read-only inspect only | inconclusive | 禁止 |
| completed | post-action view | success | not_needed |
| effect_observed | post-action view | inconclusive + assess_goal | 禁止 |
| no_effect | safe view if useful | failure | 禁止 |
| stalled | diagnostics/view | failure | 禁止 |
| ambiguous | evidence/view | inconclusive | 禁止 |
| target_lost | reacquire target for observation only | inconclusive + fresh context/view | 禁止 |
| deadline | bounded evidence/view | inconclusive | 禁止 |
| compacted success result | resolve verified readRef if within facade budget | success + inspect/read option | not_needed |
| artifact save/read unavailable | report unavailable | original outcome unchanged | 禁止 |

### 16.3 自动恢复上限

每次 façade 调用应设置：

- 最大 recovery transitions。
- 最大额外 bridge round trips。
- 最大 recovery time budget。
- 最大 re-anchor 次数。
- 最大 artifact reads。

超过上限返回 blocked/inconclusive，不进入循环。

### 16.4 自动动作可见性

~~~ts
type AgentAutomaticAction =
  | { kind: "ensure_runtime"; result: "reused" | "started" | "reconnected" }
  | { kind: "reattach_cdp" }
  | { kind: "rebind_target"; reason: string }
  | { kind: "reanchor_page"; reason: string }
  | { kind: "relocate_ref"; ref: string }
  | { kind: "retry_read"; attempt: number }
  | { kind: "expand_verified_evidence"; readRef: string };
~~~

默认只返回 kind 和结果，不返回敏感 payload 或路径。

## 17. 敏感动作与确认

Agent façade 不应发明第二套 consent 系统，但当前 `BrowserBridgeConsentCoordinator` / consent protocol 只覆盖 pairing authorization，不能宣称 action confirmation 已可直接复用。Phase 2 必须扩展同一个 coordinator/port/protocol owner，使其拥有 action-scoped confirmation；禁止新建平行 consent store 或只在 AgentContext 内保存授权位。

### 17.1 需要确认的典型动作

- 支付、下单。
- 发送公开消息或邮件。
- 删除、注销、撤销。
- 上传敏感文件。
- 修改安全设置。
- 明确标记 irreversible 的页面动作。

### 17.2 ConfirmationRef

服务端签发：

~~~ts
interface AgentConfirmation {
  confirmationRef: string;
  ownerPairingDigest: string;
  contextRefDigest: string;
  contextRevision: number;
  pageIdentityDigest: string;
  semanticActionDigest: string;
  reason: string;
  expiresAt: number;
  consumedAt?: number;
}
~~~

Binding 与消费算法必须满足：

1. `confirmationRef` 绑定 owner/pairing、contextRef、context revision、现有 PageIdentity、semantic action digest、expiry 和 one-shot consumed state。
2. PageIdentity、context revision、owner 或 semantic action 任一变化都使其失效；验证与 consumed 标记必须原子化。
3. Semantic action digest 只包含验证动作等价性所需的 canonical/redacted fields。Password、token、secret field value 不进入 UI label、日志或持久化 digest input；确需绑定 secret 输入时，只在现有 redaction/privacy boundary 下计算一次性的 keyed commitment，原值和可复用裸 hash 均不保留。
4. Coordinator 只返回 typed authorized/expired/mismatch/consumed decision，commands 层不自行解释 consent UI 文本。
5. 任何需要 consent 的 mutating façade action，在 action-confirmation protocol、contract tests 和 live smoke 完成前不得进入 preview write surface。这是 Phase 2 prerequisite，不是 Phase 2 之后的开放问题。

## 18. Evidence 与 Trace

### 18.1 Trace 目标

防腐层必须能解释：

- Agent 请求了什么语义动作。
- Context 在哪个 identity/revision。
- Compiler 生成了什么低层 plan。
- Operation 的真实终态。
- 自动恢复做了什么。
- AgentView 从哪些 canonical facts 生成。
- 哪些字段被预算折叠。

### 18.2 TraceRef

traceRef 是 owner-isolated、bounded、TTL 的逻辑引用。默认响应不嵌入完整 trace。Trace 存储失败必须 fail-open：Agent outcome/view 保持可用，trace.available=false 并给出 unavailableReason；不得因为调试证据不可用而改写已发生的浏览器终态。

建议 trace 包含：

~~~ts
interface AgentTrace {
  traceRef: string;
  contextRef: string;
  contextRevisionBefore: number;
  contextRevisionAfter: number;
  requestSummary: Record<string, unknown>;
  compiledPlanSummary?: Record<string, unknown>;
  rawOperationRef?: string;
  rawObservationRef?: string;
  automaticActionsTaken: AgentAutomaticAction[];
  projectionReport: {
    candidatesConsidered: number;
    candidatesReturned: number;
    readsBound: number;
    chars: number;
    bytes: number;
    estimatedTokens: number;
  };
  redaction: Record<string, unknown>;
}
~~~

### 18.3 Privacy

Trace 不应默认保存：

- 完整 action text value。
- 密码/secret 字段内容。
- cookies/authorization。
- 完整 network body。
- URL query 中的敏感值。

应复用现有 redaction owner，并对 Agent façade 新字段增加专门测试。

## 19. Structured Agent Transport

### 19.1 原则

普通 Agent 调用应走 structured tool call、SDK、MCP 或 JSON-RPC，而不是 shell command composition。

~~~text
Agent → structured request → daemon/command runtime
~~~

CLI 保留为：

- 人类入口。
- CI/smoke 入口。
- 调试入口。
- structured transport 不可用时的 fallback。

### 19.2 SDK 草图

~~~ts
const client = new BrowserPilotAgentClient();

const view = await client.view({
  target: { use: "active" }
});

const turn = await client.act({
  contextRef: view.context.contextRef,
  action: {
    kind: "fill",
    ref: view.candidates[0].ref,
    value: "Browser Pilot"
  }
});
~~~

### 19.3 MCP/Plugin 暴露

普通 Agent plugin 只注册 agent profile。Expert/security profile 必须由配置或用户授权显式启用。

Profile 过滤发生在工具注册层，而不是依靠 prompt 告诉 Agent“不要调用其他工具”。

### 19.4 过渡期 transport（Phase 1–3，无独立 SDK/MCP package）

正式 `agent-sdk` / `agent-mcp` package 仍是 Phase 4 独立 epic（见 ADR-E / R9）。但 preview 价值不能被 CLI skill 独占。Phase 1 起必须提供 **零新 package** 的结构化调用面：

| 交付物 | 形态 | 用途 | 约束 |
|---|---|---|---|
| Daemon JSON invoke | 现有 daemon HTTP/JSON-RPC 入口调用 façade commands | 集成方与 benchmark 主路径 | 与 CLI offline validation 同一 schema pipeline |
| Agent profile tool descriptor | 由 `capabilityProfileCatalog` + commandCatalog 生成的 machine-readable 3-tool 描述 | 手写 MCP/plugin 注册 | 只过滤 name set，不复制参数 schema 正文的第二真相 |
| Stable examples | `docs` 或 `examples/agent-preview/` 下的 view→act→read JSON 样例 | 人类与 Agent 集成对照 | 不含 secret；随 schema 契约测试 |
| CLI façade 入口 | `browser-pilot view|act|read` 或等价 agent 子命令（实现时选定一种，不双轨） | 人类调试与 smoke | 默认不改变现有 expert CLI 主帮助叙事 |
| Cognitive metrics hook | invoke 响应或 trace 中的可汇总计数 | Phase 0/1 bench | 不记录页面秘密或完整 fill value |

过渡期明确允许：

1. 集成方用 descriptor **手写** MCP server / plugin，不要求官方 package。
2. benchmark 与 golden tasks 走 daemon JSON invoke，不依赖 shell quoting。
3. 临时 expert JS 仍可通过 structured invoke 内存传 `script`，CLI 仅 stdin fallback。

过渡期明确禁止：

1. 新增 `src/apps/agent-sdk/` 或发布第二套校验逻辑。
2. 在 skill 中教 Agent 用临时文件拼 JS 或手工拼 tabId/path。
3. 用 prompt“请只使用三个工具”代替 profile 过滤。

## 20. 代码落位

### 20.1 Pure kernels

建议新增：

~~~text
src/kernels/agent/
  agentTypes.ts
  agentView.ts
  agentDecision.ts
  contextTransition.ts
  recoveryPolicy.ts
  semanticAction.ts
  cognitiveCost.ts
~~~

职责：

- 类型和 schema-independent pure model。
- PageObservation facts → candidate/view projection。
- outcome → decision mapping。
- context identity transition。
- safe recovery classification。
- cognitive metrics/cost。

禁止依赖 browser、Node、commands、bridge、runtime 或 npm runtime。

### 20.2 Session kernel

~~~text
src/kernels/session/agentContextRegistry.ts
~~~

职责：

- owner isolation。
- revision。
- bounds/TTL。
- candidate/read binding 生命周期。
- context 状态转换。

### 20.3 Browser command runtime

~~~text
src/browser-command-runtime/semanticActionCompiler.ts
src/browser-command-runtime/semanticActionExecutor.ts
~~~

职责：

- SemanticActionV1 → existing trusted program/navigation primitives。
- 复用 ref precheck、relocation、trusted input。
- 输出 debug plan。
- 不拥有 hit-test、editable/focus heuristic 或 completion classification。

### 20.4 Commands

~~~text
src/commands/agent/
  defineAgentView.ts
  defineAgentAct.ts
  defineAgentRead.ts
  agentViewProjector.ts
  agentRecoveryCoordinator.ts
  agentEvidenceResolver.ts
src/commands/operationResolvers.ts
~~~

职责：

- closed public schemas。
- 组合现有 command/runtime。
- 调用 withBrowserOperation。
- `operationResolvers.ts` 拥有 SemanticActionCompletionResolverRegistry 与 resolver coverage。
- 生成 façade envelope。

### 20.5 Daemon

~~~text
src/apps/daemon/AgentContextService.ts
src/apps/daemon/AgentTraceStore.ts
~~~

Daemon 作为 live browser session owner，持有 context/trace 实例。Commands 通过 port 访问，不能直接导入 daemon class。

### 20.6 Ports

建议新增纯端口：

~~~text
src/browser-runtime/ports/AgentContextPort.ts
src/browser-runtime/ports/AgentTracePort.ts
~~~

### 20.7 CLI；SDK/MCP 后置

~~~text
src/apps/cli/agentCommands.ts
~~~

Phase 1–3 只实现 daemon/context service、façade commands 与现有 CLI 入口，不创建 `src/apps/agent-sdk/` 或 `src/apps/agent-mcp/`，也不重构 package layout。Structured transport 仍是目标，但 SDK/MCP package、发布方式和 plugin 注册作为 façade contracts 稳定后的独立 Phase 4 epic；它不能与核心 semantic contract 同批扩大变更面。

### 20.8 不应落位的位置

以下逻辑不应放入：

- SKILL.md：只能记录使用契约，不拥有运行时策略。
- CLI flag parser：不拥有 recovery/context/action semantics。
- Bridge transport：不拥有 Agent 决策。
- Extension service worker：不拥有 goal、AgentView 排序或 recovery policy。
- capture-src：不拥有 Agent-facing envelope。

## 21. 与现有能力的复用关系

| 现有能力 | 新层如何复用 |
|---|---|
| PageObservationV3 | AgentView 的 canonical 输入 |
| actionables/entities | AgentCandidate 来源 |
| `sortEntitiesBySalience` / relevance result | L0/L1 canonical candidate order；façade 不复制 score |
| Resource refs | Candidate binding 的内部 target |
| Program Engine | Semantic Action 的执行后端 |
| ref precheck/relocation | Pre-dispatch safe recovery |
| withBrowserOperation | browser_act 的 transaction owner |
| `operationResolvers.ts` | semantic-kind completion resolver registry owner |
| browser-operation/v2 | AgentOutcome 的机械真值 |
| continuation | SafeRecoveryAutomaton 的输入之一 |
| SessionOperationRegistry | Operation settlement/late effects |
| PageIdentity | Context anchor |
| verified frontier | readRef 来源 |
| result budgeting/CostVector | AgentView/Trace budget owner |
| daemon contract identity | 新 façade schema 的版本/复用保护 |

## 22. 兼容性与发布策略

### 22.1 现有命令

现有 19 个命令在迁移期间保持行为不变。Agent façade 是新增表面，不通过兼容 alias 改写旧命令。

### 22.2 发布通道（强制三阶段）

技术完成 ≠ 产品默认。发布必须显式经过：

| 通道 | 谁能看见 façade | Catalog / toolCount | CLI 人类默认 | Agent 集成默认 | 目标 |
|---|---|---|---|---|---|
| **P0 agent-preview** | 显式 profile / 显式 invoke | 不改 v3 wire；preview 过滤 name set | expert-first 不变 | 关闭 | 收集指标与失败证据 |
| **P1 agent opt-in** | 配置/pairing/plugin 显式选择 agent | 可注册 façade tools，但未宣称 default agent surface | expert-first 不变 | 文档推荐、需用户打开 | 真实集成验证 |
| **P2 agent default（GA）** | Agent 集成默认 3 工具 | 原子执行 19→22、contract version/hash/toolCount、daemon replacement | **仍 expert-first**（除非另立 CLI UX epic） | 默认 agent profile | 认知 SLO 达标后 |

通道升级是 **产品决策门**，不是 Phase 代码合并的自动结果。每一级都需要书面记录：benchmark 数字、未解决问题、回滚方式。

回滚原则：

1. Preview/opt-in 可随时关闭 profile，不影响 primitive 19 工具。
2. GA 后若发现严重回归，允许通过 profile 默认回退到 expert，而不删除 façade 代码路径。
3. 任何回退不得破坏 completed-only 与 no-replay 不变量。

### 22.3 Preview profile 行为

`agent-preview` 启用时：

- 不成为默认 CLI 行为，也不改写 `browser-pilot --help` 的人类主路径叙事。
- 不修改 expert raw command 的默认结果 envelope。
- 收集认知指标和失败证据（脱敏）。
- 提供 §19.4 过渡期 descriptor 与 JSON 样例。
- 不得提前修改 19-tool catalog ratchet 或 v3 wire 语义。

### 22.4 Profile 选择表达（v1 锁定方向）

为避免 Phase 0 后仍摇摆，v1 采用分层表达：

1. **集成默认**：Agent plugin/MCP 注册层选择 profile（权威过滤点）。
2. **调用覆盖**：daemon invoke metadata 或 pairing 级 `capabilityProfile`（用于 preview/opt-in）。
3. **CLI 显式**：`--profile agent|expert|security|admin`（人类调试）；缺省 = expert/admin 现有行为。

禁止仅靠 skill 文本声明 profile。

### 22.5 Contract version

以下变化必须显式进入 contract identity：

- 新 façade tools。
- AgentView/AgentTurn/AgentRead schema。
- SemanticAction enum/fields。
- AgentDecision mapping。
- Profile discovery（如果公开进 machine discovery root）。

不要仅依靠 package version 或 prompt 文本表达兼容性。Schema 演进遵守 §7.8。

### 22.5.1 对 browser-operation/v2 root 规则的有意演进

当前治理要求每个公开 state-changing command 直接返回 browser-operation/v2 root。browser_act 若仍把完整 operation root 直接暴露给 Agent，再附加 AgentView，会保留大部分原有心智负担；因此本提案选择让 browser_act 返回 browser-agent-turn/v1 root，并在 outcome 中提供 browser-operation/v2 的纯、受测映射。

这是一次有意的 charter amendment，不能在实现时作为普通字段追加悄悄落地。进入实现前必须显式修改 REPO_GOVERNANCE.md，区分：

1. Primitive write commands：继续直接返回 browser-operation/v2。
2. Agent façade write：必须在内部取得完整 browser-operation/v2 后，才能返回 browser-agent-turn/v1。
3. 该例外 **仅** 适用于 agent façade write；禁止其他命令跟风自定义 root。

Agent façade 的约束：

- Raw browser-operation/v2 必须完整保留在 owner-isolated trace/artifact 中。
- AgentOutcome 必须由 src/kernels 中的纯函数映射，不得由通用 error-shape 或自然语言启发式决定。
- status、classification、completionVerified、ok、completionSource、code 和 replay 不能被改写。
- completed 仍是唯一 success。
- TraceRef 必须允许 expert/debug surface 检查原始 operation。
- 如果 raw operation 无法保存或引用，façade 仍要保留其终态和 completion source；证据持久化失败不能改写 outcome。
- CLI exit code / JSON pretty / doctor 对 AgentTurn 的映射必须复用同一 classifier 投影，不得另写成功启发式。

备选方案是保持 browser-operation/v2 root 并增加 agentView 字段，但它会让默认 Agent继续接收完整机械 envelope，不符合本方案的主要目标。除非 benchmark 证明新的 AgentTurn 映射带来不可接受的证据或兼容风险，否则不采用该备选。

### 22.6 退出 preview / 进入 opt-in / 进入 default

**进入 agent opt-in（P1）** 最低条件：

1. M1 read-only façade 可用，§7.7 失败目录覆盖主路径。
2. L0 recall 与 blocking recall 在 fixture 集上达到 gate。
3. 过渡期 descriptor + JSON 样例可用。
4. Expert 下钻与 primitive 19 工具无回归。

**进入 agent default / GA（P2）** 额外条件：

1. Golden tasks 达到认知 SLO（§25.3）。
2. mutation replay 保持为 0。
3. completed-only success contract 通过治理测试。
4. Live browser smoke 覆盖 context/reanchor/ref/reconnect/confirmation。
5. Expert/security profile 完整可用。
6. 时延预算（§26.1）在 fixture 与抽样真页上无系统性违约。
7. GA catalog 19→22 与 daemon identity checklist 一次完成。
8. Routine success、recall、下钻率达标后，才允许显著缩短 skill；skill 行数不是入门条件。

## 23. 分阶段实施与产品里程碑

实施按 **工程 Phase** 与 **产品 Milestone（M）** 双轨管理。Phase 描述工作集；M 描述可对外演示的验收包。

| 里程碑 | 对应 Phase | 产品验收句 | 发布通道 |
|---|---|---|---|
| **M0 Baseline** | Phase 0 | 19-tool 工作流认知成本可重复测量；fixture 与 requiredActionable 标注就绪 | 无 façade |
| **M1 Preview Read** | Phase 1 | Agent 仅用 view/read 完成选 tab、理解页、读内容，不传机械 ID/path | agent-preview |
| **M2 Preview Act Core** | Phase 2a–2c | 一次 act 完成 activate/fill/navigate，并返回真实 outcome + 下一决策 view | agent-preview |
| **M3 Recovery Hardened** | Phase 3 + 2 余量 | Happy path 无手写 readiness；reconnect/reanchor/stale ref 自动安全处理 | agent-preview → 可申请 opt-in |
| **M4 Agent Opt-in Defaultable** | Phase 4 前半 | 集成方可默认注册 3 工具；高级动作与治理迁移完成；CLI 仍 expert-first | agent opt-in → 条件满足后 default |
| **M5 Owner Sync** | Phase 5 | CODE_WIKI/REPO_GOVERNANCE/README/skill 与实现对齐；本文归档 | GA 后收敛 |

### Phase 0：基线、Fixture 与 Characterization

目标：先测量真实认知负担，并建立可 CI 化的页面夹具，避免只凭感觉优化。

工作：

1. 建立 agent workflow golden tasks 与标注规范（`requiredActionable`、blocking controls、expected decision）。
2. 建设 **golden fixture 仓库**（建议 `tests/fixtures/agent-pages/` 或等价静态服务）：
   - 静态导航/表单页；
   - 可控 SPA（history/hash）；
   - dialog/consent/validation；
   - native select 与 custom combobox（用于边界锁定）；
   - virtual list；
   - open/closed shadow 与 same/cross-origin iframe 最小样例；
   - 确定性 timeout/延迟按钮（用于 deadline 测试）。
3. 记录 public calls、schema lookups、opaque IDs、raw JS、artifact hops。
4. 给当前 19-tool workflow 建立 baseline。
5. Characterize common observe → act → settle → next-decision 路径。
6. 冻结现有 safety invariants。
7. 建立 L0 recall baseline，并分层报告 native/custom/virtual/shadow/iframe。
8. 定义指标脱敏规则：不记录密码、完整 fill value、cookie、authorization。

退出条件：

- 有可重复 baseline 与固定 fixture URL/seed。
- 指标不记录敏感内容。
- 任务覆盖普通导航、表单、新 tab、SPA、reconnect、stale ref、blocking dialog。
- CI 可无外部网站依赖地跑主 fixture 集（live 真网作为可选加分，不作为 M0 阻断唯一来源）。

### Phase 1：Read-only façade（→ M1）

目标：先隐藏 target/identity/artifact 机械细节，不引入 write 风险。

工作：

1. AgentContextRegistry + port 注入点（commands 不直接 import daemon class）。
2. browser_view 与 readiness ensure。
3. AgentViewProjector（canonical order + pin precedence）。
4. candidate/read bindings 与 target tabRef。
5. browser_read。
6. agent-preview profile + §19.4 descriptor/examples。
7. §7.7 失败目录主码实现（至少 CONTEXT_* / TARGET_AMBIGUOUS / READ_UNAVAILABLE / RUNTIME_NOT_READY）。
8. trace/cognitive telemetry。
9. 多 owner isolation 与 CONTEXT_BUSY/revision 的 pure/integration 测试。

退出条件（技术 + 产品）：

- Agent 不手工传 tabId/pageEpoch/baseline/path/jsonPath。
- “第一次成功”旅程可演示（§3.4）。
- View/re-anchor/replacement 有完整 deterministic tests。
- L0 critical actionable/blocking-control recall 达到 gate；expanded/expert 找回漏项不计成功。
- Native form、custom combobox、virtual list、shadow 与 iframe 的 v1 能力边界已用 characterization test 锁定，并在 blocked reason 中可区分。
- 过渡期 JSON invoke 样例通过 contract 测试。

### Phase 2：Semantic Actions（拆 PR，禁止整块合并）

目标：覆盖最常见页面动作；**consent 与 resolver 是 write surface 的硬前置**。

首批 action 仍是 activate/fill/press/scroll/navigate/history；select/drag/submit 默认放到 M4，除非 resolver 证据已充分。

#### Phase 2a：Consent protocol 扩展（blocking）

1. 扩展现有 consent coordinator/port/protocol，支持 action-scoped one-shot confirmation。
2. 绑定 owner/context revision/PageIdentity/action digest；secret 不进可逆摘要。
3. contract tests + live smoke：mismatch/expiry/consumed。
4. **未完成前，任何需要 confirmation 的 mutating façade 不得进入 preview write。**

#### Phase 2b：Resolver registry + activate/fill

1. `SemanticActionCompletionResolverRegistry` 与 enum 双向 coverage gate。
2. Compiler 只组合 existing trusted Program Engine primitives。
3. activate/fill 的 exact resolver 与 privacy-safe fill 验证。
4. context mutation serialization 与 shared PageIdentity transition。
5. 禁止第二套 hit-test 的 governance test。

#### Phase 2c：browser_act 核心路径 + post-view

1. browser_act schema 与 AgentTurn root（治理 amendment 已合入）。
2. 单一 total deadline 预算分配（§26.1）。
3. operation settlement 与 outcome-first、fail-open post-action view。
4. completed/no_effect/target_lost/deadline 等 1:1 mapping 测试。
5. press/scroll 可同批或紧随，但不得拖住 activate/fill 的 M2 验收。

#### Phase 2d：navigate/history 与剩余 write hardening

1. navigate/history 作为 write + navigation resolver。
2. 与 reanchor/post-view 时延矩阵。
3. confirmation 所需的敏感动作样例接入 fixture。

退出条件（M2）：

- 常规 golden tasks 的 activate/fill/navigate 不需要 raw JS。
- 每个 mutation 只有一次公开 browser_act。
- 非 completed 状态永不显示 success。
- 每个 **已发布** semantic write kind 均有 exact resolver；未发布 kind 不得出现在 agent schema。
- Post-view 故障仍返回权威 outcome；v1 无 streaming/partial-result。
- 时延预算在 fixture 上无系统性违约。

### Phase 3：Recovery Automaton（→ M3）

目标：把安全机械恢复从 Agent prompt 移入运行时。与 Phase 2 并行渐进：readiness/reanchor 不应等 write 全部完成才开始。

工作：

1. Readiness recovery（view 路径 Phase 1 已启动，本阶段补齐矩阵与上限）。
2. identity/re-anchor。
3. unique target replacement。
4. CDP/session setup recovery。
5. verified evidence expansion。
6. recovery budgets 与 automaticActionsTaken。
7. multi-client：双 owner 并发、同 owner CONTEXT_BUSY、revision mismatch 压测。

退出条件：

- Happy path 无 connect/status/doctor。
- 自动恢复不会重放 mutation。
- 所有恢复分支有 matrix tests。
- §7.7 恢复相关 code 全覆盖。
- 可申请进入 agent opt-in 通道。

### Phase 4：高级动作、治理迁移、默认化与 SDK/MCP epic（→ M4）

目标：在 façade contract 稳定后，完成高级能力与 **可选** 默认化；SDK/MCP 为独立评审 epic。

工作拆分：

1. **4a 高级动作**：select/drag/submit（各需 exact resolver 后才进 schema）。
2. **4b 治理 GA checklist**：19→22 tool count、catalog contract version/hash、daemon identity、25 KiB ratchet。
3. **4c 默认 profile 决策**：仅当 §22.6 GA 条件满足；CLI 人类路径默认仍 expert-first。
4. **4d 独立 SDK/MCP epic**：正式 package、plugin 注册、与 daemon 的 contract parity tests。
5. 按需求 transfer / network 高层 transaction（非 v1 阻断）。
6. Expert/security 显式启用；evaluate 永不进 agent profile。
7. skill 在成功率/下钻率不退化前提下压缩。

退出条件：

- Agent 集成面默认 visible tools = 3（若选择 GA default）。
- Expert path 无能力损失；security 不出现在普通 Agent surface。
- GA catalog 变更完整通过；preview 阶段从未改 v3 wire 语义。
- 官方 SDK/MCP 可另发版本，不阻塞 façade 本身 GA。

### Phase 5：收敛与 Owner 同步（→ M5）

工作：

1. 将稳定架构写入 CODE_WIKI.md（可在 M1 起维护草稿节，M5 定稿）。
2. 将公共契约和门禁写入 REPO_GOVERNANCE.md。
3. 更新 README/CHANGELOG/skill：Agent 主叙事 view→act→read；人类 CLI expert 路径保留入口。
4. 删除过渡性 prompt 规则和重复 adapter。
5. 删除或归档本文。

## 24. 测试与验证

### 24.1 Pure tests

新增测试：

~~~text
tests/kernels/agentView.test.ts
tests/kernels/agentDecision.test.ts
tests/kernels/agentContextTransition.test.ts
tests/kernels/agentRecoveryPolicy.test.ts
tests/kernels/agentCognitiveCost.test.ts
~~~

覆盖：

- 投影确定性。
- budget。
- candidate 排序。
- canonical actionable order/pin precedence 与 critical-actionable recall。
- identity transition 与 ghost-state invariants。
- outcome mapping。
- semantic action resolver coverage/evidence classification。
- recovery allow/deny。
- bounds/TTL。

### 24.2 Contract tests

必须保护：

1. Closed schema。
2. Unknown field rejection。
3. completed-only success。
4. AgentOutcome 与 browser-operation/v2 不漂移。
5. Agent envelope 不泄漏 path/tabId/backendNodeId/authorization。
6. readRef 只能解析 verified descriptor。
7. context owner isolation。
8. context revision/stale ref。
9. command contract hash 包含 façade schema。
10. `SemanticActionV1` enum 与 completion resolver registry 双向全覆盖。
11. `target_lost` 1:1 映射为现有 inconclusive contract。
12. 默认 agent profile/schema/candidates 均不包含 evaluate。
13. Action confirmation 与 owner/context revision/PageIdentity/action digest 绑定且 one-shot。

### 24.3 Integration tests

覆盖：

- view 创建 context。
- view 复用 target。
- document change re-anchor。
- same-document SPA。
- target replacement。
- concurrent mutation。
- operation completed/effect_observed/no_effect/ambiguous/target_lost/deadline。
- 每个 semantic kind 的 exact resolver 与 generic mutation-inconclusive case。
- post-view timeout/projection failure 仍返回 settled outcome。
- 单一 façade deadline 不被内部阶段重置，operation 获得 remaining budget。
- artifact folded content → readRef。
- daemon restart context expired。

### 24.4 Live browser smoke

建议扩展现有 smoke-browser：

1. agent view handshake。
2. activate/fill/navigation。
3. post-action view。
4. extension reconnect。
5. BFCache。
6. Prerender2 replacement。
7. stale candidate ref。
8. target close/new target。
9. no mutation replay assertion。
10. expert temporary evaluate source memory-only，且 agent profile 无 evaluate recommendation。
11. confirmation owner/page/action mismatch 与 one-shot consumption。
12. post-view unavailable 的 outcome-first 返回。

### 24.5 Governance tests

新增硬规则：

- Agent profile 工具数量固定。
- Security tools 不进入 agent profile。
- façade write 必须经 withBrowserOperation。
- semantic write kind 必须有 command-specific completion resolver，context-only kind 禁止伪造 resolver。
- completed-only success。
- no post-action wait/sleep。
- no mutation replay。
- no raw path in Agent envelope。
- no temporary JS file guidance。
- AgentContext identity transition 必须消费现有 `pageReanchorReason()` decision。
- GA tool-count 19 → 22、catalog version/hash/toolCount、daemon replacement 与 25 KiB ratchet 必须同批更新。
- CODE_WIKI/REPO_GOVERNANCE/skill owner 一致。
- Agent façade write 是 browser-operation/v2 root 的唯一特许例外；其他命令不得自定义 terminal root。
- 发布通道：preview 不得修改 catalog v3 wire；default 切换必须有 benchmark 记录。

### 24.6 Golden fixture 与标注规范

Fixture 是认知 gate 的一等公民，不是手工 demo 页。

1. **确定性**：固定 HTML/JS seed；禁止依赖公网 DOM 作为唯一 gate。
2. **分层标签**：每个 golden step 标注：
   - `requiredActionable`（canonical 可证明且为该步必需）；
   - `blockingControls`；
   - `surfaceClass`（native/custom/virtual/shadow/iframe）；
   - `expectedDecisionKind`；
   - 是否允许 expanded/expert（默认 routine 不允许计入 L0 成功）。
3. **失败归因**：区分 projection miss、actionability miss、resolver inconclusive、transport/readiness。
4. **敏感样例**：password/token 字段只存在于受控 fixture，断言 redaction，不落完整值到 metrics。
5. **并发夹具**：双 context/owner 同时 view；同 context 双 act 触发 CONTEXT_BUSY。

### 24.7 多客户端与容量测试

至少覆盖：

1. 单 owner 16 context 上限与 idle/absolute TTL 回收。
2. 全局 128 context 压力下的 LRU/拒绝策略（返回稳定 code，不 OOM）。
3. 双 owner 无法互相 resolve contextRef/readRef/tabRef。
4. mutation 串行与 read 并发 revision 标记正确。
5. daemon restart 后全部 context expired，新 view 可重建。

## 25. Agent Usability Benchmark

建议新增 canonical gate：

~~~text
mise run bench-agent
~~~

### 25.1 Golden task 类别

- 选择已有 tab。
- 打开 URL。
- 搜索。
- 填表。
- 选择下拉项。
- SPA 导航。
- 新 tab fan-out。
- 上传/下载。
- 页面内容渐进读取。
- extension reconnect。
- stale ref。
- target replacement。
- BFCache。

### 25.2 指标

~~~ts
interface AgentCognitiveMetrics {
  routineTaskSuccessRate: number;
  criticalActionableRecall: number;
  blockingControlRecall: number;
  expandedDownDrillRate: number;
  expertEscalationRate: number;
  visibleToolCount: number;
  publicCalls: number;
  schemaLookups: number;
  explicitReadinessCalls: number;
  opaqueMechanicalIdsCarried: number;
  rawJavaScriptFallbacks: number;
  lowLevelProgramFallbacks: number;
  artifactPathHops: number;
  mechanicalRecoveriesExposed: number;
  automaticSafeRecoveries: number;
  mutationReplayAttempts: number;
  defaultResponseChars: number;
  defaultResponseEstimatedTokens: number;
}
~~~

### 25.3 初始 SLO

| 指标 | 目标 |
|---|---:|
| Agent profile visible tools | 3 |
| Happy path schema lookups | 0 |
| Happy path explicit readiness calls | 0 |
| Agent 携带机械 context IDs | 1 个 contextRef |
| 每次 mutation 的公开 act calls | 1 |
| 自动 mutation replay | 0 |
| Routine golden-task success | 不低于 Phase 0 expert baseline，且 GA 不低于 95% |
| L0 critical actionable recall | 不低于 99% |
| Blocking-control recall | 100% |
| Routine expanded down-drill | 不高于 10% |
| Routine expert escalation | 不高于 5% |
| 常规任务 raw JS expert escalation | 小于 10% |
| 常规任务手工 artifact path/jsonPath | 0 |
| L0 AgentView 默认 chars | 不超过 6,000 |
| Skill 默认主流程 | 任务成功率与下钻率达标后，目标不超过约 60 行 |

Skill 行数只是滞后结果，不是独立成功标准。若 skill 压到 60 行却使 Agent 经常 expanded/expert 下钻、漏掉 required actionable 或降低任务成功率，则方案失败。SLO 可在 Phase 0 后基于数据收紧；mutation replay=0、blocking recall=100% 和 completed-only success 不可放宽。

## 26. 性能目标与时延预算

防腐层减少 Agent-visible round trips，但内部可能增加 post-action projection。需要区分：

- public round trips。
- bridge round trips。
- browser/CDP round trips。
- projection CPU。

优化顺序：

1. 优先复用 operation pageEffect。
2. 只有下一决策需要时才运行 delta observe。
3. 复用同 context 的 baseline/cache。
4. Projection 必须纯、bounded。
5. Verified artifact 自动读取受独立预算限制。
6. 不为了减少 public calls 创建无限内部循环。

### 26.1 单一 total deadline 下的阶段预算（v1 初值）

`timeoutMs` 默认 30_000，最大 300_000。下列为 **默认 30s 调用** 的 provisional cap；实现必须按比例或显式配置缩放，且 **任何阶段不得重置总时钟**。

| 阶段 | 默认 cap（30s 调用） | 规则 |
|---|---:|---|
| readiness / preflight | ≤ 3_000 ms | ensure daemon/bridge/extension；超时 → `RUNTIME_NOT_READY` |
| context resolve + ref/identity precheck | ≤ 2_000 ms | 含 revision/binding 校验 |
| semantic compile | ≤ 500 ms | 纯/近纯；不含 hit-test |
| **dispatch 前 post-view reserve** | ≥ 4_000 ms | 剩余不足则 **禁止 dispatch**，返回失败而非半执行 |
| operation（withBrowserOperation remaining） | 总剩余 − reserve | 只拿扣除已消费后的 remaining |
| post-view / projection | ≤ reserve 与剩余的较小值 | fail-open；不得改写 outcome |
| automatic recovery（累计） | ≤ 5_000 ms 且 ≤ 3 transitions | 超限 stop；见 §16.3 |
| verified evidence auto-expand | ≤ 1_500 ms | 独立子预算，失败则 inspect/read option |

附加约束：

1. `browser_view` 无 operation 时，预算重点在 readiness + observe + projection；仍受单一 timeoutMs 约束。
2. `viewStatus:"available"` 的 P95 目标（fixture，本机 warm daemon）：view ≤ 2.5s，act（activate 无导航）≤ 8s，act（同文档 fill）≤ 6s。真页抽样只作回归观察，不替代 fixture gate。
3. P95 违约先优化复用 pageEffect/cache，不得靠放宽 completed 定义。
4. telemetry 必须能拆出下列字段，供 bench-agent 与 doctor 使用。

### 26.2 Telemetry

~~~text
agentFacadeMs
contextResolveMs
semanticCompileMs
operationMs
postViewMs
projectionMs
automaticRecoveryMs
readinessMs
publicRoundTrips
bridgeRoundTrips
budgetRemainingMsAtDispatch
viewStatus
outcomeStatus
~~~

## 27. 风险与缓解

### 27.1 Hidden state 导致不可预测

风险：Agent 不再看到 target/page 标识，错误 context 可能更难理解。

缓解：

- contextRevision。
- trace descriptor。
- automaticActionsTaken。
- owner isolation。
- explicit context migration。
- 不因 active tab 变化静默迁移。

### 27.2 AgentView 省略关键事实

风险：L0 view 过度压缩。

缓解：

- L0 基础顺序直接消费 canonical `observation.actionables`。
- 只允许 blocking/actionRef/diff/frontier 的 deterministic pins，不建立 façade relevance score。
- Blocking-control recall=100%，critical-actionable recall 与 down-drill rate 作为 gate。
- L1/readRef/expert 只用于真正的渐进披露，不为 L0 漏项免责。

### 27.3 Semantic compiler 操作错误元素

风险：高层 action 隐藏了低层 hit-test/focus 细节。

缓解：

- Context-scoped ref。
- identity/revision validation。
- action compatibility。
- canonical actionability facts。
- Program Engine `precheckRefs()`/relocation/`__actionablePoint()`；Compiler 禁止复制 hit-test。
- compiled debug plan。
- semantic-kind completion resolver 与 operation mechanical evidence。

### 27.4 自动恢复重复副作用

风险：状态机错误重放 mutation。

缓解：

- 显式 dispatch boundary。
- ack/delivery proof。
- deny-by-default matrix。
- governance hard assertion。
- smoke 中记录 mutation count。

### 27.5 三个 façade 工具与原工具重复

风险：公共面总数增加。

缓解：

- Profile 决定默认可见面。
- Facade 与 primitive 的角色明确。
- 不创建 click/type 子工具。
- 稳定后移除重复 prompt/adapter，而不是立即删除 expert commands。

### 27.6 Context 内存增长

风险：多 Agent/长任务积累 bindings/trace。

缓解：

- Per-owner/global caps。
- Idle/absolute TTL。
- LRU eviction。
- bounded candidate/read/trace。
- diagnostics 只返回 counts，不泄漏内容。

### 27.7 Structured adapter 与 CLI 行为漂移

风险：SDK/MCP 形成第二套校验。

缓解：

- 共享 command definitions/schema/validation。
- Adapter 只序列化，不 normalize 未声明字段。
- Offline/daemon/SDK contract parity tests。

### 27.8 Context 与 Session identity 双轨

风险：operation generation 已推进，但 façade context 仍声称 anchored。

缓解：AgentContext 只引用现有 PageIdentity/target lineage，所有事件消费同一次 `pageReanchorReason()` decision；ghost-state invariants 和 dispatch 前 generation/identity 一致性是 pure/integration gate。

### 27.9 Facade deadline 与 post-view 放大延迟

风险：readiness、precheck、operation、post-view 各自取完整 timeout，导致一次 act 长时间无结果。

缓解：单一 total deadline、阶段 cap、dispatch 前 post-view reserve、operation remaining budget；operation settle 后 outcome-first，post-view fail-open；v1 不引入 streaming/partial contract。

### 27.10 Consent 与 catalog 治理未同步

风险：action confirmation 另造授权状态，或新增 façade 时静默改变 catalog v3/19-tool contract。

缓解：Phase 2a 先扩展现有 consent coordinator/port/protocol；GA 再原子执行 19 → 22、contract version/hash/toolCount、daemon replacement 和 size ratchet checklist。

### 27.11 技术完成被误当产品默认

风险：M2/M3 合并后直接把 Agent 集成默认切到 3 工具，导致现有 skill/脚本与用户预期断裂。

缓解：强制 §22.2 三通道；CLI 人类路径 v1 expert-first；GA 需 §22.6 书面条件；支持 profile 回退。

### 27.12 能力边界导致“看得见却点不了”

风险：§14.6 保守边界被感知为产品缺陷。

缓解：`ACTION_UNSUPPORTED_SURFACE` 与 surfaceClass 分层指标；文档/skill 明确 v1 支持面；decision=blocked 给出 expert/expanded 路径；不以放宽 actionability 换 demo。

### 27.13 过渡期无 structured 集成导致生态空转

风险：SDK/MCP 后置后，价值只能靠 CLI skill 验证。

缓解：§19.4 零新 package 的 descriptor + daemon JSON invoke + 样例；benchmark 禁止依赖 shell quoting。

### 27.14 Resolver 过严导致 inconclusive 过多

风险：安全正确但任务成功率/体验崩溃。

缓解：Phase 0 分层归因；优先增强 canonical evidence 与 resolver，不提升假 success；对 effect_observed 保持 assess_goal；bench 同时报告 success 与 inconclusive 率。

## 28. 架构决策

### ADR-A：选择三个小 façade 工具，而不是一个巨型 browser_agent

决定：使用 browser_view、browser_act、browser_read。

理由：

- Tool 语义清晰。
- Schema 更小。
- Read/write 边界明确。
- browser_act 可以独立应用 operation 治理。
- browser_read 可以保持 idempotent。
- 避免一个 action union 同时承载 target、observe、act、artifact、admin。

### ADR-B：Context 只保存机械状态

决定：不持久化目标/业务记忆；daemon restart 使 context 失效。

理由：

- 避免隐式长期记忆。
- 保持 owner/privacy 边界。
- Context 可以由 view 安全重建。

### ADR-C：AgentView 是投影，不是新的 canonical observation

决定：PageObservationV3 继续是唯一 canonical page model。

理由：

- 避免双写事实。
- 保留完整证据和 cache/artifact owner。
- AgentView 可独立演进、严格预算。

### ADR-D：不自动 replay mutation

决定：只有未 dispatch 或机械证明 not delivered 才能重新发送 mutation。

理由：

- 防止重复提交、发送、删除、支付。
- 与现有 ACK/operation truth 保持一致。

### ADR-E：Agent transport 结构化优先

决定：SDK/MCP/JSON-RPC 是默认 Agent 路径；CLI 是人类/调试/fallback。

理由：

- 消除 shell quoting。
- 临时 JS 天然 memory-only。
- 减少 skill 规则。

### ADR-F：Agent façade write 使用 AgentTurn root

决定：Primitive write 保持 browser-operation/v2；browser_act 在内部取得完整 operation 后，返回 browser-agent-turn/v1，并通过 traceRef 保留 raw operation。

理由：

- 防腐层必须真正隔离机械 envelope，而不是只在其旁边再附加一份摘要。
- AgentOutcome 可以保持 completed-only success 和原始 status/classification。
- Pure mapping、contract tests 和 raw trace 可以避免双重真值。
- 这是显式治理演进，不是兼容 alias。
- 例外仅限 agent façade write；CLI exit/doctor 必须投影同一 classifier。

### ADR-G：发布通道与 CLI 默认分离

决定：Agent 集成面走 preview → opt-in → default；人类 CLI v1 保持 expert-first。

理由：

- 保护现有 19-tool 用户与调试路径。
- 避免“代码可合并”自动变成“全站默认切换”。
- 允许 façade GA 后仍用 profile 回退。

### ADR-H：过渡期 structured invoke 先于官方 SDK package

决定：Phase 1–3 提供 daemon JSON invoke、profile descriptor 与 examples；不新建 SDK/MCP package。

理由：

- 尽早验证产品价值与 benchmark 主路径。
- 避免与不稳定 façade contract 同步放大 package 面。
- Phase 4 官方 SDK/MCP 只做序列化适配，不拥有第二套语义。

### ADR-I：失败体验是公共合同的一部分

决定：§7.7 稳定 code 目录与 decision 建议进入 contract/tests，不只写在 skill。

理由：

- 隐藏机械状态后，可诊断性依赖 typed failure。
- 防止各 adapter 各自发明错误文案与分支。

## 29. 评审风险闭环与剩余参数

### 29.1 R1–R13 closure matrix

| 风险 | 已锁定设计决策 | Canonical owner | 阶段前置条件 | Test/SLO gate |
|---|---|---|---|---|
| R1 AgentView 投影漏项 | L0 消费 canonical actionables 顺序，只允许 deterministic pins；custom widget/virtual/shadow/frame 边界按 §14.6 | observe assembly、relevance、actionability、`resultNextActions.ts` | Phase 1 | required-actionable golden labels；critical recall ≥99%；blocking recall=100%；expanded 找回不计成功 |
| R2 Compiler 重复低层语义 | Compiler 只组合 existing trusted primitives；precheck/relocation/hit-test 强制复用 Program Engine/actionability owner | `programEngine.ts`、`programOps.ts`、actionability model、stdlib prelude | Phase 2 | 禁止第二套 hit-test 的 governance test；precondition characterization |
| R3 Context identity 双轨 | Context 只引用 PageIdentity/target lineage，并消费同一次 `pageReanchorReason()` decision | SessionKernel、pageIdentity、snapshot/intent/operation registries | Phase 1–2 | ghost-state invariants；dispatch generation/identity consistency |
| R4 act 延迟/预算 | 单一 30s total deadline + §26.1 阶段 cap/reserve；outcome-first、post-view fail-open；v1 无 streaming | façade coordinator、`withBrowserOperation`、现有 transport timeout owner | Phase 2c | deadline 不重置；post-view failure 保留 outcome；fixture P95 目标 |
| R5 catalog v3/tool count | Preview 不改 v3 wire；GA 原子执行 19 → 22、version/hash/toolCount/daemon replacement/size ratchet checklist | commandCatalog、contract identity、REPO_GOVERNANCE | Phase 4b GA | catalog/main/doctor/daemon/package tests；≤25 KiB 默认保持 |
| R6 confirmation/consent | 扩展现有 consent coordinator/port/protocol，不另建 store；绑定 owner/context revision/PageIdentity/action digest，one-shot | BrowserBridgeConsentCoordinator 与 consent protocol owner | **Phase 2a blocking** | mismatch/expiry/consumed/privacy contract tests + live smoke |
| R7 evaluate escape hatch | 默认 SemanticAction/agent schema/candidates 禁用 evaluate；raw JS 只在 expert capability | expert `browser_execute` | Phase 2 profile contract | default evaluate coverage=0；raw-JS expert escalation <10% |
| R8 switch_target/navigate 分类 | Target selection 移到 `browser_view target.tabRef` 作为 context transition；navigate/history 是 writes | AgentContext transition、navigation operation owner | Phase 1 / 2d | 所有 façade operations 分类枚举；context transition 无伪 operation |
| R9 SDK/MCP package 爆炸 | Phase 1–3 只做 daemon/commands/existing CLI + §19.4 过渡 descriptor；官方 SDK/MCP 独立 epic | existing apps/package boundaries | Phase 4d | Phase 1–3 禁止新增 agent-sdk/agent-mcp package；benchmark 走 JSON invoke |
| R10 Skill 短但能力退化 | Skill ≤60 行是次级目标，只在任务成功率、recall、下钻率达标后验收 | benchmark + skill owner | Phase 4–5 | routine success ≥ baseline 且 GA ≥95%；expanded ≤10%；expert ≤5% |
| R11 误当产品默认 | §22.2 三通道；CLI expert-first；GA 需书面条件与可回退 | release/profile owner | 全程 | preview/opt-in/default 切换有记录；可 profile 回退 |
| R12 失败不可诊断 | §7.7 稳定 code + doctor 映射；trace fail-open | façade envelope + doctor | Phase 1+ | 主失败路径 contract tests |
| R13 无 fixture 导致 gate 不可 CI | Phase 0 golden fixture 仓库与标注规范 | tests/fixtures + bench-agent | Phase 0 | 主集无公网依赖 |
| Completion resolver 缺口 | `operationResolvers.ts` 新增 semantic registry；每个 **已发布** write kind exact resolver，generic mutation 不算 completed | command-specific completion owner | **Phase 2b blocking** | SemanticAction enum ↔ registry 双向 coverage；kind-specific evidence matrix |

上述 closure 是进入实现的约束，不再属于 spike 可自由改变的开放问题。若 spike 证明现有 canonical owner 无法提供某项 precondition/evidence，应先修改该 owner 的正式设计与治理，而不是在 façade 层绕过。

### 29.2 已由评审锁定的产品/工程参数

下列项在本次优化中从“开放问题”升为 v1 默认（仍可用数据微调数值，但不得回退决策方向）：

| 项目 | v1 锁定 |
|---|---|
| Profile 表达 | plugin 注册过滤权威；daemon/pairing 可覆盖；CLI `--profile` 显式；缺省人类 CLI = expert-first |
| 发布通道 | preview → opt-in → default；技术完成不自动 default |
| 过渡 transport | daemon JSON invoke + generated descriptor + examples；无新 package |
| Trace metadata | 有界内存 metadata + 大证据复用 artifact；fail-open |
| focus | 仅 per-call，不持久化为业务记忆 |
| transfer/security | 不进 façade v1 |
| post-action observe | 优先 pageEffect；证据不足且预算允许才 delta observe |
| Phase 2 拆分 | 2a consent → 2b resolver+activate/fill → 2c act/post-view → 2d navigate/history |
| select/drag/submit | 默认 M4；resolver 未就绪不进 agent schema |
| Agent schema 演进 | §7.8 additive-only within v1 |

### 29.3 仍由 Phase 0/bench 数据校准的数值

不影响安全与 ownership 决策，只校准阈值：

1. AgentView L0 candidate/char 上限是否继续 12 / 6,000（在 recall gate 下）。
2. Context idle/absolute TTL 与 128/16 context provisional bound。
3. §26.1 各阶段 cap 与 fixture P95 是否需要按真机数据收紧/放宽（不得取消 reserve-before-dispatch）。
4. Post-action 在不同 pageEffect completeness 下触发 delta observe 的精确阈值。
5. recovery max transitions / max bridge round trips 的最终 ratchet 数。

## 30. Definition of Done

Agent Interaction Plane v1 完成必须同时满足技术 DoD 与产品 DoD。二者缺一不可。

### 30.1 技术 DoD

#### Public surface

- agent profile 仅暴露 browser_view、browser_act、browser_read。
- Expert/security/admin profile 独立可用。
- 所有 schema closed 且有 machine discovery。
- §7.7 失败 code 稳定且有 contract tests。

#### Context

- Agent 只携带 contextRef。
- AgentContext 只引用现有 PageIdentity/target lineage；不维护第二套 identity equality/generation。
- Identity、baseline、candidate/read bindings 由现有 Session/daemon owner 协同管理，并共享 `pageReanchorReason()` decision。
- Owner isolation、TTL、bounds、revision、多客户端 全部有测试。
- Anchored/identity、binding/reanchor、dispatch generation 的 ghost-state invariants 全部成立。

#### View

- AgentViewV1 是 PageObservationV3 的确定性 bounded 投影。
- L0 沿用 canonical actionables/relevance order，不建立第二套 ranking。
- Blocking controls recall=100%，critical actionable recall 达标；routine 漏项不能靠 expanded/expert 算成功。
- Custom combobox、virtual list、shadow 与 iframe 边界按 §14.6 锁定，并以 typed blocked reason 暴露。
- Full canonical truth 可通过 trace/expert surface 获取。

#### Action

- activate/fill/press/scroll/navigate/history 可用（select/drag/submit 按 M4 可选）。
- 常规 golden tasks 不需要 JS。
- Compiler 只组合现有 trusted primitives，precheck/relocation/hit-test 复用 canonical owner。
- 每个 **已发布** semantic write kind 有 command-specific completion resolver；generic mutation 不算 completed。
- browser_act 使用单一 total deadline 与 §26.1 预算，包含 settlement，并以 outcome-first/fail-open 方式附带 post-action view。
- 需要 confirmation 的动作复用扩展后的 consent coordinator/protocol，且 one-shot binding 完整。
- completed 是唯一 success。

#### Recovery

- Happy path 无 readiness/schema/manual artifact orchestration。
- Re-anchor/unique replacement/read retry 自动化。
- mutation replay 始终为 0。
- 所有自动动作可通过 trace 审计。

#### Transport

- Agent 集成主路径为 structured invoke（§19.4 起，正式 SDK/MCP 可在后）。
- 临时 JS memory-only。
- 默认 agent profile/schema/candidates 不含 evaluate；raw JS 仅 expert escalation。
- CLI fallback 与 schema/validation 一致；人类 CLI 默认 expert-first。

#### Validation

- Pure/contract/integration/live smoke/capacity 全部通过。
- Task success、critical/blocking recall、expanded/expert/raw-JS escalation、时延预算等 gate 达标；Skill 行数不能替代这些 gate。
- 若选择 agent default GA：19 → 22 tool count、catalog contract version/hash、daemon identity replacement 与 size ratchet 同批通过。
- CODE_WIKI、REPO_GOVERNANCE、README、CHANGELOG、skill 已同步。
- 本提案已删除或归档，不继续作为第二规则源。

### 30.2 产品 DoD（里程碑验收句）

| 里程碑 | 必须为真 |
|---|---|
| M0 | 固定 fixture 上可重复测量 19-tool 认知成本与 L0 recall baseline |
| M1 | 未手写 connect/schema 的调用方，仅用 view/read 完成“打开已有页/列 tab/读摘要/读 content 窗口”；失败可用 §7.7 code + doctor 定位 |
| M2 | 同一调用方用 act 完成 activate 与 fill，得到真实 outcome 与下一决策 view；不传机械 ID、不写 JS、不显式 wait、不重放 mutation |
| M3 | 扩展短暂 reconnect、stale ref、document reanchor 在 happy path 无需 Agent 编排 readiness |
| M4 | 集成方可 opt-in/default 只注册 3 工具；人类 CLI 仍能 expert 下钻；能力边界有文档与 blocked reason |
| M5 | 对外文档与实现对齐；本文归档 |

**未读 skill 的 Agent 验收（GA 目标，M4 校准）：**

> 仅依赖 agent profile 的 3 工具 closed schema（无长 skill），在 fixture 常规任务上成功率不低于 Phase 0 expert baseline，且达到 §25.3 SLO；blocking recall=100%，mutation replay=0。

## 31. 建议的第一批实现切片

为了控制风险，第一批实现不应触碰 extension/CDP 语义。严格顺序：

### 31.1 通向 M1（只读）

1. Phase 0：fixture 仓库、标注规范、cognitive metrics、19-tool baseline。
2. 治理草案 PR：REPO_GOVERNANCE 预留 façade write root 例外（可先文档 draft，2c 前必须合入）。
3. Pure Agent types + context transition kernel + ghost-state tests。
4. Daemon-owned context port/service + owner isolation。
5. AgentView projector + budget/pin precedence tests。
6. browser_view + readiness ensure + §7.7 主失败码。
7. readRef binding + browser_read。
8. agent-preview profile + §19.4 descriptor/examples/JSON invoke 样例。
9. M1 产品验收演示与 bench 初跑。

### 31.2 通向 M2（write 核心）

10. **Phase 2a** action confirmation protocol/coordinator 扩展（blocking）。
11. **Phase 2b** semantic completion resolver registry + activate/fill compiler（只组合 Program Engine）。
12. **Phase 2c** browser_act + AgentTurn mapping + §26.1 deadline budget + outcome-first post-view。
13. press/scroll 与 matrix tests（可与 12 平行，但不阻塞 activate/fill 演示）。
14. **Phase 2d** navigate/history。
15. M2 产品验收演示；申请保持 preview，不自动 opt-in。

### 31.3 明确延后

- select/drag/submit（M4 / Phase 4a）。
- 官方 SDK/MCP package（Phase 4d）。
- agent default 切换（§22.6 全条件）。
- 人类 CLI 默认叙事改为 façade（另立 UX epic）。

M1 可交付句：

> Agent 仅用 browser_view/browser_read 获得 context、candidates 与窗口化内容；不传 tabId/pageEpoch/baseline/path。

M2 可交付句：

> Agent 再用 browser_act 完成一次 activate 或 fill，并在同一调用中得到真实 operation outcome 与下一决策 view；不编写 JavaScript，不显式 wait，不自动重放 mutation。

## 32. 文档落地

本提案获批后：

1. **M1 起**在 CODE_WIKI.md 增加 Agent Interaction Plane 草稿章节与模块 ownership；M5 定稿。
2. **Phase 2c 前**在 REPO_GOVERNANCE.md 合入 façade write root 例外、profiles、completed-only mapping、no-replay 和认知门禁草案。
3. 在 commandCatalog/profile owner 中建立唯一工具定义；preview 阶段 profile 只过滤 name set。
4. README：preview 阶段增加“Agent preview”小节，不删除现有 expert CLI 快速开始；GA default 后再把 Agent 主叙事改为 view→act→read。
5. skill：preview 提供短 façade 附录；GA 后主循环压缩，expert CLI 细节移入按需 reference。
6. 将本文中的暂定数值替换为测试锁定的实际 ratchet。
7. 维护 `examples/agent-preview/`（或等价）与 descriptor 生成物说明。
8. 删除或归档本文，避免架构信息重复。

## 33. 评审变更摘要（相对初稿）

本次优化闭合的主要缺口：

1. 产品定位、用户分层与开箱旅程（§3.3–3.4）。
2. 失败体验公共目录与 schema 演进规则（§7.7–7.8）。
3. 过渡期 structured transport（§19.4）与 ADR-H。
4. 强制发布通道、CLI expert-first、回滚原则（§22.2 / ADR-G）。
5. Phase/M 双轨、Phase 2a–2d 拆分、fixture 与容量测试（§23–24）。
6. 可执行时延预算与 telemetry（§26.1–26.2）。
7. 产品 DoD 与分里程碑验收句（§30.2 / §31）。
8. 将 profile 表达、trace 存储方向等从开放问题升为 v1 锁定（§29.2）。
