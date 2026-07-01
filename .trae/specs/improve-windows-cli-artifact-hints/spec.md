# Improve Windows CLI And Artifact Path Hints Spec

## Why
用户反馈显示 Browser Pilot 的核心 observe/execute/crawl 能力有效，但 Windows 上全局 `browser-pilot` 命令不可用会迫使用户绕行 `npm --silent run cli -- ...`，明显影响上手体验。同时 artifact 结果层级和 JSON 路径不够直观，用户需要靠试错查找 `data.rows`、`results.items.0.body.text` 等路径，降低快速探索效率。

## What Changes
- 修复或验证 Windows 环境下全局 `browser-pilot` bin 的构建、打包和执行路径，确保不再出现模块找不到或入口缺失问题。
- 增加 Windows CLI 相关测试或打包检查，覆盖 npm bin 指向、构建产物存在、PowerShell/Windows 路径形态和 fallback 文案。
- 为 artifact 增加更稳定、可发现的 schema/path hints，帮助用户直接定位常用内容，而不是试探多层 JSON。
- 保留现有 artifact 内容和已有 jsonPath，不破坏已落地的 PageObservation / content / text / evidence hint 参照系。
- 为文档中 `--command @file` 与实际行为不一致的问题补充最小修正：明确 `--command` 只接受内联 JSON，文件优先推荐 `--program @file` 或对应 `--script-file`。
- 增加 focused tests 和文档/治理检查，覆盖 Windows CLI packaging、artifact hint 可读性和文档参数一致性。

## Impact
- Affected specs: CLI packaging / install UX、artifact schema/hints、command help/docs、observe/crawl/execute artifact readability。
- Affected code: `package.json` bin/build/prepack/prepare 相关脚本、`scripts/*build*`、CLI bin entry、artifact hint/projection helpers、artifact/result tests、README/CODE_WIKI 或 CLI help 文案。

## ADDED Requirements
### Requirement: Windows global CLI works from package output
The system SHALL make the packaged/global `browser-pilot` command work on Windows without requiring `npm --silent run cli -- ...` as the normal path.

#### Scenario: Packaged CLI invoked on Windows
- **WHEN** a user invokes `browser-pilot --help` from a package/global install style path on Windows
- **THEN** the command SHALL resolve the built CLI entry and display help without module-not-found errors.

#### Scenario: Build artifacts missing
- **WHEN** the CLI entry or bridge dist artifacts are missing in a development checkout
- **THEN** the user-facing error or recovery guidance SHALL clearly point to the build command rather than failing with an opaque module resolution error.

### Requirement: CLI packaging verification
The system SHALL include deterministic checks for the CLI bin and package layout.

#### Scenario: Package layout checked
- **WHEN** packaging or release-readiness tests run
- **THEN** they SHALL verify the `bin.browser-pilot` target exists after build and is compatible with Windows path resolution.

### Requirement: Artifact schema/path hints
The system SHALL expose stable, compact artifact path hints for common result shapes.

#### Scenario: Artifact saved
- **WHEN** a command saves an artifact
- **THEN** the result or artifact metadata SHALL include discoverable hints for important readable paths, including kind/schema version when applicable, summary path, primary items path, body/text path, and any provider-specific artifact path already available.

#### Scenario: Path not present
- **WHEN** a common path is not present for a specific artifact kind
- **THEN** hints SHALL avoid advertising nonexistent paths and SHOULD prefer available alternatives.

### Requirement: Preserve existing artifact compatibility
The system SHALL add hints without breaking existing artifact payloads or documented PageObservation paths.

#### Scenario: Existing jsonPath readers
- **WHEN** existing tests or users read previously documented PageObservation/content/text/evidence paths
- **THEN** those paths SHALL remain valid unless explicitly documented as deprecated with a replacement.

### Requirement: File-argument documentation alignment
The system SHALL align docs/help with actual file argument support.

#### Scenario: User reads command guidance
- **WHEN** documentation or CLI help mentions `--command`, `--program`, or `--script-file`
- **THEN** it SHALL clearly distinguish inline JSON options from file-backed options and recommend file-backed forms on Windows where supported.

## MODIFIED Requirements
### Requirement: CLI install UX
The CLI install UX SHALL treat global/package-style `browser-pilot` invocation as the primary documented path and keep `npm --silent run cli -- ...` as a development fallback only.

### Requirement: Artifact readability
Artifact results SHALL include enough stable metadata and path hints for users to find common readable content without manual JSON path guessing.

## REMOVED Requirements
### Requirement: npm script invocation as normal Windows workflow
**Reason**: Requiring `npm --silent run cli -- ...` for normal Windows usage creates friction and hides packaging regressions.
**Migration**: Keep npm script invocation available for development, but fix and verify the package/global `browser-pilot` path.
