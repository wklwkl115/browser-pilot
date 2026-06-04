# ROADMAP

> 后续路线与下一步建议。当前状态见 `CURRENT.md`；历史完成项见 `ARCHIVE.md`。

## 当前非激活路线

1. jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：已完成能力思想和证据模型吸收；后续 `browser_sources`、`browser_debugger`、`browser_intercept`、`browser_storage`、`browser_canvas` 仍默认拒绝，必须另开 RFC 并证明现有 canonical tools 不足。
2. Debugger workflow 更强能力：page-authored provenance、pause/breakpoint/step lifecycle。默认仍由 `browser_command`、`persistent_cdp`、`browser_frame`、`browser_artifact` 承载；不新增公开 `browser_debugger`。
3. `browser_hook` 后续只能增加显式 hook targets 或静态 target 展开；禁止策略型 preset 名称与黑盒判断。
4. Real ACI eval runner 已在并行分支 `feat/browser-workflow-eval-runner` 落地为全量 manifest opt-in runner：`npm run eval:browser-workflows -- --fixture-server`，local-only ephemeral fixture server，默认无浏览器启动副作用，覆盖 eval `01`-`27` 与 `30`。后续路线是增加新 specs 时同步接入 runner；仍禁止 scanner/OAST/external network 默认运行。
5. Incognito/profile isolation 不在当前主干路线内；如需要，另开独立能力设计，不挂到默认浏览器会话入口。
6. 下阶段 Web reversing/security primitives 继续 RFC/eval-first；已完成 phase 1 的项不自动升级 phase 2：
   - 请求/响应拦截与热补丁原语（phase 1/2 已完成）
   - JS AST / 反混淆分析原语（phase 1 已完成）
   - DOM 事件链 / sink-flow 分析辅助（phase 1 已完成）
   - Wasm 逆向桥接（phase 1 已完成）
   - Stateful WebSocket replay/fuzz primitives（phase 1 已完成）
7. 更高层 orchestration/tooling 回归仍保持撤回状态；operation metadata 只能做诊断，不能复活旧 Desired State/Logical Target 默认入口。
8. ABML 公开 tool surface RFC 当前保持 deferred：已有真实 smoke/eval 证据支持 ABML 继续作为 internal substrate（observe/monitor/frame/vision/AX），但尚无 transcript 证据表明 agent 因缺少公开 ABML verbs 而被真实任务卡住。后续 internal substrate 的下一条可执行路线已细化为 `docs/abml-relationship-graph-execution-plan.md`（R1 relationship graph）；未来若重启公开面方向，应优先评估“现有 `browser_*` 的迁移/替换性吸收 RFC”，而不是并排新增一套 verb tools。
9. 词典 / wordlist 治理（非 ABML 主线）：见 `docs/dictionary-and-wordlist-governance-plan.md`。源自 2026-06-04 ABML login 去过拟合衍生的全仓硬编码词典盘点（约 44 处，5 类）。可执行项按 ROI 排序为 W1 安全 payload/签名外部化（最高，`readWordlist` 管道已就位）、W2 ARIA 标准词表构建期 codegen（中，非紧急；纯核禁运行时依赖）、W3 脱敏字段对照 SecLists 校准（低成本一次性）。默认非激活，启动须另开独立执行合同、不搭车 ABML 主线。
10. ABML R3 质量跟进（2026-06-04 `npm run smoke:browser:abml-inference` live 端到端验证暴露，均为既有行为、非新功能；各需另开独立执行合同）：
    - **form-dependency 真实页面脆弱**：动作后第二次 scan 时 `diff.focusedRef` 可能落到 `frame` 实体而非刚填写的可编辑字段，导致 `form-dependency` 不触发。需提升 R3 `focusedRef` 提取/时序稳健性（如归一到最深可聚焦实体，或让 form-dependency 不强依赖 live focus）。
    - **evidence-ref 应能在 `envelope.entities` 内解析**：`envelope.entities` 是 salience 子集；inference 用完整实体集选出的 evidence ref（如 login `submitRef`）可能不在该子集中，agent 拿到 ref 却查不到实体细节，削弱 R2 evidence-anchoring 的"可导航"初衷。需保证被 evidence 引用的实体进入输出子集，或提供 ref→实体的解析路径。

## 近期质量建议

- 发布/合并前继续复跑 `npm run quality:local`。
- 需要 runtime 证据时按需复跑 opt-in smoke/eval：`npm run smoke:browser:isolated`、`npm run smoke:browser:scan-summary`、`npm run smoke:browser:debugger-evidence`、`npm run release:local:smoke`、`npm run eval:browser-workflows -- --fixture-server`。
- 新能力或重大重构先补 `CURRENT.md` 决策、边界、contracts/evals，再改代码。

## 历史复核结论

当前仓库中已清理“完成但仍标记为当前”的主要口径。剩余当前项只在 `CURRENT.md` 中维护；本文件只保留 future-facing 路线，不作为执行队列。

历史压缩后的阶段归档见：`docs/archive/bridge-esm-history.md`、`docs/archive/governance-history.md`、`docs/archive/orchestration-history.md`、`docs/archive/tmwd-cdp-bridge-legacy.md`；逐条详档见对应 `*.full.md` 文件。
