# Pi Browser Tools 架构重构方案（已完成）

## 执行摘要

**结论**: 本计划的高价值工程目标已完成。已完成类型安全收口、`BrowserBridgeServer` 深拆第一轮、运行/测试链迁移到 `tsx`、outer `dist/` 构建产物与 npm/package 入口切换，以及依赖边界按运行事实收口。

**最终状态**:
- ✅ **类型安全收口完成**: `src/` 内 `Type.Any()` = 0，`as any` = 0
- ✅ **BrowserBridgeServer 已拆薄**: facade 收敛，command/client 协调已下沉到独立 driver service
- ✅ **运行/测试链已现代化**: 不再依赖 `--experimental-strip-types`，统一使用 `tsx`
- ✅ **标准构建产物已落地**: `npm run build` 生成 outer `dist/`，npm/package `main` / `types` / `exports` / `bin` 均指向编译产物
- ✅ **依赖边界已按代码事实收口**: `typebox` / `typescript` / `zod` 保留为 runtime dependencies，因为源码运行路径直接消费它们
- ⚪ **不执行项**: 测试目录重组（原 Phase 4）已判定为低收益高噪音，不再执行

---

## Phase 1: 类型安全加固 (1-2 周) 🔴

### 问题诊断

```typescript
// 历史问题示例：曾使用未约束输入与不安全断言
export const BrowserCommandToolParams = Type.Object({
  command: Type.Any(),
  tabId: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

const value = recordValue<T>(obj);
```

### 解决方案: 引入 Zod 运行时验证

**Step 1.1: 替换 Type.Any() 为结构化 Schema**

```typescript
// 新增: src/validation/schemas.ts
import { z } from 'zod';

// Bridge Command Schema (替代 Type.Any)
export const BridgeCommandSchema = z.object({
  cmd: z.string(),
  method: z.string().optional(),
  action: z.string().optional(),
  params: z.record(z.unknown()).optional(),
}).passthrough();  // 允许额外字段但保留类型检查

// HTTP Request Schema (替代 Type.Any)
export const HttpRequestSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  bodyBase64: z.string().optional(),
}).strict();

// Multipart Schema
export const MultipartSchema = z.object({
  fields: z.array(z.object({
    name: z.string(),
    value: z.string(),
  })),
  files: z.array(z.object({
    name: z.string(),
    filename: z.string(),
    content: z.string().optional(),
    contentBase64: z.string().optional(),
  })),
}).strict();
```

**Step 1.2: 创建验证中间件**

```typescript
// 新增: src/validation/middleware.ts
import { z } from 'zod';
import { BrowserBridgeError } from '../driver/errors.js';

export function validateParams<T>(
  schema: z.ZodSchema<T>,
  params: unknown
): T {
  const result = schema.safeParse(params);
  
  if (!result.success) {
    const errors = result.error.errors.map(e => 
      `${e.path.join('.')}: ${e.message}`
    ).join('; ');
    
    throw new BrowserBridgeError(
      'INVALID_PARAMS',
      `Parameter validation failed: ${errors}`,
      { 
        validationErrors: result.error.errors,
        received: params 
      }
    );
  }
  
  return result.data;
}

// 类型安全的 recordValue 替代
export function safeRecordValue<T>(
  value: unknown,
  schema: z.ZodSchema<T>
): T {
  return validateParams(schema, value);
}
```

**Step 1.3: 迁移高风险工具**

```typescript
// 修改: src/tools/registerCommandTool.ts
import { validateParams } from '../validation/middleware.js';
import { BridgeCommandSchema } from '../validation/schemas.js';

export function registerCommandTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'browser_command',
    parameters: Type.Object({
      command: Type.Any(),  // 保留 TypeBox schema (MCP 协议要求)
      // ... 其他参数
    }),
    handler: async (params) => {
      // ✅ 运行时验证
      const validatedCommand = validateParams(
        BridgeCommandSchema, 
        params.command
      );
      
      // 现在 validatedCommand 是类型安全的
      return server.execute(validatedCommand, options);
    }
  });
}
```

**迁移清单** (按优先级):
1. `browser_command` - 最高风险 ✅
2. `browser_http_replay` - 复杂对象验证 ✅
3. `browser_fuzz` - 多模式参数 ✅
4. `browser_cookie_analyze` - JWT/Cookie 解析 ✅
5. `browser_template` - 模板对象验证 ✅

**验证**: 
```bash
npm run test:unit -- tests/unit/validation/
npm run check:tools  # 确保工具契约不变
```

---

## Phase 2: BrowserBridgeServer 解耦 (2-3 周) 🔴

### 问题诊断

```typescript
// 当前: 487 行 God Object
export class BrowserBridgeServer {
  private readonly clients: BrowserBridgeClientRegistry;
  private readonly browserSessions: BrowserSessionRegistry;
  private readonly queues: BrowserCommandQueueRegistry;
  private readonly leases: BrowserLeaseRegistry;
  private readonly tabs: BrowserTabSessionRouter;
  private readonly pendingRequests: BrowserBridgePendingRequests;
  private readonly operations: BrowserOperationRegistry;
  private readonly observationSnapshots: BrowserObservationSnapshotRegistry;
  private readonly runtimeRecoveryArtifacts: BrowserRuntimeRecoveryArtifacts;
  private readonly httpEndpoint: BrowserBridgeHttpServer;
  private readonly heartbeat: BrowserBridgeClientHeartbeat;
  
  // 100+ 方法混合了协调、路由、执行逻辑
}
```

### 解决方案: 拆分为 4 个协调器

```
BrowserBridgeServer (Facade, 150 行)
├── ConnectionCoordinator (连接管理, 100 行)
│   ├── BrowserBridgeClientRegistry
│   ├── BrowserBridgeClientHeartbeat
│   └── BrowserBridgeHttpServer
├── SessionCoordinator (会话管理, 120 行)
│   ├── BrowserSessionRegistry
│   ├── BrowserTabSessionRouter
│   └── BrowserLeaseRegistry
├── CommandCoordinator (命令执行, 150 行)
│   ├── BrowserCommandQueueRegistry
│   ├── BrowserBridgePendingRequests
│   └── CommandDispatcher (新增)
└── StateCoordinator (状态管理, 80 行)
    ├── BrowserOperationRegistry
    ├── BrowserObservationSnapshotRegistry
    └── BrowserRuntimeRecoveryArtifacts
```

**Step 2.1: 创建 ConnectionCoordinator**

```typescript
// 新增: src/driver/coordinators/ConnectionCoordinator.ts
export class ConnectionCoordinator {
  private readonly clients: BrowserBridgeClientRegistry;
  private readonly heartbeat: BrowserBridgeClientHeartbeat;
  private readonly httpEndpoint: BrowserBridgeHttpServer;

  constructor(
    host: string,
    port: number,
    portRangeEnd: number,
    onClientConnect: (ws: WebSocket) => void,
    onClientDisconnect: (ws: WebSocket) => void
  ) {
    this.clients = new BrowserBridgeClientRegistry(() => this.port);
    this.heartbeat = new BrowserBridgeClientHeartbeat(
      this.clients, 
      onClientDisconnect
    );
    this.httpEndpoint = new BrowserBridgeHttpServer(
      host, 
      port, 
      onClientConnect,
      { portRangeEnd }
    );
  }

  get port(): number {
    return this.httpEndpoint.port;
  }

  get running(): boolean {
    return this.httpEndpoint.running;
  }

  async start(): Promise<void> {
    await this.httpEndpoint.start();
    this.heartbeat.start();
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();
    this.clients.clear();
    await this.httpEndpoint.stop();
  }

  connectedClientsCount(): number {
    return this.clients.connectedClientsCount();
  }

  connectedClientInfos(): BrowserBridgeClientInfo[] {
    return this.clients.connectedClientInfos();
  }

  // 只暴露连接相关的方法，不暴露内部 Registry
}
```

**迁移策略**:
1. 先创建 4 个 Coordinator，保持 BrowserBridgeServer 不变
2. 逐步将方法委托给 Coordinator
3. 运行完整测试套件确保行为不变
4. 删除 BrowserBridgeServer 中的冗余代码

**验证**:
```bash
npm run check:all:bridge  # 确保 bridge 契约不变
npm run test:unit -- tests/unit/driver/  # 单元测试
npm run check:lifecycle  # 生命周期测试
```

---

## Phase 3: 构建工具链现代化 (1 周) 🟡

### 问题诊断

```json
// 当前: tsconfig.json
{
  "compilerOptions": {
    "noEmit": true,  // ❌ 不生成 .js 文件
    "moduleResolution": "Bundler",  // ❌ 实验性特性
    "allowImportingTsExtensions": true  // ❌ 泄露 .ts 扩展名
  }
}
```

```json
// 当前: package.json
{
  "scripts": {
    "test:unit": "node --test --experimental-strip-types ..."  // ❌ 实验性特性
  }
}
```

### 解决方案: 迁移到 TSX + 标准构建

**Step 3.1: 替换 TypeScript 配置**

```json
// 修改: tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",  // ✅ 标准 Node.js ESM
    "moduleResolution": "Node16",  // ✅ 标准解析
    "outDir": "./dist",  // ✅ 生成产物
    "rootDir": "./src",
    "declaration": true,  // ✅ 生成 .d.ts
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests", "bridge_src"]
}
```

**Step 3.2: 添加构建脚本**

```json
// 修改: package.json
{
  "type": "module",
  "main": "./dist/index.js",  // ✅ 指向编译产物
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",  // ✅ 标准构建
    "build:watch": "tsc -p tsconfig.json --watch",
    "build:bridge": "node scripts/build-bridge.mjs",  // 保持不变
    "test:unit": "tsx --test tests/unit/**/*.test.ts",  // ✅ 使用 tsx
    "prepack": "npm run build && npm run build:bridge"
  },
  "devDependencies": {
    "tsx": "^4.7.0"  // ✅ 替代 --experimental-strip-types
  }
}
```

**验证**:
```bash
npm run build  # 应生成 dist/ 目录
npm run test:unit  # 应通过所有测试
npm pack --dry-run  # 检查产物
```

---

## 已关闭项：测试目录重组（原 Phase 4）

**结论**: 不执行。

**关闭原因**:
- 现有 `tests/unit` / `tests/contracts` / `tests/smoke` / `tests/release` 已形成稳定边界，并被大量 contracts、脚本、文档和 CI 入口消费。
- 目录重命名为 `integration/`、`e2e/` 仅带来形式上的一致性，不直接提升正确性、可维护性或交付质量。
- 改动收益低，但会引入大面积低价值路径调整、脚本改名、contract 漂移与审阅噪音。

**最终决策**:
- 保持当前测试目录结构不变。
- 继续通过 grouped checks、contracts、runtime fixtures、isolated smoke 维持工程质量，而不是做目录层面的机械重组。

---

## Phase 5: 依赖管理优化（已完成，按运行事实落地） 🟢

**最终依赖边界**:
- `dependencies`
  - `@modelcontextprotocol/sdk`
  - `js-yaml`
  - `typebox`
  - `typescript`
  - `ws`
  - `zod`
- `devDependencies`
  - `@types/js-yaml`
  - `@types/node`
  - `@types/ws`
  - `esbuild`
  - `tsx`

**说明**:
- `zod` 是运行时参数验证依赖，保留在 `dependencies`。
- `typebox` 被工具 schema 源码直接运行时消费，保留在 `dependencies`。
- `typescript` 被源码运行路径直接消费（如 JS AST / source-level analysis），保留在 `dependencies`。
- 因此，本项目未机械套用“TypeScript 一律放 devDependencies”的通用模板，而是以真实运行路径为准。

---

## 最终执行结果

| 项目 | 结果 | 说明 |
|------|------|------|
| Phase 1 类型安全加固 | ✅ 完成 | `src/` 内 `Type.Any()` / `as any` 清零，保留运行时 Zod 校验 |
| Phase 2 BrowserBridgeServer 解耦 | ✅ 完成当前范围 | facade 拆薄，command/client 协调已下沉到独立 service |
| Phase 3 构建工具链现代化 | ✅ 完成核心目标 | `tsx` 运行链 + outer `dist/` + npm/package 入口切换 |
| 测试目录重组（原 Phase 4） | ⚪ 不执行 | 低收益高噪音，保持现有 tests 结构 |
| Phase 5 依赖管理优化 | ✅ 完成 | 按运行事实收口 runtime/dev 依赖边界 |

---

## 风险评估与缓解

### 风险 1: 类型验证性能开销 🟡

**风险**: Zod 运行时验证可能增加 5-10% 延迟

**缓解**:
- 只在工具入口验证，不在内部循环
- 使用 `z.lazy()` 延迟验证复杂对象
- 生产环境可选禁用验证 (环境变量控制)

### 风险 2: BrowserBridgeServer 重构破坏现有行为 🔴

**风险**: 487 行代码重构可能引入 bug

**缓解**:
- 增量迁移，每个 Coordinator 独立测试
- 保持公共 API 不变 (Facade 模式)
- 运行完整测试套件 (unit + integration + e2e)
- 使用 Git feature branch，随时可回滚

### 风险 3: 构建工具链迁移导致 CI/CD 失败 🟡

**风险**: 从实验性特性迁移到标准工具可能破坏 CI

**缓解**:
- 先在本地验证完整构建流程
- 更新 CI/CD 配置前先在 feature branch 测试
- 保留旧构建脚本作为回退方案

---

## 最终验收结论

### 已达成的关键指标

| 指标 | 结果 |
|------|------|
| BrowserBridgeServer 深拆 | 已达成当前合同范围 |
| `Type.Any()` 使用次数（`src/`） | 0 |
| `as any` 使用次数（`src/`） | 0 |
| 运行/测试链去除 `--experimental-strip-types` | 已达成 |
| outer `dist/` 构建产物 | 已达成 |
| npm/package 入口切到编译产物 | 已达成 |
| 全量验证 `npm run check` | 通过 |

### 不再作为目标的指标

以下指标不再单独追求或不再具有约束力：
- 测试目录重命名/重组
- 机械压缩 npm scripts 数量
- 以固定目录命名替代现有稳定 contracts/smoke/release 边界

---

## 附录: 详细代码审查结果

### A. 类型安全问题清单

| 文件 | 行号 | 问题 | 风险等级 |
|------|------|------|----------|
| `src/tools/registerCommandTool.ts` | 28 | `command: Type.Any()` | 🔴 High |
| `src/tools/webSecurity/registerHttpReplayTool.ts` | 45 | `request: Type.Any()` | 🔴 High |
| `src/tools/webSecurity/registerFuzzTool.ts` | 60 | `mutations: Type.Any()` | 🔴 High |
| `src/tools/webSecurity/registerCookieAnalyzeTool.ts` | 35 | `cookies: Type.Any()` | 🔴 High |
| `src/tools/webSecurity/registerTemplateTool.ts` | 50 | `templates: Type.Any()` | 🔴 High |
| `src/utils/records.ts` | 15 | `as T` without validation | 🔴 High |
| `src/tools/webSecurity/replay.ts` | 60, 65 | `as any` | 🔴 High |

### B. BrowserBridgeServer 方法分类

| 类别 | 方法数 | 示例 |
|------|--------|------|
| 生命周期管理 | 5 | `start()`, `stop()`, `running` |
| 连接管理 | 8 | `registerClient()`, `unregisterClient()` |
| 会话管理 | 12 | `listBrowserSessions()`, `createBrowserSession()` |
| Tab 管理 | 15 | `getTabs()`, `attachTab()`, `detachTab()` |
| 命令执行 | 10 | `execute()`, `queueCommand()` |
| Lease 管理 | 8 | `leaseTab()`, `releaseTab()`, `acquireUiLock()` |
| 快照/诊断 | 6 | `snapshot()`, `buildTimeoutDiagnostics()` |
| 内部辅助 | 20+ | 各种私有方法 |

**总计**: 80+ 方法

### C. 构建工具链对比

| 特性 | 当前方案 | 推荐方案 |
|------|----------|----------|
| TypeScript 编译 | `noEmit: true` | `tsc` 生成 `dist/` |
| 测试运行器 | `--experimental-strip-types` | `tsx` |
| 模块解析 | `Bundler` (实验性) | `Node16` (标准) |
| 类型定义 | 无 | 生成 `.d.ts` |
| Source Maps | 仅 bridge | 全项目 |
| 增量构建 | 不支持 | 支持 (`--watch`) |

---

## 计划状态

**状态**: 已完成

后续如需继续工程治理，请不要复用本计划开启新主线；应在 `CURRENT.md` / `TODO.md` 中为新的独立工作流单独冻结边界、非目标与验证计划。
