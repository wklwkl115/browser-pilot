# Checklist

- [x] `browser_observe` 的 command description、prompt snippet、prompt guidelines 明确主路径是 canonical ABML page model，而不是让 agent 选择 mode。
- [x] `mode` 在 schema/docs/prompt 中被定位为 legacy/debug/projection 兼容参数，不再是推荐工作流。
- [x] 无显式 `mode` 时，`selector/includeLinks/htmlMode/params/intent/url` 不会把调用推断为 `content/html/text/tabs` 投影。
- [x] 无显式 `mode` 的默认调用稳定返回 canonical ABML page observation envelope。
- [x] `url`、`tabId`、`targetRef` 等观察边界参数在 canonical no-mode 路径中正常工作。
- [x] `fresh`、`diff`、`baseline`、`baselineSnapshotId`、`baselinePath` 等时间关系参数在 canonical no-mode 路径中正常工作。
- [x] canonical 输出包含或稳定表达 target/context、gist/outline、entities、actionables/refs、content digest、text index/digest、evidence/artifact refs、snapshot、memory、diff/treeDiff/causal、diagnostics。
- [x] scan/ABML 是结构、actionables、refs、actionability state 的权威来源。
- [x] content/text/html 数据作为 digest、index、evidence 或 artifact 融入 canonical 模型，不替代主模型。
- [x] optional provider 失败或超预算时，核心 ABML 模型仍可返回，并通过 diagnostics 描述降级。
- [x] 显式 legacy `mode=content/html/text/tabs` 仍可用或返回清晰标识的 legacy/projection 结果。
- [x] legacy projection 不会影响 absent-mode canonical 路径。
- [x] `CODE_WIKI.md` 描述 ABML 是 agent-native 页面统一建模层，`browser_observe` 是其公开读取入口。
- [x] `README.md` 的产品描述与 canonical ABML page model 方向一致，不再把 mode 选择描述为正常 agent 调用方式。
- [x] 命令 schema/catalog/prompt 测试已更新并通过。
- [x] mode normalization/参数校验测试已覆盖 no-mode 不推断投影与 explicit legacy mode 兼容。
- [x] canonical 输出 shape、provider 降级、大内容 artifact 引用、diff/baseline 行为测试已覆盖并通过。
- [x] 相关 focused tests 已通过。
- [x] lint/typecheck 对应 `mise` gate 已通过。
- [x] `mise run verify` 或治理要求的完整验证门禁已通过，或有明确记录说明无法运行的原因与剩余风险。

## Review Fix Checklist

- [x] render cache 命中时 no-mode `browser_observe` 仍返回与 fresh path 相同稳定路径的 canonical `PageObservation`。
- [x] cached canonical observation 只附加 cache/fromCache/priorSnapshotId 元信息，不退化为 cache-only envelope。
- [x] 最终 result middleware / CLI JSON 输出在默认预算下稳定保留 documented `PageObservation` marker、gist、content、text、evidence 路径。
- [x] canonical artifact hints 使用一致参照系，且 `PageObservation`、content digest、visible text index、raw scan evidence、exact evidence 路径真实存在。
- [x] 显式 `mode=scan` 被实现和文档定义为 legacy/debug scan projection。
- [x] 所有 explicit mode，包括 `scan/content/html/text/tabs`，都在 summary/details/diagnostics 中标识 `projection:"legacy"` 和 `canonical:false`。
- [x] 只有 omitted `mode` 被文档、schema、测试定义为 normal canonical ABML page model path。
- [x] public promptGuidelines、nextActions、recovery hints、wait hints、evidence hints、screenshot guidance、baseline hints、README、CODE_WIKI、CHANGELOG 不再普通推荐 `browser_observe mode=...`。
- [x] 若仍出现 `browser_observe mode=...`，上下文必须明确标注 explicit legacy/debug/projection compatibility。
- [x] `diff:true` 自动 baseline 选择按 `browserSessionId` + effective tab 隔离，不跨 session 误用 snapshot。
- [x] provider diagnostics 真实表达 optional provider 状态，不硬编码暗示未执行 content/html/text provider 已成功。
- [x] README/CODE_WIKI 对 provider fusion 的表述与实际 provider 执行或 diagnostics 状态一致。
- [x] 新增测试覆盖 render cache hit、最终 envelope/CLI JSON shape、explicit `mode=scan` legacy 标记、全局 `browser_observe mode=` 文案扫描、multi-session baseline 隔离和 provider diagnostics 诚实状态表达。
- [x] focused tests 已覆盖 CLI/schema、observe projection/memory、governance/docs、baseline session 隔离并通过。
- [x] lint/typecheck 对应 `mise` gate 已通过。
- [x] `mise run verify` 已通过。

## Review Follow-up Checklist

- [x] 最终 no-mode `browser_observe` 的默认/低预算输出稳定保留 `model:"PageObservation"` 与 `canonical:true`。
- [x] render cache 命中后的最终输出与 fresh path 同形，仅附加 cache 元数据。
- [x] canonical artifact hints 的 jsonPath 与 saved artifact / response envelope 参照系一致且可读取。
- [x] 显式 `mode=scan` 对 canonical-only 参数具备清晰隔离或拒绝行为。
- [x] CLI help、artifact recovery、tabs recovery 不再普通推荐 `--mode scan`。
- [x] runner 级 provider diagnostics 真实反映 ABML read fail、tabs fallback、无 artifact 与 scan-backed 状态。
- [x] `diff:true` baseline 选择不依赖 snapshot registry 返回顺序。
- [x] focused tests、lint/typecheck、`mise run verify` 全部通过。
