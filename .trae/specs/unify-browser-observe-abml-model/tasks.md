# Tasks

- [x] Task 1: 固化 canonical `browser_observe` 产品合同与边界
  - [x] SubTask 1.1: 更新 `src/commands/observeCommand.ts` 的 command description、prompt snippet、prompt guidelines 和参数描述，使主路径明确为返回 canonical ABML page model。
  - [x] SubTask 1.2: 将 `mode`、`selector`、`includeLinks`、`htmlMode`、`params`、`intent` 等策略/投影参数标注为 legacy/debug/projection 或兼容参数，避免作为推荐调用方式出现。
  - [x] SubTask 1.3: 更新 `CODE_WIKI.md` 中 `browser_observe` 与 ABML 章节，明确 ABML 是 agent-native 页面统一建模层，`browser_observe` 是公开读取入口。
  - [x] SubTask 1.4: 更新 `README.md` 中 Structured DOM Perception/Session Delta/Memory 相关文案，消除 `mode=scan/content/html/text` 是正常 agent 工作流的表达。

- [x] Task 2: 移除 no-mode 参数推断切换策略
  - [x] SubTask 2.1: 修改 `normalizeObserveMode`/相关 helper，使 absent `mode` 始终解析为 canonical scan/ABML observation，不再由 `selector/includeLinks/htmlMode/params/intent/url` 推断到 `content/html/text/tabs`。
  - [x] SubTask 2.2: 保留显式 legacy `mode` 的兼容解析和错误信息。
  - [x] SubTask 2.3: 调整 `validateObserveParams`，使 no-mode canonical 路径只接受观察边界/时间/预算参数；策略/投影参数在无显式 legacy mode 时必须被明确处理，不能静默改变结果形态。
  - [x] SubTask 2.4: 确保 `diff/fresh/baseline/baselineSnapshotId/baselinePath/url/tabId/targetRef` 在 canonical no-mode 路径中仍按现有语义工作。

- [x] Task 3: 引入 canonical ABML PageObservation 构建层
  - [x] SubTask 3.1: 在现有 observe 模块内增加清晰的 PageObservation 构建/归一化 helper，优先复用现有 envelope 字段和 ABML scan 输出，不把纯 kernel 绑定到 commands/runtime。
  - [x] SubTask 3.2: 将 scan/ABML 输出映射为统一模型的结构权威来源，包括 target/context、gist、outline、entities、actionables/refs、relations、collections、snapshot、diff/treeDiff、causal、memory、diagnostics。
  - [x] SubTask 3.3: 将 tabs context 作为 canonical model 的 context 字段/diagnostics 来源，而不是要求 `mode=tabs`。
  - [x] SubTask 3.4: 保证 no-mode canonical 输出的 top-level shape 在普通页面、大页面、带 baseline diff、provider 降级场景下保持稳定。

- [x] Task 4: 融合 content/text/html evidence 为模型组成部分
  - [x] SubTask 4.1: 设计并实现 content digest 的融合路径：可读正文进入 canonical model 的 content digest/preview/artifact 引用，不替代主模型。
  - [x] SubTask 4.2: 设计并实现 visible text digest/index 的融合路径：可见文本摘要进入 canonical model 的 text index/digest，不替代主模型。
  - [x] SubTask 4.3: 设计并实现 exact HTML/DOM evidence 的融合路径：精确证据进入 evidence/artifact 引用，不替代主模型。
  - [x] SubTask 4.4: 对 provider 失败或超预算情况输出稳定 diagnostics，确保核心 ABML 模型可返回时不因可选 provider 失败而变成 legacy shape。

- [x] Task 5: 保持 legacy projection 兼容但隔离主路径
  - [x] SubTask 5.1: 确认显式 `mode=content/html/text/tabs` 的旧调用仍可用，或返回清晰标识的 projection/legacy envelope。
  - [x] SubTask 5.2: 在 details/diagnostics 中标识 explicit legacy projection，避免与 canonical no-mode 输出混淆。
  - [x] SubTask 5.3: 确保 legacy projection 代码不重新影响 absent-mode canonical 路径。

- [x] Task 6: 增加和调整测试覆盖
  - [x] SubTask 6.1: 更新命令 schema/catalog/prompt 相关测试，锁定 `browser_observe` 不再推荐 mode 选择。
  - [x] SubTask 6.2: 增加 `normalizeObserveMode`/参数校验测试，覆盖 absent mode 不再因 `selector/includeLinks/htmlMode/params/intent/url` 推断投影。
  - [x] SubTask 6.3: 增加 canonical no-mode 输出 shape 测试，覆盖默认观察、带 URL、带 diff/baseline、provider 降级、大内容 artifact 引用。
  - [x] SubTask 6.4: 增加 legacy explicit mode 兼容测试，覆盖 `content/html/text/tabs` 仍被显式 mode 隔离。
  - [x] SubTask 6.5: 增加文档/治理相关测试或链接检查，确保 `CODE_WIKI.md` 和 README 更新不引入失效链接。

- [x] Task 7: 运行项目验证门禁并修复问题
  - [x] SubTask 7.1: 运行与 observe/command/ABML 相关的 focused tests。
  - [x] SubTask 7.2: 运行 lint/typecheck 对应的 `mise` gate。
  - [x] SubTask 7.3: 运行 `mise run verify` 或按治理要求的完整验证门禁。
  - [x] SubTask 7.4: 修复验证中发现的失败，直到所有相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1 的产品边界结论。
- Task 3 depends on Task 2 的 canonical no-mode 路径稳定。
- Task 4 depends on Task 3 的 PageObservation 构建层。
- Task 5 can run after Task 2 and in parallel with Task 3/4 的部分实现，但最终必须与 Task 3/4 合并验证。
- Task 6 depends on Task 1-5 的实现行为。
- Task 7 depends on Task 6。

## Review Fix Tasks

- [x] Task 8: 修复 canonical no-mode 输出稳定性缺口
  - [x] SubTask 8.1: 修复 render cache 命中路径，使缓存结果恢复并返回与 fresh observe 相同稳定路径的 canonical `PageObservation`，cache metadata 只能作为附加字段。
  - [x] SubTask 8.2: 确保最终 result middleware / CLI JSON 输出在默认预算下稳定保留 `model:"PageObservation"`、`canonical:true` 和 documented gist/content/evidence 路径。
  - [x] SubTask 8.3: 修复 canonical artifact hints 的 jsonPath 参照系，确保 canonical model 指向实际 `PageObservation`，content/text/raw evidence 指向真实可读 artifact 或 response 路径。
  - [x] SubTask 8.4: 增加 render cache 命中和最终 envelope 输出测试，覆盖 fresh 与 cached 两条路径 shape 一致。

- [x] Task 9: 明确并隔离所有 explicit mode 语义
  - [x] SubTask 9.1: 将显式 `mode=scan` 定义并实现为 legacy/debug scan projection，而不是 canonical no-mode contract。
  - [x] SubTask 9.2: 让所有 explicit mode，包括 `scan/content/html/text/tabs`，在 summary/details/diagnostics 中清晰标识 `projection:"legacy"` 与 `canonical:false`。
  - [x] SubTask 9.3: 更新 schema、README、CODE_WIKI 和测试，使“只有 omitted mode 是 normal canonical path”成为稳定契约。
  - [x] SubTask 9.4: 增加 explicit `mode=scan` 行为测试，防止其再次落入非 canonical 也非 legacy 的灰区。

- [x] Task 10: 清理全局 agent-facing mode 推荐
  - [x] SubTask 10.1: 清理 `src/commands/observe/scanProjection.ts`、`src/commands/observe/baseline.ts`、`src/browser-command-runtime/waitSupervisor.ts`、`src/bridge/extension/service_worker/wait.ts`、`src/kernels/evidence/distill/recovery.ts`、`src/commands/screenshotCommand.ts` 等路径中的普通 `browser_observe mode=...` 建议。
  - [x] SubTask 10.2: 将普通观察/刷新建议改为 no-mode `browser_observe`，增量建议改为 `browser_observe diff:true` 或 `baselineSnapshotId`/`baselinePath` 形式。
  - [x] SubTask 10.3: 若必须提到 exact DOM/HTML 兼容路径，明确标注为 explicit legacy/debug projection，不得作为常规 agent 工作流。
  - [x] SubTask 10.4: 更新 `CHANGELOG.md` 中仍像当前指导的 `mode=scan` 表述，避免公共文档继续推荐旧心智。
  - [x] SubTask 10.5: 增加全局文案扫描测试，禁止未标注 legacy/debug/projection 的 `browser_observe mode=` 推荐出现在 public prompt、nextActions、recovery、docs 中。

- [x] Task 11: 修复 diff baseline 与 provider diagnostics 权威性
  - [x] SubTask 11.1: 修复 `diff:true` 自动 baseline 选择，必须按 `browserSessionId` + effective tab 隔离，不得跨 session 使用同 tabId snapshot。
  - [x] SubTask 11.2: 增加 multi-session baseline 选择测试，覆盖同 tabId 不同 session 不会误用 baseline。
  - [x] SubTask 11.3: 修正 provider diagnostics，使 content/text/html/evidence provider 状态真实表达为 executed、scan-backed、skipped、failed 或 degraded，不硬编码暗示未执行 provider 已成功。
  - [x] SubTask 11.4: 确保 README/CODE_WIKI 对 provider fusion 的描述与实际执行或诊断状态一致。

- [x] Task 12: 完整复验并重新勾选 checklist
  - [x] SubTask 12.1: 更新 checklist，加入 review 修复项验收点。
  - [x] SubTask 12.2: 运行 focused tests，至少覆盖 CLI/schema、observe memory/projection、governance/docs、render cache/final envelope、baseline session 隔离。
  - [x] SubTask 12.3: 运行 lint/typecheck 对应 `mise` gate。
  - [x] SubTask 12.4: 运行 `mise run verify`，修复全部失败后再关闭任务。

# Review Fix Dependencies

- Task 8 depends on Task 3/4 的 PageObservation 构建层。
- Task 9 depends on Task 2/5 的 mode normalization 与 legacy projection 隔离。
- Task 10 can run in parallel with Task 8/9/11 but must finish before governance/doc tests。
- Task 11 can run in parallel with Task 8/9/10。
- Task 12 depends on Task 8-11。

## Review Follow-up Tasks

- [x] Task 13: 固化最终 envelope canonical marker
  - [x] SubTask 13.1: 在最终 result envelope 的稳定路径提升或保留 `PageObservation` canonical marker，确保 `model:"PageObservation"` 与 `canonical:true` 不会被 summary budget fitting 移除。
  - [x] SubTask 13.2: 更新 result middleware / envelope budget 逻辑，使默认与低预算输出仍能找到 documented canonical marker。
  - [x] SubTask 13.3: 增加最终 middleware/CLI JSON 级测试，覆盖 no-mode observe 在默认与低预算下保留 canonical marker。

- [x] Task 14: 修复 render cache hit 最终输出同形性
  - [x] SubTask 14.1: 调整 render cache hit 路径，避免把 prior final envelope 当作普通 raw value 再次蒸馏成 nested envelope。
  - [x] SubTask 14.2: 确保 cached no-mode observe 与 fresh no-mode observe 的 documented `PageObservation` 路径一致，只附加 `fromCache/cache/priorSnapshotId`。
  - [x] SubTask 14.3: 增加 runner 或 middleware 级 cache-hit 测试，断言 fresh/cached shape 等价且不存在 envelope-of-envelope。

- [x] Task 15: 统一 canonical artifact hint 参照系
  - [x] SubTask 15.1: 修正 `PageObservation` 内 content/text/evidence artifact jsonPath，移除不存在或混乱的 `result.data.*` 参照。
  - [x] SubTask 15.2: 明确区分 saved artifact root path 与 final response envelope path，并更新 hint label/jsonPath。
  - [x] SubTask 15.3: 增加 artifact jsonPath 可读性测试，覆盖 `PageObservation`、content digest、visible text index、raw scan evidence、exact evidence。

- [x] Task 16: 收紧显式 `mode=scan` 与 canonical-only 参数边界
  - [x] SubTask 16.1: 将 `params.modeExplicit` 纳入 `validateObserveParams` 或执行分支，区分 omitted-mode canonical scan 与 explicit legacy scan projection。
  - [x] SubTask 16.2: 明确处理 explicit `mode=scan` + `diff/baseline/actionRef` 等 canonical-only 参数：拒绝或返回清晰 legacy/debug projection，不得声明 canonical。
  - [x] SubTask 16.3: 修正文案中把 explicit text/scan 仍称为 canonical 的描述。
  - [x] SubTask 16.4: 增加 explicit `mode=scan` 参数隔离测试。

- [x] Task 17: 补齐 CLI-facing guidance 清理与扫描
  - [x] SubTask 17.1: 清理 CLI help、artifact recovery、tabs recovery 中普通推荐的 `browser-pilot observe --mode scan --json`。
  - [x] SubTask 17.2: 将普通 CLI 观察建议改为 `browser-pilot observe --json` 或 no-mode baseline/diff 参数。
  - [x] SubTask 17.3: 扩展 governance 文案扫描，覆盖 `browser-pilot observe --mode ...` 与其他 CLI mode 推荐形态。

- [x] Task 18: 将 provider diagnostics 绑定到 runner 实际状态
  - [x] SubTask 18.1: 在 runScanObservation 中根据 ABML read 结果、scan result、tabs refresh fallback、artifact availability 构造真实 provider 状态。
  - [x] SubTask 18.2: 将结构化 provider failure/degradation reason 传入 `PageObservation.diagnostics`。
  - [x] SubTask 18.3: 增加 runner 级 provider diagnostics 测试，覆盖 ABML read fail、tabs fallback、无 artifact、scan-backed provider。

- [x] Task 19: 稳定 diff baseline 最新快照选择
  - [x] SubTask 19.1: 修改 `selectDiffBaselineSnapshot`，先过滤同 browserSessionId + effective tab + scan + 未过期 + saved.path，再按 `capturedAt` 降序选择最新。
  - [x] SubTask 19.2: 将 baseline 选择测试改为乱序输入，确保不依赖 registry 返回顺序。

- [x] Task 20: 完整复验 review follow-up
  - [x] SubTask 20.1: 运行 focused tests，覆盖 result middleware/envelope、observe projection/cache、CLI/schema、governance/docs、provider diagnostics、baseline selection。
  - [x] SubTask 20.2: 运行 lint/typecheck 对应 `mise` gate。
  - [x] SubTask 20.3: 运行 `mise run verify`，修复全部失败后再关闭任务。

# Review Follow-up Dependencies

- Task 14 depends on Task 13 的最终 envelope 稳定路径。
- Task 15 can run in parallel with Task 13/14 but must align final documented paths。
- Task 16, Task 17, Task 18, Task 19 can run in parallel。
- Task 20 depends on Task 13-19。
