# TODO

当前 TODO 入口已拆分：

- 当前状态与执行队列：`CURRENT.md`。
- 当前激活项：ABML（Agent Browser Modeling Language）执行落地，执行 TODO 见 `docs/abml-execution-plan.md`；设计源见 `docs/unified-browser-modeling-language-plan.md`；P1 规格见 `docs/abml-p1-spec.md`。当前只允许 P1 纯函数/契约测试落地，P1 gate 通过前不得改 ref registry/runtime。 
- 当前无剩余工程债 backlog；future-facing 项只保留在 `ROADMAP.md`。
- 最近完成整理合同：`docs/current-todo-unification-plan.md`（已统一核查并整理非 MCP 当前/待办/归档队列，消除重复“当前”口径）。
- 最近完成执行合同：`docs/mcp-standardization-progressive-disclosure-plan.md` Phase 10。
- 历史完成归档：`ARCHIVE.md`。
- 后续路线与建议：`ROADMAP.md`。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`。

维护规则：新增能力、重大架构变更、成熟替代/bridge 引入、既有工具实质变更，先更新 `CURRENT.md` 中的决策、边界、契约与验证计划；执行细分任务放入对应 `docs/*execution-plan.md`；完成后迁入 `ARCHIVE.md`，后续项进入 `ROADMAP.md`。
