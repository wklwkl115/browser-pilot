# Debugger Evidence Workflow Plan

本文件定义 TODO 243 的起步方案。目标不是立即新增公开工具，而是把“浏览器内持续调试取证”收敛为一个 RFC-only problem area，并先用文档、eval、fixture 和 recipe 验证真实缺口。

## 目标

在不破坏现有 `browser_*` 工具边界的前提下，评估以下能力是否真的需要超出现有 canonical tools：

- pause / resume
- breakpoint lifecycle
- step over / into / out
- call stack
- scope / locals / closure / object preview
- scriptId / executionContext / source location / source-map artifact correlation

## 非目标

- 不立即注册新的公开工具名。
- 不构建完整 DevTools/Debugger 面板替代品。
- 不做自动去混淆、自动漏洞判断、自动路径探索。
- 不引入 live intercept、storage explorer、canvas solver、Wasm binary reversing。
- 不迁入 stealth/captcha/human behavior、frida/adb/memory/binary 能力。

## 当前事实

当前仓库已具备：

- `browser_command` 可发送精确 bridge/CDP 命令；`browser_execute` 只保留页面 JavaScript。
- `persistent_cdp` 已存在，可作为 stateful CDP attach/send/detach 基础。
- `browser_frame`、`browser_hook`、`browser_network`、`browser_crawl`、`browser_artifact` 可提供周边证据。
- 当前边界文档已明确：完整 Debugger workflow 属 RFC-only，不应直接新增公开工具。

## 当前结论（Phase 0-3 收口）

已通过文档、eval、fixture、runtime smoke 和内部 bridge 加固证明：

- 现有 `browser_execute` + `persistent_cdp` 已可稳定获取：
  - `Debugger.enable`
  - runtime payload
  - exception details
  - call frames
  - thrown eval source
  - disable/detach cleanup evidence
- Phase 2 已在 `bridge_src/service_worker/cdp.ts` 对 debugger evidence 做扁平补强，便于 recipe 与 artifact 消费，但**未新增公开工具**。
- 剩余真实缺口已收缩为：
  - `scriptParsed` / page-authored script provenance
  - `pause / breakpoint / step` 生命周期
- 因此当前 Phase 3 决策是：**不新增公开调试工具；只保留 Debugger evidence workflow 作为 RFC-only problem area。**

只有当后续 eval 证明上述剩余缺口在 call/token 成本、恢复质量、cleanup 风险或 artifact sufficiency 上不可接受，才允许重新开启更强的内部能力评估或独立 RFC。

## 最终方案

### Phase 0：RFC-only 启动，先做 eval 和边界冻结

交付物：

- 本文档
- `CURRENT.md` / `ROADMAP.md` / `TODO.md` 决策更新
- `17-debugger-evidence-workflow.md`
- `fixtures/debugger-evidence.html`

关闭条件：

- 把能力定义收紧为 “Debugger evidence workflow”，不是 “新调试工具路线”。
- 明确现有 canonical tools 的承载边界和 RFC 准入条件。

### Phase 1：现有工具 recipe / evidence gap 评估

只允许使用现有能力：

- `browser_execute`（JS） / `browser_command`（bridge command）
- `browser_frame`
- `browser_artifact`
- `browser_observe mode=scan|html` 作为页面状态辅助观察

目标：

- 证明 one-shot CDP 命令是否足以完成调试证据采集。
- 记录 call 数、token 成本、恢复质量、cleanup/stale-state 风险。
- 区分“只是 recipe 不足”与“现有工具真的不够”。

### Phase 2：若 eval 证明不足，只做内部 bridge 能力加固

允许的增强方向：

- `persistent_cdp` attach/send/detach/cleanup 诊断完善
- session / tab / stale-state / resume guarantees
- object preview / stack / scope 的 artifact-first 输出
- timeout / detach / navigation 后恢复线索

限制：

- 仍不承诺新增公开工具名。
- 默认入口继续优先评估 `browser_command` + `persistent_cdp` + `browser_frame` 是否已足够承载。

### Phase 3：RFC 决策点

只有在以下条件同时满足后，才允许评估是否新增公开能力：

1. 现有 canonical tools + Phase 2 内部增强仍不能接受地完成任务。
2. eval 明确证明 call/token 成本、恢复质量或 cleanup 风险不可接受。
3. 新公开能力有清晰、非重叠边界。
4. 不会演化成 DevTools 面板替代品或策略型黑盒。

## 默认边界

- 默认入口仍是现有 canonical tools。
- Debugger workflow 只是问题域，不是默认工具名。
- 所有大对象、scope、stack、source correlation 都必须 artifact-first。
- 自动解释、根因判断、漏洞结论保持在 agent 层，不进入工具层。

## RFC 准入条件

若未来需要正式 RFC，至少必须补齐：

- 非重叠证明：为何 `browser_execute` / `browser_frame` / `browser_artifact` 不足
- eval 数据：成功率、call 数、token、恢复质量、artifact sufficiency
- cleanup 设计：pause 残留、breakpoint 残留、tab navigation、MV3 restart、detach
- 隐私边界：scope/object preview 中的敏感值默认脱敏
- runtime smoke：真实浏览器 + 本地 fixture artifact 证据
