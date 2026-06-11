# CURRENT

## 当前状态

- 当前 shipping 外部前端是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除（CLI 用法见 `docs/cli.md`）。
- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前主链路：`browser_tabs list|switch|create` -> 显式 `tabId` -> `browser_observe` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前工具边界：22 个 `browser_*` 工具 always-on；Web Security 是 scoped follow-up 分组，不再有 capability profile / compact mode / discovery mode；不新增公开 `browser_*` 工具，不恢复 orchestration / target resolver。
- ABML 是内部 substrate，不是公开工具面：继续增强 `browser_observe` / `browser_execute monitor` / `browser_frame` / AX/vision/monitor 盲区；公开 ABML verb surface 已关闭为 perception-first 项目决策。
- jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：只吸收能力模型与证据路径，不新增被拒绝的公开工具 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`。
- 仓库单一源码根：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅作本地导出/归档产物。
- 修改协议/工具后先跑 `npm run check`；局部回归优先 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。

## 当前激活项

- 无。

## 最近完成项

### Execution feedback layer optimization (2026-06-11, 完成)

Decision: execute the broadened execution feedback plan v3, now archived at
`docs/archive/execution-feedback-layer-plan.full.md`. Default execution gains cheap factual effect
reporting built on existing page fingerprint, network seq, hook seq, operation, and artifact
substrates. Physical input is exposed only as coordinate-addressed `input.*` bridge commands. `pi.*`
was implemented as an explicit-marker internal page-world stdlib, but it did not pass the blind
adoption bar for public guidance.

Boundary: no public semantic action verbs, no `mode=auto`-style execution guessing, no
`diagnose:true`, no failure taxonomy, no intent verification, no auto-retry, no ref-addressed
gestures. Existing `browser_execute monitor:true` remains the heavy semantic before/after read.
Default effect facts are cheap and factual only. Track C remains internal/underdocumented and does
not claim a security boundary against pre-existing page-world prototype poisoning.

Contract: `browser_execute` and tab-scoped write `browser_command` calls may include compact
`effect` facts unless `PI_BROWSER_EXECUTE_EFFECT=0`. Full execution journal lives under artifact
`execution`. `input.*` commands are write access and inherit tab lease/queue semantics.
`piRuntime:"1"` appears only when stdlib is injected; namespace is pinned to `resolve`, `box`,
`setValue`, `settled`, but skill/README guidance does not promote `pi.*` after the blind result.

Verification: passed focused effect/journal/stdlib/command tests, `npm run sync:protocol`,
`npm run check:protocol`, `npm run check:all:bridge`, `npm run check:tools`,
`npm run check:runtime-fixtures`, `npm run check:page-scripts`, `npm run check:summaries`,
`npm run check:token-economy`, skill quick validate, `npm run eval:browser-workflows -- --fixture-server --eval 02-scan-execute-wait`,
`npm run smoke:browser`, `npm run smoke:browser:scan-summary`,
`npm run smoke:browser:correlation-chain`, and `npm run smoke:browser:abml-monitor-comparison`.
The blind adoption gate produced a split result: form-fill succeeded but ignored `pi.resolve` /
`pi.setValue`, so Track C stayed internal; canvas/trusted-event succeeded with `input.pointer`, so
Track B public guidance remains.

### browser_observe mode-friction reduction v2 (2026-06-11, 完成)

决策：执行 `browser_observe` mode 摩擦收敛 v2。`mode` 保留为显式参数；当 `mode` 缺省时，仅由参数蕴含集合交集做确定性推导，不做页面启发式、不新增 `mode=auto`、不新增公开工具。显式传入 `mode` 时现有严格校验保持不变；跨模式混合参数若蕴含交集为空仍硬拒。

落地边界：`intent` 升为顶层一等参数，修复 task-conditioned salience E 源在公开 `browser_observe` 面不可达的缺陷；`intent` 合法域为 `scan`/`text`，缺省 `mode` 时不参与内容模式推导并继续落到默认 `scan`。`params` 维持 html-only 协议透传语义，因此 `params` 可在缺省 mode 时推导为 `html`。`url` 放开至 `scan`/`text`/`html`/`content`，导航语义复用 `wait.navigateAndWait state:"complete"`；导航请求跳过 observe render cache 与隐式 session baseline，ledger frame 以导航后的 URL 记录，显式 baseline 仍允许。

合同：推导回显进入 tool `details.modeInferred`（无推导为 `null`，有推导为 `{mode, reason}`）；model-facing summary 只在发生推导时携带短字段 `modeInferred:"..."`。感知层 H1 `paramsSignature` 纳入顶层 `intent`，并保留内部直调 `params.intent` 兼容。`text` 模式不吸收、不弃用。

验证：已通过 `check:src:types`、observe/relevance 聚焦单测、`docs:generate`、`check:tool-docs`、`check:all:contracts`、skill quick validate、`build:bridge`、`smoke:browser:observe-navigation`。Smoke artifact：`.pi/browser-artifacts/smoke-observe-navigation-results.json`，覆盖公开 `browser_observe` 省略 mode 的 `url -> navigate+scan` 与 `selector+htmlMode+url -> navigate+html` 推导路径；真实 bridge smoke 同步修正 `persistent_cdp` 的 nested CDP result 解包。

### Debt zeroing — remove trigger-gated backlog (2026-06-10, 完成)

决策：执行用户要求的 trigger-gated debt 清零。原则：能作为确定性机械能力落地的，直接实现并加合同；没有正当产品形态或会扩大公开面/策略面的，直接关闭为项目决策，不再保留“等触发再做”的 backlog。公开 `browser_*` 工具名仍不新增；优先在既有 scan/summary/artifact/contract 面内消化。

落地：B9a 在既有 scan entry 内新增 bounded `data.media_candidates`，summary 提供紧凑 `media_candidates` 表与 `data.media_candidates` artifact hint，边界限定为 visible media identity（selector/src/poster/alt/dims/geometry/sameOrigin），不做 headline/ranking 语义。B11 在 scan actionables 给 fixed/sticky edge utility controls 打机械 `edgeUtility`/`position` 标记，summary 只在 `focus.primary_actions` 排序中降权，完整 `data.actionables` 仍保留这些控件。

清账口径：summary grandfather 的 31 个 per-tool distiller 输出位置接受为既定边界，不强改；`check:summary-boundary` 以 31 为上限做 shrink-only ratchet，并由既有 shadow guard 继续保证 allocator 不进 model-facing envelope。ABML public verb surface、web-reversing phase 2、renderer line 粒度、capture esbuild migration 均关闭为项目决策，只保留 reopen-evidence bar，不再写成 trigger-gated backlog。G 类 n=1 项只作为 rolling eval hypotheses，复现前不是工作项。

验证：已通过 `check:scan`、`check:summaries`、`check:capture`、`check:summary-boundary`、`check:output-schema-conformance`、`check:web-security`、skill quick validate、`npm run lint`、`npm run check`、`npm run smoke:browser:scan-summary`、`git diff --check`（仅 CRLF 归一化提示，退出码 0）。Smoke artifact：`.pi/browser-artifacts/smoke-browser-scan-summary-results.json`。

### Debt clearance (2026-06-10, 完成)

决策：已执行 `docs/debt-clearance-plan.md`——全项目债务/悬空/滞后审计后的清债合同。不新增公开 `browser_*` 工具，不改 agent-facing schema，不改变默认输出语义。该段记录的是 debt-zeroing 前的阶段性清账；后续 trigger-gated backlog 已在上一条完成项中清零。

落地：D2 完成 `ROADMAP.md` 诚实化重构（已关闭决策 / 当前非激活路线 / 近期质量建议）；D3 完成 W1 默认安全词表外部化并继续走 `readWordlist()`；D4 完成 recovery grandfather ratchet 文档化与 shrink-only contract 收口；D5a 将 `bench:abml-kernel` 正式写 off 到 kernel plan；D5b 将 blind findings 的 B1 改为 resolved，并把 B9a 未来边界指向 D1 基础设施；D1 在既有 scan entry 内落地 `data.rows` / summary rows / artifact hints，用真实站点 sentinel 证明无需 custom JS 即可读取 DOM-ordered visible rows。

边界：D3 默认输出保持字节恒等；D4 grandfather baseline 只缩不增；D1 保持 perception-only——只给 text/href/geometry/visibility/container hints，不做来源/作者/时间/排序语义推断，不新增第 6 capture entry 或公开工具。

验证：已通过 `npm run check`、`npm run lint`、`check:scan`、`check:summaries`、`check:token-economy`、`bench:distill`、`check:recovery-boundary`、`check:errors`、`smoke:browser:scan-summary`。D1 结清证明：真实 `https://linux.do/latest` 运行 `browser_observe mode=scan` + `browser_artifact mode=json jsonPath=data.rows`，artifact `C:\Users\HUAWEI\.pi\browser-artifacts\observe-scan-1781098809184.json` 返回 14 条 DOM 顺序 rows，全程未使用 custom `browser_execute` JS。

### capture-core + fact allocator closure (2026-06-10, 完成)

决策：已执行 `docs/capture-core-plan.md`，同时收口前序 `perception-renderer-plan` 与 `task-conditioned-salience-plan` 之间的 production fact allocator / V6 关联悬空项。交付边界保持不新增公开 `browser_*` 工具、不改 tool schema、不改变 scan/content/pick/probe 的 agent-facing 语义；page-world sensing 已迁入 capture-core generated bundle seam，`src/` builder 只保留参数归一化与注入调用；`allocateFacts` 已进入 production salience renderer，`FactSalience.relevance` 同步落地。

落地：新增 `capture-src/entries/*Template.ts`、`scripts/sync-capture.mjs`、`src/capture/inject.ts` 与 committed `src/capture/generated/*Bundle.ts`；`buildScanScript`、`buildContentScript`、`buildPickScript`、ABML 7 个 probe builder 与 `viewportScript` 均改为 generated template 注入；pick 改用 scan-canonical selector 语义并继承 B3 sibling cache；新增 `check:capture` / `check-capture-core-boundary.mjs`、package/check/lefthook 覆盖；default salience summary/preview 路径运行 `factify → allocateFacts → renderFacts`，allocator diagnostics 只进入 tool result `details`，不增加 model-facing envelope 字节。

边界：capture page-world 逻辑只允许位于 `capture-src/` 与 `src/capture/generated/`；`src/scan`、`src/content`、`src/pick`、ABML verb runtime 不得重新拥有 page-world 大模板；B3 已由 ABML kernel optimization 完成，本计划只继承并锁定；fact allocator 接线只在既有 salience renderer 内启用，ladder escape 与 artifact/privacy 语义保持不变。

门禁：已通过 `check:capture`、`check:src:types`、`check:scan`、`check:content-pick`、`check:page-scripts`、`check:abml-verb-runtime`、`check:summaries`、`check:package`、`check:distiller-coverage`、`check:task-conditioned-salience`、`bench:distill`、resultMiddleware/allocate-render 聚焦单测；最终全量门禁见本轮收口记录。

### Task-conditioned salience v3 — implicit relevance (2026-06-10, 完成)

决策：已执行 `docs/task-conditioned-salience-plan.md`，在现有默认 salience + session-delta 上增加内部 task-conditioned relevance。该合同只改变内部排序/预算提示：不新增公开 `browser_*` 工具，不新增 agent-facing schema 参数，不接入模型/会话文本，不改变 ABML 公共工具面；默认路径保持 no-signal neutral，`PI_BROWSER_RELEVANCE=0` 是一键逃生舱。

落地：V1 新增纯核 `src/distill-core/relevance.ts`、`relevanceTuning.ts` 与 `relevanceTaps.ts`；V2 在 `observeRunners.ts` 每次 scan observe 只计算一次 relevance，并通过 `summarizeScanData` 的 lookup surface 调整 action ranking 与 ABML primary entity 同 rank 排序；V3 将既有 `buildInferenceSummary` intents 映射为 source C；V4 通过 `registerTools.ts` chokepoint + `src/tools/relevanceTaps.ts` 统一收集行为 trace，并在 `PerceptionLedger` 上新增 session-keyed capped ring 与 frame LRU；V5 支持内部 `params.intent` source E，并同步 skill 一句提示。

边界：relevance compute 只落在纯核 `src/distill-core/relevance.ts` 与 `relevanceTuning.ts`；工具行为 trace 只通过统一 tap 表收集，禁止各工具散落采集逻辑；`abml-core` 不导入 `distill-core`；trace terms 不进 envelope，artifact 默认只给 source tags，debug terms 仅在 `PI_BROWSER_RELEVANCE_DEBUG=1` 且经现有 redaction 管线时出现；V6 fact-level integration 已随 capture-core closure 完成，生产 fact allocator 接线不新增 agent-facing 参数或 trace 输出。

门禁：已通过 `check:src:types`、`check:task-conditioned-salience`、`docs:sync-indexes`、relevance/ledger/observe 聚焦单测、`npm run check` 与 `npm run smoke:browser:scan-summary`。

### ABML kernel optimization — point-fix execution (2026-06-10, 完成)

决策：已执行 `docs/abml-kernel-optimization-plan.md`，完成 ABML 感知纯核 `src/abml-core/`、AX runtime `src/abml/verbs/axRuntime.ts` 与 page-side scan selector 的已审计 point-fix 队列。该合同保持 **纯 compute / sensing 内部收敛**：不新增公开 `browser_*` 工具，不改 tool schema，不改 agent-facing summary/envelope 语义；所有落地都保持 observe 输出 contract 不变。

落地：A1 删除 `observeRunners.ts` 的重复 `buildSnapshotProjection` 并新增 `tests/unit/abml/snapshotProjection.test.ts`；A2/A4/A6 把 AX 角色分类改成 module-level `Set`、`isInterestingAxNode` 改为 lazy `axValue` 读取、`buildAxEntityFromNode` 用单次 property map 复用状态/结构/值读取；A3 让 `mergeDomAndAxEntities` 预提取 name/role/box/point，避免每对 DOM×AX 重复归一化；A5 让 `stableHash24` 单遍同时更新 3 个 FNV 累加器；B1 抽出共享纯核 `src/abml-core/grouping.ts` 与 `buildTemplate()`，消除 `templating/treeDiff/snapshotProjection/semanticRefAnchor` 的重复分组与 projection 二次分组；B2 在 `axRuntime.ts` 单次 ancestor walk 同时收集 nearest container 与 current-container fallback 链；B3 给 `buildScanScript.ts` 的 `selectorFor` 增加按 parent 缓存的 sibling `nth-of-type` 索引，去掉宽容器 O(S²) sibling 扫描。

边界：保持 `distill-core`、`abml-core`、公开工具面现状不变；未改变 AX geometry source；未恢复 `templates`/`inference` agent-facing 输出；`capture-core-plan` 未激活前仅在现有 `buildScanScript.ts` 完成 B3 一次。

门禁：已通过 `check:src:types`、`check:abml-core-boundary`、`check:abml-templating`、`check:abml-snapshot-projection`、`test:observe-abml-integration`、`check:scan`、`check:all:bridge`、`npm run check` 与 `npm run smoke:browser:scan-summary`，全量收口。
### Renderer default flip — staged salience default (2026-06-10, 完成)

决策：完成 `docs/renderer-default-flip-plan.md`。按 owner 决策以“可检测 + 可回滚”换交付速度：salience 先翻默认，session-delta 后翻默认，`line` 粒度不在本契约；默认翻转前已修 F1/F2，F3 fan-out 控制已落地；多站点盲测从前置门降级为事后哨兵。

边界：不新增公开 `browser_*` 工具；不恢复 `templates`/`inference` agent-facing 输出；不改变 tool schema；`PI_BROWSER_RENDERER=ladder` 是 renderer 逃生舱；`PI_BROWSER_SESSION_DELTA=0` 是 session-delta 逃生舱；信封继续保留 `renderer:"salience-v1"` / `delta:"session"` 自述。

执行结果：P0 登记 CURRENT、提交 perception-renderer 已落地实现基线、修 npm banner 测试；P1 修 F1/F2 并落 F3 控制与 comparative bench；P2 已翻 salience 默认；P3 已翻 session-delta 默认并接入 long-conversation fixture gate。

门禁：P2 已通过 `npm run check`、`eval:browser-workflows -- --fixture-server --eval 16-scan-high-entropy-summary`、`smoke:browser:scan-summary`。P3 已通过 `check:src:types`、`test:observe-abml-integration`、`check:session-delta-long-conversation`、`npm run check`、`eval:browser-workflows -- --fixture-server --eval 16-scan-high-entropy-summary`、`smoke:browser:scan-summary`。comparative bench 要求每个 fixture 上 salience chars ≤ 1.05× ladder、事实覆盖 ≥ ladder、截断标记 ≤ ladder，且默认路径等于显式 salience；任何哨兵发现 salience 藏必要事实或 P-frame 读不懂，先回滚默认再诊断。

## 最近完成且仍影响当前规则

### Perception renderer + distill-core — unified token economy (2026-06-10, 完成)

决策：已执行 `docs/perception-renderer-plan.md` 的激活切片，把 token economy 收敛到新纯核 `src/distill-core/`。该合同最初让 salience/session-delta 仅作为 opt-in/eval 面；后续 `docs/renderer-default-flip-plan.md` 已把 salience 与 session-delta 分阶段翻为默认，`PI_BROWSER_RENDERER=ladder` 与 `PI_BROWSER_SESSION_DELTA=0` 保留兼容逃生舱。

落地：`resultMiddleware.ts` 的预算 ladder/成本/compact helper 已迁入 `distill-core`；新增 `ArtifactPlan` seam、Fact/allocator/renderer、salience envelope、当前 `DistillerDefinition` 全量 `factify`、`PerceptionLedger` substrate、默认 session delta、entity `line` granularity primitive；新增 recovery 机制集中到 `distill-core/recovery.ts`；新增 distill/recovery/summary boundary、distill bench 与覆盖测试。

边界：不新增公开 `browser_*` 工具；不恢复 `templates`/`inference` agent-facing 输出；默认 envelope 字段语义不变；side effects 继续在 tool/runtime orchestration 执行；`distill-core` 保持无 Node I/O、无 browser/driver/tools/abml imports；`abml-core` 不导入 `distill-core`。

默认翻转决策：fixture blind A/B 通过；真实 linux.do 只读 blind A/B 显示 salience/session opt-in 可用且理解力优于默认，但有 token/artifact 压力与截断成本。原结论是不翻转默认；后续 owner 决策改由 `docs/renderer-default-flip-plan.md` 承担可检测、可回滚的分阶段翻转，P2 已在修复 F1/F2/F3 与 comparative bench 后翻 salience 默认，P3 已在 long-conversation gate 后翻 session-delta 默认。

验证：`npm run check` 已通过；聚焦通过 `check:src:types`、`check:token`、`check:summaries`、`check:token-economy`、`bench:distill`、`check:distill-core-boundary`、`check:recovery-boundary`、`check:summary-boundary`、`check:abml-core-boundary`、`test:observe-abml-integration`、`smoke:browser:scan-summary`、`eval:browser-workflows -- --fixture-server --eval 16-scan-high-entropy-summary`。

### ABML Identity Plane — internal kernel upgrade (2026-06-10, 完成)

决策：在 abml-core 纯核内升级对象追踪基础设施，不加公开工具。三个切片：
- **I2 (Initiator-Enhanced Causal)**: causal.ts 读 CDP initiator metadata，parser/preload 请求标记 passive 并从 triggered 归因中过滤；script + actionRef 组合提升 confidence 到 medium。
- **I1 (Anchor Gate 放宽)**: mintingEligible 去掉 containerName 要求，保留 namedUniquely 碰撞防护。覆盖从 ~5-15% 升到 ~15-25%。
- **I3 (Identity Graph in Artifact)**: 新纯核模块 `abml-core/identityGraph.ts`，observe artifact 写入 `data.identityGraph`（byRef→anchorKey/triggeredRequests），summary 只放标量计数。

边界：不加公开 `browser_*` 工具，不加 `browser_handle`。消费面全部通过既有工具（observe 字段 + browser_artifact jsonPath）。
验证：quality:local 绿，28/28 eval 绿，16 个新单元测试。

## 最近完成且仍影响当前规则

### Performance & overhead audit execution

决策：
- `docs/performance-overhead-audit.md` 是已完成的性能/开销优化审计与执行记录。落地顺序按证据和风险分层：先做非 agent-facing contract 的 CPU/latency/byte 优化，再做需 live smoke 的扫描路径优化，最后才评估会改变 agent JSON/token contract 的输出瘦身。
- 已完成当前执行项：bridge dist service-worker/offscreen whitespace minify（保留 symbol names）、AX `DOM.getBoxModel` 并发批处理、observe network/hook seq 并发读取、default scan 的 ABML read 复用首个 `scan_extract` payload、`containsSensitiveEvidence` first-hit predicate、CLI JSON render parse-once、network diagnostics cap、intercept paused cap+overflow continue、`browser_execute` 去掉普通路径 200ms 固定等待、CLI command registry memoize 与实际 bin 顶层 help 轻量动态导入、nested validation 从 zod 迁到 TypeBox-compatible wrapper 并移除 zod 依赖、daemon 版本兼容改为只按 `DAEMON_PROTOCOL_VERSION` 判断、offscreen 端口并发 probe、resource/ref store 容量 cap + amortized prune、scan summary 跨 budget rung 预计算复用并补高熵 byte/shape golden、scan summary 剩余 per-rung loop collapse、CJK budget `String.length` guard、`fitEnvelopeBudget`/`fitSummaryBudget` serialize-once safe subset、extension readiness event-driven wait + no-extension negative cache、artifact text/search/sample 减少重复读、CLI-only success details 省略、CLI artifact read 建议去重、`browser_tabs list` compact+top-level bridge、scan `focus` entity refs-v1 输出瘦身（blind-eval 取证后落地）。
- `DAEMON_PROTOCOL_VERSION` 仍是控制/工具契约变化的强制 bump 点；普通 package version 变化不再自动重启 daemon。

边界：
- Tier 0/Tier 1 的性能优化不得改变公开 `browser_*` 工具名、CLI command surface、默认 JSON envelope 字段含义或 agent SOP。
- Tier 3 token/output shape 优化必须先做 blind eval / transcript 检查，证明 agent 不依赖被裁字段；当前已落地有兼容 guard 的 3.1 artifact 建议去重、3.2 `browser_tabs list` compact，以及 3.3 scan `focus` refs-v1（完整实体仍在 `envelope.entities` / artifacts）。
- full minify / syntax minify 若需要放宽 dist bundle 字符串合同，必须作为单独改动处理；当前只采用 whitespace minify + size budget。

验证：
- 已通过：`npm run build`、`npm run build:bridge`、`npm run verify:bridge:dist`、`npm run check:src:types`、`npm run check:deps`、`npm run check:summaries`、`npm run check:token`、`npm run check:token-economy`、`node tests/contracts/protocol/check-pi-browser-bridge.mjs`、聚焦 validation/redaction/CLI render/daemon-control/driver connection/artifactReader/resourceReader/ref-registry/CLI local 单测/契约；本轮剩余项收口还通过 `npm run check:tool-parameter-contract`、`npm run check:tool-docs`、`npm run check:doc-structure`、`npm run check`；`node dist/cli/bin.js --help` 重建后 median 约 56ms。
- 后续每个新 P0/P1 项至少补一个 guard 或 regression；扫描路径优化需补 live smoke（至少 `smoke:browser:scan-summary`）或 token-economy 对比。当前 audit 中 0.3、1.1 非默认路径、1.7 stream signal ref reuse、2.2 默认等待缩短均已由 eval 证据关闭为 future protocol/contract/eval gate；3.3 已完成 targeted blind eval 并落地 refs-v1。

### Agent-facing CLI connection control protocol

决策：
- 已新增 agent-facing 连接控制面，让 agent 主动执行 readiness gate，而不是被动依赖普通命令触发 `ensureDaemon()` 后再从失败里推断连接状态。
- 推荐入口是 `pi-browser connect --json` / `pi-browser connect --wait --timeout-ms <ms> --json`：幂等启动或复用 user-local singleton daemon，显式启动 bridge，等待扩展连接，返回机器可读 connection envelope。
- 已新增 `pi-browser status --json` 只读 agent 状态面：不启动 daemon/bridge，只报告 daemon lockfile、reachable、bridgeRunning、extensionConnected、tabCount、activeTab、health、staleLockfile、recovery commands；`--tabs` 才展开完整 `tabs[]`。
- `connect` / `status` 默认紧凑，避免多标签页 profile 把完整 tab 列表塞进每次 readiness envelope；已透出 `lastPingAt`、`lastPongAt`、`connectedForMs`、`tabSyncAgeMs` 等健康字段。
- daemon 冷启动已加 user-local start lock，避免两个 agent 同时发现无 daemon 后各自 spawn detached daemon 抢端口。
- 保留 `pi-browser daemon start|stop|status` 作为高级生命周期/诊断面；不把 `daemon stop` 写成常规 agent 收尾步骤。
- 普通工具命令保留 auto-start 兼容行为；agent SOP 改为复杂任务前先 `connect`，后续自然命令直接执行。是否增加 `--no-auto-start` / `PI_BROWSER_REQUIRE_CONNECTED=1` 作为严格手动模式，留作后续 eval 证明确有需要时另开执行合同。

边界：
- 不新增公开 `browser_*` 工具，不恢复 MCP，不改变 Pi-native `index.ts` 工具面。
- 不把策略塞入 CLI；`connect` 只承担 deterministic readiness：daemon reachable、bridge running、extension connected、tab visibility/health visible。
- 不实现 one-shot/direct transport 作为首批目标；它会牺牲跨命令状态。先把 singleton daemon 的连接控制变成 agent 显式协议，后续再用 eval 判断是否需要 `--transport direct`。
- 不泄露 daemon token；stale lockfile 继续只暴露非敏感字段。

已落地契约：
- `connect --json` 输出单一 JSON envelope，包含 `command:"connect"`、`ready`、`startedDaemon`、`startedBridge`、`waitedMs`、`daemon{pid,controlPort,version,expectedVersion,versionStale}`、`bridge{port,running}`、`extension{connected}`、`tabCount`、`activeTab`、`health`、`recovery.commands[]`；显式 `--tabs` 时才包含完整 `tabs[]`。
- `connect --wait` 在 timeout 后仍未连接扩展时返回 parseable error envelope，exit code `3`，code 类似 `CLI_EXTENSION_NOT_CONNECTED`，并给出可执行 recovery commands。
- `status --json` 永远只读、不 auto-start；daemon 不存在时 exit code `0` 且 `ready:false`，除非参数错误。
- `doctor --json` 可继续保留更宽诊断；`status` 面向 agent 快速 loop，`doctor` 面向排障。

验证：
- 完成计划：`docs/agent-cli-connection-control-plan.md`。
- 已补 CLI unit/contract：local `status` 不启动 daemon；`connect` 可启动 daemon/bridge；默认紧凑 status/connect 与 `--tabs` 展开；健康字段透出；start lock 等待并发启动；extension timeout JSON envelope；stale lockfile 不泄 token；ordinary commands 兼容 auto-start。
- 已补 runtime smoke：隔离 `PI_BROWSER_DAEMON_STATE_DIR` + patched extension port，验证 `connection.status.initial -> connection.connect-wait -> connection.status.ready -> tabs list`，agent path 不需要手动 stop；测试 cleanup 仍停止隔离 daemon。
- 已更新 `docs/cli.md`、`skills/pi-browser-tools/SKILL.md`、`CHANGELOG.md`、`TODO.md`；skill validation、focused CLI checks、package/smoke diagnostics、`smoke:cli:full` 和最终 `npm run check` 已通过。

- **Agent-native CLI 产品化主线已完成**：`docs/agent-native-cli-spec.md` 是外部面契约，`docs/agent-native-cli-execution-plan.md` 已完成。`commands/schema --json` 暴露 `agentCli` + `artifactBehavior`；推荐 `standard`/`natural` 路径覆盖 wait/network/frame/hook 高频动作；legacy `--action/--params` 保留为 advanced compatibility；`command --command @file` 保留为 native escape hatch。
- **Agent-native 统一架构 Workstream A 已落地**：`register*Tool` TypeBox schema 是 Pi-native 与 CLI 的单一契约源；机械参数从 schema/CLI help 隐藏并通过 `prepareArguments` 兼容旧调用；summary/ref/resource 副作用边界、脱敏与 artifact raw pointer 由 contracts 锁定。权威设计见 `docs/agent-native-architecture.md`。
- **盲 agent eval 机制已 live 验证**：确定性 runner 负责回归；blind real-agent layer 由 `pi-browser-blind-eval` skill 操作，隔离 `PI_BROWSER_DAEMON_STATE_DIR` + 18801+ 端口，不属于 `npm run check`。发现与三分类记录见 `evals/browser-workflows/blind-findings.md`。
- **B5 durable connection reliability 已完成**：扩展侧 WebSocket 生命周期迁到 offscreen document；native WS wire protocol 与公开工具面不变。验证、历史和后续候选见 `ARCHIVE.md` / `ROADMAP.md`。
- **Skill 按前端拆分为两个独立文件（2026-06-09）**：决策——Pi-native 与 CLI 是两条不同前端,合在一个 skill 里强迫读者按前端过滤,故拆为各自自洽的文件。边界——`skills/pi-browser-tools/SKILL.md` 保持 canonical 名,收敛为 **Pi-native 纯净版**(只 `browser_*` 对象语法、无 connect 握手、ambient readiness);新增 `skills/pi-browser-cli/SKILL.md` 为 **CLI-first 版**(`pi-browser` 子命令、connect/status/doctor 就绪门、discovery、文件化大输入、daemon 生命周期、`--json/--text`)。契约安全的原因:6 个契约测试硬绑 `pi-browser-tools/SKILL.md` 且断言的是对象语法/工具名/`detailLevel`/`tool-boundaries` 链接——保留该文件为 Pi-native 即天然满足。**前端分流关键:Pi 自动发现 `D:/Pi/agent/skills/*`(settings.json `skills:[]`),所以该全局目录只 junction `pi-browser-tools`,绝不 junction `pi-browser-cli`——否则 Pi-native agent 会同时读到两份。** CLI skill 留在仓库 `skills/pi-browser-cli/`,面向 shell/CLI agent(其 skill 发现路径与 Pi 不同,如 `~/.claude/skills/` 或 project `.claude/skills/`),按需另行 junction,不进 Pi 全局目录。配套——README 增链、两个 skill 互加 sibling 指针。代价——方法论部分在两文件重复,改工具需同步两处(已在两文件 frontmatter/正文互指以降漂移);若漂移成本上升再考虑加 drift 检查。验证——`quick_validate.py` 两个 skill 均 valid;`check-tool-doc-drift`/`check-tools-contract`/`check-token-contract` 均 ok。设计约束见 memory `pi-native-primary-smooth-path`。

## 后续路线

- future-facing 能力方向只放在 `ROADMAP.md` 与对应 RFC/eval 文档中。
- 已完成历史不再写回本文件；压缩摘要见 `ARCHIVE.md`，长详档见 `docs/archive/*.full.md`。
- 若后续重新打开 ABML public surface、debugger workflow、incognito/profile isolation 等方向，必须另开新的执行合同，不得搭车既有主线。
