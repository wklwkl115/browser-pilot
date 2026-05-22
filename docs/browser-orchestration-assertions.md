# Browser Orchestration Session Assertions / Readiness Checks 设计冻结

本文冻结 TODO235 的设计边界，并记录 TODO236 的 runtime 落地。当前状态：**设计与 runtime 已完成**。`browser_orchestrate` 现已支持 `sessionAssertions` readiness checks；`readinessChecks` 仍只保留为描述性术语，不作为第二个 schema alias。

## 1. 目标

- 为 `browser_orchestrate` 增加一层**只读的、声明式的业务就绪断言**。
- 让智能体能声明“这个浏览器会话现在应满足哪些可观测条件”，而不是把点击、输入、登录步骤塞进 orchestration。
- 保持 `browser_orchestrate` 的职责仍是**浏览器会话状态协调/对账**，不是站点工作流 DSL（workflow DSL）。

## 2. 非目标

以下能力**不进入** assertions 设计：

- 点击步骤
- 表单填写
- 账号口令输入
- 站点专用脚本
- 任意 `script` / `code` / `source`
- 登录、下单、发消息等业务流程执行
- “失败后自动再点一次/再输一次”的黑盒动作恢复

这些仍属于 `browser_execute` / `browser_scan` / `browser_wait` 的命令式工作流层。

## 3. 命名冻结

- **对外概念名**：`sessionAssertions / readinessChecks`
- **canonical desired field**：`sessionAssertions`
- `readinessChecks` 是文档与摘要中的描述性术语，**不是第二个 schema alias**。

这样避免 future runtime 同时维护两个输入字段。

## 4. 设计边界

### 4.1 断言层是只读验收层

断言层只参与：

- `apply` 之后的验收
- `status` 的当前状态判断
- `watch` 的持续检查
- `self-heal` 的可恢复性判断
- summary / artifact / diagnostics 输出

断言层**不创建新的动作入口**；它不直接触发点击、输入、站点脚本执行。

### 4.2 断言层不改变现有 phase 职责

现有 orchestration phase 继续只负责浏览器资源协调：

- tab / window / profile
- navigation / loadState
- cookie
- network recorder
- hook dispatcher
- pre-navigation hook
- persistence / adoption / cleanup

断言层只复用这些 phase 的结果做验收；不得把断言失败升级成新的流程执行器。

## 5. `desiredState` 草案

TODO236 的 runtime 只允许引入一个 canonical 字段：

```ts
type BrowserDesiredSession = {
  tag: string;
  tabs?: BrowserDesiredTab[];
  cookies?: BrowserDesiredCookie[];
  networkRecorder?: boolean | BrowserDesiredNetworkRecorder;
  hookDispatcher?: boolean | BrowserDesiredHook;
  sessionAssertions?: BrowserDesiredAssertionSet;
};

type BrowserDesiredAssertionSet = {
  mode?: "all" | "any";
  checks: BrowserDesiredAssertion[];
};
```

约束：

- `sessionAssertions` 只允许出现在 session scope。
- `checks` 必须非空。
- `mode` 默认 `all`。
- 每个断言必须有稳定 `id`。
- 每个断言可选 `tabRole`，默认该 session 的 `main` tab。
- runtime 已实现后，继续只暴露 canonical 字段 `sessionAssertions`；不得再引入 `readinessChecks` alias。

## 6. 允许的断言类型

只允许**可观测事实**：

- `url`
- `origin`
- `loadState`
- `cookie`
- `storage`
- `selector`
- `text`
- `attribute`
- `hook`
- `networkRecorder`
- `profile`

推荐草案：

```ts
type BrowserDesiredAssertion =
  | { id: string; kind: "url"; tabRole?: string; equals?: string; includes?: string }
  | { id: string; kind: "origin"; tabRole?: string; equals: string }
  | { id: string; kind: "loadState"; tabRole?: string; state: "domcontentloaded" | "complete" | "networkIdle" }
  | { id: string; kind: "cookie"; tabRole?: string; name: string; present?: boolean; valueHash?: string }
  | { id: string; kind: "storage"; tabRole?: string; storageArea: "localStorage" | "sessionStorage"; key: string; present?: boolean; valueHash?: string }
  | { id: string; kind: "selector"; tabRole?: string; selector: string; present: boolean }
  | { id: string; kind: "text"; tabRole?: string; selector?: string; includes?: string; equalsHash?: string }
  | { id: string; kind: "attribute"; tabRole?: string; selector: string; name: string; equals?: string; equalsHash?: string; present?: boolean }
  | { id: string; kind: "hook"; tabRole?: string; sessionId?: string; state?: "INSTALLED" }
  | { id: string; kind: "networkRecorder"; tabRole?: string; sessionId?: string; state?: "running" }
  | { id: string; kind: "profile"; profileId?: string; present: boolean };
```

说明：

- `cookie` / `storage` 默认只做存在性或 hash 比对，不在持久化状态里保留 raw value。
- `text` / `attribute` 允许 public literal，但持久化与 artifact 默认只保留 redacted/hash 形式。
- `selector` / `text` / `attribute` / `storage` 使用内部生成的**只读 probe**；不接受用户自带脚本。
- `hook` / `networkRecorder` / `profile` 直接复用 orchestration actual state 与 native status。

## 7. 观测来源冻结

每类断言只能使用受控观测面：

- `url` / `origin` / `loadState`：`ActualStateCollector` 现有 navigation 观测
- `cookie`：cookies primitive
- `hook` / `networkRecorder` / `profile`：现有 orchestration actual state
- `selector` / `text` / `attribute` / `storage`：受控的只读页面 probe

禁止：

- 从 Desired 中反序列化脚本后执行
- 为断言层开放任意 `browser_execute` 透传
- 因断言层新增未受控的 CDP command surface

## 8. Apply / Status / Watch 语义

### 8.1 `plan`

- 只校验断言定义是否合法。
- 可在计划摘要中上浮断言数量、按 kind 分组。
- 不执行断言 probe。

### 8.2 `apply`

- 先完成浏览器资源协调。
- 再执行 assertions verify。
- `apply` 的失败需区分：
  - 浏览器资源协调失败
  - 资源已协调，但断言未满足

断言失败**不允许**自动触发点击、输入、表单提交。

### 8.3 `status`

- 输出当前断言满足/不满足/探测失败状态。
- 必须能区分“断言未满足”和“断言无法探测”。

### 8.4 `watch`

- 持续复查断言。
- 只有 resource-backed 断言才允许进入现有 self-heal：
  - `url`
  - `origin`
  - `loadState`
  - `cookie`
  - `hook`
  - `networkRecorder`
  - `profile`

以下断言默认只产生 diagnostics，不驱动业务动作：

- `selector`
- `text`
- `attribute`
- `storage`

即：watch 可以报告“看起来已掉登录态/页面未准备好”，但不能替智能体点击“重新登录”。

## 9. 失败 envelope 草案

TODO236 runtime 建议引入结构化断言失败：

- `ORCHESTRATION_ASSERTION_INVALID`
- `ORCHESTRATION_ASSERTION_FAILED`
- `ORCHESTRATION_ASSERTION_PROBE_FAILED`

最小失败结构：

```ts
type BrowserOrchestrationAssertionFailure = {
  code: string;
  assertionId: string;
  kind: string;
  tabRole?: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};
```

约束：

- `details` 不得泄漏 cookie raw value、storage raw value、token、password、authorization。
- 必须能表达“资源已协调，但断言未满足”。
- 不做 broad catch/continue；probe 失败与断言失败要分开。

## 10. Summary / Artifact / Persistence / Redaction

### 10.1 Summary

summary 只上浮：

- assertion count
- by-kind count
- passed / failed / probeFailed count
- top failures（截断）

不在 summary 暴露 raw cookie/storage/text secret。

### 10.2 Artifact

artifact 可保存：

- assertion ids
- kinds
- target tabRole
- pass/fail/probeFailed 状态
- redacted diagnostics
- public selector strings

artifact 不可保存：

- 原始 cookie value
- 原始 storage value
- password / token / authorization
- 任意脚本源码
- 点击序列或 workflow step

### 10.3 Persistence

`PersistentOrchestrationStore` 只允许保存：

- assertion metadata
- 断言结果摘要
- hash/redacted operand

不得保存：

- raw secrets
- raw probe text bodies
- raw script/code/source

## 11. 与现有工具的边界

- `browser_orchestrate`：声明式浏览器会话状态协调 + 断言验收
- `browser_execute`：站点动作执行
- `browser_scan` / `browser_html` / `browser_content`：结构/文本观察
- `browser_wait`：等待条件
- `browser_network` / `browser_hook` / `browser_evidence`：证据采集

如果任务是“去完成登录流程”，仍应使用 `browser_execute` / `browser_wait`。
如果任务是“确认当前会话已经满足登录态断言”，才属于 `sessionAssertions`。

## 12. 验收与静态契约

TODO235 / TODO236 / TODO237 当前 gate：

- 设计文档与 runtime 边界同步
- `check:orchestration-assertions-design` 锁定 canonical 字段、design/runtime 文案、README/roadmap/coordinator/TODO/CHANGELOG 一致性
- `check:orchestration` 锁定 apply/status/watch 的 satisfied / unsatisfied assertion fixture
- `check:summaries` 锁定 orchestration summary 的 assertion counters
- `smoke:browser:isolated` 锁定真实浏览器登录态存在/不存在、pre-navigation/hook effect、logical target 与 redacted artifact 证据面
- 必要时 `release:local:smoke` 上浮 assertions diagnostics 到发布验收摘要
- `npm run check` 纳入静态/fixture gate

建议命令：

```bash
npm run check:orchestration-assertions-design
npm run check:orchestration
npm run check:summaries
npm run smoke:browser:isolated
npm run release:local:smoke
npm run check
```
