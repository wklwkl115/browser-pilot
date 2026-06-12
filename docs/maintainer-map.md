# Maintainer Map

## 目标

给维护者一个固定入口：改哪里、先看哪里、最后验哪里。

## 运行链路

1. `index.ts`
   - 扩展源码入口（Pi runtime 通过 `pi.extensions:["./index.ts"]` 加载）
   - 启动 `BrowserBridgeServer`
   - 注册 Pi commands 与 22 个 always-on `browser_*` tools
   - 发布产物入口对应 `dist/index.js`

2. `src/driver/*`
   - `BrowserBridgeServer.ts`：thin facade
   - `BrowserBridgeCommandService.ts`：command validation / target planning / payload transport
   - `BrowserBridgeClientMessageService.ts`：WS client register/unregister/message route
   - `BrowserBridgeHttpServer.ts`：HTTP/WS 接入
   - `BrowserBridgeClientRegistry.ts`：浏览器扩展 client
   - `BrowserTabSessionRouter.ts`：tab / browser session / implicit target 路由
   - `BrowserLeaseRegistry.ts` / `BrowserCommandQueueRegistry.ts`：写冲突与串行化
   - `BrowserWaitSupervisor.ts`：长 wait supervisor
   - `BrowserObservationSnapshotRegistry.ts` / `BrowserOperationRegistry.ts`：snapshot / operation metadata

3. `src/tools/toolRegistry.ts` → `src/tools/registerTools.ts` → `src/tools/distillerRegistry.ts`
   - `toolRegistry.ts`：唯一工具注册顺序与 core/security 分组元数据；无 profile gating
   - `registerTools.ts`：只遍历 registrar，不放领域逻辑
   - `distillerRegistry.ts`：fallback 摘要分发注册表；runtime 与 direct-import contract 共用初始化路径

4. `src/tools/register*.ts`
   - callable tool schema、prompt 文案、tool shell
   - 共享参数/结果/错误包装走 `toolAdapter.ts`
   - native action 工具优先消费 `src/protocol/nativeActionMetadata.ts`

5. `src/tools/observe/*` 与 `src/tools/observeRunners.ts`
   - `observeRunners.ts` 是兼容 façade
   - `observe/scanRunner.ts`、`observe/contentRunner.ts`、`observe/htmlRunner.ts` 分别持有对应 runner
   - `observe/entityViews.ts`、`memoryAugmentation.ts`、`relevanceFusion.ts`、`baseline.ts`、`renderCache.ts` 是已声明 seam；新增 observe 逻辑优先落到对应 seam

6. `src/tools/webSecurity/*`
   - `register/`：WebSecurity tool register shell
   - `browserNative/`：Pi-native HTTP/replay/fuzz/template/cookie/OAST
   - `bridges/`：`sqlmap` / `nuclei` mature bridge
   - `shared/`：HTTP/replay/HAR/template/artifact/diagnostics/mature bridge helper

7. `src/protocol/*`
   - 从 `bridge/native_command_schema.json` 生成
   - Node 侧 validator / metadata / error codes
   - 手改无效；改 schema 后跑 `npm run sync:protocol`

8. `bridge_src/*`
   - 浏览器扩展 MV3 runtime 源码
   - `service-worker.ts` 为入口
   - `service_worker/*` 为 runtime domain 模块
   - `page_scripts/*` 为 content / hook dispatcher / disable dialogs 页面脚本

9. `bridge/pi_browser_bridge/dist/*`
   - 运行时产物
   - 修改 `bridge_src/**` 后先 `npm run build:bridge`
   - `dist/build-manifest.json.buildId` 是 extension skew 诊断依据

## 改动落点

### 改 callable tool schema / 描述 / summary / artifact
- 先看：`src/tools/register*.ts`、`src/tools/summaries/*`
- 若改 fallback 摘要分发：同时看 `src/tools/distillerRegistry.ts`、`src/tools/summaries/registerBuiltinDistillers.ts`
- 若是 native command tool：同时看 `src/protocol/nativeActionMetadata.ts`
- 同步：README、CHANGELOG、contracts、必要时全局 skill

### 改 tab/session/queue/lease/wait 行为
- 先看：`src/driver/*` 与 `docs/driver-architecture.md`
- 再看：对应 tool register 与 contracts
- 若涉及 MV3 生命周期：同时看 `bridge_src/service_worker/*`

### 改 native command 名、参数、错误码、tool metadata
- 只改：`bridge/native_command_schema.json`
- 然后：`npm run sync:protocol`
- 不要手改：`src/protocol/*`、`bridge_src/service_worker/protocol.ts`、`docs/generated/native-protocol.generated.md`

### 改 bridge runtime 行为
- 先看：`bridge_src/service_worker/*`
- 构建：`npm run build:bridge`
- 验证：contracts → isolated smoke

### 改 CLI 本地命令 / routing / metadata
- 先看：`cli/localCommands.ts`、`cli/naturalRouting.ts`、`cli/commandMetadata.ts`
- `cli/index.ts` 只保留 thin `main` export
- 验证：`tests/unit/cli/*`、`check:cli-parity`、`check:param-surface`

### 改 WebSecurity mature bridge
- 先看：`src/tools/webSecurity/bridges/*`
- 共享 launcher/diagnostics：`src/tools/webSecurity/shared/matureBridge.ts`
- 不新增公开 tool；只增强现有 bridge 的 scoped 输入、结构化诊断、artifact

## 验证顺序

1. 最小局部验证
   - `npm run test:unit`
   - 或 `npm run check:all:bridge`
   - 或 `npm run check:all:package`
   - 或 `npm run check:all:contracts`

2. 协议改动
   - `npm run sync:protocol`
   - `npm run check:protocol`
   - 提交前确认 `lefthook` 已通过 `prepare` 安装；schema 改动时 pre-commit 会自动 sync + stage 生成产物

3. 最终门禁
   - `npm run check`

4. 改 bridge/runtime 后
   - `npm run build:bridge`
   - 必要时 `npm run smoke:browser:isolated`

## 不要做

- 不新增重叠 `browser_*` 工具
- 不在 `registerTools.ts` 放领域逻辑
- 不手改生成文件
- 不把 runtime smoke 接回默认主检查链
- 不在 tool 层编码策略、站点判断或隐式 scanner 编排
