# MCP 标准化 + 渐进式披露执行合同

状态：计划冻结，待实现。本文是正式 source of truth；`.plan/mcp-standardization-progressive-disclosure.md` 仅保留为评审输入指针，不再作为执行源。

目标：把当前最小 MCP stdio 适配升级为标准 MCP server，同时在不新增公开 `browser_*` 工具、不回退参数契约、不把工具合并成 dispatcher 的前提下，落地结果侧 layered delivery 与输入侧 typed handle resolution。

## 0. 已修正的评审结论

1. **不迁移 TypeBox 顶层参数契约到 Zod。** 现有项目边界仍是 TypeBox 顶层 tool params + Zod 复杂嵌套对象。MCP 入口必须消费同一份 TypeBox JSON Schema 并执行等价校验；不得为了使用 SDK 高层 `McpServer.registerTool` 把顶层 schema 改写为 Zod。
2. **MCP 参数校验必须前置。** 当前 `mcp/index.ts` 直接 `def.execute(args)`，会绕过 Pi 框架的 TypeBox `Value.Convert + Check` 行为。正式实施第一步必须补 MCP 等价校验与 contract。
3. **outputSchema 不从 TypeScript 返回类型“派生”。** 当前 distiller 返回 `Record<string, unknown>`，运行时无法从 TS 类型生成 JSON Schema。正式方案改为显式 `DistillerDefinition { summarySchema, distill }` 或等价 schema registry；schema 与 distiller 同处注册，CI 做 conformance。
4. **typed handle 先定义 store，再接 resources/ingress。** `browser-result://...` 必须映射到 opaque session resource store，不能直接暴露本地绝对路径；store 记录 `id/kind/artifactPath/section/hash/etag/createdAt/ttl/sessionId/redaction`。
5. **`browser_artifact` 只允许 MCP 路 capability-gated 退役。** Pi 路永久保留；MCP 路也必须在无 resources 能力或降级客户端下保留。
6. **阶段边界重排。** 先校验与 conformance，再 schema spike，再 structured output，再 resources/handles，最后才做 ingress 与可选退役；不得 Phase 0 同时抽 HostPort、全量 outputSchema、resources 与 handle。

## 1. 当前代码事实

- `mcp/index.ts` 当前使用低层 `Server` + `ListToolsRequestSchema` / `CallToolRequestSchema`，capabilities 只有 `{ tools: {} }`。
- `tools/list` 透传 TypeBox 生成的 JSON Schema；这是要保留的顶层参数单源。
- `tools/call` 当前直接调用 `def.execute(toolCallId, args ?? {}, undefined, undefined, undefined)`；这里必须补 MCP 等价参数校验、progress 映射与 ctx 边界。
- `mcp/adapter.ts` 只收集 ExtensionAPI tool definitions；`onUpdate` / command / lifecycle 均未映射。
- `resultMiddleware.ts` 仍生成 Pi 形态 `PiTextToolResult` envelope，且 `nextActions` 硬编码 `browser_artifact ...` 文案。
- `distillerRegistry.ts` 当前 distiller 类型为 `(value, command?) => Record<string, unknown>`，没有 schema。
- `artifactReader.ts` 是 path/root based reader；不是 `browser-result://id/section` resource store。
- `package.json` 已有 `bin.pi-browser-mcp`，但 `exports` 只暴露 package root，尚未暴露 MCP server library entry。

## 2. 不变边界

- 不新增公开 `browser_*` 工具。
- 不把多个工具合并成 dispatcher / orchestrator / strategy router。
- 不让 ingress middleware 串联多工具、选择目标、选择攻击策略或自动升级风险。
- 不把 annotations、resources 或 typed handle 当安全边界；安全仍靠工具自身 guard、scope、`allowPrivateTargets` 等现有约束。
- 不移除 Pi adapter，不破坏 Pi-native result envelope 与 `browser_artifact` 工具。
- 不引入第三方 MCP framework。可借鉴 FastMCP hook 命名，但实现使用现有 SDK/本地 adapter。
- 不通过隐藏 fallback 吞错；所有降级、解析、资源命中、kind mismatch、etag mismatch 都必须有 diagnostics。

## 3. 目标架构

### 3.1 MCP adapter 层

职责：协议适配，不承载 agent 决策。

- 暴露标准 `tools/list`、`tools/call`、progress/logging、resources、completion。
- 保留 TypeBox input schema；在 `tools/call` 执行前运行与 Pi 框架等价的 TypeBox validation/conversion。
- 将 tool result presentation 分为 MCP 形态：`structuredContent` + compatible text + optional `resource_link`。
- 仅在支持 resources 的客户端上提供 resource URI；无 resources 时回退现有 saved artifact path + `browser_artifact` 指引。

### 3.2 Core result boundary

新增或演进为纯数据结构，不含 Pi/MCP 序列化逻辑：

```ts
type DistillerDefinition = {
  toolName: string;
  commandMatcher?: (command: string) => boolean;
  summarySchema: JsonSchema;
  distill: (value: unknown, context: DistillContext) => Record<string, unknown>;
};

type DistilledResult = {
  envelopeSchemaVersion: 1;
  tool: string;
  command?: string;
  structured: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  target?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
  sections?: Array<{ name: string; kind: ResourceKind; handle?: string; count?: number }>;
  raw?: unknown;
  saved?: Record<string, unknown>;
};
```

`summarySchema` 是单源；`structured` 必须通过 schema 校验。动态表格只允许在明确开放的 `samples` / `rows` 容器内 loose，核心计数、状态、diagnostics、handles、limits 必须强校验。

### 3.3 Resource / handle store

`browser-result://{id}[/{section}]?offset=&limit=&jsonPath=&search=` 是唯一 MCP 结果句柄命名空间。

store 记录：

```ts
type BrowserResultResource = {
  id: string;
  kind: "raw-result" | "summary-section" | "http-request" | "network-entry" | "scan" | "evidence" | "artifact-slice";
  artifactPath: string;
  section?: string;
  jsonPath?: string;
  mime?: string;
  bytes?: number;
  hash: string;
  etag: string;
  immutable: boolean;
  createdAt: string;
  expiresAt?: string;
  browserSessionId?: string;
  redaction: "default" | "disabled";
};
```

MCP 返回 URI，不返回本地绝对路径；本地 path 只保留在 server diagnostics / Pi path / artifact backend。`resources/read` 复用 `artifactReader` 的分页、jsonPath、search、sample 与脱敏能力，但入口参数是 resource URI。

### 3.4 Typed ingress handle

仅在参数 schema 显式声明可接受 handle 的字段启用，例如 `request` 可接受 `HttpRequestObject | BrowserResultHandleString`。解析流程：

1. 原始 args 先做 TypeBox 校验，确认 handle 只出现在允许字段。
2. `resolveHandle(handle, { expectKind })` 读取 store，校验 kind/etag/ttl/session/redaction。
3. 展开为 typed payload。
4. 对展开后的 args 再走同一 TypeBox / Zod 嵌套校验。
5. 在结果 diagnostics 回显 `{ handle, kind, etag, size, createdAt, resolved: true }`，不回显敏感 payload。

禁止通过 handle 解析绕过校验；禁止根据 handle 自动选择下一工具或目标。

## 4. MCP capability 与降级

- `initialize` 后记录 client capabilities。
- `structuredContent` 始终配 compatible text。
- 无 resources：不发 `resource_link`，保留 saved artifact path 与 MCP/Pi 可用的 `browser_artifact` 指引。
- 无 resources.subscribe：实时资源只支持 read/poll，不能声明 subscribe。
- 无工具 deferral：继续依赖 `PI_BROWSER_TOOL_PROFILE` 粗门控 + concise description + annotations；server-side dynamic tool list 只作为后续 stretch。
- `tools.listChanged` / `resources.listChanged` 只在确实会动态改变列表时声明并触发；不能只为“标准化”虚报 capability。

## 5. 分阶段执行

### Phase -1：合同冻结与基线采集

范围：文档与测量，不改 runtime。

交付：
- 本文成为正式执行合同；`.plan` 改为指针。
- 记录当前 MCP 行为基线：tool count、capabilities、sample call result shape、参数校验缺口、token median/p90 基线。
- 选定 3 类代表性 fixtures：simple summary、dynamic table、large/sensitive artifact。

验证：
- `npm run check:doc-structure`
- `git diff --check`

### Phase 0：MCP 参数契约与 conformance 地基

范围：只补 MCP 入口可靠性，不改 result shape。

交付：
- `mcp/index.ts` 或新 adapter helper 在 `def.execute` 前执行 TypeBox `Value.Convert + Check` 等价校验。
- unknown top-level keys、invalid enum、number/boolean scalar conversion 与 Pi framework 行为一致。
- 增加 MCP contract：`check:mcp-parameter-contract`。
- 增加最小标准 MCP client fixture：initialize → tools/list → tools/call success/error。
- `onUpdate` 映射到 MCP progress 的最小实现；非 progress 更新可先落 logging 或忽略但必须记录 diagnostics。

非目标：
- 不引入 `McpServer.registerTool` 强制 Zod。
- 不改 `structuredContent`、resources、handle。

验证：
- `npm run check:src:types`
- `npm run check:mcp-parameter-contract`
- `npm run check:mcp-conformance`
- `npm run check`

### Phase 1：MCP tool metadata 标准化

范围：metadata/schema 暴露，不改执行语义。

交付：
- 为工具补 MCP annotations 映射：read-only / destructive / idempotent / open-world。
- description 保持一句话能力摘要 + 关键约束；减少 schema token 噪音但不删必要参数。
- `PI_BROWSER_TOOL_PROFILE` 继续作为非 deferral host 的粗门控；contract 覆盖 core/security profile tools/list。
- `package.json` exports 增加 MCP server library entry（如 `./mcp`），bin 保持可用。

验证：
- `npm run check:tools`
- `npm run check:package`
- MCP tools/list snapshot contract
- `npm run check`

### Phase 2：outputSchema / distiller schema spike

范围：只做 2-3 个代表性 distiller，不铺全仓。

交付：
- 新增 `DistillerDefinition { summarySchema, distill }` 注册形态，兼容旧 distiller。
- 选 1 个简单 summary、1 个动态 table、1 个 large/sensitive artifact summary 跑通 schema 校验。
- 定义统一 MCP structured envelope schema：`structured` 是 summary 核心；`diagnostics/target/limits/privacy/sections` 是 envelope 稳定字段。
- conformance gate 校验真实 distill 输出符合 schema；动态 `samples/rows` 仅开放尾部且有界。

非目标：
- 不承诺所有工具都有 outputSchema。
- 不从 TS 类型反射生成 schema。

验证：
- `npm run check:distiller-coverage`
- 新增 `npm run check:output-schema-conformance`
- `npm run test:unit`
- `npm run check`

### Phase 3：MCP structuredContent egress

范围：对 Phase 2 覆盖工具输出 `structuredContent`。

交付：
- MCP `tools/call` 对已声明 outputSchema 的工具返回 `structuredContent`，并保留 compatible text。
- 未覆盖工具继续返回现有 text content，不声明 outputSchema。
- Pi adapter 行为保持不变。
- 统计 token baseline 对比：当前 text envelope vs structuredContent + compatible text。

验证：
- `npm run check:output-schema-conformance`
- MCP client fixture 校验 outputSchema MUST → structuredContent
- `npm run check`

### Phase 4：Resource / handle store 地基

范围：实现 resource store 和 read，不做 ingress。

交付：
- 新增 browser result resource store，生成 opaque `browser-result://...`。
- `resources/read` 支持 text/json/search/sample 基础读取，后端复用 `artifactReader`。
- `resource_link` 只返回 URI，不泄露本地绝对 path。
- `resources/templates/list` 暴露稳定模板；completion 可延后到 Phase 5。
- 隐私 contract：默认脱敏，`redact:false` 仅在 explicit local read 路径允许。

非目标：
- 不退役 MCP `browser_artifact`。
- 不做 `resources.subscribe`。
- 不允许 handle 作为工具输入。

验证：
- `npm run check:artifact`
- 新增 `npm run check:mcp-resources`
- resource URI no-local-path contract
- `npm run check`

### Phase 5：Layered result delivery

范围：结果侧渐进披露完整化。

交付：
- Layer 0：structured summary 内含 counts/distribution/top-N/diagnostics/section handles/nextActions，预算 ≤ 8K chars 或 token gate 设定值。
- Layer 1：section resources，如 failed network entries、full scan nodes、evidence events。
- Layer 2：raw result resource。
- `nextActions` 生成移出 core 硬编码，改由 adapter presentation 决定：Pi 输出 `browser_artifact ...`，MCP 输出 `resources/read ...` / URI 模板。
- `resources/list` 返回本 session resource index。
- `resources.subscribe` / `updated` 只对确有生命周期的实时资源启用；否则不声明。

验证：
- budget/conformance tests
- `npm run check:summaries`
- `npm run check:mcp-resources`
- `npm run check`

### Phase 6：Typed ingress handle resolution

范围：只在显式声明的 payload 参数启用。

首批候选：
- `browser_sqli.request`
- `browser_http_replay.request`
- `browser_fuzz.request` / wordlist-like payloads（仅低风险字段）

交付：
- TypeBox schema 明确允许 handle string，带 `x-handle-kind` 或等价 metadata。
- resolve pipeline 按 §3.4 执行：raw validate → kind/etag/ttl validate → expand → normal validate。
- diagnostics 回显 handle meta，不回显 payload。
- kind mismatch、expired、not found、redaction conflict 均返回现有错误体系内的结构化错误；不新增新错误 taxonomy。

非目标：
- 不自动从上一个工具选择 handle。
- 不自动调用 `browser_network` / `browser_artifact` / scanner。
- 不把所有 string 参数都解释为 URI。

验证：
- unit tests for resolver
- integration fixture：capture artifact/resource → pass handle to selected tool
- negative fixtures：kind mismatch / expired / unknown id / schema invalid after expand
- `npm run check:web-security`
- `npm run check`

### Phase 7：MCP protocol middleware 外环

范围：协议 cross-cutting，不改 core semantics。

交付：
- 本地 hook 风格命名：`on_initialize`、`on_list_tools`、`on_call_tool`、`on_read_resource`、`on_message`。
- 可承载 logging、timing、rate-limit、auth placeholder、profile filter。
- 顺序固定：auth/profile → raw argument validation → handle resolution → tool execute → result presentation → logging。

验证：
- middleware order unit tests
- MCP conformance fixture
- `npm run check`

### Phase 8：MCP 路 `browser_artifact` capability-gated 退役

范围：只改 MCP tools/list；Pi 路不变。

前置条件：
- Phase 4/5 resources 覆盖 artifact read/search/sample/jsonPath 能力。
- 无 resources 客户端降级通过。
- skill/docs/evals/nextActions 全部 adapter 化，不再 core 硬编码 `browser_artifact`。

交付：
- 支持 resources 的 MCP client 可隐藏 `browser_artifact` 或标为 legacy。
- 不支持 resources 的 MCP client 继续暴露 `browser_artifact`。
- 触发 `tools/list_changed` 时机有 contract。

验证：
- dual-client tools/list fixture
- docs/generated drift check
- `npm run check`

### Phase 9：Stretch：无 deferral host fallback / prompts

仅 RFC，不进入当前合同交付。

候选：
- server dynamic list + lightweight discovery tool。
- slash command → MCP prompts。
- `skillful-mcp` 仅作理念参考，不照搬接口。

## 6. 成功度量

| 维度 | 指标 | 目标 |
|---|---|---|
| MCP 参数可靠性 | MCP 与 Pi 对 unknown keys / enum / scalar conversion 行为一致 | 100% contract 覆盖 |
| outputSchema 一致性 | 已声明 outputSchema 的真实输出通过 schema | 100%，0 runtime violation |
| token 经济 | Layer 0 token median/p90 相对现有 text envelope | Phase 0 建基线，Phase 5 必须下降或给出证据豁免 |
| 信息密度 | Layer 0 在预算内含 counts/distribution/top-N/handles/diagnostics | contract 断言 |
| resource 隐私 | MCP resource URI 不泄露本地绝对 path，默认脱敏 | 100% contract 覆盖 |
| ingress 正确性 | handle kind/etag/ttl/schema negative fixtures | 100% 覆盖 |
| Pi 回归 | Pi adapter result shape 与 `browser_artifact` 可用性 | 不回归 |

## 7. 文档与 contract 更新要求

每个 phase 完成时必须同步：

- `CURRENT.md`
- `TODO.md`
- `CHANGELOG.md`
- `README.md` / `AI_INSTALL.md`（仅当 MCP 使用方式或安装方式变化）
- `docs/generated/browser-tool-contract.generated.md`（如 tools/list/schema/annotation/output 变化）
- 相关 contracts / fixtures / eval sample results

最终 full gate：

- `npm run lint`
- `npm run test:unit`
- `npm run check`
- `npm run quality:local`
- MCP conformance fixture / runtime smoke（按 phase 范围）

## 8. 执行优先级

立即可执行的下一步是 Phase 0：补 MCP 参数契约校验和 conformance 地基。任何 structuredContent、resources、typed handle、browser_artifact MCP 退役工作，都必须等 Phase 0 通过后再进入。
