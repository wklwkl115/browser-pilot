# TODO
当前 TODO 入口已更新：
- 当前激活执行线：Agent-facing CLI connection control protocol。目标是把浏览器连接 readiness 从隐式 daemon auto-start 改成 agent 可主动确认、可观测、可失败恢复的 CLI 协议；执行队列见 `docs/agent-cli-connection-control-plan.md`，当前决策/边界见 `CURRENT.md`。
- 当前状态与执行队列：`CURRENT.md`。
- 历史完成归档：`ARCHIVE.md`。
- 后续路线与建议：`ROADMAP.md`。
- 文档结构规范：`docs/document-structure.md`；索引同步脚本：`npm run docs:sync-indexes`。
当前执行口径：
- 最近完成的大型主线：Agent-native 统一架构 Workstream A（合并原 CLI 优化线），状态以 `CURRENT.md` 为准；权威设计见 `docs/agent-native-architecture.md`，外部面规范 `docs/agent-native-cli-spec.md` + 队列 `docs/agent-native-cli-execution-plan.md`。
- 当前 shipping 行为是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除。
- `docs/abml-execution-plan.md` 不再作为当前执行队列；ABML R1/R2/R3/R3.x 与机制臂 M1/M2a/M2b/M2c 均已作为 internal substrate 完成。
维护规则：
- 新增能力、重大架构变更、成熟替代/bridge 引入、既有工具实质变更，先更新 `CURRENT.md` 中的决策、边界、契约与验证计划。
- 执行细分任务放入对应 `docs/*execution-plan.md`；新主线启动前先在 `CURRENT.md` 写明决策、边界、契约与验证计划。
- 完成后迁入 `ARCHIVE.md`，后续项进入 `ROADMAP.md`。
## Recently completed
- Agent-native CLI 产品化主线已按 `docs/agent-native-cli-execution-plan.md` 完成：已落地 discovery `agentCli`/`artifactBehavior`、scoped natural routing、stable JSON envelopes、doctor/selftest、文件化大输入、artifact follow-up、tab/snapshot/artifact/browser-result/ref recovery、npm wrapper JSON 边界与 frame/hook blind route-adoption 证据；详细变更与验证见 `CHANGELOG.md`。
- B5 durable connection reliability：已将扩展侧 WebSocket 连接所有权从 MV3 service worker 迁到 offscreen document；保持 native bridge WebSocket wire protocol、公开 `browser_*` 工具、端口范围 fan-out、`bridge_wake` 行为不变；验证通过 `npm run build:bridge`、`npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`、`npm run check`。
