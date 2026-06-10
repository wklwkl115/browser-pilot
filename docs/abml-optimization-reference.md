# ABML 优化参考依据

> 本文档整合了学术界和工业界在浏览器 Agent 感知建模领域的关键成果，为 ABML 后续优化提供可直接落地的参考。所有内容已浓缩内化，无需查阅原始论文即可理解。

---

## 一、ABML 当前设计的行业定位

ABML 的核心设计——AX-authoritative（无障碍树为状态权威源）+ ARIA-grounded（仅基于 ARIA 语义分组）+ Pure core / Runtime split——已被行业验证为正确方向。2024-2026 年的主流浏览器 Agent 系统（Playwright MCP、Agent Browser、Browserbeam、Skyvern、OpenAI Operator）全部收敛到 accessibility tree 作为主要感知通道，token 消耗从原始 HTML 的 15,000+ 降至 200-400。

ABML 在此基础上走得更远：不是直接输出原始 accessibility tree，而是做了 DOM↔AX 合并、实体化、模板折叠、语义锚定、因果归因、意图推理六层处理。这使得 ABML 在 token 经济和语义深度上领先于当前所有开源方案。

**但领先不意味着没有可改进空间。** 以下按子系统逐一列出。

---

## 二、Ref 系统：引入版本化机制

### 当前状态

ABML 的 `pi-ref://` URI 通过 `stableHash24` 生成，基于语义锚或 locator 的确定性 hash。Ref 失效通过 TTL 过期（默认 5 分钟）和 `stale` 状态检测，但 Agent 只在下次 resolve 时才知道 ref 已失效。

### 业界发现

浏览器 Agent 的核心可靠性问题不是"ref 找不到"，而是"ref 静默漂移"——页面局部更新后，同一个 ref 指向的 DOM 节点可能已经变成了不同的元素，但 hash 没变（因为 locator/css selector 没变），Agent 以为还在操作同一个东西。

### 具体改进方案

**Ref 版本号（Ref Versioning）：**

```
// 当前
RefDescriptor { refId: "pi-ref://control/a1b2c3d4", ... }

// 改进：增加 documentVersion
RefDescriptor {
  refId: "pi-ref://control/a1b2c3d4",
  documentVersion: "v3",  // 每次 DOM mutation epoch 递增
  ...
}
```

工作方式：
1. 每次 `DocumentEpoch.mutationEpoch` 递增时，所有活跃 ref 的 `documentVersion` 同步更新
2. Agent 发起 action 时携带 `documentVersion`，Server 端比对当前版本
3. 版本不匹配 → 返回 `REF_STALE` + 当前最新 snapshot，而非让 action 执行在错误目标上
4. 这比纯 TTL 更精确——TTL 是时间维度的过期，版本号是结构维度的过期

**实现成本：** 低。`DocumentEpoch` 已有 `mutationEpoch` 字段，只需在 resolve 链路中增加版本比对步骤。

---

## 三、PerceptionLedger：从扁平帧序列到层级记忆

### 当前状态

`PerceptionLedger` 存储最多 8 帧（`MAX_FRAMES_PER_SESSION_TAB`），每帧包含完整的实体列表、关系图、因果摘要。帧之间通过 `session-delta` 做增量，但整体结构是扁平的时间序列。

### 业界发现

层级记忆树（Hierarchical Memory Tree, HMT）研究表明，扁平记忆的核心问题是"逻辑规划与站点特定执行细节纠缠"——Agent 在新页面上检索历史记忆时，会把旧站点的具体操作细节（如"点击 class=btn-primary 的按钮"）误用到新站点，导致逻辑正确但执行错误。

HMT 提出三层解耦：

| 层级 | 职责 | 存储内容 |
|------|------|---------|
| Intent | 标准化任务目标 | "登录"、"搜索商品"、"提交表单" |
| Stage | 语义子目标 + 前置/后置条件 | "定位搜索框" → pre: 搜索框可见, post: 搜索框获得焦点 |
| Action | 动作模式 + 可迁移语义描述 | "点击 role=searchbox 的元素"（非 "点击 #search-input"） |

### 具体改进方案

**在 PerceptionLedger 中引入 Stage 层：**

```
// 当前 Ledger 结构（简化）
PerceptionLedger {
  frames: [
    { entities, relations, causal, observationId, ... },  // frame 0
    { entities, relations, causal, observationId, ... },  // frame 1 (delta)
    ...
  ]
}

// 改进：增加 stage 追踪
PerceptionLedger {
  frames: [...],  // 保持不变
  stages: [
    {
      name: "locate-search",
      preConditions:  [{ predicate: "exists", role: "searchbox", state: { visible: true } }],
      postConditions: [{ predicate: "focused", role: "searchbox" }],
      entryFrame: 0,
      exitFrame: 1,
      status: "completed" | "in-progress" | "failed"
    },
    ...
  ],
  currentStage: "type-query"
}
```

Stage 的价值：
1. **长任务恢复**：Agent 中断后可以从 `currentStage` 恢复，而非从头开始
2. **跨站迁移**：Stage 描述的是语义子目标（"定位搜索框"），不包含站点特定细节，可直接迁移到新站点
3. **错误归因**：action 失败时，可以判断是"当前 stage 的 pre-condition 不满足"还是"action 执行错误"，给出更精确的恢复建议

**实现成本：** 中。需要定义 Stage schema + pre/post condition 评估器 + 与 observeRunners 的集成点。可以先从 `inference.ts` 的 `DetectedIntent` 自动推导 Stage，再逐步支持手动定义。

---

## 四、Intent 检测：从一次性结果到可检索知识

### 当前状态

`inference.ts` 的 12 个 intent 检测器（login/search/filter-panel/single-choice/multi-choice/expandable/data-grid/navigation/dialog/tabbed-interface/alert-region/form-dependency）在每次 observe 时运行，结果随 envelope 输出，不持久化、不跨 session 复用。

### 业界发现

HMT 的 Intent 层将任务目标标准化为可检索实体——Agent 遇到新任务时，先检索历史 Intent 匹配，找到对应的 Stage 链直接复用，无需重新规划。这比从零推理快 3-5 倍（HMT 论文数据）。

### 具体改进方案

**Intent 知识库（Intent Knowledge Base）：**

```
// 检测结果持久化
IntentKnowledgeBase {
  // 按 (intent, site-pattern) 索引
  entries: Map<string, {
    intent: "login",
    sitePattern: "*.example.com",      // URL pattern
    stages: ["locate-form", "fill-credentials", "submit"],  // 对应的 Stage 链
    lastVerified: timestamp,
    successRate: 0.85,
    sampleEntities: { submitRef: "pi-ref://control/...", }  // 典型实体引用
  }>
}
```

使用方式：
1. Agent 首次遇到 login intent → 正常推理 + 执行
2. 执行成功后，将 intent + stage 链 + 站点模式存入知识库
3. 下次遇到同站点/同类站点的 login intent → 检索知识库，直接复用 stage 链
4. 如果复用失败 → 回退到正常推理，并更新知识库的 successRate

**实现成本：** 中低。核心是一个持久化的 Map + 检索逻辑。可以先做 session 内复用，再扩展到跨 session。

---

## 五、Entity 类型：拆分 hints 开放结构

### 当前状态

`Entity.hints` 是 `Record<string, unknown>`，承载了 14+ 个语义不同的字段：

| 字段 | 语义类别 | 示例 |
|------|---------|------|
| `jsonPath` | 扫描元数据 | `data.actionables[3]` |
| `selector` | 扫描元数据 | `#login-btn` |
| `listContainer` | 分组信号 | `true` |
| `hiddenCount` | 分组信号 | `5` |
| `controlsSelectors` | 关系线索 | `["#panel-1"]` |
| `ownsSelectors` | 关系线索 | `["#item-1"]` |
| `expandedTargetSelectors` | 关系线索 | `["#dropdown"]` |
| `occluderSelector` | 遮挡线索 | `[".modal-overlay"]` |
| `inputKind` | 语义分类 | `"password"` |
| `controlsSourceOnly` | 运行时标记 | `true` |
| `referencedTarget` | 运行时标记 | `true` |
| `visualFloor` | 运行时标记 | `true` |
| `canvasRegion` | 运行时标记 | `true` |
| `handlers` | 扫描元数据 | `["click"]` |

### 具体改进方案

将 `hints` 拆分为三个有类型的子结构：

```typescript
type Entity = {
  ref: string;
  kind: EntityKind;
  role: string;
  name?: string;
  value?: string;
  state: EntityState;
  structure?: EntityStructure;
  relations?: EntityRelation[];
  source: EntitySource;
  locators?: Locator[];
  geometry?: RefGeometry;
  stream?: StreamInfo;
  children?: Entity[] | { handle: string; count: number };

  // 替代 hints
  scanMeta?: {
    jsonPath?: string;
    selector?: string;
    handlers?: string[];
  };
  relationHints?: {
    controlsSelectors?: string[];
    ownsSelectors?: string[];
    expandedTargetSelectors?: string[];
    occluderSelector?: string[];
  };
  runtimeFlags?: {
    controlsSourceOnly?: boolean;
    referencedTarget?: boolean;
    visualFloor?: boolean;
    canvasRegion?: boolean;
    listContainer?: boolean;
    hiddenCount?: number;
    inputKind?: string;
  };
};
```

收益：
1. **类型安全**：拼写错误在编译期捕获
2. **文档化**：每个子结构的语义自明
3. **序列化优化**：`runtimeFlags` 在 distill 输出时可以整体省略（Agent 不需要知道 `controlsSourceOnly`）

**实现成本：** 中。需要修改 `buildDomEntityFromScanActionable` 等 builder 函数 + 所有 `entity.hints?.xxx` 的消费方。但这是纯重构，行为不变。

---

## 六、EntityChange：扩展变更检测粒度

### 当前状态

`diffEntities` 检测三种变更：`appeared`/`disappeared`/`changed`，其中 `changed` 细分为 `state-changed`/`name-changed`/`value-changed`。

### 业界发现

DOM 变更检测工具（dom-agent）的逐字段比较方法表明，精确报告"哪个属性发散"对 Agent 的恢复决策至关重要。当前 ABML 的 `state-changed` 只报告 state 对象的 delta，不检测结构属性变化。

### 具体改进方案

扩展 `EntityChangeKind`：

```typescript
type EntityChangeKind =
  | "appeared"
  | "disappeared"
  | "state-changed"
  | "name-changed"
  | "value-changed"
  // 新增
  | "role-changed"        // role 从 "button" 变为 "link"（罕见但影响 actionability）
  | "kind-changed"        // kind 从 "element" 变为 "control"（影响 ref policy）
  | "structure-changed"   // EntityStructure 变化（level/setSize/posInSet/landmark）
  | "geometry-changed"    // 位置/尺寸变化（不影响功能但影响可见性判断）
  | "relation-changed";   // 关系图变化（新增/丢失 labelledBy/controls 等）
```

优先级：`role-changed` > `kind-changed` > `structure-changed` > `relation-changed` > `geometry-changed`。前两者直接影响 actionability 判断，必须检测；后三者可以按 budget 决定是否输出。

**实现成本：** 低。`diffEntities` 函数已有 before/after 实体对，只需增加字段比较逻辑。

---

## 七、Salience Renderer：增加 ASCII Wireframe 输出模式

### 当前状态

ABML 的 salience renderer 输出结构化文本（实体列表 + 模板摘要 + 因果摘要），对"页面上有什么"表达清晰，但对"东西在哪里"表达不足。

### 业界发现

Agent Browser 的 ASCII wireframe 模式在空间布局敏感任务上表现优异。例如"点击右上角的关闭按钮"——纯文本输出需要 Agent 从 geometry 推断位置，而 wireframe 直接展示空间关系：

```
┌─────────────────────────────────────┐
│ [nav]  Logo   Search___   [e1:btn]  │
│                                     │
│ ┌─ main ──────────────────────────┐ │
│ │ [e2:heading] Product List       │ │
│ │ [e3:card] Item A    $9.99  [e4] │ │
│ │ [e5:card] Item B    $14.99 [e6] │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [footer]  About  Contact  Terms     │
└─────────────────────────────────────┘
```

### 具体改进方案

在 `distill-core/` 中增加 `wireframeRenderer`，作为 ladder/salience 之外的第三条渲染路径：

1. 将页面按 `geometry.box` 划分为 9 宫格（top-left/center/right, mid-left/center/right, bottom-left/center/right）
2. 每个格子内的实体按 y 坐标排序，用 `[ref:role]` 标记
3. 容器实体（region/landmark）用 `┌─ name ─┐` 框表示
4. 总 token 控制在 salience renderer 的 1.2 倍以内

触发条件：环境变量 `PI_BROWSER_RENDERER=wireframe` 或 observe 参数 `format: "wireframe"`。

**实现成本：** 中。核心算法是 2D bin-packing 的简化版，约 200-300 行纯计算代码，符合 `distill-core/` 的纯约束。

---

## 八、页面级语义就绪度评分

### 当前状态

ABML 有实体级 `stabilityScore`（0-1，基于 hit-test 结果），但没有页面级的语义质量评估。

### 业界发现

RNS（Role-Name-State）模型提出，页面语义质量可以从三个维度量化：
1. **Role 覆盖率**：交互元素中有明确 ARIA role 的比例
2. **Name 覆盖率**：交互元素中有可访问名称的比例
3. **State 完整性**：应该有状态的元素（checkbox/radio/expandable）是否暴露了状态

### 具体改进方案

在 observe envelope 中增加 `semanticReadiness` 字段：

```typescript
type SemanticReadiness = {
  roleCoverage: number;    // 0-1, 有明确 role 的交互元素占比
  nameCoverage: number;    // 0-1, 有 accessible name 的交互元素占比
  stateCompleteness: number; // 0-1, 应有状态的元素中状态已暴露的占比
  overallScore: number;    // 加权平均
  warnings: Array<{
    kind: "missing-role" | "missing-name" | "missing-state";
    ref: string;
    detail: string;
  }>;
};
```

Agent 使用方式：
1. `overallScore < 0.5` → 页面语义质量差，建议降级到视觉模式
2. `nameCoverage < 0.3` → 大量元素无名称，`textAnchor` locator 不可靠，优先用 `css` locator
3. `warnings` → 精确告知哪些元素语义缺失，Agent 可以在 action 前做额外验证

**实现成本：** 低。数据在 observe 时已经全部可用，只需增加一个计算函数。

---

## 九、安全：Agent 行为风险评估

### 当前状态

ABML 的安全措施集中在数据脱敏（`redaction.ts`）和隐私策略（`refPolicy.ts`），但不评估 Agent 请求本身的风险级别。

### 业界发现

SafeArena 的 ARIA（Agent Risk Assessment）框架将 Agent 行为分为四级：
- ARIA-1：立即拒绝有害请求
- ARIA-2：尝试后拒绝
- ARIA-3：尝试但未完成
- ARIA-4：成功完成有害操作

评估发现 GPT-4 完成了 34.7% 的有害请求，说明当前 LLM 的安全对齐在 Web 任务上效果很差。

### 具体改进方案

在 `browser_execute` 和 action tools 的入口增加轻量级风险评估：

```typescript
type ActionRiskLevel = "safe" | "caution" | "dangerous";

function assessActionRisk(action: {
  verb: string;
  target?: RefDescriptor;
  text?: string;
}): ActionRiskLevel {
  // 1. 目标风险：操作密码框/支付按钮/删除按钮 → caution
  // 2. 输入风险：输入包含敏感模式（信用卡号/SSN/密码）→ dangerous
  // 3. 批量风险：短时间内对同一页面执行 >5 次相同操作 → caution
  // 4. 导航风险：导航到非 HTTPS/已知钓鱼域名 → dangerous
}
```

`dangerous` 级别的操作需要 Agent 显式确认（通过 `confirm_risk: true` 参数），否则返回 `PRIVACY_BLOCKED` 错误。

**实现成本：** 低。规则数量有限，纯函数实现，符合 `abml-core/` 的纯约束。

---

## 十、ax.ts 拆分建议

### 当前状态

`ax.ts` 是 ABML 最大的单文件，承担了 AX 节点解析、DOM↔AX 匹配、状态融合、结构融合、关系提取、容器成员推断六个职责。

### 具体改进方案

拆分为四个模块：

| 模块 | 职责 | 大致行数 |
|------|------|---------|
| `axParse.ts` | AX 节点解析 + 属性提取 + 角色分类 | ~150 |
| `axMatch.ts` | DOM↔AX 匹配（box IoU + role/name 评分） | ~200 |
| `axFuse.ts` | 状态融合 + 结构融合 + 关系提取 | ~250 |
| `axGroup.ts` | 容器成员推断 + AX-sourced grouping | ~150 |

依赖方向：`axParse` ← `axMatch` ← `axFuse` ← `axGroup`，单向无环。

`ax.ts` 保留为 re-export barrel，不破坏外部 import 路径。

**实现成本：** 低。纯文件拆分，无逻辑变更。

---

## 十一、工具函数去重

### 当前状态

`stringValue`/`numberValue`/`topLevelOrigin` 在 `entity.ts`、`ax.ts`、`stream.ts`、`causal.ts` 中各有一份几乎相同的实现。

### 具体改进方案

在 `abml-core/` 内增加 `internal/primitives.ts`：

```typescript
// abml-core/internal/primitives.ts
// 不导出到 index.ts，仅供 abml-core 内部使用

export function stringValue(value: unknown): string | undefined { ... }
export function numberValue(value: unknown): number | undefined { ... }
export function boolValue(value: unknown): boolean | undefined { ... }
export function topLevelOrigin(url: string | undefined): string | undefined { ... }
```

注意：这些函数不能放到 `utils/`（那是跨模块共享层，会违反 abml-core 的边界约束），必须放在 `abml-core/internal/` 下，且不通过 `index.ts` 导出。

**实现成本：** 极低。纯重构，行为不变。

---

## 十二、评估基准对接

### 当前状态

ABML 有自建的 eval 框架（27 个场景 + blind agent），但缺少与行业标准基准的横向对比。

### 建议对接的基准

| 基准 | 任务数 | 对接价值 | 对接方式 |
|------|--------|---------|---------|
| WebArena | 812 | 验证 observe→act 循环在真实网站上的成功率 | 用 ABML 的 observe + action tools 替换 WebArena agent 的感知层，对比成功率 |
| VisualWebArena | 910 | 验证 visualFloor 降级策略的效果 | 在视觉必需任务上对比"纯 AX"vs"AX + 视觉降级"的成功率 |
| WebGames | ~50 | 验证精细交互（拖拽/悬停/组合键） | WebGames 是浏览器小游戏集合，对 actionability 和 verification 要求极高 |

**优先级：** WebArena > WebGames > VisualWebArena。WebArena 的任务最通用，对接成本最低（已有 Docker 镜像 + 标准化评估脚本）。

---

## 十三、优化路线图建议

按投入产出比排序：

| 优先级 | 改进项 | 预期收益 | 实现成本 |
|--------|--------|---------|---------|
| P0 | Ref 版本化 | 消除静默漂移，提升 action 可靠性 | 低 |
| P0 | EntityChange 扩展 | 更精确的变更归因，改善恢复决策 | 低 |
| P0 | 工具函数去重 | 消除维护负担和漂移风险 | 极低 |
| P1 | 页面级语义就绪度评分 | Agent 可自适应选择感知策略 | 低 |
| P1 | ax.ts 拆分 | 降低单文件认知负担 | 低 |
| P1 | Entity.hints 拆分 | 类型安全 + 序列化优化 | 中 |
| P2 | PerceptionLedger Stage 层 | 长任务恢复 + 跨站迁移 | 中 |
| P2 | ASCII Wireframe 渲染器 | 空间布局敏感任务提升 | 中 |
| P2 | Intent 知识库 | 跨 session 复用，减少重复推理 | 中低 |
| P3 | Action 风险评估 | 安全防护增强 | 低 |
| P3 | WebArena 基准对接 | 标准化横向对比 | 中 |
