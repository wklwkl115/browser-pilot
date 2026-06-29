# Checklist

- [x] 已盘点现有安全边界测试并确认本轮补测缺口。
- [x] 已确认本轮测试不依赖真实浏览器、真实网络或真实外部 scanner。
- [x] Authorization、Cookie、Set-Cookie、X-Api-Key、token/query/body 等敏感值不会原样出现在 summary、diagnostics、error、artifact/resource metadata 或 scanner command 记录中。
- [x] Web Security request/replay/template/scanner bridge 的错误、fallback、failure 路径已覆盖 redaction 边界。
- [x] Resource resolver 已覆盖 malformed refs、path traversal、absolute path、encoded traversal、Windows path、unknown scheme、expired refs、wrapped refs、missing backing resource 和跨 scope/cwd ref。
- [x] Resource/path 安全错误或诊断不会泄漏敏感本地路径内容。
- [x] Scanner bridge 已覆盖 shell metacharacters、换行、引号、危险 flags、缺失 scanner、非零退出、partial JSON、malformed stdout/stderr 和超长输出。
- [x] Scanner bridge command、diagnostics、error 中敏感 query/header/cookie 被 redacted，且只使用安全参数语义。
- [x] Profile/memory/workspace 已覆盖 malformed persisted data、跨 cwd/profile、disabled service、secret persistence、staleness/strike/diagnostics consume。
- [x] 如测试暴露真实安全缺陷，已做最小生产修复并补充回归测试；如未暴露，已记录未发现需修复缺陷。
- [x] 所有新增测试继续使用 Node built-in test runner + `tsx`，未引入新的重量级测试框架。
- [x] 未编辑 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物，未回滚用户已有变更。
- [x] `node scripts/run-tests.mjs all` 通过。
- [x] `mise run affected` 通过。
- [x] `mise run coverage` 通过，且三项仍满足既有阈值。
- [x] `mise run verify` 通过。
- [x] 如同步了 `CODE_WIKI.md`，本地 Markdown 链接验证通过；如无需同步，已确认原因。
- [x] 已记录最终验证结果、真实缺陷修复情况和剩余风险。

## 最终验证记录

- `node scripts/run-tests.mjs all`：通过，211 tests，0 fail。
- `mise run affected`：通过，211 tests，0 fail。
- `mise run coverage`：通过，211 tests，0 fail；coverage 为 lines 97.62%、branches 87.61%、functions 100.00%，三项均满足既有 80% 阈值。
- `mise run verify`：通过，211 tests，0 fail，lint/build 均 ok。
- `CODE_WIKI.md` 本地 Markdown 链接验证：通过，结果为 `ok: CODE_WIKI local markdown links exist`。
- 真实缺陷修复情况：Task 5 已做最小生产修复，限制 memory evidence 本地路径必须位于当前 cwd/workspace 内，并移除 unreadable evidence 错误中的本地路径 details；其他补测未发现需要生产代码修复的真实缺陷。
- 剩余风险：本轮覆盖的是本地离线单元/契约边界，不代表真实浏览器扩展、真实网络目标或真实外部 scanner 运行时的端到端安全验证。
