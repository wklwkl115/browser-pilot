# 安全边界测试 Spec

## Why
当前覆盖率已经达到目标，继续追普通覆盖率数字收益下降；更高价值的下一步是把测试重心转向安全边界。项目涉及 cookie、token、secret、request replay、scanner command、resource refs、profile/memory 持久化等敏感面，需要用稳定的无网络测试固定安全行为，防止后续重构引入泄漏、越界读取、命令注入或跨工作区污染。

## What Changes
- 新增风险导向的安全边界测试，不以继续提高覆盖率百分比为主要目标。
- 覆盖 secret/token/cookie/header redaction，确保敏感值不会出现在 summary、diagnostics、error、artifact 或 scanner command 记录中。
- 覆盖 path traversal、malformed resource refs、expired refs、wrapped refs，确保 resource resolver 不会越界读取或泄漏本地路径内容。
- 覆盖 scanner bridge command 参数安全，确保用户输入不会被 shell injection 或危险参数拼接利用，外部 scanner 缺失/异常输出时可控降级。
- 覆盖 profile/memory/workspace 边界，确保 malformed data、跨 cwd/profile、disabled service、staleness/strike 不会污染其他作用域或回显敏感信息。
- 如测试暴露真实安全缺陷，做最小生产代码修复并补充回归测试。

## Impact
- Affected specs: Web Security 测试、安全边界测试、resource resolver、memory/profile/secret 服务、scanner bridge contract、coverage 后续质量治理。
- Affected code: `tests/` 下安全边界测试、必要的测试 fixture/helper、可能的最小生产代码修复、`.trae/specs/add-security-boundary-tests/`、必要时同步 `CODE_WIKI.md`。

## ADDED Requirements
### Requirement: 敏感信息不泄漏
The system SHALL prevent secrets, cookies, tokens, authorization headers, API keys, and comparable sensitive values from appearing in summaries, diagnostics, error messages, artifacts, scanner command logs, or serialized resource metadata.

#### Scenario: 敏感输入被处理
- **WHEN** 测试向 Web Security、resource、memory/profile、scanner bridge 或 evidence summary 输入敏感 header、cookie、token 或 secret
- **THEN** 输出、错误、诊断、summary 和 artifact metadata 中不得包含原始敏感值

### Requirement: Resource ref 越界防护
The system SHALL reject or safely ignore malformed, expired, traversal-like, cross-scope, or unknown resource refs without reading arbitrary local files or leaking local paths.

#### Scenario: 恶意 resource ref
- **WHEN** resource resolver 收到 `../`、绝对路径、wrapped malformed ref、expired ref、unknown scheme 或跨 scope ref
- **THEN** 系统应返回受控错误或空结果，不得读取非授权路径，不得泄漏敏感本地路径内容

### Requirement: Scanner command 安全
The system SHALL construct scanner bridge commands using safe argument arrays and sanitized diagnostics so user input cannot trigger shell injection or leak secrets.

#### Scenario: 恶意 scanner 输入
- **WHEN** scanner bridge 接收包含 shell metacharacters、换行、危险 flags、secret query/header 或 malformed scanner output 的输入
- **THEN** 命令应保持参数化语义，日志/错误应 redacted，parser 应受控降级

### Requirement: Profile 和 memory 作用域隔离
The system SHALL keep profile, memory, staleness, and secret persistence scoped to the intended cwd/profile and tolerate malformed persisted data.

#### Scenario: 跨作用域或损坏数据
- **WHEN** profile/memory 服务读取 malformed data、跨 cwd/profile 数据、disabled service 或 stale strike 状态
- **THEN** 系统不得污染其他作用域，不得回显敏感数据，并应产生可控恢复行为

### Requirement: 安全边界测试稳定性
The system SHALL implement these security boundary tests without requiring real browsers, real networks, real external scanners, or generated artifact edits.

#### Scenario: 本地验证
- **WHEN** 开发者运行相关测试、全量测试和验证命令
- **THEN** 测试应稳定通过，并继续使用 Node built-in test runner + `tsx`

## MODIFIED Requirements
### Requirement: 测试验收
新增安全边界测试完成后，`node scripts/run-tests.mjs all`、`mise run affected`、`mise run verify` 必须通过；如变更影响 coverage scope 或安全测试说明，应同步 `CODE_WIKI.md` 并验证本地 Markdown 链接。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本变更只新增安全边界测试和必要的最小修复，不移除现有能力。
**Migration**: 不需要迁移。
