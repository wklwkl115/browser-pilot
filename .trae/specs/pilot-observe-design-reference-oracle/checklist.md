# Checklist

- [x] 已完成 Playwright locator/getByRole/ARIA snapshot/auto-wait/accessibility snapshot 参考映射。
- [x] 已完成 Testing Library DOM query priority 参考映射。
- [x] 已完成 browser-use DOM extraction 与 Stagehand observe/action/extract 分层参考映射。
- [x] 已明确哪些 P6 参考点转化为本地 tests/guardrails，哪些保持 out of scope 或 future spec。
- [x] query priority oracle 覆盖 role/name/label 优先于 selector-like、framework/generated class、long preview、SVG/path、HTML-like 候选。
- [x] locator/ref stability oracle 保护 concise user-facing semantics，不让低价值实现细节成为主语义名。
- [x] oracle fixtures 不包含站点特定 hardcode。
- [x] observe/action/extract boundary oracle 确认 `browser_observe` 不默认执行业务数据提取。
- [x] 文档或测试明确精确业务值应通过 `browser_execute` 或 artifact reads 获取。
- [x] 未新增 Playwright、Testing Library、browser-use 或 Stagehand runtime dependencies。
- [x] `src/kernels/*` 未引入 browser/runtime/third-party framework dependency。
- [x] command catalog、bridge protocol 和 generated outputs 未因 P6 oracle 不必要变化。
- [x] `CODE_WIKI.md` 已同步 P6 design reference oracle、query priority、locator/ref stability 与 observe/action/extract boundary。
- [x] `.trae/notes/abml-observe-long-term-optimization.md` 已同步 P6 状态与后续关注项。
- [x] 同一 owner note 中 P3-P5 stale 状态已按最新实测同步。
- [x] 新增/相关 focused tests 已通过。
- [x] `mise run affected` 已通过。
- [x] `mise run verify` 已通过，或有明确记录说明无法运行的原因与剩余风险。
