# 系统性补测试 Spec

## Why
当前项目测试覆盖率偏低，容易让核心浏览器控制链路、命令契约、bridge/daemon 协议、memory/artifact 等关键行为在重构中产生回归。需要用系统化的测试补强方式，优先覆盖高风险纯逻辑、边界契约和已有验证门禁中可稳定运行的场景。

## What Changes
- 建立测试补强的分层策略：先盘点未覆盖的关键模块，再按风险与可测性补充 characterization/unit tests。
- 优先补齐无需真实浏览器、无需外部网络、可在 Node built-in test runner 下稳定执行的核心逻辑测试。
- 将新增测试纳入既有 `scripts/run-tests.mjs` scope 与 `mise` 验证门禁，而不是引入新的测试框架。
- 对测试覆盖盲区形成可复查的任务清单，避免一次性大改或引入脆弱端到端测试。

## Impact
- Affected specs: 测试体系、验证门禁、核心命令契约、bridge/daemon 协议稳定性、memory/artifact 行为保护。
- Affected code: `tests/`、`scripts/run-tests.mjs`、必要时 `mise.toml`、被测试模块邻近的 test fixtures/helpers；不应修改 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物。

## ADDED Requirements
### Requirement: 覆盖率补强盘点
The system SHALL identify high-risk, low-coverage areas before adding tests, using current source structure, existing tests, and repository governance boundaries as evidence.

#### Scenario: 形成补测优先级
- **WHEN** 开始系统性补测试
- **THEN** 应先列出优先补测模块、风险理由、适合的测试类型和对应验证命令

### Requirement: 稳定的核心逻辑测试
The system SHALL add deterministic tests for critical pure or easily isolated logic without requiring a live browser, external network, or generated output edits.

#### Scenario: 测试可重复运行
- **WHEN** 运行 `node scripts/run-tests.mjs all`
- **THEN** 新增测试应在本地 Node 22 环境下稳定通过，并避免依赖真实浏览器状态

### Requirement: 命令与协议契约保护
The system SHALL add characterization tests for public `browser_*` command catalog behavior, command parameter schemas, and bridge/daemon protocol boundaries where regressions would affect users.

#### Scenario: 公共契约回归被捕获
- **WHEN** 命令列表、schema 或协议边界发生不兼容变化
- **THEN** 相关测试应失败并指出契约差异

### Requirement: 数据持久化边界保护
The system SHALL add tests for artifact/resource/memory persistence boundaries, including path scoping, validation, ranking, envelope shaping, and malformed-input handling where applicable.

#### Scenario: 非法或边界输入被保护
- **WHEN** 输入为空、畸形、越界或跨 cwd/profile 访问
- **THEN** 测试应验证系统返回受控结果且不破坏持久化数据

### Requirement: 验证门禁集成
The system SHALL keep all new tests discoverable through existing test scopes and `mise` gates.

#### Scenario: 完整验证
- **WHEN** 运行 `mise run affected` 或 `mise run verify`
- **THEN** 新增测试应被包含在相关验证路径中，且不需要额外人工步骤

## MODIFIED Requirements
### Requirement: 现有测试体系
现有 Node built-in test runner + `tsx` 测试体系应继续作为唯一测试框架。新增测试应放入 `tests/` 下合适 scope；如需新增 scope，必须同步更新 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md` 的测试体系说明。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本变更仅补强测试覆盖，不移除现有能力。
**Migration**: 不需要迁移。
