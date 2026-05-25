# ROADMAP

> 后续路线与下一步建议。当前状态见 `CURRENT.md`；历史完成项见 `ARCHIVE.md`。

## 下一步建议顺序

1. `NEXT_PHASE.md` Workstreams A-E 已完成当前主线落地；完成摘要见 `WORKSTREAMS_A_E_SUMMARY.md`。Workstream E 已完成静态 ACI eval suite：specs、synthetic fixtures、manifest、manual result schema/template、future runner boundary、contract/package checks。
2. TODO 240 已撤回 `browser_orchestrate` / orchestration coordinator / target resolver 工具面；默认浏览器自动化恢复 `browser_tabs list` + 显式 `tabId`。
3. 后续如再次设计高层会话管理，先做用户任务路径与 agent 调用成本验证；不得复用旧 Desired State/Logical Target 模型作为默认入口。
4. Incognito/profile 隔离不在当前主干路线内；如需要，另开独立能力设计，不挂到默认浏览器会话入口。
5. Workstream E 后续如要执行真实 ACI eval，按 `evals/browser-workflows/future-runner.md` 另开 opt-in runner/fixture server：ephemeral port、local-only、无默认浏览器启动、无 scanner/OAST、结果写入 manual result schema。
6. 发布/合并前继续复跑 `npm run quality:local`；需要 runtime 证据时复跑 `npm run smoke:browser:isolated` 或 `npm run release:local:smoke`。
