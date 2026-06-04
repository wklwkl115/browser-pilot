# TODO
当前 TODO 入口已更新：
- 当前无激活大型主线；ABML 机制臂 M2c living snapshot projection 已完成。
- 当前状态与执行队列：`CURRENT.md`。
- 历史完成归档：`ARCHIVE.md`。
- 后续路线与建议：`ROADMAP.md`。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`。
当前执行口径：
- 当前无并行大型架构主线；状态以 `CURRENT.md` 为准。后续 M3 / public surface / profile isolation 需单独激活。
- 当前 shipping 行为是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除。
- `docs/abml-execution-plan.md` 不再作为当前执行队列；ABML R1/R2/R3/R3.x 与机制臂 M1/M2a/M2b/M2c 均已作为 internal substrate 完成。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`
维护规则：
- 新增能力、重大架构变更、成熟替代/bridge 引入、既有工具实质变更，先更新 `CURRENT.md` 中的决策、边界、契约与验证计划。
- 执行细分任务放入对应 `docs/*execution-plan.md`；新主线启动前先在 `CURRENT.md` 写明决策、边界、契约与验证计划。
- 完成后迁入 `ARCHIVE.md`，后续项进入 `ROADMAP.md`。
