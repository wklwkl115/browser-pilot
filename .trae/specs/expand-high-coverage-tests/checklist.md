# Checklist

- [x] 已提供可重复运行的覆盖率报告入口，且默认 `node scripts/run-tests.mjs all`、`mise run affected`、`mise run verify` 行为保持稳定。
- [x] 覆盖率报告能帮助定位低覆盖目录或文件，并已记录本轮仍需后续关注的低覆盖热点。
- [x] 新增 commands 执行层测试覆盖至少三个代表性 `browser_*` 命令的成功、错误、runtime interaction 或 summary/distiller 行为。
- [x] 新增 kernels 纯逻辑测试覆盖至少两个 kernel 子域，并包含正常、空、畸形或边界输入。
- [x] 新增 daemon/server 状态机测试覆盖 pairing、lease、state dir、token 或 route validation 中至少两个高风险边界。
- [x] 新增 bridge/extension/runtime helper 测试覆盖无需真实浏览器的 malformed message、timeout、adapter failure 或 error shaping 行为。
- [x] 所有新增测试继续使用 Node built-in test runner + `tsx`，未引入新的重量级测试框架或真实浏览器端到端依赖。
- [x] 如新增测试 scope、coverage 脚本或 mise task，已同步 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md` 的相关说明。
- [x] `node scripts/run-tests.mjs all` 通过。
- [x] 覆盖率报告命令可运行并完成。
- [x] `mise run affected` 通过。
- [x] `mise run verify` 通过。
- [x] 未编辑 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物，未回滚用户已有变更。
