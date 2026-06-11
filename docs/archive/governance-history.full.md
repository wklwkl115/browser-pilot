# Governance Detailed History

## 203. 支柱五：本地质量门禁脚本

- [x] 性质判定：本地开发质量门禁，不引入 GitHub Actions、Dependabot、自动发布 registry、强制 Husky hook 或远程 CI 依赖。
- [x] 决策：新增 `npm run quality:local`，串联 `npm run build:bridge`、`npm run check`、`npm pack --dry-run --json`，作为发布/合并前默认质量门禁。
- [x] Smoke 边界：`npm run smoke:browser:isolated` 保持手动/可选门禁；`quality:local` 只输出下一步提示，不默认启动真实 Chrome/Edge，契约已锁定脚本不在 gate 段调用 smoke。
- [x] 文档：README/AI_INSTALL/TODO 记录本地门禁命令、适用场景、失败 artifact 位置和端口占用处理方式。
- [x] 验证：本地门禁脚本在当前开发树运行；脚本只编排 build/check/pack，不修改工具能力、协议或 runtime 行为。干净 checkout 的最终运行留给提交后发布/合并前复核。

## 204. 支柱五：本地并发、生命周期与泄漏验证

- [x] 性质判定：风险导向测试增强，不追求固定覆盖率数字，不引入 Playwright/Puppeteer 作为默认依赖。
- [x] 覆盖范围：新增 `tests/contracts/runtime/check-lifecycle.mjs` fake WebSocket fixture，覆盖多浏览器同数值 `tabId`、`selectBrowser`、WS 断连/重连、MV3 service worker restart、pending request cleanup、tab command queue、wait/network/hook 长任务。
- [x] Artifact：失败时写入 `.pi/browser-artifacts/lifecycle-fixture-failure.json`，包含 bridge snapshot、pending、target selection、listener/CDP/network recorder 状态；cookie/token/authorization/body/postData 等字段按字段名脱敏，不泄漏正文。
- [x] 契约：本地 fixture 使用真实 `BrowserBridgeServer`、`BrowserWaitSupervisor` 与 fake WebSocket 行为断言复现生命周期问题；未用源码字符串检查替代行为断言。
- [x] 验证：新增 `check:lifecycle` 并纳入 `npm run check`/`quality:local`；isolated smoke 仍保持单独手动运行。

## 205. 支柱五：协议与工具文档本地生成

- [x] 性质判定：文档同步成本治理；目标是减少 native schema、tool schema、README、skill、contract 多处手写漂移。
- [x] 决策：新增 `scripts/generate-tool-docs.mjs` 与 `npm run docs:generate`，从 `bridge/native_command_schema.json`、实际 `pi.registerTool` 元数据和源码结构化错误码生成可审核的工具清单、参数表、native command 表、错误码/Artifact 行为片段。
- [x] 边界：不采用 TypeDoc 作为主要产物；生成文件 `docs/generated/browser-tool-contract.generated.md` 以 callable tool/native command/error/artifact 契约为中心，不暴露内部源码 API 作为用户接口。
- [x] 同步：生成产物进入仓库 docs；`check:tool-docs` 已追加 `node scripts/generate-tool-docs.mjs --check` 漂移检查；本轮未修改全局 skill，因此未运行 skill quick validate。
- [x] 验证：生成脚本幂等；`npm run check:tool-docs` 可发现生成产物与工具/schema/错误码不一致，且 `npm run check` 会覆盖该检查。

## 206. 支柱五：本地依赖与安全审计策略

- [x] 性质判定：本地依赖治理，不接入远程 Dependabot/SonarQube/Sentry；保持生产依赖少而可审计。
- [x] 决策：新增 `check:deps`，覆盖 `package.json`/`package-lock.json` 根依赖一致性、生产依赖 allowlist、`npm ls --json --all`、`npm audit --omit=dev --audit-level=high` 可用性和生产依赖清单漂移。
- [x] 升级流程：README/AI_INSTALL 记录依赖升级必须包含范围、兼容性风险、回滚方式，并通过 `npm run check`、`npm pack --dry-run --json`，必要时运行 isolated smoke。
- [x] 安全边界：不接入外部错误追踪服务；`check:deps` 只写本地 `.pi/browser-artifacts/dependency-audit-summary.json`，不发送 cookie/token/网络正文。
- [x] 验证：依赖检查命令失败信息可执行；registry/DNS/timeout 不可用时记录 `npmAudit.status:"unavailable"` 并通过，避免普通离线开发被短暂 registry 问题阻塞；高危/严重生产漏洞、lockfile 漂移或依赖树问题会失败。

## 207. 支柱五：`BrowserBridgeServer` 职责拆分

- [x] 性质判定：Node driver 内部架构重构，不改变公开工具名、参数、错误码、artifact 或 bridge 协议。
- [x] 拆分边界：已将 HTTP/WS server、client registry、tab/session router、pending request manager、target selection diagnostics 拆到 `BrowserBridgeHttpServer.ts`、`BrowserBridgeClientRegistry.ts`、`BrowserTabSessionRouter.ts`、`BrowserBridgePendingRequests.ts`、`BrowserBridgeDiagnostics.ts`；`BrowserBridgeServer.ts` 保持 thin facade。
- [x] 行为不变：多浏览器同数值 `tabId`、`selectBrowser`、default/latest fallback、`selectionVersion`、断连 session retention、pending timeout diagnostics 全部由 fake WS/lifecycle fixture 覆盖并保持兼容。
- [x] 契约：`check:fake-ws` / `check:lifecycle` 覆盖 ambiguous tab、stale tab、client disconnect、bridge stop、timeout ACK/no-ACK、MV3 restart 与长任务 pending；`check:tools` 更新为跨 driver 模块边界断言，减少对单文件私有实现字符串的依赖。
- [x] 验证：拆分后已运行 `check:fake-ws`、`check:lifecycle`、`check:tools`、`check:protocol`、`check:pi-browser-bridge`；随后全量 `npm run quality:local` 复核。isolated smoke 仍保持手动可选，TODO 202 已有 Edge artifact。

## 208. 支柱五：统一 Tool Adapter 与结果处理中间层

- [x] 性质判定：工具注册层去重，不新增工具能力，不修改外部 callable contract。
- [x] 收口范围：新增 `src/tools/toolAdapter.ts`，统一 `sharedTabScopedToolParams`、`timeoutMs/maxChars` 归一、`runTool` 错误包装、`jsonToolResult/textToolResult` 中间层、bridge nested error 映射与 artifact fallback 命名。
- [x] 迁移范围：`scan/content/html/execute/pick/evidence/transfer/nativeAction/screenshot/artifact/tabs` 注册层已改走 adapter；WebSecurity shared shell 改走 adapter，并补 `sharedWebSecurityParams`、`sharedWebSecurityBrowserSessionParams`、`sharedWebSecurityResultParams` 三类共享参数 helper。
- [x] 边界：各工具领域逻辑仍保留在原模块；`registerTools.ts` 继续只做组合入口；WebSecurity 12 个注册模块继续显式注册、具名 ToolParams 归一和 shared shell 执行，不把 cookie binding、summary 或成熟引擎逻辑搬进 adapter。
- [x] 契约：现有 `browser_*` 名称、promptSnippet/guidelines、TypeBox 参数、summary/saved envelope、错误码保持稳定；contracts 已兼容并锁定 `toolAdapter`、`jsonToolResult/textToolResult/runTool`、WebSecurity 唯一 shared shell 与生成文档 drift。
- [x] 文档生成：`scripts/generate-tool-docs.mjs` 已识别 adapter/shared helper、`sharedTransferParams()`、WebSecurity browser-session/result params 与 `includeTabId:false`，`browser_download/browser_upload` artifact 行保持 `outputPath/artifact`。
- [x] 验证：已运行 `npm run docs:generate`、`check:tool-docs`、`check:tools`、`check:pi-browser-bridge`、`check:web-security`、`check:transfer`、`check:artifact`；最终以本项收口后的 `npm run check` 与 `npm run quality:local` 复核。

## 209. 支柱五：协议单源化终态设计与实现

- [x] 性质判定：协议治理重构；目标是把 native command、tool 参数、错误码、文档片段和测试 fixture 尽量收敛到单一可生成源。
- [x] 设计：已新增并归档为 `docs/archive/protocol-single-source-plan.full.md`，明确继续以 `bridge/native_command_schema.json` 为单源，不引入外部 IDL；记录生成产物、人工维护边界、兼容策略和回滚方式。
- [x] 生成范围：`scripts/sync-native-protocol.mjs` 支持 `--check` 并生成 `bridge/pi_browser_bridge/native_command_schema.json`、`bridge_src/service_worker/protocol.ts`、`src/protocol/nativeProtocol.ts`、`src/protocol/nativeActionMetadata.ts`、`src/protocol/nativeErrorCodes.ts`、`docs/generated/native-protocol.generated.md`。
- [x] 迁移边界：首批只迁移 `browser_wait`、`browser_network` 与 `browser_download`/`browser_upload`；wait/network action alias、actionDescription、transfer command/artifact metadata 已从生成产物消费，hook/frame/html/screenshot/evidence 后续按域迁移。
- [x] 错误码：`bridge/native_command_schema.json` 已维护 60 个结构化错误码，覆盖 driver/runtime/tool 当前公开错误码；`check-protocol-contract.mjs` 会扫描 `src` 与 `bridge_src` 中结构化 code，发现 schema 漏项即失败。
- [x] 契约：`check:protocol` 先跑 `sync-native-protocol.mjs --check` 再跑 protocol contract；契约锁定生成文件头、生成文档、wait/network/transfer metadata 消费、root/bridge schema 一致和手改生成产物 drift。
- [x] 验证：已运行 `npm run check:protocol`；本项最终门禁继续以 `npm run check` 与 `npm run quality:local` 复核，未修改全局 skill。

## 210. 支柱五：Web Security 子域边界加固

- [x] 性质判定：同包内边界强化，不拆出新的 Web 扩展，保持 `pi-browser-tools` 一个 Web 包；本项不新增 callable tool、不扩大默认扫描/外部进程行为。
- [x] 边界：`register/` 只保留 schema、具名 ToolParams 归一和 shared shell 调用；crawl/fuzz/sqlmap/nuclei/callback/cookieAnalyze/httpReplay 只能通过 cookie/HAR/raw-request/artifact/browser-native/shared adapter 访问基础 browser 能力。
- [x] 输入输出：`executeWebSecurityToolShell` 统一 timeout/maxBodyBytes/maxChars、cookie provider、artifact fallback、result distill；新增 `webSecurity/shared/diagnostics.ts` 统一 WebSecurity domain failure envelope、敏感字段脱敏与 stack suppress；sqlmap/nuclei bridge 继续通过 bounded `spawnSync`、request/stdout/stderr artifact 和 replay inputs。
- [x] 契约：`check-web-security-tools.mjs` 增加 domain boundary contract，锁定 register/browserNative/bridges/shared 分层、`webSecurityCore` 只做兼容 re-export、基础 `registerTools` 不直接导入实现层、WebSecurity 模块不反向依赖 driver/bridge runtime/chrome API。
- [x] 验证：`npm run check:web-security` 已通过；最终门禁继续以全量 `npm run check` 与 `npm run quality:local` 复核。不引入自动扫描默认路径。

## 211. 支柱五：Artifact 与证据隐私治理

- [x] 性质判定：本地证据治理；保护 cookie/token/authorization/postData/body/websocket payload 等敏感内容，同时保留可审计原始证据路径；不新增外部上传、远程存储或清理守护进程。
- [x] 策略：新增 `src/utils/redaction.ts` 与 `src/tools/artifactPrivacy.ts`，统一 artifact 分类 `local_raw_evidence`、默认根 `.pi/browser-artifacts/`、`localOnly:true`、手动清理提示、summary/details/error/browser_artifact 默认脱敏规则。
- [x] 边界：`outputPath`/自动落盘 artifact 继续保存完整原始 envelope/artifactValue；summary/full/details/error content 默认脱敏，敏感 full 结果返回 `saved_to_artifact`；`browser_artifact` 默认脱敏读取，只有显式 `redact:false` 才返回本地原始证据。
- [x] 契约：`check-token-contract.mjs` 覆盖 error/resultMiddleware 的 cookie/token/authorization/body/postData/websocket 脱敏与原始 artifact 保真；`check-artifact-reader.mjs` 覆盖 text/json/search/sample 默认脱敏、privacy metadata 与 `redact:false` 显式原始读取。
- [x] 验证：已运行 `docs:generate`、`check:token`、`check:artifact`、`check:summaries`、`check:errors`、`check:tools`、`check:tool-docs`，并通过全量 `npm run check` 与 `npm run quality:local` 复核。

## 212. 支柱五：可重放 runtime fixture 库

- [x] 性质判定：本地可复现测试资产建设，减少复杂行为只能靠真实浏览器 smoke 发现的问题；不新增 callable tool，不引入浏览器自动化重依赖。
- [x] 覆盖：新增 `tests/contracts/runtime/check-runtime-fixtures.mjs`，覆盖 network body/postData/HAR 与 WebSocket frames、hook session/listener cleanup、wait immediate selector 状态、transfer direct/click download 与 upload、frame evaluate、screenshot visible-tab fallback、callback worker state file 与 stale lock recovery；MV3 restart/lease 继续由 `check:lifecycle` 的 fake WebSocket supervisor fixture 覆盖。
- [x] 形式：使用本地 HTTP/WS fixture、fake Chrome/CDP API、可重放 bridge envelopes；未引入 Playwright/Puppeteer。
- [x] Artifact：成功摘要写 `.pi/browser-artifacts/fixtures/runtime-fixtures-summary.json`，失败诊断写 `.pi/browser-artifacts/fixtures/runtime-fixtures-failure.json`；临时输入写测试临时目录，callback session 结束后清理，诊断按字段名脱敏 cookie/token/authorization/body/postData/payloadData。
- [x] 验证：新增 `check:runtime-fixtures` 并纳入 `npm run check` / `quality:local`；已运行 `npm run check:runtime-fixtures`，最终门禁继续以全量 `npm run check` 与 `npm run quality:local` 复核。

## 213. 支柱五：错误码与诊断 taxonomy 收口

- [x] 性质判定：错误体系治理；本轮不新增 callable tool、不重命名公开错误码，只在 Node/tool 归一化输出中补充 `taxonomy` 与 `diagnostics`。
- [x] 分类：`src/utils/errors.ts` 已统一 driver/tool/native/page/CDP/network/transfer/security/artifact/protocol/unknown domain；优先消费 `src/protocol/nativeErrorCodes.ts` 的 schema category/retryable/summary，schema 外 artifact/CDP/page/tool timeout 使用显式 heuristic 分类。
- [x] 诊断：归一化错误保留原 `code/message/details/name`，新增 `taxonomy.domain/category/retryable/source/summary` 与紧凑 `diagnostics.scopes`，从 details 提取 target(tab/browser/source/selectionVersion)、session(request/wait/listener/session id)、pending(id/acked/timeout/pendingCount)；完整 details 仍按原路径保留并脱敏输出。
- [x] 兼容：保留现有公开错误码与 bridge/native response envelope；`INVALID_BROWSER_COMMAND` 额外标为 protocol domain，不改变 code；WebSecurity 继续使用 domain failure envelope，Node 侧归类为 security。
- [x] 契约：扩展 `check-errors`，覆盖 BrowserBridgeError、ArtifactReaderError、protocol/native response、nested bridge response、transfer validation、WebSecurity failure、CDP/tool 分类、stack strip、secret redaction 与 circular details。
- [x] 文档：`docs:generate` 生成 `Structured error taxonomy` 表；README/AI_INSTALL/CHANGELOG/TODO 记录 `check:errors` 与 taxonomy 边界。
- [x] 验证：已运行 `npm run check:errors`；最终门禁继续以全量 `npm run check` 与 `npm run quality:local` 复核。

## 214. 支柱五：本地发布包验收与回滚演练

- [x] 性质判定：本地发布可靠性验证；不配置远程 registry、自动发布或远程 CI，只新增本地脚本和可审计 artifact。
- [x] 验收：新增 `npm run release:local`，脚本位于 `tests/release/release-local-acceptance.mjs` 以符合 scripts 边界；在 `.pi/browser-artifacts/release-acceptance/work/pack-run` clean cwd 执行 `npm pack --dry-run --json` 与实际 pack，解包检查 manifest `dist/service-worker.js`、dist page bundles、native schema、source maps 和 `build-manifest.json` 的 `serviceWorkerBuildMode:"esm-import-graph"` / `orderedConcatenation:false`。
- [x] Runtime smoke：`npm run release:local:smoke` 支持对当前解包扩展运行 full isolated smoke；`tests/smoke/smoke-browser-isolated.mjs` 支持 `PI_BROWSER_SMOKE_EXTENSION_DIR` / `PI_BROWSER_SMOKE_RESULT_PATH` / 失败临时目录保留。
- [x] 回滚：脚本把上一成功包轮转到 `previous/`，保存当前包到 `last-successful/`；`release:local:smoke` 对上一包执行最小 tabs/wait/execute rollback smoke。
- [x] 文档：AI_INSTALL/README/CHANGELOG/TODO 记录本地打包验收、回滚步骤、必附 artifact 与失败排查字段。
- [x] 失败诊断：`release-acceptance-summary.json` 输出 pack 文件列表、build manifest、Chrome profile、bridge port、smoke artifact；失败时可用 `--keep-temp-on-failure` 或 `PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE=1` 保留临时 profile/extension。
- [x] 验证：已运行 `npm run release:local`；已用 Edge 运行 `PI_BROWSER_SMOKE_CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm run release:local:smoke`，当前包 full isolated smoke 和上一包最小 rollback smoke 均通过。关键 artifact：`.pi/browser-artifacts/release-acceptance/release-acceptance-summary.json`、`current-smoke-browser-isolated-results.json`、`rollback-smoke-browser-isolated-results.json`。

## 215. 支柱五：仓库换行治理基线

- [x] 性质判定：本地开发一致性治理，不改变 runtime、tool schema、artifact、协议或构建产物语义。
- [x] 决策：新增 `.gitattributes`，固定 TS/JS/MJS/JSON/Markdown/YAML/HTML/CSS/SVG 为 LF，图片与压缩包为 binary；不做全仓换行重写，避免制造无意义大 diff。
- [x] 验证：运行 `git diff --check`，确认无 whitespace error；后续新增/修改文本文件由 Git attributes 统一规整，减少 Windows/Git Bash 下 CRLF 噪声。

