# ABML 恒等格架构与执行合同

> Doc-class: execution-contract
> Status: COMPLETE（2026-06-14）。本次执行线已完成；完成标准与关闭证据见 §0.1 / §10，关闭记录写入 `CHANGELOG.md`。

本文记录一次关于 "AX+DOM 融合还能怎么补强" 的架构推理，结论是：**补强方向不是"再加 CDP 通道"，而是把感知核收敛到一棵以 `backendNodeId` 为根的恒等格（identity lattice），并承认感知核是「格 ⊕ 关系层 ⊕ ledger」三件套，不是单一融合算法。**

---

## 0. 文档定位与读者

- 读这篇文章前，应已读 `docs/abml-kernel-manifest.md`（分层契约）、`docs/abml-optimization-reference.md`（可落地优化参考）、`AGENTS.md` 的 ABML 项目开发规则与 Root-Truth Sourcing 原则。
- 本文不重复这些文档的内容，只在其之上提出一个**贯穿性的架构判断**，并把本轮可执行收敛项落到代码、contract、skill 和验证门。
- 本文的执行边界是：先完成 projection-first/diagnostics/recovery 可见面，避免默认输出继续让 agent 猜；重型 bootstrap / OOPIF / DOMSnapshot paint-order 只在有当前机制证据和可验证门时执行，不能留下开放 plan 占位。2026-06-14 追加执行线已把 DOM scan `backendNodeId` best-effort bootstrap、OOPIF `(targetId, backendNodeId)` 复合 key 路由与 DOMSnapshot paint-order 遮挡关系接入产品/运行时路径，证据见 §0.4。

### 0.1 本轮执行项

| 项 | 文件 | 动作 | 验证 |
| --- | --- | --- | --- |
| L0 文档收口 | `docs/abml-identity-lattice-architecture.md`, `CURRENT.md` | 将草案改为 execution contract，列明本轮交付边界、验证门与关闭条件 | `npm run docs:sync`, `npm run check:docs-sync` |
| L1 恒等格诊断 | `src/abml-core/identityGraph.ts`, `src/tools/observe/scanRunner.ts`, `src/tools/resultMiddleware.ts`, `src/distill-core/ladder.ts` | 输出 `identity` 覆盖摘要；完整 `identityGraph.byRef` 仅 artifact 化；默认 envelope 不暴露完整图 | `tsx --test tests/unit/abml/identityGraph.test.ts tests/unit/tools/envelope-disclosure.test.ts` |
| L2 artifact 精读路径 | `src/tools/observe/scanRunner.ts`, `tests/contracts/tools/check-abml-scan-envelope.mjs` | `artifact_hints.jsonPaths` 明确 `envelope.identityGraph` / `envelope.snapshotProjection` / `envelope.relations` / `envelope.relationGraph` / `envelope.collections` | `npm run check:abml-scan-envelope`, `npm run check:summaries` |
| L3 agent-facing 口径 | `README.md`, `skills/pi-browser-tools/SKILL.md`, `skills/pi-browser-cli/SKILL.md`, `CHANGELOG.md` | 说明 `identity` 是恒等格诊断摘要，完整图通过 artifact 精读；不新增公开 ABML verb | skill quick validate, `npm run docs:sync` |

### 0.2 本轮重开结果与仍关闭项

以下项不作为未完成 TODO 挂起。已满足证据门的项已经重开并执行；关系层、ledger 容量、projection/frontier 预算也在 2026-06-14 追加 closure run 中完成证据核验：关系层以 artifact-only 中央 `RelationGraph` 关闭，ledger 与 projection/frontier 则以现有上限/预算保留关闭。仍缺真实站点扩展证据的部分只保留为后续 reopen bar，不登记为当前 TODO。

- DOM scan 实体批量盖 `backendNodeId`：已重开并实现为 best-effort bootstrap。产品路径复用 `DOMSnapshot.captureSnapshot` 的 `backendNodeId + bounds` 行，对 scan actionables 做 viewport/document/DPR 归一后的唯一高 IoU 匹配；只有 `matched` 写 `backendNodeId`，`ambiguous/stale/missing/unsupported` 全部 fail-open 并保留诊断。
- LayerTree / paint-order 遮挡关系：LayerTree 直连在当前浏览器 CDP 中不可用；实现脊柱改走 `DOMSnapshot.captureSnapshot(includePaintOrder:true)`。当前工作区已把 `backendNodeId + bounds + paintOrder` 接入 capped `coveredBy`/`occludes` 关系派生；full paint-order entries 只进 saved artifact，model-facing 只给 relation summary / compact diagnostics。
- DOMDebugger listeners 进感知格：已重开并实现为 bounded read-only hints。产品路径只对带 `backendNodeId` 的少量 `data.actionables[]` 候选 probe `DOM.resolveNode` + `DOMDebugger.getEventListeners`，将 capped listener facts 写入 `Entity.hints.listeners`，并在 `data.listenerOracle` 记录 candidate/probed/listener/failure 统计；不引入 click/type 策略。
- OOPIF 复合主键 `(targetId, backendNodeId)`：已重开并落地双写兼容。`nodeKey` 优先写 `t:<targetId>:b:<backendNodeId>`，保留旧 `b:<backendNodeId>` 兼容；`persistent_cdp` 通过 `Target.setAutoAttach` / `Target.attachedToTarget` 获取 flat child session，`input.ref` 可用 target-scoped backend ref 派发，缺失 target fail-closed 为 `OOPIF_SESSION_UNSUPPORTED`。
- 关系层升一等公民：已重开并关闭为现有 schema 内的中央关系图。`RelationGraph` 持有完整 `edges/bySource/byTarget/byType`；`entity.relations[]` 保持 capped 派生兼容字段；model-facing 只暴露 `relations.summary/highlights`，完整图通过 `artifact_hints.jsonPaths.relationGraph = "envelope.relationGraph"` 精读。
- ledger 容量调整：已重开核验，结论是不调大。最终 fixture eval 33/33 passed，temporal profile 175 个样本 `historyLostCount=0`，没有证据表明 `MAX_FRAMES_PER_SESSION_TAB=8` 或 `MAX_TRACE_TERMS_PER_SESSION=32` 导致当前任务失败。
- projection/frontier 预算：已重开核验，结论是不调参。eval runner 已持久化 `observeCallCount`、`observeResultTextChars`、`observeEstimatedTokens` 与 artifact read mix；最终全量 run 的 observe 估算 token max 为 3335，artifact read 为 7 次，其中 4 次 jsonPath、3 次 broad read，未显示首屏预算需要扩大或重分配。

### 0.3 后续重开证据项

以下证据项是 §8 后续演进的重开门槛。已满足的项记录为当前实现证据；未满足的项不是当前 TODO，只有当一项能同时满足"当前代码证据 + 可运行 gate + artifact 证据"时，才允许派生成新的激活执行合同。

| 重开项 | 当前代码证据 | 缺失证明 | 可接受证据 | 最小 gate |
| --- | --- | --- | --- | --- |
| DOM scan 实体批量盖 `backendNodeId` | 已实现。`src/abml/verbs/axRuntime.ts` 暴露 DOMSnapshot geometry rows；`src/abml-core/identityBootstrap.ts` 做 scan rect ↔ snapshot bounds 的 best-effort bootstrap；`src/abml-core/entity.ts` 产出 `backendNodeId` locator / hint；`src/abml-core/ax.ts` 在几何启发式前先按 backend id 精确 join | 真实站点 animation/virtualized list/多 frame 的批量成本与边界；不是 fixture 正确性的阻塞项 | `32-abml-identity-bootstrap-evidence` 证明产品 artifact 中 `backendNodeIdBootstrap.matched=3`、`ambiguous=2`、`sampleWindowMs=15`，scan entities 带 `backendNodeId` locator；手工 drift 样本证明 `stale=1` fail-open | `tests/unit/abml/identity-bootstrap.test.ts` 五态状态机 + `tests/contracts/tools/check-abml-scan-entities.mjs` backend locator/hint + `32-abml-identity-bootstrap-evidence` |
| LayerTree / paint-order 遮挡关系 | `bridge_src/service_worker/layer.ts` 内部 `layer.probe` 证明 `LayerTree.enable` 返回 `-32601`，但 `DOMSnapshot.captureSnapshot(includePaintOrder:true)` 可返回 `paintOrder + backendNodeId + bounds`；`src/abml-core/relations.ts` 已按 paint-order 相邻候选 + spatial bucket 派生 capped `coveredBy`/`occludes`；`src/abml/verbs/axRuntime.ts` 已在 paint-order unsupported 时回退普通 DOMSnapshot 保住几何 | 真实站点复杂合成、alpha/clip/filter/transform 的精度边界；是否需要像素反查 probe 只作可疑样本复核 | overlapping fixed/sticky/opacity/transform fixture 中 `covered`/`covering` 同时有 `backendNodeId`、bounds、paintOrder；artifact 写 `paintOrderEvidence.entries`，model-facing 只暴露 capped relation summary 与 compact diagnostics | `33-layer-paint-occlusion-boundary` + `tests/contracts/tools/check-abml-relation-graph.mjs` + `npm run check:abml-scan-envelope` |
| DOMDebugger listeners 进感知格 | 已实现。`runtime.ts` 对带 `backendNodeId` 的 capped `data.actionables[]` 候选执行 `DOM.resolveNode` + `DOMDebugger.getEventListeners`；`Entity.hints.listeners` 只写 bounded read-only facts，`data.listenerOracle` 写 candidate/probed/listener/failure 统计 | 真实站点上更大候选集的成本、事件委托深链是否需要更深 `depth`、是否要把 listener facts 升格为关系边 | `32-abml-identity-bootstrap-evidence` 证明产品 artifact 中 listener oracle `listenerCount=1` 且 `listenerEntityCount=1`；runtime 单测证明 listener hints 和 backend bootstrap 同路径落地 | `tests/unit/abml/verbs-runtime.test.ts` + `32-abml-identity-bootstrap-evidence` |
| OOPIF 复合主键 `(targetId, backendNodeId)` | 已实现。`src/abml-core/nodeKey.ts` 提供复合/legacy key；`identityGraph.ts` 和 `relations.ts` 双写兼容；`bridge_src/service_worker/cdp.ts` 通过 `Target.setAutoAttach` / `Target.attachedToTarget` 路由 child target；`input.ref` 消费 `targetId` 并在 miss 时 fail-closed | 真实站点多 OOPIF/导航后 child session 生命周期与跨 target artifact 归属边界；不是 fixture 正确性的阻塞项 | `34-oopif-composite-key-boundary` 证明 cross-origin child target snapshot、target-scoped `input.ref` click、裸 parent backend ref 兼容、missing target 零派发 fail-closed | `tests/contracts/runtime/check-input-ref-runtime.mjs` + `tests/unit/abml/identityGraph.test.ts`/`relations.test.ts` + `34-oopif-composite-key-boundary` + `npm run check:protocol` |
| 关系层升一等公民 | 已完成。`src/abml-core/relations.ts` 产出中央 `RelationGraph`，包含 `edges/bySource/byTarget/byType`；`entity.relations[]` 是 capped 派生兼容字段；`scanRunner.ts` 把完整图只写入 saved artifact，并注册 `artifact_hints.jsonPaths.relationGraph = "envelope.relationGraph"` | 真实站点复杂遮挡/控制关系的精度边界；不是 schema 阻塞项 | 单测证明 model-facing summary 不泄露 full graph，saved artifact 暴露 `envelope.relationGraph`，且 `byTarget` 可反查 inbound relation；关系 summary 继续走既有 projection slot | `tests/unit/tools/observe-abml-integration.test.ts` relationGraph artifact test + `tests/unit/abml/relations.test.ts` + `npm run check:abml-relation-graph` |
| `growthProbe` 数据通道 | 已实现。`src/scan/buildScanScript.ts` 注入 bounded `collectGrowthProbe`，用 scroll metrics + `IntersectionObserver` 采样虚拟窗口变化并恢复 scroll；`src/tools/observe/scanRunner.ts` 将 `data.growthProbe` 传给 `buildCollectionModels`；`collections.ts` 消费 count/height/windowShift 三类证据 | 真实站点 lazy/virtualized 组件的副作用成本、采样 wait 上限、嵌套 scrollport 选择策略 | `35-abml-growth-probe-evidence` 证明产品 artifact 中 `growthProbe.supported=true`、`windowShifted=true`、`restoredScrollTop=true`，collection 为 `virtualized` 且 evidence source 为 `growthProbe` | `npm run check:scan` + `npm run check:abml-collections` + `npm run check:abml-scan-envelope` + `35-abml-growth-probe-evidence` |
| ledger 容量调整 | 已核验并保持现值。`src/abml/perceptionLedger.ts` 仍为 `MAX_FRAMES_PER_SESSION_TAB = 8`、`MAX_TRACE_TERMS_PER_SESSION = 32`；最终 temporal profile 175 样本 `historyLostCount=0`、`waitAttempts` p95/max=1、`workerRestarts` max=0 | 真实长任务如果出现 history miss，需要带失败样本重开；当前没有容量不足证据 | 现有 run 不支持调大：33/33 passed 且 history loss 为 0；未来只有出现具体 history miss + token/内存成本可接受时才扩容 | `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T10-50-35-673Z-56540c24/temporal-profile-summary.json` |
| projection/frontier 预算 | 已核验并保持现值。当前 envelope 已提升 `gist/outline/relations/identity/collections/treeDiff`，完整 identity/relation/collection 图走 artifact；runner 已记录 `observeEstimatedTokens` 和 artifact read mix | 真实 agent friction 或任务成功率下降时才需要 A/B；当前 fixture suite 没有预算失败信号 | 33/33 passed；`browser_observe` 调用 18 次，observe 估算 token max=3335；artifact read 7 次，其中 4 次 jsonPath、3 次 broad read | `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T10-50-35-673Z-56540c24/browser-workflow-eval-summary.json` + `tests/contracts/tools/check-eval-workflows.mjs` |

### 0.4 Eval 证据采集记录（2026-06-14）

基线执行（扩展前默认集）：

```bash
npm run eval:browser-workflows -- --fixture-server --timeout-ms 120000
```

第一轮基线结果：29/29 fixture workflows passed。主产物：

- `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T04-38-00-224Z-9f39faa4/browser-workflow-eval-summary.json`
- `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T04-38-00-224Z-9f39faa4/observe-timings-summary.json`
- `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T04-38-00-224Z-9f39faa4/temporal-profile-summary.json`

随后按本草案当前缺口补了 3 个定向 eval，并单项跑通：

- `32-abml-identity-bootstrap-evidence` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-07-57-045Z-728d37b4/browser-workflow-eval-summary.json`
- `33-layer-paint-occlusion-boundary` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-13-32-558Z-28f63bd8/browser-workflow-eval-summary.json`
- `34-oopif-composite-key-boundary` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T10-26-11-136Z-8d9458ae/browser-workflow-eval-summary.json`

LayerTree / paint-order 最小机制验证随后补跑：

- `33-layer-paint-occlusion-boundary` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T06-24-54-827Z-8c99c70f/browser-workflow-eval-summary.json`
- 结论：`LayerTree.enable` 在当前 Edge/Chrome 149 扩展 CDP 路径返回 `-32601`，不能作为实现脊柱；同一内部探针中的 `DOMSnapshot.captureSnapshot(includePaintOrder:true)` 返回 10 个 paint-order owner `backendNodeId`，其中 `covered` / `covering` 均有 `backendNodeId`、bounds、paintOrder。实现路径应走 DOMSnapshot paint-order，而不是 LayerTree owner mapping。

DOMSnapshot paint-order 关系层接入后补跑：

- `33-layer-paint-occlusion-boundary` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T06-48-32-175Z-d3f525ad/browser-workflow-eval-summary.json`
- 结论：fixture 中 `relations.summary` 为 `occludes=2` / `coveredBy=2`；`axDiagnostics.paintOrder` 给 compact stats（10 entries / 10 owners）；完整 paint-order rows 留在 saved artifact，关系 evidence 中有 `paintOrder:true`；LayerTree 仍记录为 unavailable boundary。
- 分层/fallback 收口后复跑 passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T06-57-36-001Z-e49d6ab1/browser-workflow-eval-summary.json`。boundary artifact 证明 `paintOrderRuntime.fullEntriesArtifactOnly=true`，`paintOrderArtifactEvidence.entryRows=10`，`relations.summary` 仍为 `occludes=2` / `coveredBy=2`。

DOM scan `backendNodeId` best-effort bootstrap 与 bounded listener hints 产品路径接入后补跑：

- `32-abml-identity-bootstrap-evidence` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T07-42-18-225Z-0690c7fb/browser-workflow-eval-summary.json`
- 结论：产品 scan artifact 中 `abml.data.backendNodeIdBootstrap` 为 `matched=3` / `ambiguous=2` / `stale=0` / `sampleWindowMs=15`，`32-abml-identity-bootstrap-evidence.result.json` 记录 `product stamped entities=17`。comparison artifact 的手工 drift 样本给 `bootstrapStats.matched=3` / `ambiguous=2` / `stale=1`，证明漂移和重复同框目标 fail-open，不会盖低置信 `backendNodeId`。同一产品 artifact 还证明 `listenerOracle.listenerCount=1` 且 `listenerEntityCount=1`，listener facts 只作为 bounded read-only hints。

`growthProbe` 产品数据通道接入后补跑：

- `35-abml-growth-probe-evidence` passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T08-06-58-676Z-27c2fbf5/browser-workflow-eval-summary.json`
- 结论：产品 scan artifact 中 `data.growthProbe.supported=true`、`windowShifted=true`、`restoredScrollTop=true`，固定 DOM 数量的虚拟列表从 `Result 1` 切到 `Result 7`；collection 输出为 `virtualized` / `virtual-window`，evidence source 含 `growthProbe`，且 comparison artifact 证明没有新增 public continuation/action surface。

扩展后全量回归已跑通：

- `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-24-15-768Z-9bfb712a/browser-workflow-eval-summary.json`
- 结果：32/32 passed；新增 `32/33/34` 全部 passed。
- run-local timing：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-24-15-768Z-9bfb712a/observe-timings-summary.json`、`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-24-15-768Z-9bfb712a/temporal-profile-summary.json`。

剩余关系层/ledger/frontier closure 追加全量回归：

- `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T10-50-35-673Z-56540c24/browser-workflow-eval-summary.json`
- 结果：33/33 passed；`browser_observe` 调用 18 次，`browser_artifact` 调用 7 次，其中 jsonPath 精读 4 次、broad read 3 次；observe 估算 token max=3335。
- temporal profile：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T10-50-35-673Z-56540c24/temporal-profile-summary.json`，175 个样本 `historyLostCount=0`，`waitAttempts` median/p95/max=1，`workerRestarts` max=0。
- observe timing：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T10-50-35-673Z-56540c24/observe-timings-summary.json`，9 个样本，`abmlMs` median=36ms / p95=99ms，`renderMs` median=5ms / p95=19ms，`transportMs` median=73ms / p95=218ms，`abmlPrefetchedScan=true` 9/9，`fusedFingerprint=true` 9/9。

中间一次全量回归 `.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-15-56-492Z-ab8799da/browser-workflow-eval-summary.json` 曾出现旧 `15-jshook-canvas-observation` 的 `browser_screenshot` 15s ACK 后超时（`BRIDGE_TIMEOUT`），随后单项复跑 passed：`.pi/browser-artifacts/eval-browser-workflows/2026-06-14T05-18-24-136Z-9fe0ad74/browser-workflow-eval-summary.json`。这条记录只作为截图路径时序波动的历史诊断，不作为最终回归状态。

这轮 eval 是**证据采集**，不是自动重开 §0.3 的所有后续方向；其中 OOPIF 复合主键、关系层 artifact-only 中央图、ledger 容量保留、projection/frontier 预算保留已被重开并按证据关闭。真实站点复杂边界仍按证据门另起合同。覆盖关系如下：

| 证据项 | 本轮 artifact | 已证明 | 未证明 / 仍需新增证据 |
| --- | --- | --- | --- |
| 当前 `identity` / `identityGraph` artifact 可见性 | `30-abml-internal-routing-evidence-observe.json` | `summary.identity` 存在，样本 `backendNodeIdCoverage=0.636`；`artifact_hints.jsonPaths.identityGraph = "envelope.identityGraph"`；完整 `identityGraph` 在 artifact 侧可读 | 这只证明当前 AX/DOM 融合后的 identity diagnostics 可见，不证明 DOM scan 批量 bootstrap 盖章正确 |
| DOMDebugger listener oracle | `23-dom-flow-listener-chain-listeners.json`, `23-dom-flow-listener-chain-chain.json`, `2026-06-14T07-42-18-225Z-0690c7fb/32-abml-identity-bootstrap-evidence-comparison.json` | `hook.getNodeListeners` 在 selector-scoped 场景返回 listener，listener 记录含 `backendNodeId`；产品 scan artifact 已对 capped backend candidates 写入 `Entity.hints.listeners`，本轮 `listenerOracle.listenerCount=1` / `listenerEntityCount=1` | 已证明 fixture 级感知 hints 落地；未证明真实站点大候选集成本、事件委托深链 depth 策略、是否需要关系边 |
| projection / artifact 精读纪律 | `16-scan-high-entropy-summary-scan.json`, `21-cross-tool-correlation-chain-*.json` | scan summary 能先暴露 high-entropy action/form/list/text signals 和 artifact hints；跨工具链保留 operation/snapshot/wait/request ids，并使用窄 jsonPath 读取 | 未做 projection/frontier/ref-pool A/B；没有比较任务完成率、二次 artifact 读取次数和 token 预算比例 |
| projection/frontier 预算 closure | `2026-06-14T10-50-35-673Z-56540c24/browser-workflow-eval-summary.json` | runner 已记录 `observeCallCount`、`observeResultTextChars`、`observeEstimatedTokens` 与 artifact read mix；33/33 passed，observe token max=3335，artifact read 7 次 / jsonPath 4 次 / broad 3 次 | 未做真实 agent friction A/B；当前没有扩大预算或重分配的失败信号 |
| 关系层中央图 artifact path | `tests/unit/tools/observe-abml-integration.test.ts` relationGraph artifact test | `relations.summary` 留在 model-facing envelope；完整 `RelationGraph` 不泄露到 summary，只在 saved artifact 的 `envelope.relationGraph`；`artifact_hints.jsonPaths.relationGraph` 可发现，`byTarget` 支持 inbound lookup | 真实站点复杂关系精度仍需新样本；当前 schema/artifact 分层已关闭 |
| ABML 内部路由边界 | `30-abml-internal-routing-evidence-*.json` | ABML-backed primary entities、frame entities、vision regions 和 monitor facts 能继续通过现有 `browser_*` 工具面暴露；没有证据要求新增公开 ABML verb | 公开 ABML verb 仍关闭；后续只按真实任务证据扩内部 substrate |
| 执行平面 backendNodeId 落点 | `31-execution-plane-cdp-fusion-*.json` | `pi.click(ref)` 通过内部 `input.ref` 派发，trusted semantic success 由 wait/observe 复核；旧路径与 fused path 有可比 artifact | 同 target 裸 backend ref 已保留；跨 target 行为由 `34-oopif-composite-key-boundary` 补证 |
| observe timing / ledger 历史 | `2026-06-14T05-24-15-768Z-9bfb712a/observe-timings-summary.json`, `2026-06-14T05-24-15-768Z-9bfb712a/temporal-profile-summary.json`, `2026-06-14T10-50-35-673Z-56540c24/temporal-profile-summary.json` | 最新 175 个 temporal profile 样本 `historyLostCount=0`；`waitAttempts` median/p95/max=1；`workerRestarts` max=0 | 不调大 ledger 容量；未来只有具体 history miss 任务样本才能重开 |
| DOM scan 批量 `backendNodeId` bootstrap | `2026-06-14T07-42-18-225Z-0690c7fb/32-abml-identity-bootstrap-evidence-comparison.json`, `32-abml-identity-bootstrap-evidence-scan.json` | 产品 observe 路径已写 `abml.data.backendNodeIdBootstrap`，本轮为 `matched=3` / `ambiguous=2` / `sampleWindowMs=15`，scan entities 已带 `backendNodeId` locator（result 记录 stamped entities=17）；手工漂移样本证明 `stale=1` fail-open，重复同框样本 `ambiguous=2` fail-open | 已证明 fixture 级产品盖章与 fail-open 状态机；未覆盖真实站点 animation/virtualized list/多 frame 批量成本 |
| LayerTree / paint-order 遮挡关系 | `33-layer-paint-occlusion-boundary-layer-probe.json`, `33-layer-paint-occlusion-boundary-boundary.json` | overlapping fixture 中 `elementFromPoint` 证明 covered-center 顶层命中 `covering`；`LayerTree.enable` 返回 `-32601`；`DOMSnapshot.captureSnapshot(includePaintOrder:true)` 返回 10 个 `paintOrder + backendNodeId` owner；当前产品感知路径已把 DOMSnapshot paint-order 接入 capped `coveredBy`/`occludes` 关系，full entries 留 artifact-only | 已证明 fixture 级 paint-order 关系落地和输出分层；未证明真实站点复杂合成、alpha/clip/filter/transform 边界，也未证明需要/不需要额外像素反查 |
| `growthProbe` 数据通道 | `2026-06-14T08-06-58-676Z-27c2fbf5/35-abml-growth-probe-evidence-comparison.json`, `35-abml-growth-probe-evidence-scan.json` | 产品 scan 已产出 `data.growthProbe`；固定 DOM 数量虚拟列表中 `windowShifted=true`、`restoredScrollTop=true`、`intersectionSupported=true`，collections 消费后输出 `virtualized` / `virtual-window` 且 evidence 含 `growthProbe` | 已证明 fixture 级数据通道、消费链和非 public action 边界；未证明真实站点 lazy/virtualized 组件副作用成本、采样 wait 上限和嵌套 scrollport 策略 |
| OOPIF 复合主键 | `2026-06-14T10-26-11-136Z-8d9458ae/34-oopif-composite-key-boundary-boundary.json` | cross-origin iframe fixture 中父页读子 frame 被 `SecurityError` 阻断；`Target.getTargets` 返回 child `type=other` target；child DOMSnapshot 解析 `backendNodeId`；`input.ref` 用 `(targetId, backendNodeId)` 走 `Target.setAutoAttach` flat session 且 `attachRouteUsed=true`，child click 送达；裸 parent backend ref 仍可用；missing target 返回 `OOPIF_SESSION_UNSUPPORTED` 且 `dispatched=0` | 已证明 fixture 级复合 key、旧 ref 兼容与 fail-closed；未覆盖真实站点多 OOPIF/导航后的 child session 生命周期和跨 target artifact 归属 |

---

## 1. 起点：当前"AX+DOM 原生融合"的真实形状

当前融合落在 `src/abml-core/ax.ts:419-443` 的 `mergeDomAndAxEntities`。它**不是**主键对齐，而是**几何评分的贪心匹配**：

```
axMatchScore（ax.ts:403-417）优先级：
  1. box-IoU ≥ 0.8（COINCIDENT_BOX_IOU）          → 120 + iou*10   几何完全重合
  2. name 不同                                    → 直接淘汰
  3. name 匹配 + 点距离 ≤ 24px                    → 100 - dist
  4. role 匹配 + 点距离 ≤ 24px                    → 80 - dist
  5. role+name 匹配但无几何                       → 60            弱信号
  6. role 匹配无几何                              → 40            低置信兜底
```

算法是 O(n×m) 贪心（`ax.ts:424-441`），每条 AX 找最佳 DOM。融合后用 `AX_AUTHORITATIVE_STATE`（`ax.ts:30`，checked/selected/pressed/expanded/current）做双向权威字段合并。

**这里有两个被"原生融合"这个词掩盖的事实：**

1. **DOM 侧没有 `backendNodeId`。** DOM 实体来自注入页面 JS 的 `scanBundle.ts`（`querySelectorAll` + `getBoundingClientRect` + 五点 hit-test），它**拿不到 backendNodeId**。AX 侧有 `backendDOMNodeId`（`axRuntime.ts:304-305` 已建 `nodeByBackend` 映射），但只在几何回填时单独用 CDP，**不参与匹配主键**。
2. **退化路径真实存在。** 当元素无几何或 name 缺失时，匹配落到 `ax.ts:414-416` 的 role-only 兜底（得分 40/60），极易错配。这是一类输入的不可靠性，不是个别 bug。

按 `AGENTS.md` 的 Root-Truth Sourcing 原则——"thread it by an identity that survives boundaries (`backendNodeId`, not CSS selector)"——当前融合是**违反自己定的原则**的：它用几何/文本去猜关联，而不是问引擎要那个跨边界存活的 identity。

---

## 2. 核心洞察：从"加通道"退化成"加权图匹配"的危险

朴素的补强直觉是："再加几个 CDP 通道（LayerTree、DOMDebugger、OOPIF）进来"。但这会触发一个结构性问题：

**当前 `mergeDomAndAxEntities` 能稳定运行，靠的是一个隐含契约：AX 和 DOM 是同一棵 DOM 树的两个投影，1:1 对应同一个物理节点。** 所以能用几何/名称评分匹配，哪怕有损，也只是"猜错对象"，不是"无对象可猜"。

而绝大多数候选新通道**不满足这个 1:1 契约**：

| 通道 | 与 entity 的关系 | 强行融合会怎样 |
| --- | --- | --- |
| LayerTree 合成层 | 1:N 或 N:1 | entity 要带 `layers[]`，遮挡判定从 boolean 变成 alpha 合成 |
| DOMDebugger listeners | 1:N（含祖先委托） | 要判定"这个 listener 真响应该节点的点击吗"——又一层打分 |
| OOPIF AX | 1:1 但跨坐标系 | 匹配要懂坐标变换，主键要 frame 作用域化 |
| 像素 captureVisibleTab | N:M | 完全不同物种，需要"视觉实体"概念 |

**每加一个不满足 1:1 的通道，融合就从 `join` 退化成 `加权图匹配`**——而加权图匹配没有稳定最优解，参数（IoU 阈值、距离阈值、listener 权重）会随站点漂移，于是被迫加 per-framework 分支，于是 Root-Truth 原则被自己的代码违反。

这就是"再融就难维护"的真实形状：**不是代码行数多，是融合契约被稀释成启发式堆。**

---

## 3. 转向：底层 ID 构成一棵收敛到 `backendNodeId` 的恒等格

把视角从"通道"换成"identity"，会发现一个被忽略的事实：**CDP 暴露的多种 node identity 之间，存在廉价的解析路径，且最终都收敛到 `backendNodeId`（或它的容器）。**

这意味着补强不必是"加融合"，而是**"在格上点亮脊柱"**——每点亮一条脊柱，多一类真值能通过 `JOIN`（O(n) 哈希）挂上去，而不是通过融合（O(n×m) 打分）挂上去。**点亮越多，主键对齐越强，融合算法越简单**（更多 join 替代 scoring），不会更复杂。

### 恒等格的完整定义

```
根脊柱（每个 target 内）:  backendNodeId
├─ 可直接解析回根:
│   ├─ objectId (Runtime.RemoteObject)   ←DOM.resolveNode⇄backendNodeId   真 JS 运行时: listeners/属性/原型链
│   ├─ paintOrder (DOMSnapshot.layout)   ←同列给出 backendNodeId+bounds   真绘制序: 遮挡候选/alpha 前置证据
│   └─ animationId (Animation)           ←关联节点(松)                    真动画态: 正在动/当前帧
│
├─ 容器脊柱（根的父级作用域）:
│   ├─ executionContextId + uniqueId     ←auxData.frameId                  JS realm 边界: 主世界/isolated 世界
│   ├─ frameId                           ←Page.getFrameTree               帧边界: 每帧一组 backendNodeId
│   └─ targetId                          ←Target.setAutoAttach/attachedToTarget 进程/OOPIF 边界: backendNodeId 只在 target 内唯一
│
├─ 版本脊柱（给整张图盖时间戳）:
│   └─ loaderId / navigationId           ←每次导航一个                     documentVersion 的底盘; ref 漂移靠它
│
└─ 解析不回去的（留独立 source, agent 自己 join）:
    ├─ networkRequestId                  ←只锚 frameId+loaderId+initiator(松), 到不了 node
    └─ 像素 captureVisibleTab            ←无 node identity, 纯 raster
```

### 判据（修正版）

> **一个真值的 anchor，在 CDP 恒等格里能否解析回 `backendNodeId` 或它的容器（frameId / targetId）？**
> - **能** → 进内核，走 JOIN，零融合复杂度。
> - **只能解析到 frameId+loaderId（网络）或没有 node identity（像素）** → 留独立 source，由 agent 在策略层 join。

按这条线重判所有候选通道：**只有 network 和 pixels 留在外面，其余全进内核**。而且进内核的代价全部是"一次廉价 CDP 解析 + 一个新字段"，不是"改融合算法"。

### 稳定性天然分层（白送的缓存策略）

格上每条脊柱稳定性不同，直接决定缓存策略，不用拍脑袋：

| 脊柱 | 稳定性 | 缓存策略 |
| --- | --- | --- |
| backendNodeId | node 生命周期内稳，跨导航失效 | 跨感知周期缓存（现有 5min TTL 合理） |
| frameId / targetId | frame 生命周期内稳 | tab 生命周期内缓存 |
| executionContextId / uniqueId | world 生命周期内 | 中等 |
| loaderId | 每次导航变 | 每次 navigation event 重置 → 天然的 documentVersion 时钟 |
| layerId | 每次合成更新变（极不稳） | **当次读取当次用，绝不缓存** |
| objectId | 单次 evaluate 内，可能被 GC | **当次 evaluate 批量取，不跨调用** |

`layerId` 和 `objectId` 的极端不稳定性是**反向保护**：它逼你必须"按需 probe 而不是全量融合"，这恰好是"内核变臃肿"担忧的天然刹车。**格的形状本身在约束你不要乱融。**

---

## 4. 真正的架构：感知核是「格 ⊕ 关系层 ⊕ ledger」三件套

格只回答"此刻这个节点是什么"。但感知还有两个维度格天然表达不了。承认它们，才能把架构摆正。

### 4.1 关系层：格表达不了的「二元真值」

格是 `node → 真值` 的映射。但有一整类感知是 `(node, node) → 真值`：

- **遮挡**："A 遮挡 B" 是两层之间的 paint order + alpha 合成关系，不是任何单层的属性。
- **控制**：`aria-controls` / `aria-owns` 的指向（当前 `entity.ts` 的 `buildReferencedTargetEntity` 已解析，但它是关系真值）。
- **因果**："A 的点击触发了 B 的可见性变化"——跨两节点 + 时间。

关系层的数据结构是 `Map<(fromId, toId), Relation>`，**主键直接复用格的 backendNodeId**，不引入新脊柱，不引入新融合复杂度。

现状对照：`Entity.relations?: EntityRelation[]`（`entity.ts`）已经是这个形状，只是没升格成独立一等概念。升格的好处：
- 对称/传递关系（遮挡）不再重复存储。
- "B 被谁遮挡"这种反查不必全扫。
- 语义准确：同一节点对不同参照物有不同遮挡关系。

### 4.2 Ledger：格表达不了的「时间序列」

格是时刻 t 的结构真值。感知还要回答"同一个 backendNodeId 在 t₁, t₂, t₃... 的状态序列"。

现状对照：`perceptionLedger.ts` 的 `PerceptionLedgerFrame`（含 `capturedAt / facts / versionStamp / stableStamp / pageFingerprint / navigationEpoch`）**已经在做这件事**，容量上限 `MAX_FRAMES_PER_SESSION_TAB = 8`、`MAX_TRACE_TERMS_PER_SESSION = 32`（`perceptionLedger.ts:70-71`）。

**关键架构结论：documentVersion（ref 漂移的解药）不该塞进 entity，该塞进 ledger。** entity 永远是某一瞬的快照，版本号是序列的索引——它是 ledger 的字段。现有 `versionStamp / stableStamp` 已放在 ledger frame 里，位置是对的，只是没说清楚为什么。

**推论：版本脊柱 `loaderId` 的归宿是 ledger，不是 entity。** 这解决了"loaderId 进内核"说法的别扭——它进内核，但进的是 ledger 子系统，不污染 entity schema。

### 4.3 三件套的总图

```
              backendNodeId（共享主键）
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     格(entity)   关系层(rel)    ledger(time)
     节点固有真值  二元关系真值   时间序列真值
     always-on    derived         per-navigation
        │             │             │
     join 即可    join 复用主键   按版本索引
```

- 三者**共享 backendNodeId 主键**——这是复杂度不爆炸的唯一原因。
- 三个都是 O(n) 或 worst-case O(n²)（关系层），**没有任何一个是加权图匹配**。
- 恰好对应 `AGENTS.md` 的 Recoverable Diagnostics：格给状态，关系层给上下文，ledger 给历史。诊断三问（当前是什么 / 为什么 / 之前怎样）一一对应。

---

## 5. 补强清单（按格的脊柱重排）

把第 2 节那张"加通道会怎样"的表，用格的判据重新分类：

### 5.1 进内核（JOIN，零融合复杂度）

读这一节前必须先看 §5.5 的修正——本表的"代价"列在最早期草稿里把"DOM 实体盖 backendNodeId"写成"替换 scanBundle 主路径 / 一次廉价解析"，**那个代价描述是错的**，已在 §5.5 修正。本表保留原结构作对照，真值形态以 §5.5 为准。

| 脊柱 / 动作 | 补的盲区 | 解析回根的代价 | 对位现有代码 |
| --- | --- | --- | --- |
| **DOM 侧补 `backendNodeId`** | 消除整类错配；`ax.ts:414` 兜底整条消失 | captureSnapshot 当 identity+几何+遮挡真值面，与 scanBundle 的页面语义面 **join**（非替换）；join 前仍需一次几何 bootstrap，见 §5.6 | DOM scan 实体补 backendNodeId 字段，scanBundle **保留** |
| **`DOMSnapshot.captureSnapshot` 当 identity+几何+遮挡真值面** | identity + quad 几何 + paintOrder（可算遮挡） | 一次 CDP | `axRuntime.ts` 已按 backendNodeId 列式取 nodes+bounds；现在同时喂 AX 几何、DOM scan bootstrap 与 paint-order 关系层；**与 scanBundle 是 join 非替换，见 §5.5**；`33-layer-paint-occlusion-boundary` 已证明 paint-order rows 可用 |
| **`DOM.getContentQuads` 替代 `getBoundingClientRect`** | 变换元素（rotate/skew）的 IoU 不再算错 | 按需 CDP | scanBundle hit-test 几何源 |
| **DOMSnapshot paint-order → 关系层遮挡** | z-order / paint-order 相邻遮挡候选 | captureSnapshot 已给 owner `backendNodeId` | LayerTree 直连已验证不可用（`LayerTree.enable` 返回 `-32601`）；实现脊柱走 DOMSnapshot paint-order，不走 LayerTree owner mapping |
| **`DOMDebugger.getEventListeners` → 格 listeners** | 真交互性（含祖先委托） | 每节点 `DOM.resolveNode` 后查 | **已落地** `bridge_src/service_worker/dom_flow.ts:146-170`（listener 已带 `backendNodeId`，§5.4 详述） |
| **`MutationObserver` → loaderId/documentVersion** | ref 静默漂移主动失效 | 零 CDP，纯页面 JS | 落 ledger，不动 entity |
| **`IntersectionObserver` + bounded scroll sample → growthProbe 真值** | virtualized/lazy completeness 不再瞎猜 | 零 CDP | 已修 `collections.ts:463-477,630` 的断链：scan 产出，observe 映射，collections 消费 |
| **复合主键 `(targetId, backendNodeId)`** | OOPIF 穿透 | 一次性 schema 升级 | 现 `OOPIF_SESSION_UNSUPPORTED` fail-closed |

### 5.2 留 runtime 按需 probe（结果作 hints 注入）

- `captureVisibleTab` 像素验证 → 仅在 fusion 出可疑结果时反查。
- DOMDebugger listeners 全量太贵（每节点一次 CDP）→ 见 §8 决策四的"限定集合"讨论。

### 5.3 留独立 source（agent 在策略层 join）

- networkRequestId（无 node identity）→ 已是 `Entity.source = "network"`。
- 像素 raster（N:M）→ 已是 `Entity.source = "vision"`。

**关键观察：格的边界恰好就是 `Entity.source` 枚举里已经单列的 network / vision。** 这不是巧合——现有设计已经本能地画出了格的边界，只是没把它说成"格"。

### 5.4 DOMDebugger listener oracle：已落地（执行平面 + bounded 感知 hints）

初稿写"代码未落地"是错的。核实源码：`bridge_src/service_worker/dom_flow.ts:146-170` 的 `collectNodeListeners` **已经在用** `DOMDebugger.getEventListeners`（`:152`，`{ objectId, depth: 1, pierce: true }`），且 listener 记录里**已带 `backendNodeId`**（`:166`）。这是最近 execution-plane CDP fusion 那条 commit 的产出。

这件事对架构判断是**加分而非减分**：

- 它证明"listener 真值挂在格上"不是设计推测，是仓库里跑通的形态——`listener.backendNodeId` 直接就是格的根脊柱，无需新解析路径。
- 它证明 CDP 直连通道（`cdpSend` + `DOMDebugger`）在 bridge service worker 里可用，感知层补强 #1/#2 的通道前提已具备。
- 当前 gap 已从"没喂感知实体"收窄为真实站点成本/深度边界：产品 scan 路径已只对 capped `data.actionables[]` backend candidates 执行 `backendNodeId` → `DOM.resolveNode` → `DOMDebugger.getEventListeners`，并把 bounded listener facts 写入 `Entity.hints.listeners`；`data.listenerOracle` 记录 candidate/probed/listener/failure 统计。
- 代价侧的"每节点 `DOM.resolveNode`"判断需修正：`dom_flow.ts:151` 是按 selector 解析 objectId（`resolveNodeObjectId`），而感知层入口是 `backendNodeId` → `DOM.resolveNode`，selector 已不必要。但每节点一次 CDP 调用的成本结构不变，所以实现只 probe 少量候选，不全量扫描。

### 5.5 承重修正：captureSnapshot 是「identity+几何+遮挡」真值面，**不替换** scanBundle 的「页面语义」真值面

这是本文最需要拧紧的一处，初稿 §5.1 写"DOM 实体改从 captureSnapshot 派生，替换 scanBundle 主路径""代价全部是一次廉价 CDP 解析 + 一个新字段"——**这两句话都错了**。

核实 `capture-src/entries/scanTemplate.ts`（scanBundle 的源模板，minified 后约 37KB 单行）实际产出的远不止几何：

- `selectorFor` —— 规范选择器引擎（与 pick 共享的早退-id 选择器），用于 locator
- `scoreActionable` —— 可动性排序启发式（一长串 role/attr/text 模式）
- `clickable / editable / disabled / focused` —— actionability 判定（DOM 权威，AX 看不全）
- `aria-controls / aria-owns` 解析 → selector（关系层控制关系的 DOM 侧来源）
- `label / displayLabel / innerText` —— 语义文本抽取
- `list_hints / canvas / media / data.rows` —— 集合/画布/媒体/结构化数据 hint

**captureSnapshot 给：** identity（`nodes.backendNodeId`）+ 几何（`layout.bounds` / quad）+ paintOrder（可算遮挡）+ computedStyles。**它不给上面这一整层页面语义计算。**

所以正确形态是 **join，不是 replace**：

```
   captureSnapshot                scanBundle
   ─────────────                  ──────────
   identity (backendNodeId)       selector / locator
   quad 几何                       clickable/editable/disabled/focused
   paintOrder (遮挡)              aria-controls/owns → 关系
   computedStyles                 label/displayLabel/innerText
                                  scoreActionable / list_hints / canvas / media / data.rows

              └──── backendNodeId JOIN（一次，bootstrap，见下）────┘
                                  │
                            MergedDomEntity
```

scanBundle **保留为页面语义真值面**，captureSnapshot **新增为 identity+几何+遮挡真值面**，两者用 backendNodeId join 一次。

### 5.6 承重修正：格不消灭几何，而是把几何 bootstrap 挪到更干净的缝

承认上面 "join 一次" 仍含一步几何关联——DOM scan 实体一开始没有 backendNodeId，要盖这个章，得先把 scan-rect 对到 snapshot-quad。**这一步仍是几何关联，格不是"零几何"。**

但它比现在的 DOM↔AX 模糊匹配干净得多，理由是结构性的：

| 维度 | 现 DOM↔AX 匹配 | 新 DOM↔snapshot bootstrap |
| --- | --- | --- |
| 同引擎 | 否（AX 树是浏览器语义重述，DOM scan 是页面 JS） | **是**（snapshot 与 scan 同源同引擎） |
| 同坐标系 | 近似（都有偏差，见下） | **是**（都是引擎真值） |
| 同一物理节点 | 投影关系，需猜 | **是**（同一帧的同一批节点） |
| 期望 IoU | 0.8 阈值（`COINCIDENT_BOX_IOU`，模糊） | **≈1.0**（同节点 quad 应完全重合） |
| 发生频率 | 每页每节点，每次感知 | **每页每节点，但仅一次**（盖章后全 join） |

净改进：**把一次模糊几何匹配（DOM↔AX，0.8 阈值，每次）换成一次几何关联（DOM↔snapshot，drift-free 窗口内 IoU≈1.0，仅一次）+ 之后全 backendNodeId 精确 join。** 这是真改进，但不是"零几何"，也不是"确定性干净 join"。

### 5.6b 承重修正的承重修正：bootstrap 不是确定性 join

上一节（§5.6 初稿）的措辞"IoU≈1.0 因为同引擎同坐标系"隐含了"干净关联"的承诺。**这个承诺必须收回，否则派生执行计划会按"确定性 join"实现，在真实页面翻车。**

真相是：scanBundle（页面 JS 注入）和 `DOMSnapshot.captureSnapshot`（CDP）是**两次独立采样**，天然不原子。在两次采样的间隔里，页面可能滚动（viewport-relative 偏移）、SPA 可能 mutation（一边看到 A、另一边没看到或反之）、transition/animation 让 box 变化（IoU 偏离 1.0）。这时"同引擎同坐标系"不成立——两次采样看到的不是同一个页面状态。

所以 bootstrap 的正确表述不是"干净关联"，是 **"在 drift-free 采样窗口内是干净关联；drift 时 fail-open，不盖章"**。这是一个**有约束、可失败、可诊断的内部盖章过程**，不是默认可信的确定性 join。

> 预期 fail-open 比例（待 eval 量化，当前未测）：在静态/低动页面应 <5%（按告警处理）；在 SPA 路由切换/高频动画/持续滚动场景可能 >20%（按双轨常态处理）。这一比例未知数决定 §5.8 状态机的默认严格度。若实测常态偏高，则 §5.6 的"净改进"论断要进一步弱化——bootstrap 退化成"DOM↔AX 之外的第二证据"，而非主路径。

派生执行计划的实现约束（由本节直接推出）：

1. bootstrap 是**可选的成功路径**，不是必需步骤。盖章失败的 entity 仍正常参与 projection/collections/relations。
2. 盖章结果必须带**置信度与诊断字段**（§5.8），不允许"盖了就当真"。
3. 下游所有 join（relations anchor key、`pi.click` 落点、listener 关联）必须能**优雅处理无 backendNodeId 的 entity**，不能假设它一定存在。
4. 诊断字段写入 artifact，agent 可精读 bootstrap 质量判断当前页面的归一可信度。

### 5.7 承重修正：坐标系 parity 是一等验证门（perf 审计已钉过的陷阱）

bootstrap 的几何关联只在坐标系一致时才 IoU≈1.0。仓库的 perf/正确性审计早就钉过这三套坐标系的差异，任何派生执行计划必须把它当**一等验证门**：

| 来源 | 坐标系 | 含义 |
| --- | --- | --- |
| `Element.getBoundingClientRect()`（scanBundle） | **viewport-relative** | 滚动会动 |
| `DOMSnapshot.captureSnapshot` 的 `layout.bounds` | **document-relative** | 滚动不动 |
| `DOM.getBoxModel` 的 quad | **content-box quad**，document-relative | 含 border/padding 边界 |

对错一点就同时回归**融合正确性**（IoU 算错 → bootstrap 盖错章）和**点击落点**（quad 偏移 → `pi.click` 落空或落错）。派生执行计划必须：

1. 在 bootstrap 阶段统一坐标系（document-relative 为基准，scan 侧加 scroll offset）。
2. 把"坐标系 parity"做成 contract test（`tests/contracts/`），不只靠 eval 兜底。
3. 任何动到几何源的改动（scanBundle、captureSnapshot 消费、`pi.click` 落点）都要重跑 parity 检查。

这一条在初稿完全没提，是承重缺漏。

### 5.8 bootstrap 状态机：盖章是可失败的诊断过程

承接 §5.6b——bootstrap 不是确定性 join。它必须有显式状态机，每个 DOM scan entity 经过 bootstrap 后落入五态之一：

| 状态 | 触发条件 | 行为 | 写 backendNodeId？ |
| --- | --- | --- | --- |
| **matched** | 唯一高置信匹配（drift-free 窗口 + IoU ≥ 阈值 + 唯一候选） | 正常 join，盖 backendNodeId 章 | **是** |
| **ambiguous** | 多个候选相近（IoU 接近、无唯一最大值） | 保留 DOM entity，**不盖章** | 否 |
| **drifted** | 采样窗口内 scroll/mutation/layout 变化超容差（§5.9） | 保留 DOM entity，**不盖章** | 否 |
| **unavailable** | `DOMSnapshot.captureSnapshot` 不可用（老 Chrome / 特殊页面 / worker） | **整体退回当前 scanBundle + AX merge 路径** | 否 |
| **partial** | 同一次 bootstrap 里部分 entity matched、部分 ambiguous/drifted | matched 的盖章，其余不盖章；**未盖章 entity 必须仍可参与 projection/collections**（§7.5） | 部分 |

**钉死的原则**：失败时降级到今天的行为（DOM entity 无 backendNodeId，靠现有 DOM↔AX 几何评分兜底），**绝不造一个低置信 backendNodeId**。造一个"看起来有主键但实际猜的"backendNodeId，比没有更糟——它会污染下游所有 join（relations anchor key、`pi.click` 落点、listener 关联），且诊断字段无法区分"真匹配"与"假盖章"。

**partial 是常态而非异常**：真实页面里总有部分节点匹配干净（静态结构）、部分不干净（正在动画的、刚 mutation 的）。状态机必须支持单次 bootstrap 内**混合状态**，不能要求"全或无"。

诊断字段（每个 entity 至少记）：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `backendNodeIdCoverage` | 本次 bootstrap 的 matched 比例 | 整体归一质量告警 |
| `matched / ambiguous / failed` 计数 | 各态计数 | 派生执行计划的 eval 指标 |
| `sampleWindowMs` | scan 与 snapshot 采样的时间跨度 | drift 判据 |
| `scrollDelta` | 窗口内 scroll 偏移量 | drifted 态判据 |
| `mutationDirty / changeSeq` | 窗口内 mutation 是否 dirty + ledger 的 changeSeq | drifted 态判据 |

这些字段写入 artifact（不只是内部日志），agent 可精读判断"当前页面这次 observe 的归一可信度"，决定是否需要重 observe 或降级到更保守的策略。

### 5.9 时序诊断：采样窗口的客观记录

承接 §5.6b 的"两次独立采样不原子"——诊断必须记录**客观时间戳与环境状态**，不依赖推断。

记录字段（每次 observe 一组）：

| 字段 | 含义 |
| --- | --- |
| `scanCapturedAt` | scanBundle 注入执行完成的时刻（页面 JS 侧时间） |
| `snapshotStartedAt` / `snapshotEndedAt` | `DOMSnapshot.captureSnapshot` 调用的起止时刻（CDP 侧时间） |
| `sampleWindowMs` | 上述两端的最大跨度，drift 判据的主输入 |
| `scrollX / scrollY` | 采样时的 scroll offset（用于坐标系 parity，§5.7） |
| `viewport` | 采样时的 viewport 尺寸 |
| `fingerprint.changeSeq` | ledger 的 pageFingerprint.changeSeq（mutation 计数） |
| `fingerprint.dirty` | 是否有未消化的 mutation |

**不依赖** `computedStyles.timestamp`（CDP 的 computedStyles 时间戳语义不稳、跨版本不一致）。只用上述自记录的客观字段。

派生执行计划必须把这些字段当成 **bootstrap 质量的输入**，不是事后日志——drifted 态的判定（§5.8）直接读它们，决定是否 fail-open。

### 5.10 边界条件与性能约束（bootstrap 的工程边界）

§5.6b/§5.8/§5.9 定义了 bootstrap 的状态机和诊断。本节定义它（及配套真值面）的**工程边界**——性能上限、降级路径、批量策略。这些不是可选优化，是派生执行计划的硬约束。

**约束 1：captureSnapshot 必须复用，不许二次全量。**

`axRuntime.ts:321` **已经在调** `DOMSnapshot.captureSnapshot` 回填 AX 几何。感知层给 DOM scan 盖 backendNodeId 章，**必须复用这一次调用的结果**，不许再额外打一遍。否则 bootstrap 把每次 observe 的 captureSnapshot 调用从 1 次翻倍到 2 次，直接抵消 §3 "点亮脊柱"的性价比。

派生执行计划的约束：bootstrap 消费的 snapshot 对象与 `axRuntime.ts:321` 的回填调用**共享同一返回值**，通过参数传递而非重复请求。

**约束 2：captureSnapshot 不可用时整体降级。**

老 Chrome / 特殊页面 / 某些 worker 场景，captureSnapshot 可能不全或抛错。此时触发 §5.8 的 `unavailable` 态——**整体退回当前的 scanBundle + AX merge 路径**（即 §1 描述的几何评分匹配），不部分启用 bootstrap。

这意味着 §1 的 `mergeDomAndAxEntities`（`ax.ts:419`）**不能被删除**，只能被降级为 fallback 路径。它是 bootstrap unavailable 时的安全网。派生执行计划必须保留它且有测试覆盖。

**约束 3：DOMDebugger listeners 必须限定集合 + 并发上限。**

`dom_flow.ts:152` 现在是**单 selector 查一次** getEventListeners。感知层若对候选集全量查（列表页候选可能几百个），N 次串行 CDP 调用会把 scan 拖慢一个数量级。CDP 没有 batch getEventListeners。

派生执行计划的约束：

- 默认**不全量** listener oracle。只对 frontier refs / top-K actionable refs probe（K 的上限由 §8 决策四定）。
- probe 必须**并发有上限**（如 `Promise.all` + 并发度 ≤ 4），不许串行。
- listener 结果作 `Entity.hints`（§5.4），不是 entity 固有字段——避免无 listener 的 entity 被当作"不可交互"。

**约束 4：遮挡关系按 paint-order 收敛，不许 O(n²)。**

§4.1 说关系层 worst-case O(n²)。但遮挡关系**不是任意节点对**——它是 paint order / z-order 上相邻的对。真实设计应按 paint-order 排序后只记**相邻遮挡候选**，加 spatial bucket（屏幕分块）收敛，输出**capped highlights**（如 top-20 遮挡关系）。

全量遮挡矩阵不适合默认感知层（n=1000 时百万级关系，envelope 装不下，agent 也读不完）。派生执行计划必须把遮挡关系做成 capped，全量留 artifact 供精读。

**约束 5：坐标系 parity 的测试归属。**

§5.7 说"做成 contract test"。修正：字段/schema 的不变量（如 entity 必带 backendNodeIdCoverage）可以进 `tests/contracts/`；但**几何正确性**（document-relative vs viewport-relative 在真实滚动下是否一致）要真实浏览器 fixture，归 `tests/integration/` 或 eval。纯离线 contract 测不出坐标系 bug。

**约束 6：精读路径必须有 nextActions / artifact hints。**

§7 把 entity 池折叠进 ref pool / artifact 后，agent 诊断"为什么这个 ref 错"时要二次 `browser_artifact` 查询。projection-first envelope **必须**在输出里带 nextActions 或 artifact hints，告诉 agent 如何按 `jsonPath` / ref / templateId / collectionId 读完整 entity、relations、bootstrap diagnostics（§5.8）。

否则"默认降噪"会变成"诊断断路"——agent 看不到完整实体，又不知道去哪精读，recoverable diagnostics 回路断在 envelope 层。这条是 AGENTS.md Recoverable Diagnostics 原则在 projection-first 下的具体化。

---

## 6. 红线复核

按 `AGENTS.md:57-60` 的 perception-only 规则逐项过：

- 格内 objectId→listeners、layerId→遮挡、frameId→OOPIF、loaderId→版本：**全绿**，只读感知。
- 关系层的遮挡、控制：**全绿**，只读。
- ledger 的版本序列：**全绿**，只是记录。
- **唯一要小心的是关系层的"因果"**（A 点击导致 B 变化）：检测因果需要执行 A 来观察 B，踩"不恢复 actuator"红线。**因果关系不进内核**，留 agent 策略层推断或走 evidence 工具的事后回放。

由 `check:abml-verb-runtime` 锁定的红线（不恢复 click/type/scroll actuator、不新增公共 ABML verb）**与本架构完全兼容**——本架构只扩 entity/ledger 字段和关系表，不扩 verb 面。

---

## 7. Projection-first envelope：独立于第 1 层的止血层

### 7.1 这一节在回答什么

前面 §1–§6 补的是"**读准**"——同一物理节点能不能稳定归一、结构能不能可靠建立（反馈里的第 1 层）。但真实生产里有第二类问题，**与读准无关**：

> 一个结构重复的页面（论坛帖子、列表项、导航）会产出大量 button/link/control entity。agent 真正想要的是"页面讲了什么、有哪些主要内容、哪些入口重要"，但首屏输出被大量 pi-ref://、selector、operation/snapshot 元数据和重复实体占掉，projection / collections / 正文被截断，只能去 artifact 里读。

这个问题**即使第 1 层完美也不消失**——因为它的病因不在感知核，在**默认渲染 envelope 的优先级**。所以它是独立的一层，可以、也应该**先于第 1 层做**：第 1 层是地基工程，envelope 是止血，两者正交。

### 7.2 当前 envelope 形态（要被替换的）

```
默认 observe 输出 ≈
  [大量 entity 实例]  ← 一等，占满预算
  + [projection]      ← 被预算挤掉的奢侈品
  + [collections]     ← 同上
  + [正文 / outline]  ← 同上
```

后果：1.2MB / 960 entities 的首屏，agent 不得不二次 `browser_artifact` 才能看到结构。

### 7.3 目标 envelope 形态（projection-first）

```
默认 observe 输出 ≈
  gist                ← 一句话页面概要（页面是什么 / 当前状态）
  + collections       ← 集合摘要（哪个列表、completeness、规模）
  + snapshotProjection ← 模板折叠（一个模板 + N 个实例 handle）
  + outline           ← 结构大纲（heading/landmark）
  + relations.summary/highlights  ← 关系摘要（哪个 controls 哪个、遮挡 highlights）
  + frontier refs     ← 少量高信号可操作入口（agent 当前最可能要点/读的）
  + [entity 池 → ref pool / artifact]  ← 完整池折叠，按需精读
```

**完整 entity 池不消失**——它进 ref pool / artifact，agent 用 `browser_artifact` 按 ref / templateId / collectionId 精读。变的是**默认首屏的优先级**：结构投影在第一顺位，entity 实例不在。

### 7.3b 关系摘要已是 projection-first 的既定成员（不是新加的）

`relations.summary` / `relations.highlights` **已经是** projection-first 的默认输出，不是本文要新增的。核实源码 `src/tools/resultMiddleware.ts:40-42, 234-236, 446, 509, 535`：

- `:40-42` 注释明确："relations.summary = type→count, **always present** when abmlIntegrated; relations.highlights = deterministic capped sample. **Lifted here so the budget never hides it.**"
- `:236` `envelopeRelations()` 从 uncompressed focus 克隆 relations 摘要。
- `:446 / :509 / :535` 在 envelope 装配点强制写入，**不受预算挤压影响**。

所以 §7.3 把 `relations.summary/highlights` 列入目标形态，是在记录**既有行为**，不是提议新行为。本文的增量是：当 §4.1 把关系层从派生字段升格、§5.1 点亮遮挡/控制真值面后，这个**已在 projection-first 中保形**的 relations 摘要会**承载更准的关系真值**（遮挡不再靠 elementFromPoint 猜、控制不再靠 selector 对）。输出槽位不变，槽里的真值变准。

一个推论：派生执行计划里，"关系层一等公民化"（§8 决策一）的**渲染侧不需要新输出槽**——`envelopeRelations` 已经在跑。增量全在感知侧（真值更准 + anchor key 稳定）。这降低了关系层升级的渲染面风险。

### 7.3c frontier refs 的信号来源（修正：ledger 不是 saliency oracle）

初稿曾暗示"ledger 能动态选 frontier refs"。**这是错的，修正如下。**

ledger 是**连续性与历史载体**（perceptionLedger.ts：`facts / versionStamp / stableStamp / pageFingerprint / objective`），它回答"这个 ref 之前展示过吗 / 变了吗 / 稳定吗"，**不回答"agent 现在最该关注哪个"**。把 ledger 当 saliency oracle 是范畴错误。

frontier refs 的选择应是**多信号合成**，ledger 只参与其中"稳定性/最近展示/历史变化"那一维：

| 信号 | 来源 | 回答 |
| --- | --- | --- |
| relevance | task intent / 当前焦点 region | "agent 的任务指向哪块" |
| actionability | scanBundle 的 `scoreActionable` + clickable/editable | "这个 ref 能不能被操作" |
| recency / stability | **ledger**（versionStamp/stableStamp/lastShownGranularity） | "这个 ref 刚变过吗 / 一直稳定吗" |
| delta | `treeDiff` / `diff`（abml-core 的 temporal diff） | "这个 ref 是新出现的还是持续存在的" |
| relations weight | relations.summary/highlights | "这个 ref 在关系网里是枢纽吗（controls 多个目标）" |

ledger 在这张表里只是五行之一，不是 oracle。派生执行计划必须把 frontier 选择实现成**可插拔的信号合成**，而不是"问 ledger 要 top-N"——后者会把 ledger 的历史职责和 saliency 职责耦合，违反 Semantic Singularity。

### 7.4 为什么这层独立于第 1 层，可以先做

| 维度 | 第 1 层（identity lattice） | 第 7 层（projection-first envelope） |
| --- | --- | --- |
| 病因 | DOM↔AX 归一不准，重复结构难合并 | 渲染优先级错位，entity 池当一等输出 |
| 触碰的代码 | `ax.ts` 合并、scanBundle 几何源、ledger | renderer / envelope 装配 / observeRunners |
| 可观测收益 | 模板折叠更稳定（同一物理节点更可靠合并） | 首屏 token 直接下降，agent 默认看到结构 |
| 依赖关系 | 不依赖第 7 层 | **不依赖第 1 层**——projection/collections 现在就在跑 |
| 见效速度 | 地基工程，慢 | **立刻止血** |

第 7 层做完后，第 1 层的收益会更**显形**——因为 entity 池进了 ref pool，模板折叠的稳定性直接决定 agent 精读时能不能拿到干净的实例集。两层是乘法关系，但可独立交付。

### 7.5 一个要主动反驳的表述：不能让 scan "先结构后 entity"

反馈里有一句"scan 的感知底盘仍容易先产出一堆 entity，再让 renderer 在预算里裁剪"，并把"让结构靠前"当成中间层补法。**这个表述把因果颠倒了，本文不采纳。**

理由是结构性的：

- `snapshotProjection` 的模板折叠**需要**完整 entity 池才能做（要看到所有兄弟节点才能识别重复模式）。
- `collections` 的 completeness 判定**需要**完整 entity 池（要数清集合成员）。
- 所以 scan **必须**先产出完整 entity 池——这是它的本职。让 scan "先给结构后给 entity" 等于让 scan 干 renderer 的活，违反 brain-hand separation，也违反 Unix 哲学（scan 出原始数据，renderer 决定怎么看）。

正确的表述是：**scan 继续产出完整 entity 池（感知层不变），envelope 的默认优先级改成 projection-first（渲染层变）**。病因在渲染策略错位，不在感知层"先产出了 entity"。这一区分对派生执行计划很重要——它决定了改动落在 `observeRunners` / renderer 还是 `ax.ts` / scanBundle，落错了地方就白做。

### 7.6 与 §1–§6 的关系（不冲突、可叠加）

- 第 1 层让 entity 池**更干净**（稳定归一 → 模板折叠更准）。
- 第 7 层让 entity 池**默认不看**（projection-first）。
- 叠加效果：agent 首屏看到干净的结构投影，精读时拿到稳定归一的实例集。
- 两层都做完，"1.2MB / 960 entities"问题才**完整**闭合——第 1 层单独做完，entity 池更干净但仍占满首屏；第 7 层单独做完，首屏干净但精读时实例可能错配。所以反馈说"草案还不能单独完成问题 2"是对的，但要补的不是"再做一个 Projection-first scan envelope 跑在感知核之上"这种串行依赖，而是**两个正交层并行交付**。

---

## 8. 后续演进决策（本轮关闭，按证据重开）

本节保留恒等格后续演进方向，但这些项**不是**当前未完成计划。OOPIF 复合主键、关系层中央图、ledger 容量、frontier 预算都已在本轮由 closed decision 重开核验；当前状态分别见决策一/二/三/五。真实站点复杂边界只按 §0.3 的证据门另起执行合同。

### 决策一：关系层是一等公民还是 entity 的派生字段？

- **当前关闭状态：一等公民的中央图已落地，entity 字段保持派生兼容。**
- `RelationGraph` 是完整关系层：`edges` 存边本体，`bySource` / `byTarget` / `byType` 提供反查索引；`entity.relations[]` 继续作为 capped 派生字段，维持旧消费面和 compact summary。
- 输出分层已关闭：model-facing envelope 只给 `relations.summary/highlights`；完整图只进 saved artifact 的 `envelope.relationGraph`，并由 `artifact_hints.jsonPaths.relationGraph` 指路。当前不需要再做 schema big-bang。

### 决策二：复合主键升级 `(targetId, backendNodeId)` 的当前状态

不做 → OOPIF 永远进不来；当前已完成最小可验证路径，缺失 target 仍 fail-closed。

做 → 正确的终态是 `nodeKey = { targetId?, backendNodeId }`（或字符串复合 key），但**不能 big-bang**。本轮按双写兼容落地：target-scoped 节点优先写 `t:<targetId>:b:<backendNodeId>`，同时保留 `b:<backendNodeId>`；裸 backend ref 继续在同 target 路径工作，target-scoped ref 则显式带 `targetId`。

已执行的迁移策略（双写兼容）：

1. **内部新增** `nodeKey = { targetId?, backendNodeId }`。同源 frame 下 `targetId` 为空，退化为裸 backendNodeId——这一步对现有同源行为零影响。
2. **关系层双注册**：新 `nodeKey` + 旧 `b:<backendNodeId>` anchor 同时写入，消费侧先读新 key，旧 key 保持兼容。
3. **public / ref / runtime 继续接受裸 backendNodeId**。裸 ref 走当前 tab/target 上下文；只有跨 target/OOPIF 的 backend ref 显式携带 `targetId`。
4. **OOPIF runtime gate 已补证**：`34-oopif-composite-key-boundary` 证明 `Target.setAutoAttach` / `Target.attachedToTarget` flat session 路由、child click delivery、旧 ref 兼容和 invalid target fail-closed。

剩余边界不是当前未完成项：真实站点多 OOPIF、导航后 child session 生命周期、跨 target artifact 归属与成本，需新证据门再扩展。

### 决策三：ledger 容量边界现在合理吗？

- 现 `MAX_FRAMES_PER_SESSION_TAB = 8` / `MAX_TRACE_TERMS_PER_SESSION = 32`。
- 本轮结论：**保持不变**。最终 fixture eval 33/33 passed，temporal profile 175 个样本 `historyLostCount=0`，没有当前任务因为历史帧不足失败。
- 扩容的 reopen 条件：真实长任务或 blind eval 给出可复现 history miss，且扩大 ring 后 task success 提升、token/内存增量可接受。没有这类证据时，调大只是在增加状态面。

### 决策四：DOMDebugger listeners 进格还是留 probe？

- 进格：每个交互候选节点带 listeners 真值，agent 单次决策即可判断可点性。
- 留 probe：agent 按需查，省 CDP 调用。
- 当前执行结果：**交互候选节点进格（限定集合，不全量）**。产品路径只 probe capped `data.actionables[]` backend candidates，listener facts 只作为 `Entity.hints.listeners` 证据，不变成 action 策略。后续若重开，只讨论真实站点成本、事件委托深链 depth、是否需要关系边。

### 决策五：projection-first envelope 的预算分配 + frontier 信号

第 7 层的止血已做，"projection / collections / frontier refs / ref pool 各占多少预算"本轮按现有预算关闭：

- 预算太倾向 projection → agent 看到结构但缺可操作入口（frontier refs 太少）。
- 预算太倾向 frontier refs → 退化回 entity-first 的老问题。
- 倾向：**projection + collections 占首屏预算的大头**（结构是 agent 决策的地基），frontier refs 按"当前任务/焦点区域"动态选少量（不是静态 top-N）。

**frontier refs 的信号来源见 §7.3c**：是多信号合成（relevance + actionability + treeDiff/diff + relations weight + ledger 的 recency/stability），**ledger 不是 saliency oracle**，只是五信号之一。初稿"依赖 ledger 版本序列"的表述已被 §7.3c 推翻——这条决策不与决策三（ledger 容量）强耦合，frontier 选择有独立实现路径。

预算分配与 frontier 选择的验证已补持久化指标：`evals/browser-workflows/runner.mjs` 记录 `observeCallCount`、`observeResultTextChars`、`observeEstimatedTokens`、`artifactJsonPathReadCalls`、`artifactBroadReadCalls`。最终 run 33/33 passed，`browser_observe` 18 次，observe 估算 token max=3335，`browser_artifact` 7 次且 4 次为 jsonPath 精读；没有证据要求调大首屏预算或重分配。未来若真实 agent friction 显示找不到入口，再以任务成功率 + 二次 artifact 读取成本 A/B 重开。

### 决策六：第 1 层与第 7 层的交付顺序

反馈暗示"先做第 1 层地基，再做第 7 层 envelope"（串行）。本文判断相反：**第 7 层先做（止血），第 1 层后加固（地基），两层正交可并行**。理由：第 7 层不依赖第 1 层（§7.4），且见效快；第 1 层是慢工程，不应阻塞止血。

后续重开时的建议顺序（架构判断，非当前排期承诺；本轮关闭条件见 §10）：

1. **Projection-first envelope**（§7）——改 renderer/envelope 默认展示，立刻止血，不依赖 identity lattice。
2. **文档补齐**——relations 在 projection-first 中的位置（§7.3b）、frontier 信号来源（§7.3c）、entity pool/artifact 精读路径（§5.10 约束 6）。
3. **Bootstrap diagnostics + fail-open contract**（§5.8/§5.9/§5.6b）——已按 best-effort 产品路径落地：`matched` 才盖 `backendNodeId`，`ambiguous/stale/missing/unsupported` fail-open，证据见 §0.4。
4. **Identity lattice 精确 join + 复合 key + listener/遮挡/growthProbe 真值面扩展**（§5.1/§5.4/§5.5/§4）——遮挡已走 DOMSnapshot paint-order 落地，listener 已作为 bounded read-only hints 落地，growthProbe 数据通道已接入 scan → collections，OOPIF 复合 key 已完成 fixture 级 runtime gate；剩余方向转为真实站点边界和关系层/ledger/frontier 扩展。

第 7 层先落地会**暴露**第 1 层的缺口（agent 精读 ref pool 时遇到错配实例），这是好事——给第 1 层提供 eval 信号，让"读准"的优先级由真实 agent 痛点驱动，而不是架构师的预判。

---

## 9. 与现有代码的对位（证明这不是推倒重来）

本架构的大部分地基**已经存在**，只是没被说成"三件套"：

| 架构概念 | 现有代码 | 缺口 |
| --- | --- | --- |
| 格的根 backendNodeId | `axRuntime.ts` 已建 `nodeByBackend`，`identityBootstrap.ts` 已把 DOMSnapshot geometry rows best-effort 盖到 scan actionables | fixture 产品路径已对齐；剩余是真实站点 animation/virtualized/multiframe 边界 |
| 双向权威字段合并 | `ax.ts:363-390` `mergedEntity` | 已对，保留 |
| 关系层 | `entity.ts` `EntityRelation[]` + `relations.ts` 中央 `RelationGraph` | 完整图已是一等公民；entity 字段为 capped 派生兼容 |
| ledger | `perceptionLedger.ts` 完整存在 | versionStamp 已在 frame 里，定位正确；容量经 eval 保持现值 |
| 格的边界（network/vision 留外） | `types.ts` `Entity.source` 枚举 | 已本能画出，未显式表述为格 |
| DOMDebugger listener oracle | **已在执行平面落地** `dom_flow.ts:146-170`，listener 带 backendNodeId；`runtime.ts` 已将 capped backend candidates 的 listener facts 写入 `Entity.hints.listeners` | fixture 产品路径已点亮；剩余是真实站点候选集成本和事件委托深链策略 |
| captureSnapshot 的 identity+几何 | `axRuntime.ts` 按 backendNodeId 列式取 geometry rows；`runtime.ts` 复用同一次 snapshot 对 scan data 做 bootstrap | 已完成 best-effort 盖章；剩余是真实站点边界与成本证据 |
| DOMSnapshot paint-order | `bridge_src/service_worker/layer.ts` 内部探针已证明 `paintOrder + backendNodeId + bounds` 可取；`relations.ts` 已按 paint-order 相邻候选 + spatial bucket 派生 capped `coveredBy`/`occludes`；`runtime.ts` 在 merge/remint 后写入关系层 | 已完成 fixture 级关系落地；剩余缺口是真实站点复杂合成边界与像素反查是否需要 |
| OOPIF | `nodeKey.ts` / `identityGraph.ts` / `relations.ts` 已双写 target-scoped 与 legacy backend keys；`cdp.ts` 通过 `Target.setAutoAttach` flat session 路由 child target；`input.ref` 消费 `targetId` 并 fail-closed | fixture runtime gate 已点亮；剩余是真实站点多 OOPIF/导航后 session 生命周期与 artifact 归属边界 |
| growthProbe | `buildScanScript.ts` 已注入 bounded `collectGrowthProbe`，`scanRunner.ts` 已将 `data.growthProbe` 传入 `collections.ts`；`collections.ts` 按 count/height/windowShift 证据分类 | fixture 产品路径已点亮；剩余是真实站点 lazy/virtualized 组件副作用成本和嵌套 scrollport 策略 |

**结论：本架构是对现有代码的"重新表述 + 定向点亮"，不是重写。** 大部分代码不动，动的是（与 §5.5/§5.6/§5.7 的承重修正一致）：

- **scanBundle 不替换**：保留为页面语义真值面，captureSnapshot 新增为 identity+几何+遮挡真值面，两者 backendNodeId join 一次（§5.5）。
- DOM scan 实体已 best-effort 补 backendNodeId 字段（一次几何 bootstrap，§5.6；坐标系 parity / fail-open 状态机由 `32-abml-identity-bootstrap-evidence` 与单测锁定）。
- DOMSnapshot paint-order 已作为遮挡关系脊柱接入；后续只在复杂合成/像素反查边界上继续加证据，不再回到 LayerTree owner mapping。
- listener oracle 已从执行平面拉只读分支进感知 `Entity.hints.listeners`（§5.4，capped / fail-open / 非策略）。
- growthProbe 已从 collection kernel 的悬空消费点变为产品数据通道：scan artifact 产出 `data.growthProbe`，observe collections 消费并输出 `virtualized` continuation evidence。
- 关系图 artifact 精读路径、eval 指标持久化和 ledger/projection 预算证据闭环。

---

## 10. 执行收口与关闭条件

本轮不把所有 §5/§8 的地基工程一次性做完；完成标准是把当前可验证、低隐藏依赖的恒等格可见面落地：

- `identityGraph` 给出 backendNodeId 覆盖率、source 分布、语义 anchor 与 triggered 边计数；完整 `byRef` 图只进 artifact。
- `browser_observe mode=scan` 的 model-facing envelope 顶层暴露 `identity` 摘要，紧预算下仍保留 compact 诊断。
- `artifact_hints.jsonPaths` 明确指向 `envelope.identityGraph`、`envelope.snapshotProjection`、`envelope.relations`、`envelope.relationGraph`、`envelope.collections`，agent 不需要猜 raw artifact 路径。
- `RelationGraph` 完整图 artifact-only，`bySource/byTarget/byType` 可用于关系反查；`entity.relations[]` 继续作为 capped 兼容派生字段。
- workflow eval summary 持久化 observe token 与 artifact read mix；temporal profile 证明当前 ledger 容量没有 history loss，projection/frontier 预算无当前失败信号。
- `CURRENT.md`、README、skill、CHANGELOG 与 tests/contracts 同步；`docs:sync` 与最终 `npm run check` 通过。

关闭后本文件保留为当前架构参考，不迁入 archive，除非后续另起更深的真实站点 bootstrap/listener/OOPIF/DOMSnapshot paint-order 或关系层/ledger/frontier 执行合同。

---

## 附：关键文件索引

- `src/abml-core/identityBootstrap.ts` — DOM scan `backendNodeId` best-effort bootstrap 状态机与诊断统计
- `src/abml-core/nodeKey.ts` — `(targetId, backendNodeId)` 复合 nodeKey 与 legacy backend key 兼容格式
- `bridge_src/service_worker/cdp.ts` + `bridge_src/service_worker/input.ts` — `Target.setAutoAttach` flat child session 路由与 target-scoped `input.ref`
- `src/abml-core/ax.ts` — `mergeDomAndAxEntities` 先按 backendNodeId 精确 join，缺失时降级到几何评分融合
- `src/abml-core/ax.ts:30-32` — `AX_AUTHORITATIVE_STATE` / `GEOMETRY_MATCH_RADIUS_PX` / `COINCIDENT_BOX_IOU`
- `src/abml/verbs/axRuntime.ts:281-289` — `Accessibility.getFullAXTree`（无 frameId，OOPIF gap 根因）
- `src/abml/verbs/axRuntime.ts:300-311` — `nodeByBackend` 映射（格根的雏形）
- `src/abml/verbs/axRuntime.ts` — `DOMSnapshot.captureSnapshot` geometry / paintOrder 行来源
- `src/abml-core/entity.ts` — Entity / EntityRelation schema（关系层雏形）
- `src/abml/verbs/runtime.ts` — scanBundle 注入点与 DOMSnapshot bootstrap 汇合点
- `src/abml/perceptionLedger.ts:20-71` — ledger 完整形态 + 容量边界
- `src/scan/buildScanScript.ts` + `src/tools/observe/scanRunner.ts` + `src/abml-core/collections.ts:463-477,630` — growthProbe 产出/映射/消费链
- `AGENTS.md:21` — Root-Truth Sourcing 原则（本架构的法理依据）
- `AGENTS.md:57-60` — ABML perception-only 红线（本架构兼容性边界）
