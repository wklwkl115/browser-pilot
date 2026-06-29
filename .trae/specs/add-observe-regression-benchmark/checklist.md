# Checklist

- [x] benchmark case 格式已定义，能表达 fixture 输入、期望指标和断言。
- [x] benchmark 使用离线 fixture/纯逻辑路径，不依赖真实浏览器、extension、network 或外部站点。
- [x] benchmark harness 能加载多个 case 并输出 deterministic pass/fail。
- [x] benchmark 覆盖 markup pollution 指标，能检测 `<path`、`<svg`、raw HTML-like semantic name 回归。
- [x] benchmark 覆盖 long name / pricing card preview 不进入 `collection.containerName`。
- [x] benchmark 覆盖 duplicate collection name 消歧。
- [x] benchmark 覆盖 item preview 被拒绝为容器名后 evidence/sample 仍保留。
- [x] benchmark 覆盖或复用 canonical no-mode PageObservation shape 保护。
- [x] 首批 benchmark cases 包含 SVG/path 污染、长 pricing card、duplicate collection name、sample preservation。
- [x] 新增测试不改变 production `browser_observe` 输出契约。
- [x] benchmark 已纳入现有 Node test runner 或明确 scope。
- [x] `mise run affected` 能覆盖 benchmark 相关变更。
- [x] 如果新增测试 scope 或 workflow，`scripts/run-tests.mjs`、`mise.toml`、`CODE_WIKI.md` 已同步。
- [x] benchmark 维护说明已放在 case/test 附近或现有 owner 文档中。
- [x] 新增 benchmark/focused tests 已通过。
- [x] `mise run affected` 已通过。
- [x] `mise run verify` 已通过，或有明确记录说明无法运行的原因与剩余风险。
