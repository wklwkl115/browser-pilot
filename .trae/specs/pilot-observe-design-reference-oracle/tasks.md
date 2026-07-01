# Tasks

- [x] Task 1: 调研 P6 外部设计参考并映射到 Browser Pilot 边界
  - [x] SubTask 1.1: 梳理 Playwright locator/getByRole/ARIA snapshot/auto-wait/accessibility snapshot 的可借鉴点和不采纳点。
  - [x] SubTask 1.2: 梳理 Testing Library DOM query priority 的可借鉴点和不采纳点。
  - [x] SubTask 1.3: 梳理 browser-use DOM extraction 与 Stagehand observe/action/extract 分层的可借鉴点和不采纳点。
  - [x] SubTask 1.4: 将参考点映射为 Browser Pilot 本地 guardrails：query priority、locator/ref stability、observe/action/extract boundary、runtime dependency boundary。

- [x] Task 2: 建立 query priority 与 locator/ref stability oracle
  - [x] SubTask 2.1: 找出现有 observe/ABML/ref 测试中最合适承载 user-centric query priority 的位置。
  - [x] SubTask 2.2: 增加或强化 fixture，覆盖 role/name/label 优先于 selector-like、framework/generated class、long preview、SVG/path、HTML-like 候选。
  - [x] SubTask 2.3: 增加或强化断言，保护 Browser Pilot refs/locators 使用 concise user-facing semantics。
  - [x] SubTask 2.4: 确保 oracle 不引入站点特定 hardcode。

- [x] Task 3: 建立 observe/action/extract boundary oracle
  - [x] SubTask 3.1: 增加或强化测试，确认 `browser_observe` 输出 task entry points、refs、relations、content/artifact hints、diagnostics 和 evidence，而不是默认执行业务数据提取。
  - [x] SubTask 3.2: 增加或强化测试/文档断言，明确精确业务值应通过 `browser_execute` 或 artifact reads 获取。
  - [x] SubTask 3.3: 确认新增 oracle 不扩大 `browser_*` public command surface。

- [x] Task 4: 保护 runtime dependency 和架构边界
  - [x] SubTask 4.1: 增加或强化依赖边界检查，确认未引入 Playwright、Testing Library、browser-use 或 Stagehand runtime dependencies。
  - [x] SubTask 4.2: 确认 `src/kernels/*` 仍保持纯逻辑边界，未引入 browser/runtime/third-party framework dependency。
  - [x] SubTask 4.3: 确认 command catalog、bridge protocol 和 generated outputs 未因 P6 oracle 不必要变化。

- [x] Task 5: 同步文档和长期优化记录
  - [x] SubTask 5.1: 更新 `CODE_WIKI.md`，说明 P6 design reference oracle、query priority、locator/ref stability 和 observe/action/extract boundary。
  - [x] SubTask 5.2: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P6 记录为已沉淀为 repository-local oracle/guardrail，并写明后续关注项。
  - [x] SubTask 5.3: 如发现 stale notes/spec 文字与已完成 P3-P5 实测不一致，顺手同步同一 owner note 中的状态，不新建文档。

- [x] Task 6: 运行验证门禁
  - [x] SubTask 6.1: 运行新增/相关 focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 1。
- Task 4 can run after Task 1 and may run in parallel with Task 2-3。
- Task 5 depends on Task 1-4 的实际结论。
- Task 6 depends on Task 1-5。
