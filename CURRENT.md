# CURRENT

## 当前状态

- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前主链路：`browser_tabs list` / `browser_tabs switch|create` -> 显式 `tabId` -> `browser_observe mode=scan|content|html|text|tabs` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前工具边界：不恢复 `browser_orchestrate` / target resolver；除已冻结但未实施的 `browser_memory` v1 执行合同外，不新增公开 `browser_*` 工具；MCP-only 能力不进入 Pi adapter 工具面。
- jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：只吸收能力模型与证据路径，不新增被拒绝的公开工具 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`。
- 修改协议/工具后先跑 `npm run check`；局部回归优先 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。
- 仓库单一源码根：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅作本地导出/归档产物。

## 当前激活项

当前激活主线：ABML（Agent Browser Modeling Language）执行落地。执行 source of truth：`docs/abml-execution-plan.md`；设计源：`docs/unified-browser-modeling-language-plan.md`；P1 规格源：`docs/abml-p1-spec.md`。

执行边界：P1/P2/P3/P4 内部 gate 已通过；P5 已完成 AX source adapter、AX→Entity、DOM/AX merge，并通过 `check:all:bridge`，且真实 AX smoke 已收口（证据：`.pi/browser-artifacts/smoke-browser-ax-merge-results.json`）。P5S 已完成 CaptureRef lifecycle、network-entry/event 流实体、payloadHandle inspect、network-entry→http_replay 边界与 lifecycle tests。P6/P7 已完成内部 ABML runtime/contract 层：虚拟滚动稳定停止、closed-shadow pierce、frame/OOPIF 显式边界、region 视觉地板、point-backed region 动作与 screenshot-backed inspect。P8 已完成 envelope 升级内部收口：DistilledEnvelope 新增 `entities/error`、`sections[].handle` 接受 `pi-ref://data-slice/*`、`nextActions` 去本地 path 泄露并转向动词/`read_saved_artifact` 建议、AbmlError 默认脱敏，并通过 token/structured-envelope/output-schema/mcp-sections gate。P9 已完成：公开 callable surface 继续保持既有 `browser_*` canonical face，不新增 ABML verb tool 名；README / generated docs / CHANGELOG / skill 已同步，skill validate 通过，`npm run check` 与 `npm pack --dry-run --json` 通过。其后已开始“内部接线拿证据”阶段：`browser_observe mode=scan|text` 内部已接 ABML `read`，并在 `details.abml.integrated/entityCount/primaryEntityCount/listEntityCount/visualRegionCount/frameEntityCount` 暴露事实性诊断；`browser_execute monitor:true` 当前只接观察侧，优先走 ABML `read`，失败时回退旧 scan helper；`browser_frame` 结果层现已显式暴露 `abmlIntegrated/entityCount/frameCount`。真实证据现已补齐六条：`.pi/browser-artifacts/smoke-browser-scan-summary-results.json` 证明 observe 主链仍稳定；`.pi/browser-artifacts/smoke-browser-correlation-chain-results.json` 证明 observe artifact 已出现 ABML 主实体投影、execute monitor 已出现 ABML-integrated monitor 证据；`.pi/browser-artifacts/smoke-browser-abml-monitor-comparison-results.json` 提供同一真实 fixture 上 legacy scan diff 与直接 ABML read 的对照结果；`.pi/browser-artifacts/smoke-browser-abml-frame-compare-results.json` 证明同源 frame 场景下 ABML frame entities 已进入真实 observe 路径，且 frame result 层可直接看到 `abmlIntegrated/frameCount/entityCount`；`.pi/browser-artifacts/smoke-browser-abml-vision-compare-results.json` 证明 canvas/vision 场景下 ABML visual regions 已进入真实 observe 路径，且 observe 结果可直接看到 `visualRegionCount`。当前证据说明“内部接线已经真实生效”，并进一步显示 ABML 在 frame/vision/AX 盲区下更富结构化实体信息；但 monitor 对照也表明 diff 文本并不天然更紧凑，因此更像 observe/monitor/frame 底层增强，而不是直接推出公开 verb surface 的证据。`smoke:browser:isolated` 仍因当前环境 `spawn EINVAL` 失败，记为环境问题而非代码 gate 失败。后续阶段仍不得实现 in-page `pi.*`。

执行队列：ABML 主线当前进入结论收口状态。现阶段不启动公开 ABML tool surface RFC；ABML 继续作为现有 `browser_*` 的内部 substrate。后续若继续，应只在新的执行计划中推进更深内部整合，或在出现“现有 public surface 明显不足”的真实 transcript 证据后，再考虑公开面 RFC。

最近一轮延后债已按收窄边界完成。

事实核查结果：

| 项 | 状态 | 证据 / 处理 |
| --- | --- | --- |
| M-001 BrowserBridgeServer 深拆 | 已完成第一轮，当前不继续扩 scope | 已拆 `BrowserBridgeCommandService` / `BrowserBridgeClientMessageService`，facade public API 保持稳定。 |
| M-002 network recorder 事件分支拆分 | 已完成 | `bridge_src/service_worker/network_events.ts` 已承载 CDP event/body helper，`network.ts` 只保留生命周期与命令分发。 |
| M-003 `PiBridgeResponse.error` 类型收敛 | 本批已完成 | `bridge_src/service_worker/types.ts` 已收口为 `PiBridgeResponseError` 联合，去掉 `JsonRecord & ...` 顶层扩展。 |
| M-004 TODO 189 口径遗留 | 本批已完成 | contracts 去掉 `boundary marker for TODO 189` 兼容，只保留稳定 `ESM module metadata` 口径。 |
| M-005 wsSession 终态保留上限 | 已完成 | `WS_SESSION_RETAIN_CLOSED_MS` / `WS_SESSION_MAX_RETAINED_TERMINAL` / `pruneTerminalWsSessions()` 已存在。 |
| M-006 toolAdapter 双重断言/原地错误改写 | 本批已完成 | `runWebSecurityTool()` 已用真实 `TPrepared` 泛型去掉 `as unknown as TRunParams`，`attachOperationToError()` 不再 `Object.assign(new Error(...))`。 |
| M-007 写命令列表与 schema 重复 | 已由 H-001 关闭 | access mode 已来自 protocol schema。 |
| M-008 session registry 隐式创建 | 已完成 | `BrowserSessionRegistry.require/getIfExists/create` 已拆分，miss 会 `SESSION_NOT_FOUND`。 |
| M-009 intercept access mode 重复 | 已由 H-001 关闭 | access mode 已 schema 单源。 |
| M-010 network model 摆脱 `JsonRecord` 基类 | 待做 | `network.ts` / `network_model.ts` 仍大量使用 `JsonRecord`。 |
| M-011 bridge WebSocket 连接数上限 | 已完成 | `BrowserBridgeHttpServer` 已有 `PI_BROWSER_BRIDGE_MAX_CONNECTIONS` / 503 拒绝与单测。 |

本轮完成结果：

- M-003：`PiBridgeResponse.error` 收口为显式 `PiBridgeResponseError` 联合，去掉过宽 `JsonRecord & ...` 顶层扩展。
- M-006：`runWebSecurityTool()` 去掉 `as unknown as` 双重断言；`attachOperationToError()` 改为稳定 `BrowserBridgeError` 包装，不再 `Object.assign(new Error(...))`。
- M-004：contracts 不再兼容 `boundary marker for TODO 189` 历史口径，只保留稳定 `// ESM module metadata`。
- helper/parse/drift：新增 `parseJsonOrThrow()`；`BrowserBridgeClientMessageService`、`webSecurity/shared/replay.ts`、`oastWorkerManager.ts` 收口到共享 parse helper；`check-boundaries` 现在约束 `src/` 内 `JSON.parse` 只允许留在审核过的固定 roots。
- H-002 收窄批：runtime state map 的 `chrome.storage.session` load/save 失败已显式 `console.warn`；`ws.close` 显式关闭失败已可见；目标文件中剩余 silent catch 保留为 A 类 best-effort cleanup/probing。
- M-010 core-only：network 新增显式 `NetworkRecorderSummary` / `NetworkClearResult` / `NetworkHarContent` / `NetworkHarEntry` 类型，`network.ts` / `network_model.ts` 主链不再只用泛化 `JsonRecord` 表达 summary/clear/HAR 结果。

验证结果：`npm run check:src:types`、`npm run check:boundaries`、`npm run check:all:contracts`、`npm run check` 已通过。

## Next backlog

当前无新的工程债 backlog；后续仅保留 future-facing 路线到 `ROADMAP.md`。

## 已完成但最近容易误标为当前的队列

- MCP 标准化 + 渐进式披露 Phase -1 -> Phase 10 已完成；eval 28/29 已改为 passed，token economy 已扩到 9 fixtures。
- MV3 runtime state recovery Phase 1-5 已完成；`state_store`、network/intercept recoverer、hook/ws/CDP diagnostics、runtime recovery error codes 与 contracts 已落地。
- Web Security affordance / validation / recovery 收口已完成：summary `nextActions`、集中 validator、recovery 透传、Type.Any 高频迁移均已落地。
- bridge runtime hardening broad 计划已完成 H-001/H-003/H-004/H-005；剩余 H-002 已单列 backlog。
- 工具面治理、架构与工程化设计改进、工具层参数契约、ESLint debt ratchet、cross-tool correlation metadata、JS AST、DOM flow、Wasm、Stateful WS 等均为已完成归档项。

## 后续路线

- Future-facing 能力方向保持在 `ROADMAP.md` 与对应 RFC/eval 文档中；未进入本文件的项不是当前执行队列。
- 下阶段 Web reversing/security primitives 已完成 phase 1 的项不自动升级 phase 2；新 phase 必须先补边界、contracts、eval。
