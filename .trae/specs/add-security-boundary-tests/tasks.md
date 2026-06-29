# Tasks

- [x] Task 1: 盘点安全边界测试面：确认现有 redaction、resource、scanner bridge、profile/memory 测试和可复用 helper。
  - [x] SubTask 1.1: 搜索现有 secret/cookie/token/header redaction 测试，确认缺口。
  - [x] SubTask 1.2: 搜索 resource ref/resolver、profileService、memory secret/staleness 测试，确认缺口。
  - [x] SubTask 1.3: 搜索 scanner bridge command/output parser 测试，确认缺口。
  - [x] SubTask 1.4: 明确本轮不使用真实浏览器、真实网络或真实外部 scanner。
  - 盘点结果：现有覆盖包括 `tests/memory/resultMiddlewareEnvelope.test.ts` 的 result redaction 指针/隐私元数据、`tests/artifacts/artifactReader.test.ts` 的 artifact text redaction、`tests/js-ast/webSecuritySharedBridge.test.ts` 的 header/step/scanner failure redaction 与本地 stub scanner、`tests/bootstrap/coreCommandsDispatch.test.ts` 的 bridge error redaction、`tests/bootstrap/temporalEvidenceResource.test.ts` 与 `tests/memory/memoryFactBoundary.test.ts` 的 resource ref/expiry/stale/missing evidence、`tests/bootstrap/kernelRuntimeHelpers.test.ts`、`tests/memory/observeScanProjection.test.ts`、`tests/memory/executeMonitorAdapter.test.ts` 的 scan/ABML/monitor helpers，以及 `tests/memory/memoryFactBoundary.test.ts` 的 cwd 隔离、profile malformed recovery、secret scope、staleness/strike/disabled service。
  - 缺口：redaction 仍需补 Authorization/Cookie/Set-Cookie/X-Api-Key/query/body token 在 Web Security summary/diagnostics/error/artifact/resource/scanner command 记录中的端到端不泄漏；resource 仍需补 traversal、encoded traversal、absolute/Windows path、unknown scheme、wrapped malformed ref、跨 scope/cwd 与路径泄漏；scanner bridge 仍需补 shell metacharacters、换行、引号、危险 flags、缺失 scanner、非零退出、partial/malformed/超长输出与 redacted diagnostics；profile-memory 仍需补 malformed persisted data 对有效数据隔离、跨 cwd/profile/resource/staleness 不串扰、disabled/strike/diagnostics 不回显敏感值。后续测试只使用 Node test runner、本地 fixture/stub，不使用真实浏览器、真实网络或真实外部 scanner。

- [x] Task 2: 补充敏感信息不泄漏测试：覆盖 Web Security、summary、diagnostics、artifact/resource metadata、scanner bridge 的 redaction 边界。
  - [x] SubTask 2.1: 覆盖 Authorization、Cookie、Set-Cookie、X-Api-Key、token/query/body 中敏感值不会原样出现在 summary 或 diagnostics。
  - [x] SubTask 2.2: 覆盖 Web Security request/replay/template/scanner bridge 中错误、fallback、failure 记录不会包含原始敏感值。
  - [x] SubTask 2.3: 覆盖 artifact/resource metadata 或 serialized output 不保存原始 secret/token。
  - [x] SubTask 2.4: 运行相关测试并确认无真实网络或 scanner 调用。

- [x] Task 3: 补充 resource ref 越界与路径安全测试：覆盖 malformed refs、path traversal、expired refs、unknown schemes 和 wrapped refs。
  - [x] SubTask 3.1: 覆盖 `../`、绝对路径、URL 编码 traversal、Windows 路径、unknown scheme 等输入。
  - [x] SubTask 3.2: 覆盖 expired resource、missing backing resource、wrapped malformed `bp-ref://data-slice`、跨 scope/cwd ref。
  - [x] SubTask 3.3: 验证错误或诊断不会泄漏敏感本地路径内容。
  - [x] SubTask 3.4: 如发现越界读取风险，做最小修复并补回归测试。

- [x] Task 4: 补充 scanner bridge command 安全与异常输出 contract 测试：覆盖参数化、注入输入、缺失 scanner、malformed output 和 redacted diagnostics。
  - [x] SubTask 4.1: 覆盖包含 shell metacharacters、换行、引号、危险 flags 的 URL/header/template 输入不会改变安全参数语义。
  - [x] SubTask 4.2: 覆盖 scanner binary 缺失、非零退出、partial JSON、malformed stdout/stderr、超长输出的受控降级。
  - [x] SubTask 4.3: 覆盖 scanner command/diagnostics/error 中敏感 query/header/cookie 被 redacted。
  - [x] SubTask 4.4: 运行相关 bridge 测试并确认只使用本地 stub，不调用真实 scanner。
  - 验证结果：新增 `scanner bridge command contract preserves argv boundaries for injection-like input` 与 `scanner bridge failure and malformed output contract redacts diagnostics`，扩展本地 `scannerStub.cjs` 的 echo/failure/malformed 模式；`node --import tsx --test tests/js-ast/webSecuritySharedBridge.test.ts`、`mise run test-js-ast`、`mise run affected` 均通过；未发现需要生产代码修复的真实缺陷。

- [x] Task 5: 补充 profile/memory/workspace 隔离测试：覆盖 malformed persisted data、跨 cwd/profile、disabled service、secret persistence、staleness/strike。
  - [x] SubTask 5.1: 覆盖 profile/memory 数据损坏时可控恢复，不污染有效数据。
  - [x] SubTask 5.2: 覆盖不同 cwd/profile 之间 secret、facts、resource refs、staleness 状态不串扰。
  - [x] SubTask 5.3: 覆盖 disabled service、strike flush、diagnostics consume 中敏感值不回显。
  - [x] SubTask 5.4: 运行 memory/profile 相关测试。
  - 验证结果：新增 `memory validation keeps evidence paths inside the active workspace`，覆盖 browser-result、artifact、operation evidence 跨 cwd/workspace 不可引用且错误不泄漏本地路径；保留并复用现有 malformed profile recovery、valid fact preservation、cwd/profile/secret 隔离、disabled service、diagnostics consume、strike flush/staleness 测试。最小修复限制 memory evidence 本地路径必须位于当前 cwd/workspace 内，并移除 unreadable evidence 错误中的本地路径 details。`node --import tsx --test tests/memory/memoryFactBoundary.test.ts`、`node --import tsx --test tests/memory/*.test.ts`、`npm run --silent typecheck` 均通过。

- [x] Task 6: 最终验证与收口：运行全量测试、affected、coverage、verify，更新任务和验收记录。
  - [x] SubTask 6.1: 运行 `node scripts/run-tests.mjs all`。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 运行 `mise run coverage`，确认三项仍满足既有阈值。
  - [x] SubTask 6.4: 运行 `mise run verify`。
  - [x] SubTask 6.5: 如安全测试说明或流程有变化，同步 `CODE_WIKI.md` 并验证本地 Markdown 链接。
  - [x] SubTask 6.6: 在 checklist 中记录验证结果、真实缺陷修复情况和剩余风险。
  - 验证结果：`node scripts/run-tests.mjs all` 通过（211 tests，0 fail）；`mise run affected` 通过（211 tests，0 fail）；`mise run coverage` 通过（211 tests，0 fail），coverage 为 lines 97.62%、branches 87.61%、functions 100.00%，三项均满足既有 80% 阈值；`mise run verify` 通过（211 tests，0 fail，lint/build 均 ok）。因工作区已有 `CODE_WIKI.md` 修改，已执行本地 Markdown 链接验证脚本并通过（`ok: CODE_WIKI local markdown links exist`）。本轮安全边界测试使用 Node built-in test runner + `tsx` 和本地 fixture/stub，未调用真实浏览器、真实网络或真实外部 scanner；未编辑 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物。真实缺陷修复情况：Task 5 已做最小生产修复，限制 memory evidence 本地路径必须位于当前 cwd/workspace 内，并移除 unreadable evidence 错误中的本地路径 details；其他补测未发现需要生产代码修复的真实缺陷。剩余风险：覆盖的是本地离线单元/契约边界，不代表真实浏览器扩展、真实网络目标或真实外部 scanner 运行时的端到端安全验证。

# Task Dependencies

- Task 2、Task 3、Task 4、Task 5 depends on Task 1。
- Task 2、Task 3、Task 4、Task 5 可在 Task 1 完成后并行推进，但不得编辑同一测试文件或生产文件造成冲突。
- Task 6 depends on Task 2、Task 3、Task 4、Task 5。
