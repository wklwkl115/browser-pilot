# 继续补高覆盖率测试 Spec

## Why
上一阶段已经补齐了一批关键契约与边界测试，但项目仍存在源码规模大、测试密度不足的问题，尤其是 `src/commands`、`src/kernels`、`src/bridge` 和 daemon/runtime 相关路径。需要继续分阶段补充稳定、可维护的测试，以提高核心模块的行为覆盖和回归保护能力。

## What Changes
- 在上一阶段 `add-systematic-tests` 已完成的基础上，继续补充更高覆盖率的测试。
- 优先覆盖 commands 执行层、kernels 纯逻辑、daemon/server 状态机、bridge/extension 可抽离 helper 与 runtime helper。
- 引入覆盖率观测能力作为报告工具，先不设置全仓库硬性阈值，避免历史欠账阻塞门禁。
- 保持现有 Node built-in test runner + `tsx` 测试体系，不引入重量级或脆弱的真实浏览器端到端测试。
- 所有新增测试必须纳入既有 `scripts/run-tests.mjs` scope、`mise run affected` 与 `mise run verify` 验证路径。

## Impact
- Affected specs: 测试体系、验证门禁、命令执行层、kernel 纯逻辑、daemon 状态机、bridge 协议 helper、runtime helper。
- Affected code: `tests/`、`scripts/`、`mise.toml`、`CODE_WIKI.md`、必要的测试夹具或 helper；不应修改 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物。

## ADDED Requirements
### Requirement: 覆盖率观测报告
The system SHALL provide a repeatable coverage reporting path for the current Node test suite without making historical low coverage fail the default gates immediately.

#### Scenario: 生成覆盖率报告
- **WHEN** 开发者运行覆盖率报告命令
- **THEN** 系统应运行现有测试并输出可用于定位低覆盖目录或文件的覆盖率信息

#### Scenario: 默认门禁保持稳定
- **WHEN** 开发者运行 `mise run affected` 或 `mise run verify`
- **THEN** 覆盖率报告不应因为未设置阈值而阻塞已有门禁，除非测试本身失败

### Requirement: Commands 执行层补测
The system SHALL add deterministic tests for representative command execution paths, including success envelopes, validation errors, runtime port interactions, and distiller/summary outputs where applicable.

#### Scenario: 命令执行回归被捕获
- **WHEN** 核心 `browser_*` 命令的执行结果、错误 envelope 或 runtime 调用契约发生变化
- **THEN** 对应测试应失败并指出具体命令行为差异

### Requirement: Kernels 纯逻辑补测
The system SHALL add unit tests for pure kernel logic, parser/classifier/builder helpers, and malformed or boundary inputs without introducing browser, Node runtime, bridge, or command dependencies into kernels.

#### Scenario: Kernel 边界输入稳定
- **WHEN** kernel helper 接收空输入、畸形输入、大输入或边界输入
- **THEN** 测试应验证输出稳定、受控且不跨越 kernel 依赖边界

### Requirement: Daemon 状态机补测
The system SHALL add tests for daemon/server state boundaries including pairing lifecycle, lease lifecycle, state directory handling, token handling, HTTP route validation, and shutdown cleanup where these paths can be isolated.

#### Scenario: Daemon 状态异常受控
- **WHEN** daemon 遇到缺失、损坏、过期或冲突状态
- **THEN** 测试应验证返回受控错误或恢复行为，并且不泄露 token

### Requirement: Bridge 与 Runtime helper 补测
The system SHALL add tests for bridge/extension helper logic and browser runtime adapters that can be exercised without a live browser.

#### Scenario: 协议 helper 拒绝畸形消息
- **WHEN** bridge/extension helper 接收未知、缺字段或类型错误的消息
- **THEN** 测试应验证系统拒绝或降级处理该消息，并保持受控错误输出

## MODIFIED Requirements
### Requirement: 现有测试体系
现有 Node built-in test runner + `tsx` 测试体系继续作为主要测试体系。若新增覆盖率报告脚本或测试 scope，必须同步更新 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md` 的测试/验证说明，并保持 `mise` 作为 canonical gate。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本变更继续补强测试覆盖，不移除现有能力。
**Migration**: 不需要迁移。
