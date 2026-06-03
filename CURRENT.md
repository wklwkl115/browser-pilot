# CURRENT

## 当前状态
- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前 shipping 外部前端是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除（CLI 用法见 `docs/cli.md`）。
- 当前主链路仍是：`browser_tabs list` / `browser_tabs switch|create` -> 显式 `tabId` -> `browser_observe` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前工具边界不变：不新增公开 `browser_*` 工具；不恢复 orchestration / target resolver；ABML 继续作为现有 `browser_*` 的内部 substrate（纯核 15 模块已物理分层到 `src/abml-core/`，运行时留 `src/abml/`，边界由 `check:abml-core-boundary` 锁定；清单见 `docs/abml-kernel-manifest.md`）。
- jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：只吸收能力模型与证据路径，不新增被拒绝的公开工具 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`。
- 修改协议/工具后先跑 `npm run check`；局部回归优先 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。
- 仓库单一源码根：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅作本地导出/归档产物。

## 当前激活项

当前无并行大型架构主线；新 workstream 不得与既有主线并行激活，除非用户显式改优先级。

## 已完成但不再作为当前队列

- **CLI + Skill Frontend Migration 已完成**：`pi-browser` CLI（用户级单例 daemon 驱动）成为唯一外部前端，MCP shell 整体移除，`@modelcontextprotocol/sdk` 下线；Pi-native `index.ts` 不变且验证通过（注册 22 工具、零 mcp 依赖），live `npm run smoke:cli` 端到端通过。执行合同：`docs/cli-skill-frontend-migration-plan.md`；CLI 文档：`docs/cli.md`。
- **ABML 内核解耦已完成**：纯核 15 模块 + `index.ts` barrel 物理分层到 `src/abml-core/`（零浏览器/Node 依赖），运行时留 `src/abml/`，边界 CI 锁定（`check:abml-core-boundary`）。清单见 `docs/abml-kernel-manifest.md`；workspace 包提升为可选延后项。
- ABML 执行落地已收口为 internal substrate；公开 ABML tool surface RFC 继续 deferred。历史执行合同保留在 `docs/abml-execution-plan.md`，但不再是当前执行队列。
- MCP 标准化 + 渐进式披露 Phase -1 -> Phase 10 已完成，并随 MCP shell 移除归档为历史（`docs/mcp-standardization-progressive-disclosure-plan.md`，HISTORICAL，非当前行为）。
- Web Security affordance / validation / recovery、MV3 runtime state recovery、bridge runtime hardening、工具面治理与工程化收口均已归档，不再作为当前 active queue。

## Next backlog

当前无并行大型架构主线；后续候选（ABML R1 关系图谱 / R2 推理层 / R3 感知源扩展）继续只作为 `ROADMAP.md` 与 RFC/eval 规划，未激活。

## 后续路线

- future-facing 能力方向继续放在 `ROADMAP.md` 与对应 RFC/eval 文档中。
- 若后续重新打开 ABML public surface、debugger workflow、incognito/profile isolation 等方向，必须另开新的执行合同，不得搭车既有主线。
