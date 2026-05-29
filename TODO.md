# TODO
当前 TODO 入口已拆分：
- 当前状态与执行队列：`CURRENT.md`（当前无新的激活主线；最近完成项含 cross-tool evidence correlation metadata、interception phase 1/2、JS AST / 反混淆 phase 1、DOM 事件链 / sink-flow phase 1、Wasm 逆向桥接 phase 1 与 Stateful WebSocket replay/fuzz primitives phase 1）
- 当前执行组：`TODO 257-261 维护入口 / 协议单源收口 / 单测扩面 / mature bridge 预检诊断 / 文档去重` 已完成；结果、边界与验证记录见 `CURRENT.md` 与 `ARCHIVE.md`
- 当前架构工作流：`TODO 244-249 tool surface consolidation`，完整执行合同见 `docs/tool-surface-consolidation-plan.md`
- 当前工程治理补充队列：`TODO 250-256 build/test/doc governance follow-up`，首版实现已落地；修正版问题清单、边界、执行顺序、已完成项与 CI 自动化口径见 `CURRENT.md`
- 历史完成归档：`ARCHIVE.md`
- 后续路线与建议：`ROADMAP.md`
- 下阶段深水区能力规划：`docs/next-phase-web-reversing-and-security-primitives-plan.md`
- 最近完成的下阶段执行合同：`docs/stateful-websocket-replay-and-fuzz-plan.md`
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`
维护规则：新增能力、重大架构变更、成熟替代/bridge 引入、既有工具实质变更，先更新 `CURRENT.md` 中的决策、边界、契约与验证计划；完成后迁入 `ARCHIVE.md`，后续项进入 `ROADMAP.md`。
