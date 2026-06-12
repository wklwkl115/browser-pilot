# CURRENT

## 当前状态

- 当前 shipping 外部前端是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除，CLI 用法见 `docs/cli.md`。
- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync` 同步。
- 当前主链路：`browser_tabs list|switch|create` -> 显式 `tabId` -> `browser_observe` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前工具边界：22 个 `browser_*` 工具 always-on；Web Security 是 scoped follow-up 分组；不恢复 capability profile / compact mode / discovery mode；不新增公开 `browser_*` 工具，不恢复 orchestration / target resolver。
- Agent 审计收件箱是 `agent-audits/`，异步审计/修复 skill 是 `skills/pi-browser-audit-fix/SKILL.md`：审计 agent 只写报告，不改项目代码；修复 agent 由用户另行指定，独立复核报告后进入普通修复 workstream。
- ABML 是内部 substrate，不是公开工具面；公开 ABML verb surface 已关闭为 perception-first 项目决策。
- jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：只吸收能力模型与证据路径，不新增被拒绝的公开工具 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`。
- 仓库单一源码根：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅作本地导出/归档产物。
- 修改协议/工具后先跑 `npm run check`；局部回归优先 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。

## 当前激活项

- 当前无激活执行线；新主线启动前先在此处写明决策、边界、契约与验证计划。

## 最近完成索引

- Recent completed details are archived in
  `docs/archive/recent-completed-workstreams.full.md`; summary index:
  `docs/archive/recent-completed-workstreams.md`.
- Historical summaries and full-detail archive pairs are indexed from
  `ARCHIVE.md`; future/non-active routes live in `ROADMAP.md`.
- The old completed-entry prose was migrated out of this file during the C2
  ceiling work. `CURRENT.md` must remain at or below 180 lines; long completed
  workstream detail belongs in `docs/archive/*.full.md`.

## 后续路线

- Future-facing ability directions belong in `ROADMAP.md` and corresponding
  RFC/eval docs.
- Completed history must not be expanded back into this file; use `ARCHIVE.md`
  and `docs/archive/*.full.md`.
- Reopening ABML public surface, debugger workflow, incognito/profile isolation,
  or similar closed directions requires a new execution contract.
