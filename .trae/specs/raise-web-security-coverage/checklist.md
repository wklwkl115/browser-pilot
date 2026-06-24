# Checklist

- [x] 已复核覆盖率报告并记录本轮开始时的行、分支、函数覆盖率。
- [x] 已明确本轮不依赖真实浏览器、真实网络、外部 scanner 或生成产物测试。
- [x] 新增 Web Security shared/bridge/helper 测试覆盖至少三个 shared helper 和一个 bridge/browser-native 可隔离 helper。
- [x] 新增 ABML kernel 测试覆盖至少两个低覆盖子域，并包含空树、重复节点、缺失属性、畸形关系或边界大小输入中的多个场景。
- [x] 新增 temporal/evidence distill 测试覆盖预算、估算、相关性或 salience 边界。
- [x] 新增 memory/profile/resource 服务测试覆盖 malformed/missing profile、secret redaction、staleness 或 missing resource 边界。
- [x] 所有新增测试继续使用 Node built-in test runner + `tsx`，未引入新的测试框架、真实浏览器或网络依赖。
- [x] `node scripts/run-tests.mjs all` 通过。
- [x] `mise run coverage` 通过，并已记录最新行、分支、函数覆盖率与剩余低覆盖热点。
- [x] `mise run affected` 通过。
- [x] `mise run verify` 通过。
- [x] 如测试 scope、coverage 流程或文档说明有变化，已同步 `CODE_WIKI.md` 并验证本地 Markdown 链接；如无变化，已确认无需更新。
- [x] 未编辑 `dist/` 或 `bridge/browser_pilot_bridge/` 生成产物，未回滚用户已有变更。

## Task 6 收口记录

- 最新覆盖率：行 64.60%，分支 64.69%，函数 54.78%。
- 验证：`node scripts/run-tests.mjs all` 通过（187 passed）；`mise run coverage` 通过；`mise run affected` 通过（187 passed）；`mise run verify` 通过（187 passed，lint/build ok）。
- 文档检查：本轮未改变测试 scope、coverage 流程或文档说明，确认无需更新 `CODE_WIKI.md`；本 spec 的本地 Markdown 引用检查通过。
- 剩余低覆盖热点：Web Security browserNative 命令实现仍是最大热点，尤其 `crawl.ts`、`httpReplay.ts`、`cookieAnalyze.ts`、`templateCheck.ts`、`callbackOast.ts`、`fuzz*`、`sqliProbe.ts`、`crawlExtractors.ts`、`oastWorkerManager.ts`；Web Security shared/bridge 中 `replay.ts`、`requestTemplate.ts`、`railsCookieTokens.ts`、`jsAstReductionContext.ts`、`matureBridge.ts`、`nucleiBridge.ts`、`sqlmapBridge.ts` 仍偏低；ABML 的 `ax.ts`、`inference.ts`、`entity.ts`、`relations.ts` 仍是后续纯逻辑补测候选。
