# TODO
当前 TODO 入口已更新：
- 当前激活执行线：无；新增主线必须先登记到 `CURRENT.md`。
- 当前状态与执行队列：`CURRENT.md`。
- 历史完成归档：`ARCHIVE.md`。
- 后续路线与建议：`ROADMAP.md`。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`。
## Maintenance Rules
- 新增能力、重大架构变更、成熟替代/bridge 引入、既有工具实质变更，先更新 `CURRENT.md` 中的决策、边界、契约与验证计划。
- 执行细分任务放入对应 `docs/*execution-plan.md`；新主线启动前先在 `CURRENT.md` 写明决策、边界、契约与验证计划。
- 完成后迁入 `ARCHIVE.md`，后续项进入 `ROADMAP.md`。
