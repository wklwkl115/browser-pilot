# 覆盖率提升到 80% Spec

## Why
当前覆盖率约为行 64.60%、分支 64.69%、函数 54.78%，距离高覆盖率仍有明显差距。用户明确要求继续补更多、更完整的测试覆盖，并要求三项覆盖率数据均达到至少 80%，因此需要以覆盖率报告为驱动集中补齐低覆盖热点，并把 80% 阈值纳入验收。

## What Changes
- 以 `mise run coverage` 为基准，持续补齐低覆盖文件和分支，直到行、分支、函数覆盖率均达到 80% 或以上。
- 优先覆盖 Web Security browserNative/shared/bridges、ABML kernel、temporal/evidence distill、memory/profile/resource 以及 coverage 报告中新增的低覆盖热点。
- 新增测试继续使用 Node built-in test runner + `tsx`，优先补充 deterministic unit/characterization tests。
- 如为达到 80% 需要调整 coverage 报告范围，必须只排除真正不可执行或生成产物类文件，并在文档和验收记录中说明理由。
- 若测试暴露真实 bug，应做最小生产代码修复并补充回归测试。

## Impact
- Affected specs: 测试体系、覆盖率观测、Web Security 命令与 helper、ABML kernel、temporal/evidence distill kernel、memory/profile/resource 服务、coverage gate。
- Affected code: `tests/`、必要的测试 fixture/helper、可能的最小生产代码修复、`scripts/run-coverage.mjs`、`mise.toml`、`CODE_WIKI.md`、`.trae/specs/raise-coverage-to-80/`。

## ADDED Requirements
### Requirement: 覆盖率三项均达到 80%
The system SHALL ensure line coverage, branch coverage, and function coverage are each at least 80% according to the repository coverage command.

#### Scenario: 覆盖率达标
- **WHEN** 开发者运行 `mise run coverage`
- **THEN** 行覆盖率、分支覆盖率、函数覆盖率均应大于或等于 80%

### Requirement: 覆盖率阈值可验证
The system SHALL make the 80% coverage requirement mechanically verifiable instead of relying only on manual report reading.

#### Scenario: 覆盖率低于阈值
- **WHEN** 任一覆盖率指标低于 80%
- **THEN** 覆盖率验证应失败或清晰报告未达标指标，防止误判完成

### Requirement: 低覆盖热点优先补测
The system SHALL prioritize tests for files and branches that materially affect the three coverage metrics.

#### Scenario: 补测优先级
- **WHEN** 覆盖率报告显示低覆盖热点
- **THEN** 应优先选择可稳定单测、无真实浏览器/网络/scanner 依赖且覆盖收益高的文件

### Requirement: Web Security 深度覆盖
The system SHALL add broader tests for Web Security browserNative/shared/bridges logic without invoking external scanners, real browsers, or network services.

#### Scenario: Web Security 行为稳定
- **WHEN** Web Security helper 或 adapter 接收正常、空、畸形、边界、失败或 fallback 输入
- **THEN** 测试应验证解析、构造、错误 shaping、recovery metadata 和安全边界行为

### Requirement: Kernel 与 Service 深度覆盖
The system SHALL add broader tests for ABML, temporal, evidence distill, memory/profile/resource, and other low-coverage pure logic or isolated services.

#### Scenario: Kernel 和 service 边界稳定
- **WHEN** helper/service 接收空输入、畸形输入、重复数据、超长输入、过期数据、跨作用域数据或预算边界
- **THEN** 测试应验证稳定输出、受控错误、敏感信息不泄露和持久化边界不破坏

## MODIFIED Requirements
### Requirement: 覆盖率报告与门禁
覆盖率报告应继续通过 `mise run coverage` 运行。若本变更加入 80% 阈值门禁，应同步更新 `CODE_WIKI.md` 和相关脚本说明。完成本 spec 前，`node scripts/run-tests.mjs all`、`mise run coverage`、`mise run affected` 和 `mise run verify` 必须全部通过。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本变更继续补强测试覆盖，不移除现有能力。
**Migration**: 不需要迁移。
