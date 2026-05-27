# CURRENT

## 当前状态

- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前主链路：`browser_tabs list` / `browser_tabs switch|create` -> 显式 `tabId` -> `browser_observe mode=scan|content|html|text|tabs` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 已冻结下一阶段工具面治理计划：`docs/tool-surface-consolidation-plan.md`。该计划是 TODO 244-249 的执行合同；实现前不得按口头讨论临时改 schema、工具名或文档口径。
- 已完成方向：`browser_observe` 已成为观察层 canonical surface；`browser_execute` / `browser_command` 已拆分完成；recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata、Web Security capability profiles 已落地。
- 当前设计方向：单包分层，优先保留 Pi-native 浏览器态执行层；通用解析优先成熟依赖；成熟漏洞引擎仅以同包内可选 bridge 接入，不在核心工具里追平外部 CLI。
- TODO 200-215 工程治理期已完成；后续新增能力、公开工具变更、bridge 协议变更、工具注册条件变更必须先在本文件和 `docs/tool-surface-consolidation-plan.md` 补决策、边界文档、契约与验证计划。
- 已撤回 `browser_orchestrate` / orchestration coordinator / target resolver 工具面；默认浏览器自动化保持 `browser_tabs` first + 显式 `tabId`，观察层已由 `browser_observe` 承载。
- 后续仍保持能力完整性：不新增工具层安全闸；安全边界继续由 Pi 平台/安全层负责；新增高层状态管理必须先证明比显式 tab 流程更低模型负担。
- Web 执行面已进入当前工具清单：`browser_recon_probe`、`browser_crawl`、`browser_fuzz_paths`、`browser_fuzz_vhosts`、`browser_sqli_probe`、`browser_sqlmap_bridge`、`browser_nuclei_bridge`、`browser_template_check`、`browser_callback_oast`、`browser_cookie_analyze`、`browser_fuzz_params`、`browser_http_replay`。
- 已移除历史动作拆分工具：`browser_query`、`browser_click`、`browser_type`、`browser_dom_snapshot`、`browser_dom_click`、`browser_dom_type`；不要恢复为默认工具面。
- 修改协议/工具后先跑：`npm run check`。如需按故障域局部回归，使用 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。真实浏览器 smoke 只在需要验证 reload 后 runtime 时执行。

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
- 失效显式：cache/snapshot/lease/queue/operation 冲突都必须带 target、selectionVersion、stale/conflict reason；禁止 silent fallback。
- 完成标准：每个 TODO 完成时必须同步 `CURRENT.md`、`ROADMAP.md`、`docs/tool-boundaries.md`、README、CHANGELOG、generated docs、全局 skill（如影响运行时选择）、contracts/evals，并运行对应 check；不能只完成代码或只完成文档。

## 当前执行队列

当前无进行中的主线改造队列；新增能力或重大变更前，先在本文件补决策、边界、契约与验证计划。

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





