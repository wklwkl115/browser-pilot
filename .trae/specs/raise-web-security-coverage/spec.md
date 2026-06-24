# 下一轮补覆盖率 Spec

## Why
上一轮覆盖率报告显示整体行覆盖率约 61%，函数覆盖率仍低于 50%，低覆盖热点集中在 Web Security commands/shared/bridges、ABML kernel、temporal/evidence distill 与 memory/profile/resource 服务。需要继续沿覆盖率热点补测试，优先选择无需真实浏览器、外部网络或重型工具的稳定逻辑，逐步提高有效覆盖率。

## What Changes
- 基于 `mise run coverage` 的低覆盖热点，继续补充 Web Security shared helpers 与 bridge adapter 的纯逻辑测试。
- 继续补充 ABML、temporal、evidence distill、memory/profile/resource 等 kernel/service 边界测试。
- 保持现有 Node built-in test runner + `tsx` 体系，不引入真实浏览器端到端依赖。
- 以覆盖率报告作为反馈，记录本轮覆盖率变化与仍需后续关注的热点。
- 所有新增测试必须纳入现有 `scripts/run-tests.mjs` scope、`mise run affected` 与 `mise run verify`。

## Impact
- Affected specs: 测试体系、覆盖率观测、Web Security helpers、ABML kernel、temporal/evidence distill kernel、memory/profile/resource 服务。
- Affected code: `tests/`、必要的测试 fixture/helper、`.trae/specs/raise-web-security-coverage/`；通常不应修改生产代码，除非测试暴露真实 bug 且需要最小修复。不应修改 `dist/` 或 `bridge/browser_pilot_bridge/`。

## ADDED Requirements
### Requirement: Web Security 纯逻辑覆盖
The system SHALL add deterministic tests for Web Security shared helpers and bridge adapters that can run without external scanners, live browser sessions, or network dependencies.

#### Scenario: Web Security helper 边界稳定
- **WHEN** replay、cookie token、multipart、HAR、JS AST reduction 或 scanner bridge helper 接收正常、空、畸形或边界输入
- **THEN** 测试应验证输出稳定、错误受控且不执行外部工具或网络请求

### Requirement: ABML kernel 覆盖提升
The system SHALL add tests for low-coverage ABML kernel helpers, including collection, stream, snapshot projection, accessibility mapping, or identity graph boundaries where practical.

#### Scenario: ABML 边界输入稳定
- **WHEN** ABML helper 接收空树、重复节点、缺失属性、畸形关系或边界大小输入
- **THEN** 测试应验证结果可预测，并保持 kernel 纯逻辑依赖边界

### Requirement: Temporal 与 Evidence Distill 覆盖提升
The system SHALL add tests for temporal estimation/budget helpers and evidence distill relevance/salience helpers identified as low coverage.

#### Scenario: 预算与相关性边界稳定
- **WHEN** temporal 或 evidence distill helper 接收缺失时间、异常预算、低相关性、高相关性或超长输入
- **THEN** 测试应验证 clamp、fallback、排序或摘要边界符合当前契约

### Requirement: Memory/Profile/Resource 服务覆盖提升
The system SHALL add tests for remaining memory/profile/resource service boundaries, especially malformed profile data, secret redaction, staleness, missing resources, and scoped persistence behavior.

#### Scenario: 服务边界异常受控
- **WHEN** profile、secret、resource 或 staleness 服务遇到缺失、损坏、过期或跨作用域数据
- **THEN** 测试应验证受控返回、不会泄露敏感信息且不会破坏持久化数据

### Requirement: 覆盖率回归观察
The system SHALL run coverage after the new tests and report updated coverage numbers and remaining low-coverage hotspots.

#### Scenario: 覆盖率反馈可见
- **WHEN** 本轮补测完成
- **THEN** 应记录 `mise run coverage` 的最新行、分支、函数覆盖率，以及仍低覆盖的主要文件或目录

## MODIFIED Requirements
### Requirement: 现有测试体系
新增测试继续使用 Node built-in test runner + `tsx`，优先放入既有 scope。若新增 scope 或覆盖率流程变化，必须同步 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md`。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本变更继续补强覆盖率，不移除现有能力。
**Migration**: 不需要迁移。
