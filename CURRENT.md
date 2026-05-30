# CURRENT

## 当前状态

- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前主链路：`browser_tabs list` / `browser_tabs switch|create` -> 显式 `tabId` -> `browser_observe mode=scan|content|html|text|tabs` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 已冻结下一阶段工具面治理计划：`docs/tool-surface-consolidation-plan.md`。该计划是 TODO 244-249 的执行合同；实现前不得按口头讨论临时改 schema、工具名或文档口径。
- 已完成方向：`browser_observe` 已成为观察层 canonical surface；`browser_execute` / `browser_command` 已拆分完成；recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata、Web Security capability profiles 已落地。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎仅以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- 本轮已完成 `cross-tool evidence correlation metadata` 收口：不新增公开 `browser_*` 工具，在现有 distilled result envelope、artifact summary、workflow eval 与 runtime smoke 内补齐 `operationId`、`snapshotId`、`requestId`、`waitId`、`listenerId`、`sessionId`、`selectionVersion*`、`sourceMode` 等跨工具对账线索。
- TODO 200-215 工程治理期已完成；后续新增能力、公开工具变更、bridge 协议变更、工具注册条件变更必须先在本文件和 `docs/tool-surface-consolidation-plan.md` 补决策、边界文档、契约与验证计划。
- 下阶段 problem-area 规划已冻结到 `docs/next-phase-web-reversing-and-security-primitives-plan.md`；其中“请求/响应拦截与热补丁原语”phase 1/2、“JS AST / 反混淆分析原语”phase 1、“DOM 事件链 / sink-flow 分析辅助”phase 1、“Wasm 逆向桥接”phase 1 与“Stateful WebSocket replay/fuzz primitives” phase 1 均已完成并归档。
- 当前 active queue：MV3 runtime state recovery，执行合同见 `docs/mv3-runtime-state-recovery-plan.md`。目标是把 Service Worker 重启后的 network/intercept/ws/CDP/hook 长生命周期状态丢失改为自动恢复或显式 `RUNTIME_STATE_*` 诊断；不新增公开工具，不恢复 orchestration。
- 当前并行收口队列：Web Security affordance / validation / recovery。目标是补齐 follow-up affordance、运行时参数校验、恢复提示透传与高频 schema 收敛，降低 agent 在原子工具之间的接缝猜测成本；不新增公开工具，不做跨工具自动调用，不把 nextActions 变成单一路径 workflow。
- 当前新增治理队列：共享 helper 去重 / parse 策略 / 防漂移治理。目标是收敛 `isRecord` / `recordValue` 重复定义、减少 `src/` 内联 object-guard、统一核心 `JSON.parse` 热点策略，并用 contract 防止新代码继续漂移；不处理生成文件，不做大规模无收益 rename/alias 清扫。
- 已撤回 `browser_orchestrate` / orchestration coordinator / target resolver 工具面；默认浏览器自动化保持 `browser_tabs` first + 显式 `tabId`，观察层已由 `browser_observe` 承载。
- 后续仍保持能力完整性：不新增工具层安全闸；安全边界继续由 Pi 平台/安全层负责；新增高层状态管理必须先证明比显式 tab 流程更低模型负担。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。如需按故障域局部回归，使用 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。
- 仓库收敛规则：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅保留为本地导出/归档产物，不得再作为并行开发仓库。

## 已完成归档摘要（241-249）

- 241：完成 jshookmcp 能力原生吸收闭环；只吸收能力模型与证据路径，不新增 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`；闭环账本见 `docs/jshookmcp-native-absorption.md`。
- 242：完成 `browser_scan` high-entropy summary v2；默认摘要升级为 Scan Manifest v2，新增 `artifact_hints` 精确导航，并补本地 eval、fixture、contracts、`smoke:browser:scan-summary`。
- 243：完成 Debugger evidence workflow RFC/eval 收口；现有 `browser_execute` + `persistent_cdp` 已能稳定产出 debugger evidence，剩余缺口收缩为 page-authored provenance 与 pause/breakpoint/step 生命周期，继续保持 RFC-only。
- 244-249：完成工具面治理主链收口；`browser_observe` 成为观察层 canonical surface，`browser_execute` / `browser_command` 拆分完成，recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata、Web Security capability profiles 全部落地并通过 `npm run check`。
- 详细过程、证据与边界已迁入 `ARCHIVE.md`；本文件不再保留 241-249 的逐项长记录。

## 工具面治理执行原则（TODO 244-249，计划冻结）

- 计划合同：`docs/tool-surface-consolidation-plan.md` 是 TODO 244-249 的唯一执行合同。实现时只允许收敛该文档，不允许创建平行计划或临时口径。
- 能力完整：不得通过风险分级、任务分类、站点判断或默认禁用削弱 Web 安全能力；可见工具面缩减只能通过显式 profile/config，并且必须可诊断、可启用。
- 语义单例：迁移期允许 wrapper，但每个 wrapper 必须有退出步骤；不能长期保留两个 canonical callable surfaces。
- 原子组合：不新增 `browser_orchestrate`、target resolver、desired-state coordinator、自动选择 tab、自动选择观察 mode、自动 scanner 策略器。
- 证据优先：observe、command、progress、multi-search、snapshot、operation metadata 都必须保留 final envelope 和 artifact evidence；stream/progress 不能替代最终结果。
- 可恢复诊断：recovery hints 只做工具+参数级 nextActions，不自动执行，不吞原始错误码，不提供漏洞利用策略。
- Web Security affordance 收口边界：只补“可能的后续动作 / common follow-ups”、输入组合校验、结构化 recovery 与 schema 可推断性；禁止在工具内部自动串联 `crawl -> fuzz -> sqli`，禁止自动升级 mode/engine/action，禁止伪造 `rawRequest` 或其他中间态，禁止把提示写成命令式唯一下一步。
- 失效显式：cache/snapshot/lease/queue/operation 冲突都必须带 target、selectionVersion、stale/conflict reason；禁止 silent fallback。
- 完成标准：每个 TODO 完成时必须同步 `CURRENT.md`、`ROADMAP.md`、`docs/tool-boundaries.md`、README、CHANGELOG、generated docs、全局 skill（如影响运行时选择）、contracts/evals，并运行对应 check；不能只完成代码或只完成文档。

## 当前执行队列

### 进行中：Web Security affordance / validation / recovery 收口

状态：待实现，作为当前并行治理收口；保持现有 callable tool surface 与 capability profile，不新增公开 `browser_*` 工具。

目标：

- 为 Web Security follow-up 工具补齐 agent-first affordance，而不是引入固定 workflow。
- 让原子窄工具之间的接缝可见：summary follow-up、参数组合校验、结构化 recovery、热字段 schema 收敛。
- 降低 agent 对 mode/engine/action/输入源的猜测成本，同时保持 Brain-Hand Separation。

实施原则：

- nextActions 只提供 `possible/common follow-ups`，不自动执行、不单路编排。
- validator 只拒绝无效组合，不隐式改写 mode/engine/target。
- summary 只暴露句柄/证据/提示，不伪造请求模板或跨工具中间态。
- 错误只给 factual recovery，不给 exploit strategy。

计划范围：

1. 修复 `src/tools/webSecurity/shared/http.ts` 中过时 `browser_recon_probe` 错误文案，改成工具无关的输入缺失提示。
2. 为 7 个 Web Security register 工具补共享 guideline：明确 HTTP target execution 由 Node.js `fetch` 直接发起，仅可选注入 browser-session cookies；文案避免把非 HTTP-only action 误写成总是发请求。
3. 在 `resultMiddleware` 中把 `summary.nextActions` 作为域级提示上浮到顶层 envelope `nextActions`，保持 additive contract；域级提示优先，但仍与 artifact/截断/target 诊断型提示并列，不变成固定下一步。
4. 为 Web Security summary 层补 `nextActions`：至少覆盖 `recon`、`crawl`、`fuzz` 三种 mode、`sqli` builtin、`bridges`（sqlmap/nuclei）、`template`、`oast`、`cookie`、`replay`；所有提示使用并列 follow-up，不写成命令式单路径。
5. 在 `src/tools/webSecurity/register/shared.ts` 集中新增 validator：`validateCrawlParams`、`validateFuzzParams`、`validateSqliParams`、`validateTemplateParams`、`validateOastParams`、`validateHttpReplayParams`。校验同时覆盖：
   - 至少一个有效输入源存在；
   - mode/engine/action 不接受无关字段；
   - 错误用 `INVALID_RULE` + structured `recovery.nextActions` 返回。
6. 透传已有 `details.recovery`：`normalizeError()` 保留并与 code-generated recovery 合并，existing recovery 优先；`webSecurityToolError()` 把 recovery 写回 envelope。
7. 增量替换高频 `Type.Any()`：优先 `headers`、`requestHeaders`、`responseHeaders`、`locations`、`probeTypes`、`dbms`、`tamper`、`tags`、`excludeTags`、`severities`、`authors`、`templateIds`、`matchStatus`、`filterStatus`、`filterBodyBytes`。复杂对象如 `request/har/mutations/multipart/templates/variables/jsonValues/cookies/claimMutations` 保持 `Type.Any()`。

明确非目标：

- 不在工具内部自动调用其他工具。
- 不新增 `browser_orchestrate`、scanner strategy router、auto mode/engine selection。
- 不从 `crawl` 伪造 `rawRequest`；真实模板仍来自 `browser_network` / HAR / captured request。
- 不改变 direct `fetch()` 绕过 bridge 的架构选择。
- 不拆 `browser_sqli` 的 bounded multi-stage builtin flow。

验证计划：

- `npm run check:summaries`
- `npm run check:errors`
- `npm run check:web-security`
- `npm run check`
- 若更新 docs 索引结构，再跑 `npm run docs:sync-indexes`

文档同步要求：

- 同步 `CURRENT.md`、`TODO.md`、`README.md`、`CHANGELOG.md`。
- 若公开 contract 文案或 tool guideline 有实质变化，同步 `docs/tool-boundaries.md`、`docs/reference/web-security-methodology-map.md` 与全局 `pi-browser-tools` skill。

最终判定标准：

- Agent 获得更清晰的 follow-up affordance 与恢复提示；
- 工具仍保持原子、显式、可组合；
- 没有把 affordance 演化成固定 workflow。

### 计划中：共享 helper 去重 / parse 策略 / 防漂移治理

状态：计划冻结，待实现。该治理项只处理真实高价值技术债，不把低收益别名清扫扩成全仓噪音改动。

问题核查结论：

- `isRecord`：`src/` 内 8 处定义，`bridge_src/` 内 1 处定义；另有 `src/` 内联 `typeof ... === "object" && !Array.isArray(...)` 守卫 24 处。属于真实重复与持续漂移问题。
- `recordValue`：`src/utils/records.ts` 与 `src/tools/summaries/html.ts` 各 1 处，功能相同。属于低成本可收敛重复。
- `normalizeTabId`：仅 `src/utils/params.ts` 1 处定义；当前不作为主治理目标，只冻结不再新增。
- `toTabId`：手写定义 1 处 + 生成文件 1 处；生成文件排除，不做主治理目标。
- `JSON.parse`：`src/` 内 24 处调用，其中 5 处不在显式 `try` 中，是真正的统一策略热点；tests/contracts 内更多 parse 不在本治理范围。

目标：

- 收敛真正共享的小工具，而不是继续接受“约定式复用”。
- 让新代码优先复用 canonical helper，而不是就地定义 `isRecord` / `recordValue`。
- 统一核心 parse 热点的失败语义，减少 ad-hoc 解析策略。

Workstream A：共享记录工具收敛

- 保留授权根：
  - `src/utils/records.ts`
  - `src/tools/summaries/common.ts`
  - `src/tools/webSecurity/shared/normalize.ts`
  - `bridge_src/service_worker/types.ts`
- 排除生成文件：
  - `src/protocol/nativeProtocol.ts`
  - `bridge_src/service_worker/protocol.ts`
  - 其他 generated docs / build artifacts
- 实施项：
  1. 删除 `src/driver/BrowserWaitSupervisor.ts` 本地 `isRecord`，改用 canonical helper。
  2. 删除 `src/driver/BrowserRuntimeRecoveryArtifacts.ts` 本地 `isRecord`，改用 canonical helper。
  3. 删除 `src/tools/summaries/transfer.ts` 本地 `isRecord`，改从 `src/tools/summaries/common.ts` 导入。
  4. 删除 `src/tools/summaries/html.ts` 本地 `recordValue`，改从 `src/utils/records.ts` 导入。
  5. 删除 `src/tools/webSecurity/register/shared.ts` 本地 `isRecord`，改用 canonical helper。
  6. 替换 `src/` 内 24 处内联 object-guard 为共享 helper；若上下文确有边界原因，必须留注释说明不收敛。

Workstream B：JSON parse 策略统一

- 只处理 `src/` 核心热点，不扩到 tests/contracts：
  - `src/tools/artifactReader.ts`
  - `src/tools/webSecurity/shared/har.ts`
  - `src/tools/webSecurity/shared/template.ts`
  - `src/tools/webSecurity/browserNative/callbackOastWorker.mjs`
- 实施项：
  1. 将 `tryJson` 从 `src/tools/webSecurity/shared/normalize.ts` 提升到 `src/utils/json.ts`。
  2. 以上热点按调用语义统一：
     - 允许宽松探测的位置返回 `undefined`；
     - 必须报错的位置抛结构化 `INVALID_RULE` 或等价 coded error；
     - 禁止继续散落 ad-hoc parse-failure 模式。

Workstream C：防漂移治理

- 新增 contract，禁止重复问题再次出现：
  1. `isRecord` 定义点限制：`src/` 非授权根不得新增本地定义。
  2. `recordValue` 不得新增本地实现。
  3. 新增内联 `typeof value === "object" && !Array.isArray(value)` 守卫需受 contract 限制；确需保留时必须白名单或注释说明。
  4. `normalizeTabId` 暂不删除，但新增 contract 禁止重新引入平行 alias。
- 先用现有 contracts 体系落地；ESLint 规则不是本轮必要前置。

明确非目标：

- 不处理生成文件内的 helper 自包含实现。
- 不做 `normalizeTabId` 大范围 alias 清扫。
- 不做全仓 `JSON.parse` 清零工程。
- 不把 helper 去重扩成无边界的“代码风格统一运动”。

验证计划：

- `npm run check:src:types`
- `npm run check`
- 如新增/修改 contract：对应更新 `tests/contracts/*`

文档同步要求：

- 同步 `CURRENT.md`、`TODO.md`、`CHANGELOG.md`。
- 若 helper canonical root 口径变化影响维护者入口，再同步 `docs/maintainer-map.md`。

最终判定标准：

- `src/` 中非授权根 `isRecord` 定义显著收敛；
- `recordValue` 本地重复清零；
- 24 处内联 object-guard 收敛或明确白名单化；
- 5 处核心 parse 热点改成统一策略；
- 新增 contract 能阻止同类重复再次进入仓库。

### 已完成：MV3 runtime state recovery（Phase 1-5）

状态：已完成并通过 `npm run check`。

结果：

- 已落 `state_store.ts` 基础模块：`RuntimeStateRecord` 类型、TTL（24h）、per-kind cap（50）、redaction、diagnostics、idempotent persist/forget。
- 已落 network recoverer：persist recorder config at start/reconfigure/stop；recover recorder config and CDP subscriptions；mark `recoveredAt/historyLost` in status/list/export diagnostics。
- 已落 intercept recoverer：persist install config/stages/rules；recover with `Fetch.disable` then `Fetch.enable` and rule reinstall；report `pausedLost:true` after restart。
- 已落 hook diagnostics：status-only recovery；no auto reinstall；persist install args/session metadata。
- 已落 WS diagnostics：config-only lost diagnostics；no auto reconnect；persist session config。
- 已补 `RUNTIME_STATE_RECOVERED` / `RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS` / `RUNTIME_STATE_LOST` error codes 到 native error taxonomy。
- 已同步 protocol、generated docs、contracts。
- `piBridgeInfo()` 和 `ext_ready` 已包含 `runtimeRecovery` 摘要。
- 启动恢复流程已集成到 `transport.ts`，在首次 `ext_ready` 前自动运行。

验证：

- 已通过：`npm run build:bridge`
- 已通过：`npm run check`
- 已通过：`npm run docs:generate`

最近完成：第二轮深度缺陷修复批次已收口，覆盖 callback OAST `sessionId` 路径收口、动态 HTTPS 证书、stale-lock token 校验、`maxRuntimeMs` 生命周期上限、WebSecurity `wordlistPath` 本地边界、private/link-local/metadata target 默认阻断与 `allowPrivateTargets`、mature bridge `allowLauncherOverride`、MV3 restart state-loss 轻量持久化诊断、旧 content page-script DOM 命令通道移除、`javascript:`/`data:` 导航阻断、template/fuzz/sqli 上界、summary hard-cap、peer/CI/package/legacy bridge 收口；不新增公开 `browser_*` 工具，不引入策略型 orchestration，不削弱 WebSecurity 能力。

## 最近完成：Stateful WebSocket replay/fuzz primitives（phase 1）

状态：已完成并进入归档。

结果：

- 已落 tab-scoped session/transcript model：`bridge_src/service_worker/ws_model.ts`。
- 已落 internal/native `ws.open/status/send/replay/wait/collect/close` primitive：`bridge_src/service_worker/ws.ts`。
- 已落 Node-side explicit helper/shell：`src/tools/webSecurity/shared/wsSession.ts`、`src/tools/webSecurity/shared/wsShell.ts`。
- 已落 compact summary adapter：`src/tools/summaries/webSecurity/ws.ts`。
- 已落 internal slash-command path：`/browser-ws`，输入保持显式且有界；不新增公开 `browser_*` 工具。
- 已补 bounded replay、replay failure diagnostics（`stepIndex` / `lastSeq` / `partialSteps` / `partialTranscript`）与 partial transcript artifact。
- 已补 eval/sample result：`evals/browser-workflows/27-websocket-session-transcript.md`、`evals/browser-workflows/results/27-websocket-session-transcript.result.json`。
- 已补 opt-in runtime smoke：`tests/smoke/smoke-websocket-session.mjs`，真实浏览器 + 本地 `WebSocketServer` fixture 已通过。

验证：

- 已通过：`npm run test:unit`
- 已通过：`npm run check:pi-browser-bridge`
- 已通过：`npm run check:smoke-diagnostics`
- 已通过：`npm run smoke:browser:websocket-session`
- 已通过：`npm run check`

## 已完成：DOM 事件链 / sink-flow 分析辅助（phase 1）

状态：已完成并进入归档。

结果：

- 已在既有 `browser_hook` canonical surface 下落 internal/native actions：`getNodeListeners`、`getListenerChain`、`getSinkHints`。
- 已落 selector-scoped listener/source/sink evidence 提取：`bridge_src/service_worker/dom_flow.ts`。
- 已落 compact summary adapter：`src/tools/summaries/webSecurity/domFlow.ts`。
- 已补本地 fixture / eval / sample result：`evals/browser-workflows/fixtures/dom-flow-listeners.html`、`evals/browser-workflows/23-dom-flow-listener-chain.md`、`evals/browser-workflows/results/23-dom-flow-listener-chain.result.json`、`evals/browser-workflows/24-dom-flow-sink-hints.md`、`evals/browser-workflows/results/24-dom-flow-sink-hints.result.json`。
- 已保持 evidence-assist 边界：不新增公开 DOM-flow 工具，不承诺 full taint engine，不做 exploit judgement。

验证：

- 已通过：`npm run sync:protocol`
- 已通过：`npm run docs:generate`
- 已通过：`npm run test:unit`
- 已通过：`npm run check:eval-workflows`
- 已通过：`npm run check:browser-workflow-results`
- 已通过：`npm run check:summaries`
- 已通过：`npm run check:pi-browser-bridge`
- 已通过：`npm run check`

## 已完成：JS AST / 反混淆分析原语（phase 1）

状态：已完成并进入归档。

结果：

- 已落 internal-only parse/summary/reduction helpers：`src/tools/webSecurity/shared/jsAst.ts`、`src/tools/webSecurity/shared/jsAstArtifact.ts`、`src/tools/webSecurity/shared/jsAstShell.ts`。
- 已落 compact summary adapter：`src/tools/summaries/webSecurity/jsAst.ts`。
- 已落 internal slash-command path：`/browser-js-ast`，输入必须是显式本地 JS 文本或本地文件路径；不新增公开 `browser_*` 工具。
- 已覆盖 imports / exports / function inventory / 可疑模式摘要 / string-array / decoder / constant folding / alias propagation / object-dispatch readability reduction。
- 已建立 artifact output convention：reduction payload 超阈值或显式 `outputPath` 时写 `.pi/browser-artifacts/`，summary 只回传 compact descriptor。
- 已补 eval / sample result：`evals/browser-workflows/22-js-ast-artifact-summary.md`、`evals/browser-workflows/results/22-js-ast-artifact-summary.result.json`。

验证：

- 已通过：`npm run test:unit`
- 已通过：`npm run check:eval-workflows`
- 已通过：`npm run check:browser-workflow-results`
- 已通过：`npm run check:browser-commands`
- 已通过：`npm run check`

## 已完成：请求/响应拦截与热补丁原语（phase 1）

状态：已完成并通过 contracts / runtime smoke。

结果：

- 已新增 internal/native interception primitives：`intercept.install`、`intercept.uninstall`、`intercept.status`、`intercept.listRules`、`intercept.addRule`、`intercept.removeRule`、`intercept.collect`、`intercept.pause`、`intercept.continue`、`intercept.fail`、`intercept.fulfill`。
- 已打通手工 fulfill、自动 fulfill 与 `replaceScript` 三条真实浏览器路径。
- 已补 transcript / diagnostics / status / uninstall / fail-closed 行为，并维持不新增广义公开拦截工具的边界。
- 已新增 opt-in runtime smoke：`npm run smoke:browser:intercept-response`、`npm run smoke:browser:intercept-replace-script`、`npm run smoke:browser:intercept-uninstall-fail-closed`。

验证：

- 已通过：`npm run check:protocol`
- 已通过：`npm run check:pi-browser-bridge`
- 已通过：`npm run check:smoke-diagnostics`
- 已通过：`npm run check`
- 已通过：`npm run smoke:browser:intercept-response`
- 已通过：`npm run smoke:browser:intercept-replace-script`
- 已通过：`npm run smoke:browser:intercept-uninstall-fail-closed`

## 已完成：cross-tool evidence correlation metadata

状态：已完成并通过 contracts / package / runtime smoke。

结果：

- distilled envelope 统一上浮 `operationId`、`snapshotId`、`requestId`、`waitId`、`listenerId`、`sessionId`、`selectionVersionAtDispatch/Resolve`、`sourceMode` 等对账字段。
- `browser_wait` / `browser_network` / `browser_hook` / `browser_frame` / `browser_evidence` 等 native action 工具已补 tracked operation metadata，不再只有 observe/execute/command 容易对账。
- `browser_artifact mode=json` 会从 artifact summary 中提取 correlation 线索并输出 `correlationPaths`，支持优先按 `jsonPath` 做定点读取。
- 新增 `evals/browser-workflows/21-cross-tool-correlation-chain.md` 与 sample result `evals/browser-workflows/results/21-cross-tool-correlation-chain.result.json`。
- 新增 opt-in runtime smoke：`npm run smoke:browser:correlation-chain`；已验证 observe → execute → wait → artifact 的 targeted correlation jsonPath read。

验证：

- 已通过：`npm run test:unit`
- 已通过：`npm run check:all:contracts`
- 已通过：`npm run check:package`
- 已通过：`npm run check`
- 已通过：`npm run smoke:browser:correlation-chain`

## 已完成：TODO 257-261 维护入口 / 协议单源收口 / 单测扩面 / mature bridge 预检诊断 / 文档去重

状态：已完成并通过 `npm run check`。

结果：

- 新增 `docs/maintainer-map.md`，把 `index.ts -> driver -> toolRegistry/register -> bridge_src -> tests` 的维护入口、改动落点和验证顺序固定为单一入口图。
- `bridge/native_command_schema.json` 新增 mature bridge 结构化错误码：`MATURE_BRIDGE_LAUNCHER_NOT_FOUND`、`MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT`、`MATURE_BRIDGE_LAUNCHER_PROBE_FAILED`、`MATURE_BRIDGE_LAUNCH_FAILED`、`MATURE_BRIDGE_PROCESS_TIMEOUT`、`MATURE_BRIDGE_TARGET_REQUIRED`、`MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED`，并已通过 `npm run sync:protocol` 同步到 runtime / Node / generated docs。
- `src/tools/webSecurity/shared/matureBridge.ts` 成为 mature bridge launcher probe / process timeout / failure record 的单点 helper；`sqlmapBridge.ts` / `nucleiBridge.ts` 已接入共享预检诊断，不再各自散落 launcher 探测逻辑。
- `browser_sqlmap_bridge` 现在会在缺少 target、launcher 不存在、probe timeout、process timeout 时返回稳定结构化错误；`browser_nuclei_bridge` 额外在模板选择缺失时前移失败，而不是晚到执行阶段。
- `normalizeError` 已补 mature bridge recovery nextActions；README 已补 maintainer map 入口和 mature bridge 诊断口径；protocol/contracts/unit tests 已同步。
- 新增 unit tests：`capabilityProfile`、`webSecurity/shared/diagnostics`、`webSecurity/shared/matureBridge`、`errors-advanced` 的 mature bridge recovery 分支；contracts 已覆盖 shared mature bridge 边界和 sqlmap/nuclei preflight 失败断言。

验证：

- 已通过：`npm run sync:protocol`
- 已通过：`npm run docs:generate`
- 已通过：`npm run test:unit`
- 已通过：`npm run check:web-security`
- 已通过：`npm run check`

已完成的本轮治理收口：

- 工具注册已从 `registerTools.ts` 手工逐个调用收敛为 `src/tools/toolRegistry.ts` 声明式 registry；core/security 分组与 capability profile gating 统一由 registry 维护，`registerTools.ts` 只负责遍历组合。
- 文档索引同步已从 `scripts/sync-doc-indexes.mjs` 的固定阶段号/固定文件名硬编码改为基于 `docs/archive/*.md` 自动收集 summary/full 配对生成 `ARCHIVE.md` / `ROADMAP.md` 入口；`check-doc-structure` 也同步改成按目录配对校验。
- CI 已扩展为分层 jobs 入口：contracts/unit/package/doc-structure/full-check 为默认链，runtime smoke/release smoke 改为显式环境变量启用的 opt-in jobs，避免继续只有单一串行 job；本地 `npm run check` 也已改为共享 grouped runner（`scripts/run-check-groups.mjs`），并已让 `.github/workflows/check.yml` 直接复用 `check:all:bridge / package / contracts`，避免本地与 CI 校验链分叉；CI 共享 setup/build 已抽到 `.github/actions/setup-node-build`，grouped runner 也支持 `--json` 结构化摘要输出。

当前范围：

- 维护入口：新增维护者代码流向图，明确 `index.ts -> driver -> toolRegistry/register -> bridge_src -> tests` 的唯一入口。
- 协议单源收口：继续锁定 `hook / frame / html / screenshot / evidence` 的 metadata 消费和 drift contracts，不改变公开 command/tool 名称。
- unit test 扩面：补 `capabilityProfile`、WebSecurity diagnostics、mature bridge launcher 诊断等纯逻辑测试，并继续保持 runtime smoke 为 opt-in。
- mature bridge 预检诊断：前移 `sqlmap` / `nuclei` 的 launcher 不存在、探测超时、模板选择缺失等失败，并返回稳定错误码、nextActions 与本地 artifact 指引。
- 文档去重：压缩 `README` / `CURRENT` / `ROADMAP` / `ARCHIVE` 的重复描述，只保留单一事实源与互链入口。

边界：

- 不新增公开 `browser_*` 工具，不修改外部 callable tool 名称。
- 不修改公开 bridge command 名称；如新增结构化错误码，只允许用于 mature bridge 诊断并同步 schema/generated docs/contracts。
- 继续保持生成 metadata 驱动 command/tool metadata，执行路径与 summary/artifact 语义不做无关改造。
- test 扩面优先纯逻辑与本地 bounded fixture，不把默认浏览器 smoke 接回主检查链。
- 不引入新的 Web 扩展包或策略型 orchestration 抽象。

## 已完成：TODO 250-256 build/test/doc governance follow-up（首版落地）

状态：已完成并通过 `npm run check`。本组只收口工程治理、构建/测试/文档维护流程，不改变现有 callable tool 名称、schema、运行时能力边界或安全策略。

结果：

- `verify:bridge:dist` 已取代 `check` 隐式重建；`check:bridge:build` 改为只读验证当前 dist，dist 缺失时要求先执行 `npm run build:bridge`。
- `test:unit` 已建立并接入 `npm run check`；当前基于 Node `node:test` 覆盖 `shared/http.ts`、`shared/replay.ts`、`shared/requestTemplate.ts`、`browserNative/sqliProbe.ts`、`toolAdapter.ts`。
- `scripts/build-bridge.mjs` 已对 service worker entry 试开 tree-shaking。
- browser cookie binding 文案已统一收口为“HTTP request header injection”；保留外部参数名 `bindBrowserSession`，不夸大为浏览器网络栈 replay。
- build-manifest 模块清单已改为 metadata-only 命名，并显式标记 `metadataOnlyModuleLists:true`。
- 已补 `docs/hook-dispatcher-multi-file-evaluation.md`，明确多文件注入仍是 RFC-only 评估，不直接改 runtime。
- 已新增 `.github/workflows/check.yml`，PR/push 默认执行 `npm ci -> npm run build:bridge -> npm run check`。

修正后的长期口径：

- `hook_dispatcher` 单文件边界真实存在，但“无 source map”结论已失效。
- 当前测试不只依赖手动 smoke；contracts + fake fixtures + `test:unit` 已覆盖自动化回归面。
- 文档漂移不再只是手动检查；本地 `npm run check` 和外部 CI merge gate 均已覆盖。

边界：

- 不把 `bindBrowserSession` 的文案修正扩展成“真实浏览器网络栈请求”承诺；若未来探索 CDP Fetch/Network interception，需另开 RFC/TODO。
- 不因 tree-shaking 讨论回退当前 ESM import graph 或重引 ordered-concat 兼容路径。
- 不把 build-manifest metadata-only 重命名简化成删除所有诊断字段；现阶段保留可审计模块清单。
- 不把 README/AI_INSTALL/`docs/tool-boundaries.md`/仓库外全局 skill 改成全自动生成文件；解释性文档继续保留人工边界与审阅权。
- 不引入默认 browser smoke 到 `npm run check`；runtime smoke 继续显式 opt-in。

验证：

- 已通过：`npm run build:bridge`
- 已通过：`npm run test:unit`
- 已通过：`npm run verify:bridge:dist`
- 已通过：`npm run check`

## 已完成：TODO 244 Observation surface consolidation / `browser_observe` canonical migration

状态：已完成直接 cutover。执行合同与剩余 TODO 边界见 `docs/tool-surface-consolidation-plan.md`。

决策：

- 接受 `browser_observe` 合并观察层，目标是成为唯一 canonical observation tool。
- 已完成：`browser_scan`、`browser_content`、`browser_html` 的能力已完整迁移到 `browser_observe` 的显式 mode；旧工具已移除。
- `browser_screenshot` 和 `browser_frame` 不并入 `browser_observe`；它们分别是视觉证据和 frame/CDP context 管理。

边界：

- 不允许 `mode:"auto"`。
- 不允许 selector miss 后自动 fallback 到其它 mode。
- 不允许长期 alias 并存。
- 不允许丢失 `SELECTOR_NOT_FOUND`、`INVALID_SELECTOR`、content `empty:true`、content timeout validation、durable navigation、native `html.get` 语义。

计划参数与 mode contract：见 `docs/tool-surface-consolidation-plan.md` 的 TODO 244。

验证：

- `npm run docs:generate`
- `npm run check:tools`
- `npm run check:summaries`
- `npm run check:content-pick`
- `npm run check:scan`
- `npm run check:tool-docs`
- `npm run check`
- runtime reload 后复用 `npm run smoke:browser:scan-summary` 作为 `browser_observe mode=scan` 验证。

完成标准：

- `browser_observe mode=scan|content|html|text|tabs` 覆盖当前三工具所有必要行为。
- 已完成：旧三工具已删除，README/skill/contracts/generated docs 不再把它们呈现为 callable tools。
- docs/generated/skill/README/contracts 不再把旧三工具呈现为 canonical callable tools。

## 已完成：TODO 245 JavaScript execution and bridge command split

状态：已完成。执行合同见 `docs/tool-surface-consolidation-plan.md`。

结果：

- `browser_execute` 已收敛为 JavaScript-only。
- `browser_command` 已成为 bridge command object surface。
- 工具层 JSON-string command promotion 已移出 documented callable semantics；命中 command-like JSON string 时显式返回 `browser_command` recovery hint。

验证：

- `npm run check:tools`
- `tests/contracts/check-execute-tool.mjs`
- `npm run check`

## 已完成：TODO 246 Recovery hints and bounded artifact multi-search

状态：已完成。执行合同见 `docs/tool-surface-consolidation-plan.md`。

结果：

- `normalizeError` / `compactError` 已输出 factual `diagnostics.nextActions` 与 `recovery`。
- `browser_artifact` 已支持 bounded multi-artifact search：显式 `paths` 或受限 `root`/`glob`，并受 `maxFiles/maxBytes/maxMatchesPerFile/maxTotalMatches/maxChars` 约束。
- 默认 redaction、safe regex 和 artifact root 边界保持不变。

验证：

- `npm run check:artifact`
- `npm run check:errors`
- `npm run check:token`
- `npm run check:summaries`
- `npm run check`

## 已完成：TODO 247 Explicit progress and stream-ready evidence contract

状态：阶段 1 已完成；stream 协议仍保持未启用，但合同已按 stream-ready 方向固定。执行合同见 `docs/tool-surface-consolidation-plan.md`。

结果：

- Web Security follow-up tools 已通过 shared shell 输出 Pi tool-level `_onUpdate` progress。
- `browser_execute` / `browser_command` / `browser_observe` 已输出 operation metadata，final envelope 仍是唯一成功/失败权威。
- progress 不绕过 resultMiddleware、privacy redaction、artifact 保存。

验证：

- `npm run check:web-security`
- `npm run check:tools`
- `npm run check`

## 已完成：TODO 248 Explicit snapshots and operation metadata

状态：已完成。执行合同见 `docs/tool-surface-consolidation-plan.md`。

结果：

- `browser_observe` 已为 structure/content/html/tabs 结果生成 explicit snapshot metadata，并强制 artifact-backed snapshot identity。
- `browser_tabs action=snapshot` 已暴露 bridge snapshot、capability profile、active operations，以及按 `snapshotId` 查询 observation snapshot metadata。
- stale snapshot 默认 fail closed，需 `allowExpired:true` 才返回旧 metadata。
- operation metadata 只用于诊断，不做自动调度或抢占。

验证：

- `npm run check:tools`
- `npm run check:content-pick`
- `npm run check`

## 已完成：TODO 249 Explicit Web Security capability profiles

状态：已完成。执行合同见 `docs/tool-surface-consolidation-plan.md`。

结果：

- 同包 12 个 Web Security tools 保持不变。
- 可见工具面已由显式 `PI_BROWSER_TOOL_PROFILE` 控制：默认 `security`，可设为 `core` 后 `/reload` 隐藏 Web Security follow-up tools。
- disabled state 已通过 `browser_tabs action=snapshot` / `/browser-status` snapshot 暴露 capability profile 诊断。
- generated docs 已区分 always-on 与 security profile tools。

验证：

- `npm run docs:generate`
- `npm run check:tool-docs`
- `npm run check`

## 历史能力状态摘要（216 及更早）

- TODO 216 原生多 browser session / 并发路由：已完成 1-6 阶段，含 session registry、显式 `browserSessionId` 路由、session 生命周期、tab lease/UI lock、per-session 写队列、artifact/evidence session 维度，以及跨 Pi 进程 bridge 端口争用修复。
- TODO 200-215 工程治理期：已全部完成，包含支柱二 ESM/TS bundler 终态、协议单源、artifact/privacy、runtime fixtures、依赖审计、质量门禁、本地发布验收等；详细记录已迁入 `ARCHIVE.md`。
- 当前 `CURRENT.md` 仅保留执行中的主链与最新完成组摘要；更早 TODO 的详细过程不再在本文件重复展开。

## 归档与路线入口

- 历史完成项：`ARCHIVE.md`。
- 后续路线/建议顺序：`ROADMAP.md`。





