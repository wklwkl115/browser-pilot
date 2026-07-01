# Tasks

- [x] Task 1: 盘点 Windows CLI 与 artifact hint 现状
  - [x] SubTask 1.1: 检查 `package.json` bin、build/prepack/prepare 脚本、CLI built entry、npm pack 文件列表和 Windows shim 行为。
  - [x] SubTask 1.2: 复现或模拟 Windows 全局 `browser-pilot --help` 的模块解析路径，记录失败原因和最小修复点。
  - [x] SubTask 1.3: 盘点 observe/crawl/execute/artifact 结果中已有 schema、kind、jsonPath、artifact hints 和缺口。
  - [x] SubTask 1.4: 盘点文档/help 中 `--command @file`、`--program @file`、`--script-file` 的描述与实际 parser 行为差异。

  Task 1 conclusions:
  - Packaging/bin: `package.json` declares `bin.browser-pilot` as `./dist/src/apps/cli/bin.js`, `main`/`types` under `dist/`, `build` runs `clean-build` then `tsc -p tsconfig.build.json`, `prepack` runs build/native/bridge, and `prepare` runs `tsc -p tsconfig.build.json` plus bridge. `npm pack --dry-run --json` currently runs prepack and prepare, but the resulting file list contains `DistCount=0` and no `dist/src/apps/cli/bin.js`, `dist/src/apps/cli/help.js`, `dist/src/apps/cli/main.js`, or `dist/index.js`; bridge dist files are present. The likely root cause is stale incremental `tsBuildInfoFile` surviving `clean-build`: `clean-build` removes `dist/` and bridge dist but not `.cache/tsconfig.build.tsbuildinfo`, so `tsc` can exit successfully without re-emitting deleted dist files. Minimum Task 2 fix point: make build/prepack deterministic by removing or invalidating the build info, forcing emit, or otherwise asserting/rebuilding missing `dist` before packing.
  - Windows shim/help resolution: npm global installs on Windows create `browser-pilot.cmd`/PowerShell shims that execute the package bin target, so the module resolution path is the package root plus `dist/src/apps/cli/bin.js`. That entry imports `./help.js` for top-level `--help` before loading `main.js`; therefore a built package with `bin.js` and adjacent `help.js` should print help locally. With the current package output, the shim resolves to a missing entry and fails before Browser Pilot can show recovery guidance. Minimum Task 2 fix point: ensure the bin target and its local imports exist in package/global layouts, and add a clear missing-build recovery for development checkout invocation.
  - Artifact hints/schema: canonical observe already has `PageObservation.artifact_hints` with `jsonPaths`/`preferredReads`, kind labels for response envelope, saved observation artifact, raw scan evidence, content/text, optional Readability, and ABML additions for collections/snapshotProjection/relations/identity. Scan summaries also expose `data.content`, `data.actionables`, `data.list_hints`, `data.media_candidates`, and `data.rows`. Provider telemetry includes artifact refs for html/evidence/axe/readability when available. Execute JS can add `artifact_hints.preferredReads` for non-inline `data` and top object fields, but lacks `jsonPaths` and schema/version metadata. Program execute does not add artifact hints for `executed`, frame results, final `result`, or monitor data. Generic result middleware saves `saved` and `diagnostics.artifact` but does not add stable kind/schema/path hints for non-observe commands. Web-security crawl and related commands use generic summaries/artifacts without a common compact hint layer for `summary`, primary item arrays, bodies/text, provider-specific artifact paths, or schema version. `browser_artifact` documents common paths in parameter text but returns reads inline and has no artifact schema/hint descriptor of its own.
  - File-argument help/docs: parser behavior is centralized in `parseArgs`: string/json/array flags accept inline values, `@file`, and stdin `-`; JSON flags parse the referenced content as JSON, arrays parse JSON arrays or newline lists. `--program @file` is therefore supported through array parsing, and `--script-file` reads a path in `applyCliOnlyParams`; however `schema` metadata currently advertises inputs `["inline","@file","stdin"]` for all string flags, including `scriptFile`, even though `--script-file @file` means “read a path string from a file” rather than “load this JS file”. `browser-pilot command --help` only says `--command <json>` and does not mention `@file`, while `schema command --json` advertises `@file`/stdin for `--command`. Current repo docs only show inline `--command '{...}'`; there is no active README/CODE_WIKI `--command @file` recommendation found, but the broad schema metadata can still lead agents to recommend it. Task 4 should decide whether to support and document `--command @file` explicitly or change metadata/help so `--command` is inline-only as the spec says, while continuing to recommend `--program @file` and `--script-file <path>` for Windows large inputs.

- [x] Task 2: 修复并验证 Windows CLI package/global invocation
  - [x] SubTask 2.1: 调整最小构建或打包逻辑，确保 `bin.browser-pilot` 指向的 built CLI entry 在 package/global 安装布局中存在。
  - [x] SubTask 2.2: 如开发 checkout 未构建，提供清晰 recovery 文案或检查，避免 opaque module-not-found。
  - [x] SubTask 2.3: 增加 deterministic packaging/bin tests，覆盖 Windows 风格路径、built entry 存在性和 help invocation。
  - [x] SubTask 2.4: 确认 bridge dist 构建与 CLI packaging 不互相破坏，尤其 `bridge/browser_pilot_bridge/dist/*` 的生成和 npm files 列表。

- [x] Task 3: 增加 artifact schema/path hints
  - [x] SubTask 3.1: 设计最小 hint 形态：artifact kind/schema version、summary path、primary items path、body/text path、provider-specific path、saved artifact path。
  - [x] SubTask 3.2: 在 result/artifact projection 层生成 compact hints，不复制大型 artifact 内容。
  - [x] SubTask 3.3: 避免广告不存在路径；对不同 kind 输出可用路径和 fallback path。
  - [x] SubTask 3.4: 保持现有 PageObservation/content/text/evidence jsonPath 兼容。

- [x] Task 4: 对齐文档和 help 中的文件参数说明
  - [x] SubTask 4.1: 修正 `--command @file` 相关描述，明确 `--command` 只接受内联 JSON。
  - [x] SubTask 4.2: 明确推荐 Windows 用户使用 `--program @file`、`--script-file` 或其他实际支持的文件参数。
  - [x] SubTask 4.3: 增加或更新文档治理检查，防止再次把不支持的 `--command @file` 写成推荐用法。

- [x] Task 5: 增加测试与回归保护
  - [x] SubTask 5.1: 增加 CLI/package layout focused tests，覆盖 Windows bin entry、help invocation 和未构建 recovery。
  - [x] SubTask 5.2: 增加 artifact hints tests，覆盖 observe/crawl/execute 常见 artifact 的 stable path hints 和不存在路径过滤。
  - [x] SubTask 5.3: 增加或更新 regression/gov tests，确认现有 jsonPath 仍可读、artifact payload 未被大型 inline 复制。
  - [x] SubTask 5.4: 运行相关 focused tests，修复失败。

- [x] Task 6: 同步文档并运行验证门禁
  - [x] SubTask 6.1: 更新 `CODE_WIKI.md` 和必要 README/CLI help，说明 Windows global CLI、dev fallback、artifact hints 和文件参数规则。
  - [x] SubTask 6.2: 运行 `npm run build`、`npm run build:bridge` 或等价 packaging 验证。
  - [x] SubTask 6.3: 运行 `mise run affected`。
  - [x] SubTask 6.4: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.5: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 1。
- Task 4 depends on Task 1。
- Task 5 depends on Task 2-4。
- Task 6 depends on Task 2-5。
