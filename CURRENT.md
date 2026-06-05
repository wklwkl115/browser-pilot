# CURRENT

## 当前状态
- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前 shipping 外部前端是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除（CLI 用法见 `docs/cli.md`）。
- 当前主链路仍是：`browser_tabs list` / `browser_tabs switch|create` -> 显式 `tabId` -> `browser_observe` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前工具边界不变：不新增公开 `browser_*` 工具；不恢复 orchestration / target resolver；ABML 继续作为现有 `browser_*` 的内部 substrate（纯核模块已物理分层到 `src/abml-core/`，运行时留 `src/abml/`，边界由 `check:abml-core-boundary` 锁定；清单见 `docs/abml-kernel-manifest.md`）。R1/R2/R3 已完成：`browser_observe` envelope 顶层有 `relations/inference`，`mode=scan` 可用 `baseline` 生成顶层 `diff`，并支持 `form-dependency` 推理。
- jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：只吸收能力模型与证据路径，不新增被拒绝的公开工具 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`。
- 修改协议/工具后先跑 `npm run check`；局部回归优先 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。
- 仓库单一源码根：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅作本地导出/归档产物。

## 当前激活项

- 当前无激活执行线。最近一条 **browser-tools 真 agent 评估线**（action 臂回退 + 观察侧采用/窄主动 hint，2026-06-05）已收口,详见下方"已完成"。后续若继续 M3 / public surface / profile isolation,必须另开执行合同。

## 已完成但不再作为当前队列

- **Browser-tools 真 agent 评估线 — 已收口（2026-06-05）**。三件事一条线：
  1. **action 臂回退（Option A）**：首份怀疑型评估证实公开 `action:{click|type|scroll}` 臂在野外不站住（`action.click` 静默失败/`ACTIONABILITY_TIMEOUT`/selector miss，agent 退回 JS；"verified ≠ intent achieved"；静默失败→升 CDP 有 click 双重执行风险）。**B2 整体回退**：`registerExecuteTool` restore 到 `{script}`-only，移除 smoke/fixture/package 脚本/生成文档的 `action` 参。**ABML 回归观察-only**；执行 = `browser_execute {script}`(JS)，trusted-event 逃生口 = `browser_command` CDP（已存在，无需新子工具）。commit `7a59b5a`。
  2. **观察侧采用诊断（三轮放养→引导→修后放养）**：放养 4/4 跳过深层 observe 产物（scan 只当初步定位，提取/理解整组/检测变化全退回 JS）；引导下 templates/relations 只给结构、agent 仍需 JS 取条目值，只有 `causal`/`treeDiff` 真省事。修了 artifact 顶层镜像漏的 `relations`+`inference`（commit `d7486cf`）+ SKILL "Observe products" 路由 + JS 边界。**关键发现（已排除混淆项：重测 agent 逐字抄回新 skill 段落却仍 4/4 跳过）→ 被动文档改不动采用**，JS 优先本能盖过它。
  3. **窄主动 hint（commit `ecf8dfb`，已 live 验证收口）**：`observeRunners` 经 `summary.nextActions` 主动推送,**只推 `causal`+`treeDiff`**（普通 scan 带 snapshotId → plant "baseline 再扫拿 treeDiff/causal"；baseline scan 真有变化 → 直指产物；低噪；不推 templates/relations）。**验证（干净前后隔离）**：放养重测 task2，agent 做了前两轮放养从没做的 `browser_observe scan baseline=... 读 treeDiff/causal` —— round3（新 skill 无 hint）跳过 vs 本轮（skill+hint）采用，唯一差别是 hint → **主动 push 推动了采用**（实证"反向暴露"）。边界：treeDiff 给结构级、条目级仍补 JS（正确边界）；causal 经 observe 时可达、纯 network 流走 network 亦可；templates/relations 数据取值=JS。静态接线锁在 `check:abml-causal`。**结论：observe = 感知 + 一个已验证能推动采用的 treeDiff/causal 主动 hint。** 执行合同 `docs/browser-tools-eval-fixes-execution-plan.md` + `docs/abml-action-path-gap-plan.md`。
- **ABML R3 质量跟进已完成（2026-06-05，浏览器验证）**：执行合同 `docs/abml-r3-quality-followup-execution-plan.md`。完成 `form-dependency` live-focus 稳健化、scan actionable `focused` 采集、inference evidence refs→`envelope.entities` 实体补齐、prior-envelope baseline 优先读取 saved full `abml.entities`。边界保持：不新增公开 `browser_*` 工具、不改 native protocol、不改 ref minting。验证：`check:abml-inference`、`check:abml-diff`、`check:scan`、`smoke:browser:abml-inference`、`npm run check`。
- **ABML 机制臂 M2c — living snapshot projection 已完成（2026-06-04，浏览器验证）**：执行合同 `docs/abml-mechanism-m2c-living-snapshot-projection-execution-plan.md`。完成 pure `snapshotProjection`、budget-immune envelope lift、saved artifact 持久化、live projection delta smoke。边界：复用 M1 templates + M2a treeDiff + M2b stable refs；不新增公开 `browser_*` 工具、不改 native protocol、不改 action/ref 行为、不做 DOM tag/class/selector 猜测。验证：`check:abml-snapshot-projection`、`smoke:browser:abml-templating`、`npm run check`。
- **ABML 机制臂 M2b — semantic ref anchor 已完成（2026-06-04，浏览器验证）**：执行合同 `docs/abml-mechanism-m2b-semantic-ref-anchor-execution-plan.md`。完成 P1/P2/P3/P4：纯候选锚派生、shadow ref 稳定性实验、窄范围 high-confidence ref-minting feed、live read/click smoke。边界：只允许 named AX/ARIA template container + unique accessible name 的 high-confidence anchor；duplicate/unnamed/posInSet-only 继续 locator-based / diff-only；无新公开 `browser_*` 工具或 native protocol 变更。验证：`check:abml-semantic-ref-anchor`、`smoke:browser:abml-templating`、`npm run check`。
- **ABML 机制臂 M2a — living treeDiff-first 已完成（2026-06-04，浏览器验证）**：执行合同 `docs/abml-mechanism-arm-execution-plan.md`。M2a 只做 treeDiff 投影：复用 M1 ARIA-grounded template groups，对 `browser_observe(mode=scan, baseline)` 输出 `envelope.treeDiff`。边界已保持：不新增公开 `browser_*` 工具、不改 native protocol、不改 `stableRefIdForDescriptor` / ref minting、不做 DOM tag/class/selector 猜测。验证：`check:abml-tree-diff`、`smoke:browser:abml-templating`、`npm run check`。
- **ABML R3.x — network/API 因果平面已完成（2026-06-04，浏览器验证）**：P0+P1+P2(A+B+C) 全部落地于 master。执行合同 `docs/abml-r3x-causal-plane-execution-plan.md`。P0=被动网络增量 `envelope.causal`；P1=`triggered` 时序归因；P2-A=事件因果 `causal.events`；P2-B=事件源归因 `source:"event"`；P2-C=因果 stream plane（游标 drain 通道，`read(plane:network|event)` arm/drain，内部 substrate 经 `integration.readStream`）。仅"真正的服务端推送"出范围（req/resp 架构物理不可能）。
- **Browser workflow eval runner 已完成并合并入 master（2026-06-04）**：`feat/browser-workflow-eval-runner` 的可执行 opt-in runner 已合并，分支已删除；入口 `npm run eval:browser-workflows -- --fixture-server`，默认无副作用、fixture server 仅绑 `127.0.0.1`。
- **CLI + Skill Frontend Migration 已完成**：`pi-browser` CLI（用户级单例 daemon 驱动）成为唯一外部前端，MCP shell 整体移除，`@modelcontextprotocol/sdk` 下线；Pi-native `index.ts` 不变且验证通过（注册 22 工具、零 mcp 依赖），live `npm run smoke:cli` 端到端通过。执行合同：`docs/cli-skill-frontend-migration-plan.md`；CLI 文档：`docs/cli.md`。
- **ABML 内核解耦已完成**：纯核模块 + `index.ts` barrel 物理分层到 `src/abml-core/`（零浏览器/Node 依赖），运行时留 `src/abml/`，边界 CI 锁定（`check:abml-core-boundary`）。清单见 `docs/abml-kernel-manifest.md`；workspace 包提升为可选延后项。
- ABML 执行落地已收口为 internal substrate；公开 ABML tool surface RFC 继续 deferred。历史执行合同保留在 `docs/abml-execution-plan.md`，但不再是当前执行队列。
- MCP 标准化 + 渐进式披露 Phase -1 -> Phase 10 已完成，并随 MCP shell 移除归档为历史（`docs/mcp-standardization-progressive-disclosure-plan.md`，HISTORICAL，非当前行为）。
- Web Security affordance / validation / recovery、MV3 runtime state recovery、bridge runtime hardening、工具面治理与工程化收口均已归档，不再作为当前 active queue。

## Next backlog

R1/R2/R3/R3.x 与 ABML 机制臂 M1/M2a/M2b/M2c 均已完成。其余后续候选（iframe AX aggregation、incognito/profile isolation、public surface 等）继续只作为 `ROADMAP.md` 与 RFC/eval 规划。

## 后续路线

- future-facing 能力方向继续放在 `ROADMAP.md` 与对应 RFC/eval 文档中。
- 若后续重新打开 ABML public surface、debugger workflow、incognito/profile isolation 等方向，必须另开新的执行合同，不得搭车既有主线。
