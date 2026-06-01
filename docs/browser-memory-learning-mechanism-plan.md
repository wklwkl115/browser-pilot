# Browser Memory / Learning Mechanism v1 执行合同

> Status: execution contract. 本文取代 `.plan/browser-memory-learning-mechanism.md` 作为实现 source of truth；`.plan/...` 仅保留为讨论记录。

## 目标

为 `pi-browser-tools` 增加本地学习/记忆层：任务成功后由 agent 显式提交已验证经验；后续相同 origin 的浏览器任务可先 recall 相关 SOP/facts，减少错误动作。

v1 只做本地、证据门控、显式召回、极小自动提示；不做 repo promote、不做 embeddings；`task/project` 仅做 local-only scope，不做 curated/export 流程。

## 最终分析与执行口径

1. 现有 `.pi/browser-artifacts/`、`resultMiddleware`、`browser_artifact` 已覆盖 L4 证据；本项只补 `record -> derived index -> recall/read` 闭环。
2. `operationId` 单独不是可读证据；v1 接受它作为 correlation ref，但 `record/validate` 至少需要一个可读 durable ref：`saved.path`、`browser-result://...`，或未过期 snapshot 且 snapshot 带 `saved.path`。
3. 原始 locked layout 中 `facts/<scopeKey>.md` 与“每条 entry 有 frontmatter + append-only”冲突；执行布局改为**每条 fact/SOP 一个文件**，`scopeKey` 仍在 frontmatter 与 index 中作为 L2 分组键。
4. `browser-result://` 解析不能让 `src/tools` 反向 import `mcp/*`；MCP 入口通过可选 resolver 注入 `registerBrowserTools()`，Pi runtime 未注入时只接受本地 path/snapshot 证据。
5. `browser-memory://` 与 `browser-result://` 分离；前者持久、无 TTL、按 `.pi/browser-memory/` 解析，后者继续短 TTL 结果句柄。
6. v1 自动提示只追加一条 `nextActions` 字符串；不注册 section sub-resource，不读正文，不在 tabs list/no-url 结果上触发。
7. 新增 `browser_memory` 是有计划的新公开工具；必须同步 registry、budgets、MCP annotations/visibility、generated docs、README、skill、contracts。

## 非目标

- 不写入 repo-tracked memory，不做 `export/promote`。
- 不做 `task/project` 的 repo curated/export/promote。
- 不引入 eTLD+1 / public suffix dependency。
- 不做 MCP prompt 注入，不改 `mcp/prompts.ts` 的静态 prompt 语义。
- 不重建 per-call logging，不复制 `.pi/browser-artifacts/`。
- 不新增 `browser_memory_*` 多工具名，不做 workflow/orchestrator。

## 延后项（Deferred backlog）

已知但本轮不做的方向（部分与上述非目标重叠，集中记录便于后续取舍）：

1. repo promote/export — 记忆提升为 repo-tracked / 导出。
2. task/project curated workflow — 人工策展 / 导出 / 晋升流。
3. embeddings / ranking / retrieval engine — 语义召回与排序（当前 recall 为精确 scope + 子串 trigger 命中）。
4. 更强的跨进程 / 跨宿主一致性 store — 当前为本地文件 + 每次读取保鲜，无分布式一致性。
5. 更强的 supersede / merge 人工确认流 — 当前 supersede 为「同 scope+kind+title」自动 tombstone，无人工合并确认。

## 公开工具合同

新增 core 工具：`browser_memory`，`action` discriminator。

### 参数

顶层用 `strictToolParameters()`，v1 字段：

- `action`: `record | recall | read | validate`
- `kind?`: `sop | fact`；`record/validate` 必填
- `scopeKind?`: `origin | task | project`；默认 `origin`；v1 全部为 local-only scope
- `scopeKey?`: origin key；可由 `url` 归一化得到
- `url?`: 用于归一化 origin
- `query?`: recall 关键词
- `title?`, `triggers?`, `body?`: `record/validate` payload
- `evidenceRefs?`: `record/validate` 必填，数组，支持：
  - `{kind:"artifact", path}` 或直接 saved path string
  - `{kind:"browser-result", uri}` 或 `browser-result://...`
  - `{kind:"snapshot", snapshotId}`
  - `{kind:"operation", operationId}`（仅 correlation；不能单独满足 durable gate）
- `id?`, `uri?`: `read` 目标
- `mode?`: `text | json`；`read` 默认 `text`
- `offset?`, `limit?`, `maxChars?`, `jsonPath?`

### 行为

- `record`: 验证 payload + evidenceRefs + secret scan；写新 entry 文件；必要时写 tombstone；重建 `index.json`；返回 L1 card + `browser-memory://...` handle。
- `validate`: 同 `record` 全部校验，但不写文件；返回 diagnostics。
- `recall`: 通过 `url/scopeKey/query` 查 `index.json`；只返回 bounded cards，不返回正文。
- `read`: 通过 `id` 或 `browser-memory://...` 读取 bounded 内容；正文仍受 `offset/limit/maxChars/jsonPath` 限制。

### 错误码

用 `createCodedError()`，不改 native protocol schema。新增 heuristic taxonomy：`MEMORY_*` -> `domain:"tool"`, `category:"tool.memory"`。

必需错误码：

- `MEMORY_ACTION_UNSUPPORTED`
- `UNSUPPORTED_SCOPE_KIND`
- `MEMORY_SCOPE_REQUIRED`
- `MEMORY_EVIDENCE_REQUIRED`
- `MEMORY_EVIDENCE_UNREADABLE`
- `MEMORY_EVIDENCE_STALE`
- `MEMORY_EVIDENCE_UNRESOLVABLE`
- `MEMORY_SECRET_DETECTED`
- `MEMORY_SCHEMA_INVALID`
- `MEMORY_ENTRY_NOT_FOUND`
- `MEMORY_RESOURCE_STALE`

## 数据模型

### Origin 归一化

```ts
new URL(url).hostname.toLowerCase().replace(/^www\./, "")
```

- `localhost`、IP literal 原样保存。
- 文件名使用安全 slug；slug 不是 scopeKey 单源，frontmatter 才是事实。

### Entry frontmatter

每条 SOP/fact 一个文件，frontmatter 最小字段：

```yaml
schemaVersion: 1
id: sop_20260601_abcdef12
title: "xiaohongshu search first result like"
kind: sop
triggers: ["xiaohongshu", "search", "like"]
scopeKind: origin
scopeKey: xiaohongshu.com
sensitivity: local
status: active
confidence: verified
verifiedAt: "2026-06-01T00:00:00.000Z"
updatedAt: "2026-06-01T00:00:00.000Z"
evidenceRefs:
  - kind: artifact
    path: ".pi/browser-artifacts/observe-scan-...json"
    etag: "..."
```

### 存储布局

```text
.pi/browser-memory/
  sop/<id>.md
  facts/<id>.md
  tombstones/<ts>-<id>.json
  index.json
  audit/<ts>-<op>.json
```

- `.pi/` 已 gitignored；运行时不得写 repo memory。
- `index.json` 由扫描 `sop/`、`facts/`、`tombstones/` 派生；禁止手写。
- supersede/deprecate 不改旧 entry；写 tombstone，index 派生 `status:"deprecated"`。
- compaction 是 v2/维护动作；如实现必须显式 action + audit artifact，不能静默 prune。

### `index.json` shape

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-01T00:00:00.000Z",
  "entries": [
    {
      "id": "sop_...",
      "kind": "sop",
      "title": "...",
      "triggers": ["..."],
      "scopeKind": "origin",
      "scopeKey": "xiaohongshu.com",
      "status": "active",
      "confidence": "verified",
      "updatedAt": "...",
      "handles": ["browser-memory://sop/sop_..."]
    }
  ],
  "byScope": {"origin:xiaohongshu.com": ["sop_..."]}
}
```

## Evidence gate

`record/validate` 必须执行：

1. `evidenceRefs.length > 0`。
2. 至少一个 durable ref 可读：
   - path：解析到 cwd 下或绝对路径，文件存在，读取时默认 redaction；记录 etag/bytes，不保存原文。
   - `browser-result://`：MCP resolver 校验 resource 存在、未过期、fresh，返回 server-side artifact path/etag/bytes；Pi 无 resolver时拒绝该 ref。
   - snapshot：通过 `BrowserBridgeServer.getObservationSnapshot()`；过期拒绝；若有 `saved.path` 可转 durable。
3. operationId 只作为 correlation；必须能在 durable artifact/snapshot 中对账，或仅作为 supplemental ref。
4. `title/triggers/body/frontmatter` 经过 `containsSensitiveEvidence()`；命中则 `MEMORY_SECRET_DETECTED`。
5. body caps：SOP ≤120 行，fact ≤160 行，单 entry ≤16KB；超限 `MEMORY_SCHEMA_INVALID`。
6. `scopeKind` 为 `task|project` 时要求显式 `scopeKey`，不走 URL 归一化。

## `browser-memory://` MCP resource

新增持久 resource reader，不复用短 TTL result store。

- scheme：`browser-memory://index`、`browser-memory://sop/<id>`、`browser-memory://fact/<id>`。
- URI 不暴露本地路径。
- resource metadata 带 `etag/updatedAt/kind/id`，不带 body。
- read 支持 `?mode=text|json&offset=&limit=&jsonPath=`。
- `resources/list` 合并现有 `browser-result://` 短命资源和 memory resources。
- `resources/templates/list` 新增 browser-memory templates。
- `resources/read` 按 scheme dispatch：`browser-result://` -> 现有 reader；`browser-memory://` -> memory reader。
- 抽 `mcp/resourceFreshness.ts`：`computeEtag()`、`computeContentHash()`、`isFresh()`；现有 `mcp/resourceStore.ts` 与 memory reader 共用。

## 自动提示

> 已更新（post-v1）：auto-surface 已放宽，运行时口径以 `docs/browser-memory.md` 为准，回归锁定于 `tests/contracts/tools/check-memory-autosurface.mjs`。下列 v1 约束已被取代：触发不再限于 `browser_observe`（改为任意带页面上下文的结果，仅排除 `browser_memory`/`browser_tabs` 与 observe `mode=tabs`）；除 exact-origin 外，`task/project` scope 按 entry trigger 命中页面 url/title 浮现；每个命中 scope 追加一条 `nextActions`（至多 3 条）；`index.json` 每次读取保鲜（取消进程级永久 cache，修复"本会话内新 record 不浮现"），无记忆时不创建文件。新增写入侧催记：结果带 durable evidence 且其 origin 尚无活跃记忆时，追加一条 `record candidate:` 提示（每 origin 每会话至多一次，origin 录过即转为 recall），点火 record 闭环。以下为原始 v1 口径，保留作历史记录：

实现位置：`resultMiddleware` 或 observe summary 注入 helper，必须满足：

- env `PI_BROWSER_MEMORY_AUTOSURFACE=0` 关闭。
- 只对 `tool === "browser_observe"` 且 `mode !== "tabs"` 生效。
- 从 `summary.url` / `target.url` / `snapshot.url` 得到 origin；无 URL 不触发。
- 只 exact-origin 命中；不做 query/ranking。
- 只追加一条 `nextActions`：
  `relevant memory: browser_memory action=recall scopeKey=xiaohongshu.com (3 SOPs, 1 facts)`
- 不返回正文；不注册 resource_link/sections。
- index 读取使用 mtime cache，单次 hot path 不扫描全目录。

## 设计取向：保持 GA 式简单

刻意**不做**显式学习机器(feedback/打分/health/自动衰减淘汰)。曾实现过一版,评估后移除——它与"坏 SOP 下次成功时重新 record 自然 supersede"功能重叠,且要求 agent 额外调 `feedback` 才生效,复杂度不抵收益。收敛为 GA 式 **record / recall / supersede**。

> **证据门槛已放宽(取代下文 v1 的"evidenceRefs 必填/无 evidence 必拒"口径)**:对齐 GA"成功即结晶",`record`/`validate` **不再强制** durable evidence。`evidenceRefs` 改为可选 provenance——提供则仍校验真实性(`MEMORY_EVIDENCE_UNREADABLE`/`STALE`/`UNRESOLVABLE` 仍会抛),不提供也放行;`MEMORY_EVIDENCE_REQUIRED` 保留为声明码但不再抛出。安全护栏(密钥扫描、尺寸上限、redaction)不变。结晶的蒸馏器是 agent 本身(它持有完整轨迹)。

唯一保留的写入侧增量是**显著性 / 去重**(防止库被琐事与近重复稀释,纯函数在 `src/tools/memory/salience.ts`):

- `record`/`validate` 与同 scope、同 kind 活跃条目算加权 token 相似度;精确同标题或相似度 ≥ `0.8` 自动 supersede,`0.5`–`0.8` 作 `duplicateCandidates` 软提示,低相似度共存。
- 写入侧催记仅在"做了事"的工具触发(排除 observe/screenshot/wait/frame/pick/artifact 等纯读),recall 浮现不受限。

补上 GA 的 **L1 极简索引**(`src/tools/memory/routing.ts`,回归锁定于 `tests/unit/memory/routing.test.ts`):`index.json` 物化倒排 token 索引 `routing`,recall(query)与 auto-surface 的 task/project 改用 token 重叠路由(token 边界正确、可排序),取代子串扫描;origin 仍精确匹配。纯 token 路由,无 embeddings(语义检索仍延后)。延后项 #3 的"ranking"由此落地一部分。

## 实施阶段

### W0. 合同落地与当前入口同步

- 新增本文。
- `.plan/browser-memory-learning-mechanism.md` 标记为讨论记录并指向本文。
- 更新 `CURRENT.md` / `TODO.md`：列入当前激活项、边界、验证计划。

验收：`npm run check:doc-structure`。

### W1. Memory core 模块

新增：

- `src/tools/memory/types.ts`
- `src/tools/memory/paths.ts`
- `src/tools/memory/origin.ts`
- `src/tools/memory/frontmatter.ts`
- `src/tools/memory/indexStore.ts`
- `src/tools/memory/evidence.ts`
- `src/tools/memory/reader.ts`
- `src/tools/memory/autoSurface.ts`

要求：

- atomic write：temp + rename。
- 简单文件锁：`.pi/browser-memory/.lock`，stale lock 有明确 timeout/diagnostics。
- frontmatter 用 `js-yaml`；禁止 ad-hoc YAML parser。
- 所有 JSON.parse 走 `parseJsonOrThrow()`；如触发 boundary contract，更新允许根。
- 不在 core memory 模块 import `mcp/*`。

验证：unit tests 覆盖 origin、slug、frontmatter roundtrip、index derive、secret scan、durable evidence gate、atomic write。

### W2. `browser_memory` tool

新增 `src/tools/registerMemoryTool.ts`，注册进 `CORE_BROWSER_TOOL_REGISTRARS`。

同步：

- `src/tools/budgets.ts` 加 `browser_memory`。
- `mcp/toolAnnotations.ts` 加 annotation。
- `mcp/toolVisibility.ts` 加 core/artifact group，默认可见。
- `tests/contracts/tools/check-tools-contract.mjs` 工具清单更新。
- `tests/contracts/tools/check-mcp-tools-list.mjs` core=15、security=22。
- `tests/contracts/tools/check-mcp-e2e.mjs` modern security visible=22（22 - artifact + discovery）。

验证：`npm run check:tools`、`npm run check:mcp-tools-list`、`npm run check:mcp-e2e`。

### W3. MCP resource 与 evidence resolver

新增/修改：

- `mcp/resourceFreshness.ts`：从 `mcp/resourceStore.ts` 抽 etag/hash/freshness。
- `mcp/memoryResourceStore.ts`：解析/list browser-memory resources。
- `mcp/memoryResourceReader.ts`：bounded read。
- `mcp/index.ts`：resources list/templates/read dispatch；注册工具时注入可选 browser-result evidence resolver。
- `src/tools/toolShared.ts`：`ToolRegistrarContext` 增可选 `memoryEvidenceResolver` 或等价注入点。
- `src/tools/registerTools.ts`：options 透传该 resolver。

验证：新增 `tests/contracts/tools/check-mcp-memory.mjs` 覆盖：

- `browser-memory://` URI 不泄露路径。
- resources/templates/list 暴露 browser-memory templates。
- resources/read unknown/stale/fresh 行为。
- `browser_memory validate` 可接受 MCP `browser-result://` evidence ref。
- local-only `task/project` scope 的 `validate -> record -> recall -> read` 由 smoke 覆盖。
- Pi/no-resolver 下 `browser-result://` evidence ref 返回 `MEMORY_EVIDENCE_UNRESOLVABLE`。

### W4. Auto-surface

- 接入 observe 结果的 `nextActions`。
- mtime cache + env toggle。
- exact-origin only。

验证：contract 覆盖：无 index 不提示；origin 命中只一条；`mode=tabs` 不提示；`PI_BROWSER_MEMORY_AUTOSURFACE=0` 不提示；不返回 body/handles 超 3。

### W5. 文档、生成物、skill

同步：

- `docs/browser-memory.md`：短设计说明与使用示例；明确 v1 local-only、record 需要 evidence。
- `README.md`：工具清单、边界、维护入口。
- `docs/tool-boundaries.md`：新增 `browser_memory` 行。
- `skills/pi-browser-tools/SKILL.md`：只写运行用法，不写 v2 promote。
- `CHANGELOG.md`：记录新增能力。
- `docs/generated/browser-tool-contract.generated.md`：通过 `npm run docs:generate` 生成，不手改。

验证：

```bash
npm run docs:generate
PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools
npm run check:tool-docs
```

### W6. 最终验证

局部优先：

```bash
npm run check:src:types
npm run test:unit
npm run check:all:contracts
npm run check:all:package
```

最终门禁：

```bash
npm run check
```

如实现期间改到 runtime reload 或真实浏览器行为，再补 bounded fixture smoke；本计划默认不要求真实 browser smoke，因为 memory v1 主体是 local file + MCP resource + result envelope。

## 完成标准

- `browser_memory record/validate`：evidence 可选(GA 式成功即结晶);若提供则校验真实性,不提供也可写。
- `recall/read` 默认 bounded；正文不在 recall inline 泄露。
- `.pi/browser-memory/index.json` 可由 entry+tombstone 全量重建且结果确定。
- `browser-memory://` 持久语义与 `browser-result://` 短命语义分离。
- observe exact-origin 命中只出现一条轻量 nextAction。
- `npm run check` 通过，generated docs/README/skill/tool boundaries 无能力漂移。
