# Checklist

- [x] 已记录本轮开始覆盖率基线：行、分支、函数覆盖率。
- [x] `mise run coverage` 或其底层脚本能机械化验证行、分支、函数覆盖率均 ≥80%，未达标时会清晰失败或报告。
- [x] 如存在 coverage 排除项，已确认仅排除不可执行文件、生成文件或纯类型文件，并记录理由。
- [x] Web Security browserNative/shared/bridges 的低覆盖热点已补充足够测试，且不依赖真实浏览器、真实网络或外部 scanner。
- [x] ABML kernel 的低覆盖热点已补充足够纯逻辑测试，且未破坏 kernel 依赖边界。
- [x] temporal、evidence distill、memory/profile/resource 及 coverage 新热点已补充足够测试。
- [x] 如测试暴露真实 bug，已做最小生产修复并补充回归测试。
- [x] 所有新增测试继续使用 Node built-in test runner + `tsx`，未引入新的重量级测试框架。
- [x] `node scripts/run-tests.mjs all` 通过。
- [x] `mise run coverage` 通过，且最终行覆盖率 ≥80%。
- [x] `mise run coverage` 通过，且最终分支覆盖率 ≥80%。
- [x] `mise run coverage` 通过，且最终函数覆盖率 ≥80%。
- [x] `mise run affected` 通过。
- [x] `mise run verify` 通过。
- [x] `CODE_WIKI.md` 已同步覆盖率阈值/流程说明，本地 Markdown 链接验证通过。
- [x] 未编辑 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物，未回滚用户已有变更。
- [x] 已记录最终覆盖率、验证结果、排除项理由和剩余风险。

## Task6 验收记录

- 最终覆盖率：行 97.62%、分支 87.61%、函数 100.00%，`mise run coverage` 通过并确认三项均 ≥80%。
- 验证结果：`node scripts/run-tests.mjs all` 通过，206 项测试全部通过；`mise run affected` 通过；`mise run verify` 通过；`CODE_WIKI.md` 本地 Markdown 链接校验通过。
- 排除项理由：coverage 脚本继续采用既有最小化排除集合，排除 bridge/apps/browser runtime/commands/scan/utils/validation/native、若干 kernel 子域、types 等当前专项未纳入机械化覆盖阈值的扩展运行时、应用外壳、集成边界、生成/协议/类型或不可直接以纯 Node 单测稳定执行的区域；本轮未新增排除项。
- 剩余风险：coverage 阈值当前针对纳入覆盖 scope 的纯逻辑与可隔离测试面生效，未被 scope 覆盖的浏览器扩展、真实浏览器、真实网络、外部 scanner 与生成产物路径仍依赖 `mise run verify` 中的类型、lint、构建、治理测试以及后续集成验证兜底。
