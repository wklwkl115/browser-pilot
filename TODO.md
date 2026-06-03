# TODO
当前 TODO 入口已更新：
- 当前激活主线：`docs/cli-skill-frontend-migration-plan.md`。
- 当前状态与执行队列：`CURRENT.md`。
- 历史完成归档：`ARCHIVE.md`。
- 后续路线与建议：`ROADMAP.md`。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`。
当前执行口径：
- `pi-browser` CLI + Skill 前端迁移现为唯一激活的大型架构变更。
- 当前 shipping 行为仍是 **Pi-native entry (`index.ts`) + MCP shell (`mcp/`)**；在 CLI parity、contracts、docs、runtime 验证全部落地前，不得宣称已完成切换。
- `docs/abml-execution-plan.md` 不再作为当前执行队列；ABML 保持已落地的 internal substrate / 历史执行合同。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`
维护规则：
- 新增能力、重大架构变更、成熟替代/bridge 引入、既有工具实质变更，先更新 `CURRENT.md` 中的决策、边界、契约与验证计划。
- 执行细分任务放入对应 `docs/*execution-plan.md`；当前迁移主线执行源为 `docs/cli-skill-frontend-migration-plan.md`。
- 完成后迁入 `ARCHIVE.md`，后续项进入 `ROADMAP.md`。
