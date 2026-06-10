# ROADMAP

> 后续路线与下一步建议。当前状态见 `CURRENT.md`；历史完成项见 `ARCHIVE.md`。

## 已关闭决策（不在执行队列；仅凭下列明确证据才重开）

这些项目已经过设计评审或 blind-eval 证据裁定为"不做"。保留在此作为决策记录，
防止未来重复讨论。重开条件写在括号里；无该条件则维持关闭。

- **browser_sources / browser_debugger / browser_intercept / browser_storage /
  browser_canvas**：jshookmcp 吸收时裁定 canonical tools 已覆盖能力模型（见
  `docs/jshookmcp-native-absorption.md`）；现有 `browser_command`、`persistent_cdp`、
  `browser_evidence`、`browser_artifact` 组合承载全部能力。
  *(重开条件：blind-eval 出现 canonical tools 无法关闭的真实任务)*
- **Debugger pause/breakpoint/step lifecycle 专用工具**：`browser_command`、
  `persistent_cdp`、`browser_frame`、`browser_artifact` 已覆盖；zero 受阻证据。
  *(重开条件：transcript 证明现有组合无法完成 debugger 工作流)*
- **Incognito/profile isolation 默认入口**：另开独立能力设计，不挂默认会话入口。
  *(重开条件：成立独立能力 RFC，不搭车任何现有主线)*
- **Orchestration/Desired State/Logical Target 回归**：已撤回；operation metadata
  只做诊断。*(重开条件：无；保持撤回状态)*

## 当前非激活路线（真实未来项，带重开触发器）

1. **Real ACI eval runner 扩展**：runner 已落地（`npm run eval:browser-workflows
   --fixture-server`，覆盖 01-27 + 30）；后续是新增 spec 时同步接入；仍禁止
   scanner/OAST/external network 默认运行。
2. **Web reversing/security 下阶段原语**：已完成 phase 1（拦截/热补丁/JS AST/DOM
   事件链/Wasm/WebSocket）；phase 2 须另开 RFC + eval-first。*(触发：phase-1 原语
   eval 无法关闭的真实任务)*
3. **ABML 公开 verb surface**：`blind-findings.md` W1（WAI）主动否定需求——agent
   在 10 次真实 blind 运行中报告"acting 无 friction"，只有返回值渲染痛点（已修）。
   目前延迟有强正面证据支撑。*(触发：transcript 显示 agent 因缺公开 verb 被真实任务
   卡住)*
4. **Renderer `line` 粒度扩展**（entity 面原语已落）：最高理解风险档，零正面证据。
   *(触发：逐平面盲测 eval 证据)*
5. **词典/wordlist 治理 W2/W3**：W1（安全 payload/签名外部化）已由 debt-clearance
   执行；W2（ARIA 词表 codegen，纯核无运行时依赖约束）和 W3（SecLists 校准，外部
   依赖）维持 parked。*(触发：W2 须独立执行合同；W3 须 SecLists 依赖评审)*
6. **browser_hook 后续扩展**：只能增加显式 hook targets 或静态 target 展开；禁止
   策略型 preset 名称与黑盒判断。*(触发：blind-eval 确认新 target 必需)*
7. **盲测滚动台账中的 n=1 items**（G5 artifact regex / G1 G6 CLI papercuts / B9a
   媒体候选 / B11 sidebar-dominant）：等待复现确认后才成为工作项。

## 近期质量建议

- 发布/合并前复跑 `npm run quality:local`（含 lint；`npm run check` 不跑 eslint）。
- 需要 runtime 证据时按需复跑 opt-in smoke/eval：`npm run smoke:browser:isolated`、
  `npm run smoke:browser:scan-summary`、`npm run eval:browser-workflows
  -- --fixture-server`。
- 新能力或重大重构先补 `CURRENT.md` 决策、边界、contracts，再改代码。
- 历史压缩后的阶段归档见 `docs/archive/` 各摘要与详档（`*.full.md`）文件。
