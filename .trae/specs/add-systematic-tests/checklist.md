# Checklist

- [x] 已完成测试覆盖盘点，并能说明本轮补测优先级、风险理由与不纳入范围。
- [x] 新增命令与 schema 契约测试覆盖公开 `browser_*` 工具名唯一性、命名约束、关键参数 schema 和错误输入路径。
- [x] 新增 bridge/daemon 可隔离逻辑测试覆盖连接/请求生命周期、端口/config 或 daemon invoke 的关键边界。
- [x] 新增 memory/artifact/resource 持久化边界测试覆盖作用域隔离、路径边界、畸形输入和 envelope/ranking/dedup 行为。
- [x] 新增纯逻辑 kernel/runtime helper 测试覆盖正常、空、畸形和边界输入，且不依赖真实浏览器或外部网络。
- [x] 所有新增测试可通过合适的 `scripts/run-tests.mjs` scope 被发现；如新增 scope，已同步 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md`。
- [x] `node scripts/run-tests.mjs all` 通过。
- [x] `mise run affected` 通过。
- [x] `mise run verify` 通过。
- [x] 未编辑 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物，未引入新的测试框架。
