# 工具层统一化重构方案

## 问题诊断

### 当前状态：26 个工具，两套注册范式

**核心工具层（14 个）** — 手动模式：
- 每个工具直接调用 `pi.registerTool()`，内部自行处理参数、超时、结果
- 部分工具使用 `sharedTabScopedToolParams()` + `runTool()` + `jsonToolResult()`
- 部分工具（tabs）绕过 distillation 管线，直接调用 `jsonResult()`
- 操作追踪（`withTrackedOperation`）使用不统一

**安全工具层（12 个）** — shell 模式：
- `executeWebSecurityToolShell()` 统一包装：cookie binding、timeout、artifact、operation、distill、error wrapping
- 与核心工具共享底层（`runTool` + `jsonToolResult`），但注册形态独立

### 问题一：核心工具缺少统一执行壳

核心工具每个自行重复 timeout/maxChars/artifact/operation 处理逻辑。安全工具的 shell 模式反而更好——问题不是安全工具"太不同"，而是核心工具"太散"。

### 问题二：安全工具过多且高度同质化

12 个安全工具存在 5 个明显的合并簇：

| 合并簇 | 当前工具 | 合并后 | 共性 |
|--------|---------|--------|------|
| Fuzz 系列 | fuzzPaths + fuzzVhosts + fuzzParams | `browser_fuzz` | 相同的 baseline 对比 + 候选生成 + 过滤聚类架构 |
| SQL 注入 | sqliProbe + sqlmapBridge | `browser_sqli` | 相同的请求变异 + SQL 探测目标 |
| 模板检测 | templateCheck + nucleiBridge | `browser_template` | 相同的模板匹配 + HTTP 请求验证 |
| 信息收集 | recon + crawl | `browser_crawl` | 相同的 URL 抓取 + 元数据提取 |

---

## 目标架构

### 分层模型

```
toolAdapter.ts
├── defineBrowserTool(ctx, spec)     ← 统一注册入口（元数据 + schema + execute 绑定）
├── runBrowserTool(spec)             ← 统一执行壳（envelope, budget, artifact, operation, error）
└── runWebSecurityTool(spec)         ← 安全领域适配器（扩展 runBrowserTool + 安全 hooks）
```

### 各层职责边界

**`defineBrowserTool(ctx, spec)`** — 只管注册：
- 调用 `pi.registerTool()` 注册元数据（name, label, description, promptSnippet, promptGuidelines）
- 绑定 TypeBox schema
- 绑定 execute 函数到 spec.run
- **不吞掉领域逻辑**

**`runBrowserTool(spec)`** — 统一执行协议：
- `runTool()` 包装
- `withTrackedOperation()`（**可选**，由 spec.operation 控制）
- `toolTimeoutMs()` / `toolMaxChars()`
- `jsonToolResult()` / `textToolResult()` 结果构建
- artifact fallback
- `errorResult` / `normalizeError` 统一错误处理

**`runWebSecurityTool(spec)`** — 安全领域适配器：
- 内部调用 `runBrowserTool()`
- 增加安全领域 hooks：
  - `cookieProvider` 创建
  - `defaultMaxBodyBytes`
  - `defaultTimeoutMs`
  - `allowPrivateTargets` 参数
  - `securityErrorMap`（安全领域脱敏 + domain 诊断）
- **不允许**：自己构造不同 envelope、绕过 jsonToolResult、自定义 artifact fallback

### operation tracking 可选设计

```typescript
// spec 中的 operation 字段
operation?: false | {
  command: string;
  tabId?: (params, body) => unknown;
  initialProgress?: number;
}
```

- `false` 或省略：不启用 `withTrackedOperation`（tabs, artifact, screenshot 等轻量工具）
- 对象：启用操作追踪，heartbeat + progress 上报

### error 统一设计

```typescript
// spec 中的 error 字段
error?: {
  map?: (error, params) => unknown;  // 领域错误映射（如 webSecurityToolError 的脱敏逻辑）
  domain?: "browser" | "webSecurity" | "artifact" | "transfer";
}
```

- `map` 在 `runTool` 的 `onError` 上游执行：先做领域映射（脱敏、domain details），再交给通用 `errorResult` / `normalizeError`
- `webSecurityToolError` 的脱敏逻辑迁移到 `map` 中，不丢弃

### 统一后的工具清单（21 个）

**核心浏览器工具（14 个，不变）：**
1. `browser_tabs`
2. `browser_command`
3. `browser_execute`
4. `browser_observe`
5. `browser_pick`
6. `browser_download`
7. `browser_upload`
8. `browser_wait`
9. `browser_network`
10. `browser_hook`
11. `browser_evidence`
12. `browser_frame`
13. `browser_screenshot`
14. `browser_artifact`

**合并后的安全工具（4 个，从 12 个合并）：**
15. `browser_crawl` — 合并 recon + crawl，新增 `action` 参数（`fingerprint` / `crawl`，**默认 `crawl`**）
16. `browser_fuzz` — 合并 fuzzPaths + fuzzVhosts + fuzzParams，新增 `mode` 参数（`path` / `vhost` / `param`）
17. `browser_sqli` — 合并 sqliProbe + sqlmapBridge，新增 `engine` 参数（`builtin` / `sqlmap`）
18. `browser_template` — 合并 templateCheck + nucleiBridge，新增 `engine` 参数（`builtin` / `nuclei`）

**保留不变的独立安全工具（3 个）：**
19. `browser_http_replay`
20. `browser_cookie_analyze`
21. `browser_callback_oast`

**总计：14 + 4 + 3 = 21 个工具**（从 26 个减少 5 个）

---

## 实施方案

### 阶段 A：协议统一（adapter / envelope / error / operation / artifact）

#### A1. 抽取 `runBrowserTool()`

**目标：** 从现有安全工具 shell 和核心工具中提取公共执行协议。

**步骤：**
1. 在 `toolAdapter.ts` 中新增 `runBrowserTool(spec)` 函数
2. 从 `executeWebSecurityToolShell` 中提取公共逻辑：
   - `runTool()` 包装
   - `toolTimeoutMs()` / `toolMaxChars()` 解析
   - `withTrackedOperation()`（按 spec.operation 可选）
   - `jsonToolResult()` 结果构建
   - artifact fallback
   - error taxonomy
3. spec 类型定义：
   ```typescript
   type RunBrowserToolSpec<TParams, TResult> = {
     toolName: string;
     command?: string;
     fallbackPrefix: string;
     params: TParams;
     ctx?: ToolContext;
     onUpdate?: ToolOnUpdate;
     // 执行
     run: (params: TParams) => Promise<TResult>;
     distill?: (result: TResult) => Record<string, unknown>;
     details?: (result: TResult) => Record<string, unknown>;
     // 配置
     defaultTimeoutMs?: number;
     defaultMaxBodyBytes?: number;
     maxChars?: number;
     operation?: false | { command: string; tabId?: ...; initialProgress?: number };
     error?: { map?: (error, params) => unknown; domain?: string };
     // 领域扩展（WebSecurity 用）
     hooks?: {
       cookieProvider?: CookieProvider;
       augmentParams?: (params) => Partial<TParams>;
       securityErrorMap?: (error) => unknown;
     };
   };
   ```

**验证：** `runBrowserTool` 独立可测试，不依赖任何具体工具。

#### A2. WebSecurity shell 降级为领域适配器

**步骤：**
1. `executeWebSecurityToolShell` 内部改调 `runBrowserTool()`
2. 安全领域逻辑作为 `hooks` 传入：
   - `cookieProvider` 创建
   - `augmentParams`（followRedirects 默认值等）
   - `securityErrorMap`（脱敏 + domain 诊断）
3. **兼容别名**：
   ```typescript
   export const executeWebSecurityToolShell = runWebSecurityTool;
   ```
4. 逐步改调用点，最后删除旧名

**验证：** 所有 12 个安全工具行为不变。

#### A3. 核心工具逐步迁移

**迁移顺序（从最像通用壳的开始）：**

1. **`registerNativeActionTool()`**（wait, network, hook, frame）
   - 已经最像通用壳：config-driven + `runTool` + `withTrackedOperation` + `jsonToolResult`
   - 迁移为 `defineBrowserTool()` + `runBrowserTool()` 的直接调用

2. **`registerExecuteTool` / `registerCommandTool` / `registerEvidenceTool`**
   - 中等复杂度，有 `withTrackedOperation`

3. **`registerTransferTools`**（download, upload）
   - 无操作追踪，简单迁移

4. **`registerObserveTool`**
   - 最复杂：委托给 runner，每个 runner 内部独立调用结果构建
   - 需要 runner 也迁移到 `runBrowserTool()`

5. **`registerTabsTool` / `registerScreenshotTool` / `registerArtifactTool` / `registerPickTool`**
   - 轻量工具，`operation: false`

**每个工具迁移后独立验证行为不变。**

#### A4. 错误处理统一

1. `BrowserBridgeError.code` 类型改为 `NativeErrorCode`
2. `webSecurityToolError` 的脱敏逻辑迁移到 `runWebSecurityTool` 的 `error.map` hook
3. 统一 `normalizeError` 在 `runTool` / `errorResult` 上游执行
4. 各工具不再自行决定错误格式，统一由 `runBrowserTool` 的 error pipeline 处理

---

### 阶段 B：表面收敛（工具合并，逐簇迁移）

**前提：阶段 A 完成后才开始。** 避免同时改"壳"和"表面"，contract 失败时难以定位。

#### B1. 合并 Fuzz 系列（3→1）

`browser_fuzz_paths` + `browser_fuzz_vhosts` + `browser_fuzz_params` → `browser_fuzz`

**参数设计原则：**
- 平铺参数 + description 标注适用 mode，不追求 TypeBox discriminated union
- execute 内做 mode validation 和 ignored-fields 诊断

```typescript
parameters: Type.Object({
  mode: Type.Optional(Type.Union([
    Type.Literal("path"),     // 默认，原 fuzzPaths
    Type.Literal("vhost"),    // 原 fuzzVhosts
    Type.Literal("param"),    // 原 fuzzParams
  ], { description: "Fuzz dimension (default: path). path: URL segments; vhost: Host header; param: request parameters" })),

  // 共享参数（所有 mode）
  ...sharedTabScopedToolParams(),
  ...browserCookieBindingParams(...),
  ...redirectControlParams(...),
  ...rateLimitPerSecondParam(...),
  url: ..., urls: ...,
  words: ..., wordlist: ..., wordlistPath: ...,
  matchStatus: ..., filterStatus: ..., filterBodyBytes: ...,
  method: ..., headers: ..., defaultScheme: ...,

  // path mode 专用
  paths: ..., extensions: ..., appendSlash: ...,
  recursive: ..., maxDepth: ..., baselinePath: ...,
  filterBaseline: ..., baselineStrategy: ...,
  maxCandidates: ...,

  // vhost mode 专用
  hosts: ..., baseDomain: ..., template: ...,
  baselineHost: ..., baselineHosts: ...,
  sniMode: ..., sniName: ...,

  // param mode 专用
  rawRequest: ..., request: ..., body: ..., bodyBase64: ...,
  mutations: ..., locations: ..., paramNames: ...,
  values: ..., jsonValues: ..., operations: ...,
  contentTypeVariants: ..., maxCases: ...,
})
```

**内部路由：**
```typescript
async execute(...) {
  return await runWebSecurityTool({
    ...spec,
    run: (params) => {
      const mode = params.mode ?? "path";
      switch (mode) {
        case "path":  return runFuzzPaths(params);
        case "vhost": return runFuzzVhosts(params);
        case "param": return runFuzzParams(params);
      }
    },
    distill: (result, params) => {
      // 按 mode 路由到各自的 distill 函数
    },
  });
}
```

**实现策略：** 复用现有 `runFuzzPaths` / `runFuzzVhosts` / `runFuzzParams`，不修改内部逻辑。

#### B2. 合并 SQL 注入（2→1）

`sqliProbe` + `sqlmapBridge` → `browser_sqli`

```typescript
engine: Type.Optional(Type.Union([
  Type.Literal("builtin"),  // 默认，原 sqliProbe
  Type.Literal("sqlmap"),   // 原 sqlmapBridge
], { description: "Detection engine (default: builtin). builtin: lightweight probes; sqlmap: external binary" })),
```

#### B3. 合并模板检测（2→1）

`templateCheck` + `nucleiBridge` → `browser_template`

```typescript
engine: Type.Optional(Type.Union([
  Type.Literal("builtin"),  // 默认，原 templateCheck
  Type.Literal("nuclei"),   // 原 nucleiBridge
], { description: "Template engine (default: builtin). builtin: lightweight matchers; nuclei: external binary" })),
```

#### B4. 合并信息收集（2→1）

`recon` + `crawl` → `browser_crawl`

```typescript
action: Type.Optional(Type.Union([
  Type.Literal("crawl"),        // 默认，保持现有 browser_crawl 语义
  Type.Literal("fingerprint"),  // 原 browser_recon_probe
], { description: "Collection mode (default: crawl). crawl: recursive discovery; fingerprint: single-shot metadata" })),
```

**向后兼容：**
- `browser_crawl` 默认行为不变（`action: "crawl"`）
- `browser_recon_probe` 保留一个版本，内部转发：
  ```typescript
  // deprecated alias
  browser_crawl({ action: "fingerprint", ...params })
  ```
- 下一版本删除 `browser_recon_probe`

#### B5. 清理

1. 删除废弃的注册文件（合并后不再需要）
2. 更新 `toolRegistry.ts`（`WEB_SECURITY_TOOL_REGISTRARS` 从 12 个减为 7 个）
3. 更新 `budgets.ts`（合并后工具使用新名称）
4. 更新 contract 测试
5. 更新文档（`npm run docs:generate`）
6. 更新 evals / smoke tests

---

## 实施顺序（严格固定）

```
A1. 抽取 runBrowserTool()
    ↓ 验证：独立可测试
A2. WebSecurity shell 改调 runBrowserTool() + 兼容别名
    ↓ 验证：12 个安全工具行为不变
A3. 核心工具逐步迁移（nativeActions → execute/command/evidence → transfer → observe → tabs/screenshot/artifact/pick）
    ↓ 验证：所有 26 个工具行为不变
A4. 错误处理统一
    ↓ 验证：error taxonomy 一致
B1. 合并 Fuzz 系列
    ↓ 验证：contracts + smoke
B2. 合并 SQL 注入
    ↓ 验证
B3. 合并模板检测
    ↓ 验证
B4. 合并信息收集 + recon deprecated alias
    ↓ 验证
B5. 清理废弃文件 + 更新文档/测试/evals
```

每个步骤完成后运行 `npm run quality:local` 验证。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `runBrowserTool` 设计过于抽象 | 新人理解成本高 | spec 类型清晰定义，每个字段有文档；先在 nativeActions 上验证 |
| 合并后参数 schema 过于庞大 | Agent 难以正确构造参数 | 平铺参数 + description 标注 mode；execute 内做 mode validation |
| 内部 run 函数需要修改参数接口 | 大量代码变动 | 保持 run 函数签名不变，只在注册层做参数路由和转换 |
| 合并后 distill/summarize 需要按 mode 分支 | 结果格式可能不一致 | 保持各 mode 的 distill 逻辑独立 |
| `executeWebSecurityToolShell` 兼容别名遗漏 | 部分调用点未迁移 | 全局搜索确认所有调用点后再删除旧名 |
| 删除旧工具名称 | evals/smoke/contract 引用失效 | 逐簇迁移，每簇同步更新引用 |

---

## 不做的事

1. **不内联安全工具的 12 个注册文件** — shell 保留为领域适配器
2. **不改变核心工具的外部行为** — 只统一内部执行协议
3. **不一次性迁移所有工具** — 逐个迁移，每步可验证
4. **不追求 TypeBox discriminated union** — 平铺参数 + description 更适合 Agent 使用
5. **不丢弃 webSecurityToolError 的脱敏逻辑** — 迁移到 error.map hook
