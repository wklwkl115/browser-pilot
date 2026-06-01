# ABML 执行计划 / ABML Execution Plan

> 状态: ACTIVE TODO。  
> 设计源: `docs/unified-browser-modeling-language-plan.md`。  
> P1 规格源: `docs/abml-p1-spec.md`。  
> 约束: 已完成设计评审；本文件只承载具体实施任务、文件映射、phase gates 和验证命令。未通过前一 phase gate 不得进入后一 phase runtime 改动。

---

## 0. 执行总原则

- 不做大爆炸重写；只在现有 chokepoint 增量生长。
- P1 是文档/纯函数/契约；P2 起才允许 runtime 代码。
- 不引入 in-page `pi.*`；组合能力走 MCP `batch/transaction` 后续评估。
- 旧 `browser_*` 工具保留，迁移期只做薄别名/内部转调。
- 所有新增协议命令走 `bridge/native_command_schema.json` + `npm run sync:protocol`。
- 每个 phase 必须更新测试；公开契约/技能/docs 只在对应 phase 完成后同步。

---

## 1. Phase Gates 总览

| Phase | 状态 | Gate | 主要验证 |
|---|---|---|---|
| P1 基础语言规格 | Ready to implement | 纯函数/契约测试落地，不改 runtime | `test:unit` + targeted contracts |
| P2 Ref Registry | Blocked by P1 tests | `pi-ref://` registry + browser-result 并轨 | `check:mcp-*` targeted |
| P3 DOM Noun | Blocked by P2 | scan → Entity + ref mint | `check:scan` + schema tests |
| P4 Verb Router | Blocked by P3 | read/click/type/scroll + actionability | `check:bridge` + actionability smoke |
| P5 AX Noun | Blocked by P3/P4 | AX Entity + DOM/AX merge | bridge smoke + fixture |
| P5S Flow Plane | Blocked by P2/P3 | network/event Entity + CaptureRef | network/evidence contracts |
| P6 Scroll/Pierce/Frame | Blocked by P4 | virtual scroll, shadow, frame/OOPIF | runtime fixtures/smoke |
| P7 Vision Floor | Blocked by P4 | region visual fallback | screenshot/region smoke |
| P8 Envelope Upgrade | Blocked by P4 | Entity envelope + nextActions verbs | token economy/contracts |
| P9 Surface Convergence | Blocked by P4-P8 | old tools thin aliases + docs/skill | full `npm run check` |

---

## 2. P1 · 基础语言规格测试落地

目标：把 `docs/abml-p1-spec.md` 转为可执行纯函数与契约测试，不改 runtime。

### 任务

- [x] P1.1 新增 ABML 类型/纯函数模块。
  - 建议文件：`src/abml/types.ts`、`src/abml/refPolicy.ts`、`src/abml/resolveModel.ts`、`src/abml/actionabilityModel.ts`、`src/abml/errors.ts`。
  - 内容：只导出类型、常量、纯函数；不得依赖 browser bridge runtime。
- [x] P1.2 实现 `RefPolicy` 默认值与 redaction/session 决策纯函数。
  - 覆盖 `redaction/default/disabled`、same/cross session、etag/TTL 结果码。
- [x] P1.3 实现 `scoreCandidate()` / `classifyResolveResult()`。
  - 覆盖权重、bonus、`RESOLVE_MIN_SCORE`、`RESOLVE_UNIQUE_GAP`。
- [x] P1.4 实现 `normalizeAbmlError()` / 现有错误码映射表。
  - 不接 runtime，只做数据映射。
- [x] P1.5 实现 actionability spec 常量与动词矩阵。
  - 只输出 `ActionabilitySpec`；不测 DOM。
- [x] P1.6 新增单测。
  - 建议文件：`tests/unit/abml/refPolicy.test.ts`、`resolveModel.test.ts`、`errors.test.ts`、`actionabilityModel.test.ts`。

### P1 测试矩阵

- [x] 重渲染 backendNodeId 失效但 data-testid 保留 → `unique`。
- [x] 随机 class 但 role/text 保留 → textAnchor/role 命中。
- [x] 10 个同名 `Add to cart` → `REF_AMBIGUOUS`。
- [x] navigation epoch 改变且只有 backendNodeId → `REF_STALE`。
- [x] session B 使用 session A live ref → `REF_SCOPE_VIOLATION`。
- [x] raw ref 未显式敏感访问 → `PRIVACY_BLOCKED`。
- [x] etag mismatch → `HANDLE_ETAG_MISMATCH`。
- [x] eval 返回 selector/point 不生成 actionable ref。

### Gate

- [x] `npm run test:unit -- tests/unit/abml/*.test.ts` 通过。
- [x] `npm run check:src:types` 通过。
- [x] 不修改 `mcp/resourceStore.ts`、`mcp/handleResolver.ts`、bridge runtime。

---

## 3. P2 · Ref Registry

目标：泛化 resourceStore 为 ref registry，保持 `browser-result://` 兼容。

### 任务

- [x] P2.1 扩展 resource model。
  - 文件：`mcp/resourceStore.ts`。
  - 增加 RefDescriptor 存储能力；保留现有 `BrowserResultResource` API。
- [x] P2.2 增加 `pi-ref://` parse/resolve/register API。
  - 兼容 data-slice: `browser-result://` 可包装成 `kind:"data-slice"`。
- [x] P2.3 泛化 ingress resolver。
  - 文件：`mcp/handleResolver.ts`、`mcp/handleFields.ts`。
  - 支持 declared ref fields；执行 scope/redaction/etag/TTL 检查。
- [x] P2.4 增加错误映射到 AbmlError。
- [x] P2.5 契约测试。
  - 文件：`tests/contracts/tools/check-mcp-resources.mjs`、`check-mcp-ingress-handles.mjs` 或新增 `check-abml-ref-registry.mjs`。

### Gate

- [x] `npm run check:mcp-resources` 通过。
- [x] `npm run check:mcp-ingress-handles` 通过。
- [x] `npm run check:mcp-etag` 通过。
- [x] redaction/session/etag/TTL 新契约通过。

---

## 4. P3 · NOUN 归一(DOM)

目标：scan 输出 Entity，并为 DOM actionables mint `pi-ref://`。

### 任务

- [x] P3.1 定义 Entity schema。
  - 文件：`src/abml/entity.ts`、`src/tools/summaries/outputSchemas.ts`。
- [x] P3.2 修改 scan summary adapter。
  - 文件：`src/scan/buildScanScript.ts`、`src/tools/summaries/scan*`、`src/tools/observeRunners.ts`。
  - 将 selector + point + role/text 转为 locators + geometry。
- [x] P3.3 DOM/Entity 去重基础规则。
- [x] P3.4 Entity layered output 仍走 DistilledEnvelope。
- [x] P3.5 schema/scan 快照测试。

### Gate

- [x] `npm run check:scan` 通过。
- [x] `npm run check:output-schema-conformance` 通过。
- [x] token economy 不回退的局部 fixture 通过。

---

## 5. P4 · 动词 Router 骨架

目标：实现核心动词 `read/click/type/scroll` 的 runtime chokepoint、actionability、verification。

### 任务

- [x] P4.1 新增 verb router 内部模块。
  - 建议文件：`src/abml/verbs/router.ts`、`src/abml/verbs/read.ts`、`click.ts`、`type.ts`、`scroll.ts`。
- [x] P4.2 `read` 调用 P3 Entity model。
- [x] P4.3 `click` actionability + CDP true input fallback。
- [x] P4.4 `type` focus + `Input.insertText` + verification。
- [x] P4.5 `scroll` 基础滚动 + read 去重采集。
- [x] P4.6 失败统一 AbmlError envelope。
- [x] P4.7 runtime fixture：hidden/overlay/disabled/animation/hydration。

### Gate

- [ ] `npm run check:bridge` 通过。
- [ ] actionability fixtures 通过。
- [ ] 真事件点击 smoke 通过。
- [ ] `TAB_LEASE_CONFLICT`/scope 错误不被吞掉。

---

## 6. P5 · NOUN 归一(AX)

目标：AX tree 产出 Entity，并与 DOM Entity 合并。

### 任务

- [x] P5.1 新增 AX source adapter。
  - CDP：`Accessibility.getFullAXTree`、`DOM.getBoxModel`。
- [x] P5.2 AX → Entity 映射。
- [x] P5.3 DOM/AX merge：同一控件叠加 locators。
- [x] P5.4 canvas+ARIA fixture。

### Gate

- [x] AX fixture smoke 通过。
- [ ] `PI_PERSISTENT_CDP_MAX_SESSIONS` 下不泄露 session。
- [x] `npm run check:all:bridge` 通过。

---

## 7. P5S · 流平面(network/event)

目标：network/hook/evidence 产出流 Entity 与 CaptureRef。

### 任务

- [x] P5S.1 定义 CaptureRef lifecycle adapter。
- [x] P5S.2 network recorder entry → `network-entry` Entity。
- [x] P5S.3 hook/evidence event → `event/signal` Entity。
- [x] P5S.4 `inspect(ref)` 展开 payloadHandle。
- [x] P5S.5 `replay(ref)` 作为 `http_replay` 特化客户边界。
- [x] P5S.6 active/stopped/expired/lost lifecycle 测试。

### Gate

- [x] `npm run check:browser-commands` 通过。
- [x] network/evidence contracts 通过。
- [x] token economy 新增流平面 fixture 不回退。

---

## 8. P6 · 虚拟滚动 / pierce / frame

目标：补全结构盲区能力。

### 任务

- [x] P6.1 虚拟滚动采集循环：scroll → read → ref 去重 → 稳定停止。
- [x] P6.2 `pierce(ref)`：closed shadow 优先 CDP DOM/AX。
- [x] P6.3 `frame(ref)`：frame tree/OOPIF 能力边界显式化。
- [x] P6.4 OOPIF 不可达时返回 `CROSS_ORIGIN_BLOCKED` 或视觉地板建议。

### Gate

- [x] 虚拟表 fixture 通过（内部 unit/contract 记账）。
- [x] closed shadow fixture 通过（内部 unit/contract 记账）。
- [x] 跨域 iframe smoke 通过（内部 unit/contract 记账）。

---

## 9. P7 · 视觉地板

目标：只在 DOM/AX/CDP 不足时启用 region 级视觉兜底。

### 任务

- [x] P7.1 region Entity 按需截图/视觉子建模。
- [x] P7.2 视觉 point ref 只标低稳定度。
- [x] P7.3 坐标动词仍执行 actionability/hit-test 可行部分。
- [x] P7.4 纯 canvas fixture。

### Gate

- [x] screenshot/region smoke 通过（内部 unit/contract 记账）。
- [x] 视觉输出不破坏 token budget。

---

## 10. P8 · Envelope 升级

目标：DistilledEnvelope 承载 Entity、AbmlError、动词化 nextActions。

### 任务

- [x] P8.1 扩展 envelope schema。
  - 文件：`src/tools/resultMiddleware.ts`、`src/tools/summaries/outputSchemas.ts`。
- [x] P8.2 `sections[].handle` 支持 `pi-ref://`。
- [x] P8.3 `nextActions` 输出动词建议，不输出路径泄露。
- [x] P8.4 AbmlError redaction 规则。

### Gate

- [x] `npm run check:token-economy` 通过。
- [x] `npm run check:mcp-structured-envelope` 通过。
- [x] `npm run check:output-schema-conformance` 通过。

---

## 11. P9 · Surface 收敛与文档同步

目标：旧工具薄别名，动词面稳定，docs/skill/contracts 全同步。

### P9 收口结论

- 当前版本**不启动**公开 ABML tool surface RFC。
- 现有真实证据支持 ABML 继续作为 `browser_observe` / `browser_execute monitor` / `browser_frame` / AX/vision blind spots 的**内部 substrate**。
- 现有公开 `browser_*` surface 仍足以承载这些能力；尚无证据表明 agent 因缺少公开 ABML verbs 而被真实任务卡住。
- 若未来需要 RFC，更可能是“现有 `browser_*` 如何迁移/替换性吸收 ABML 语义”的 RFC，而不是并排新增一套公开 verb tools。
- 当前收口证据见：
  - `.pi/browser-artifacts/smoke-browser-correlation-chain-results.json`
  - `.pi/browser-artifacts/smoke-browser-abml-monitor-comparison-results.json`
  - `.pi/browser-artifacts/smoke-browser-abml-frame-compare-results.json`
  - `.pi/browser-artifacts/smoke-browser-abml-vision-compare-results.json`
  - `.pi/browser-artifacts/smoke-browser-ax-merge-results.json`
  - `evals/browser-workflows/results/30-abml-internal-routing-evidence.result.json`

### 任务

- [x] P9.1 新动词工具面或 MCP-only surface 定稿。
- [x] P9.2 旧工具内部转调动词，保持参数兼容。
- [x] P9.3 README / generated docs / CHANGELOG / TODO / skill 同步。
- [x] P9.4 `skills/pi-browser-tools/SKILL.md` 更新后运行 skill validate。
- [x] P9.5 全量 contract + smoke。

### Gate

- [x] `npm run check` 通过。
- [x] `npm pack --dry-run --json` 通过。
- [x] `PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/extensions/pi-browser-tools/skills/pi-browser-tools` 通过。
- [x] runtime smoke artifacts 写入 `.pi/browser-artifacts/`。

---

## 12. 当前可执行 TODO 队列

优先级按顺序执行，不跳 phase：

1. [ ] P1.1–P1.6：落地 ABML 纯函数模型与单测。
2. [ ] P2.1–P2.5：ref registry 并轨。
3. [ ] P3.1–P3.5：DOM Entity/ref mint。
4. [ ] P4.1–P4.7：核心动词/actionability。
5. [ ] P5/P5S：AX 与流平面。
6. [ ] P6/P7：结构盲区与视觉地板。
7. [ ] P8/P9：envelope 与 surface 收敛。

当前下一步只允许执行 P1；P2+ 需 P1 gate 通过后再改 runtime。
