# 项目减负重构 Spec

## Why
当前项目覆盖 CLI、daemon、bridge、extension、commands、runtime、kernels、web security、memory、artifact 等多个层级，长期演进后容易出现冗余代码、重复实现、过时模块和依赖边界松动。需要以证据驱动方式系统识别并移除低价值或重复实现，在不破坏核心 `browser_*` 工具能力和浏览器控制链路的前提下，降低维护负担并提升可读性、可维护性和执行效率。

## What Changes
- 建立重构基线：统计重构前代码量、测试/验证耗时、关键模块规模、依赖关系与公共入口。
- 识别冗余与低价值区域：覆盖未引用文件/导出、重复逻辑、过时桥接代码、功能重叠命令辅助层、可合并工具函数和依赖链异常。
- 制定保守删除与简化策略：优先删除无引用、无公共契约、无运行时价值的代码；对核心入口和高风险区域仅做证据充分的小步整理。
- 执行代码去重、无用模块移除、复杂逻辑简化与依赖关系梳理，保持 ESM、Node 22+、TypeScript strict、`.js` import 扩展规则。
- 同步架构/维护文档：当模块职责、公共契约、验证门禁或边界发生变化时，仅更新现有权威文档或更窄 owner 文档。
- 提供重构说明：记录删除/合并/保留决策、重构前后代码量对比、验证证据、性能或执行耗时对比、残余风险。
- 不编辑生成产物 `dist/` 与 `bridge/browser_pilot_bridge/`。
- 不主动改变公共 `browser_*` 工具列表、CLI 契约、root `index.ts` 导出或 native protocol schema，除非有明确证据证明对应能力已无效且迁移路径清晰。

## Impact
- Affected specs: 项目维护性、命令工具层、bridge/daemon/extension 运行链路、runtime/kernels 边界、artifact/memory/web security 辅助模块、验证门禁与架构文档一致性。
- Affected code: `src/commands/**`, `src/bridge/server/**`, `src/bridge/extension/**`, `src/browser-runtime/**`, `src/browser-command-runtime/**`, `src/browser-page-runtime/**`, `src/kernels/**`, `src/artifacts/**`, `src/memory/**`, `src/resources/**`, `src/scan/**`, `src/content/**`, `src/utils/**`, `tests/**`, `scripts/**`, `package.json`, `mise.toml`, `CODE_WIKI.md`, `REPO_GOVERNANCE.md`。

## ADDED Requirements
### Requirement: Evidence-driven refactor baseline
The system SHALL capture a reproducible pre-refactor baseline before deleting or simplifying code.

#### Scenario: Baseline captured
- **WHEN** 重构开始执行
- **THEN** 应记录源代码文件数量、有效代码行数、测试数量或测试入口、主要模块规模、依赖/引用关系摘要、当前验证门禁结果与耗时基线。

### Requirement: Redundancy and value audit
The system SHALL classify candidate cleanup targets by evidence, business value, technical necessity, and risk.

#### Scenario: Candidate classified
- **WHEN** 发现未引用文件、重复实现、过时代码路径或复杂辅助逻辑
- **THEN** 应标注其证据来源、所属模块、是否属于公共契约、删除或合并风险、建议动作与验证方式。

### Requirement: Safe deletion and simplification
The system SHALL remove or simplify only code whose removal has supporting evidence and preserves core browser automation behavior.

#### Scenario: Safe cleanup applied
- **WHEN** 删除或合并候选代码
- **THEN** `browser_execute`、`browser_command`、tab/session/lease、extension bridge、capture/scan、artifact/memory 以及现有 web security 命令的公共行为不应出现无意破坏。

### Requirement: Dependency boundary cleanup
The system SHALL improve dependency clarity and keep architectural boundaries enforceable.

#### Scenario: Boundary validated
- **WHEN** 重构影响跨层 import、kernel、runtime、command 或 bridge 关系
- **THEN** 应保持 `src/kernels/*` 纯逻辑边界，不引入 browser、Node、npm runtime、bridge、commands 或 browser-runtime 依赖，并避免增加新的循环依赖或重复 owner。

### Requirement: Refactor report and metrics
The system SHALL provide a final refactor report with quantitative and qualitative evidence.

#### Scenario: Report delivered
- **WHEN** 重构完成
- **THEN** 应提供重构前后代码量对比、删除/合并模块清单、依赖变化摘要、验证命令结果、性能或门禁耗时改进数据、未处理候选项和残余风险说明。

## MODIFIED Requirements
### Requirement: Repository validation workflow
重构完成前，系统 SHALL 使用 `mise` 门禁进行验证：范围内开发验证优先使用 `mise run affected` 或相关 `mise run dev-*`，最终完成声明前使用 `mise run verify`。若修改治理、工作流或文档规则，系统 SHALL 使用 `mise run dev-governance`。

### Requirement: Documentation ownership consistency
当重构改变架构、公共契约、工作流、验证门禁或模块所有权时，系统 SHALL 更新 `CODE_WIKI.md`、`REPO_GOVERNANCE.md` 或模块本地 owner 文档中的既有权威位置，且不得创建重复架构或工作流文档。

### Requirement: Public surface preservation
系统 SHALL 将 `index.ts`、CLI 入口、daemon 入口、extension 入口、`src/commands/commandCatalog.ts`、native protocol schema 与 schema-derived 类型视为公共或半公共边界。任何影响这些边界的删除、重命名或行为变更 SHALL 有明确迁移说明与验证证据。

## REMOVED Requirements
### Requirement: Unowned stale implementation paths
**Reason**: 无引用、无公共契约、无测试覆盖且无法证明业务价值的旧实现路径会增加维护成本和误用风险。
**Migration**: 删除前记录引用审计与验证证据；若存在可替代实现，迁移到唯一 canonical owner；若存在文档引用，同步更新权威文档。

### Requirement: Duplicate helper implementations
**Reason**: 多处重复的参数处理、结果裁剪、错误包装、路径处理或 JSON/文本处理逻辑会造成行为漂移。
**Migration**: 合并到现有 canonical helper，更新调用点并通过相关测试与 `mise` 门禁验证一致性。
