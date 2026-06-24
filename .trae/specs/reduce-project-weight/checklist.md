# Checklist

- [x] 已建立重构前基线，包含源文件数量、有效代码行数、主要模块规模、验证入口结果与耗时，并明确排除生成产物 `dist/` 和 `bridge/browser_pilot_bridge/`。
- [x] 已完成公共/半公共边界审计，确认 `index.ts`、CLI/daemon/extension 入口、`src/commands/commandCatalog.ts`、native protocol schema、package exports/bin 未被无证据破坏。
- [x] 每个删除或合并项均有引用审计、业务价值判断、技术必要性判断、风险等级和验证方式记录。
- [x] 已移除至少一批低风险冗余、过时或无引用代码，且未留下悬空 import、测试引用或文档引用。
- [x] 已合并或简化至少一处有明确重复证据的实现，调用点更新后行为保持兼容。
- [x] `src/kernels/*` 仍保持纯逻辑边界，未引入 browser、Node、npm runtime、bridge、commands 或 browser-runtime 依赖。
- [x] command/runtime/bridge 等关键层未新增循环依赖、重复 owner 或不必要反向依赖。
- [x] 核心业务功能保持可用，包括 `browser_execute`、`browser_command`、tab/session/lease、extension bridge、capture/scan、artifact/memory 和现有 web security 公共命令。
- [x] 受影响测试已补充或调整，能够覆盖删除、合并或简化后的关键行为。
- [x] 已根据实际架构、公共契约、工作流或模块职责变化同步现有权威文档，不创建重复架构或工作流文档。
- [x] 已运行最终 `mise run verify` 并通过；若修改治理或工作流文档，已运行 `mise run dev-governance` 并通过。
- [x] 已提供最终重构说明，包含重构前后代码量对比、性能或验证耗时改进数据、删除/合并模块清单、保留项原因、未处理候选项和残余风险。
