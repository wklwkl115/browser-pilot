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
- **ABML 公开 verb surface**：北极星是 perception-first；B2 public action arm 已于
  2026-06-05 试过并整体回退；W1/WAI 证据显示 agent 未因缺公开 action verb 被真实
  任务卡住。*(重开证据线：除非 perception-first 北极星本身被推翻，否则不重开)*
- **Web reversing/security phase 2 扩面**：phase-1 原语已覆盖当前真实 eval 需求；成熟
  维护期不保留投机性扩面 backlog。*(重开证据线：真实 agent eval 证明
  source-map/逆向摩擦阻断真实任务)*
- **Renderer `line` 粒度扩展**：renderer-default-flip owner 已决 line granularity stays
  out；entity 面原语保留，line 面不进默认渲染。*(重开证据线：per-plane blind evidence
  证明实体/结构面无法覆盖)*
- **capture esbuild migration**：当前 capture-core generated bundle seam 足够；entry-set
  合同与 escape ledger 保护现状。*(重开证据线：capture entry-set 或 escape ledger 证明
  当前同步模型无法维护)*
- **Check acceleration hot daemon**：`docs/archive/check-acceleration-plan.full.md` 评审后关闭
  daemon 阶段；P1 direct spawn、P2 cache、TypeScript `--incremental`、落盘 import graph
  已覆盖主要收益，常驻 daemon 会引入 stale state、watcher 可靠性和与 browser daemon
  概念混淆。*(重开条件：P0'-P4 落地后 trace 显示进程冷启动 + 图重算仍占
  `check:smart` 代表性 wall time >30%)*
- **更重的 popup ownership 感知面**：真实 form-fill 会话证明 Element Plus 类 shared
  popper 需要用 trigger 的 `aria-controls`/`aria-expanded` 锚定 popup；本轮已通过 skill
  方法论、`data.controls_pairs` nearest-path 诊断和动态 fixture effect 证据收口，不新增
  entity-level expanded/controls 字段或 post-open auto-pairing。*(重开条件：E3/E4 落地后，
  第二个不同组件库的真实 agent run 仍因 popup ownership 混淆受阻)*

## 当前非激活路线（治理/RFC 区；不是 debt backlog）

1. **Real ACI eval runner 扩展**：runner 已落地（`npm run eval:browser-workflows
   --fixture-server`，覆盖 01-27 + 30）；后续是新增 spec 时同步接入；仍禁止
   scanner/OAST/external network 默认运行。
2. **词典/wordlist 治理 W2/W3**：W1（安全 payload/签名外部化）已由 debt-clearance
   执行；W2（ARIA 词表 codegen，纯核无运行时依赖约束）和 W3（SecLists 校准，外部
   依赖）维持 parked；启动前必须另开独立执行合同。
3. **browser_hook 后续扩展**：只能增加显式 hook targets 或静态 target 展开；禁止
   策略型 preset 名称与黑盒判断；新 target 必须由 blind-eval 或真实任务证据立项。
4. **盲测滚动台账 n=1 hypotheses**（G5 artifact regex / G1 G6 CLI papercuts 等）：
   只作为 eval 观察记录；复现前不是工作项，复现后也必须重新立合同。
5. **Check acceleration implementation**：`docs/archive/check-acceleration-plan.full.md` 已完成
   设计评审收口；实施顺序为 P0' in-place trace、P1' single-source DAG、P2'
   coarse git-tree cache、P4 impact graph/ABI-as-edge、P5 miss recorder、P7 docs。
   启动前必须先在 `CURRENT.md` 当前激活项登记决策、边界、契约和验证计划。
6. **ABML collection completeness / continuation kernel**：草案见
   `docs/abml-collection-continuation-kernel-plan.md`。目标是在 ABML 感知层输出
   collection completeness、continuation handle、data-source/evidence/state-transition，
   消除 agent 对 scroll/click/pagination 这类人类 UI 动词的依赖；不新增公开
   `browser_scroll`，不恢复 `browser_execute {action}`。2026-06-13 blind finding L1
   已用 linux.do + bilibili 两站确认 Phase 1-3 感知缺口；W2 同时裁定手写 scroll
   执行为 WAI，runtime continuation arm 封存到新证据重开线。启动前必须先在
   `CURRENT.md` 登记执行合同。

## 近期质量建议

- 发布/合并前复跑 `npm run quality:local`（含 lint；`npm run check` 不跑 eslint）。
- 需要 runtime 证据时按需复跑 opt-in smoke/eval：`npm run smoke:browser:isolated`、
  `npm run smoke:browser:scan-summary`、`npm run eval:browser-workflows
  -- --fixture-server`。
- 新能力或重大重构先补 `CURRENT.md` 决策、边界、contracts，再改代码。
- 历史压缩后的阶段归档见 `docs/archive/` 各摘要与详档（`*.full.md`）文件。
