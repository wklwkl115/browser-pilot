# ARCHIVE

> 历史已完成工作归档。当前执行入口见 `CURRENT.md`；未来路线见 `ROADMAP.md`。

## 最新完成归档（近期主线）

近期主线已压缩到 `docs/archive/recent-completed-workstreams.md`；完整历史流见
`docs/archive/recent-completed-workstreams.full.md`。入口只保留开发者需要的状态：

- Agent-native / CLI / skill / bridge reliability 已完成并成为当前外部面基线。
- Observe / ABML / salience / session-delta / cache-gate / mode-friction 等感知层收口已完成；当前行为以 `CURRENT.md` 和 tool contracts 为准。
- Web/security primitive phase 1 workstreams 已完成为 internal/native primitives 或现有 canonical tools 的增强；不新增被拒绝的公开工具名。
- 工程治理、lint、protocol single-source、tool parameter contract、performance audit、debt-zeroing 均已关闭；未来工作必须重新进入 `CURRENT.md` 执行合同或 `ROADMAP.md` 非激活路线。
- 发布包验证保持在 package gate 中执行；历史归档记录以 `npm pack --dry-run --ignore-scripts --json` 覆盖生成产物与包文件边界。

## 早期编号 TODO 归档

- 1-179 已完成并压缩为阶段摘要/详档：Bridge 基础能力、撤回的历史动作拆分、Web 执行面、Bug report C/H/M/L 批次、桌面审计批次、WebSecurity 拆分、Network recorder 拆分等均已收口。
- 这些编号不是执行队列；需要细节时读下方 `docs/archive/*.md` 摘要与对应 `*.full.md` 详档，不从 `ARCHIVE.md` 展开。

## 历史阶段摘要

- 2026 06 02 Real Session Fixes Verification历史摘要见 `docs/archive/2026-06-02-real-session-fixes-verification.md`
- Bridge ESM / dist runtime历史摘要见 `docs/archive/bridge-esm-history.md`
- Execution Feedback Layer Plan历史摘要见 `docs/archive/execution-feedback-layer-plan.md`
- 本地工程治理期历史摘要见 `docs/archive/governance-history.md`
- Memory Kernel Plan历史摘要见 `docs/archive/memory-kernel-plan.md`
- 已撤回 orchestration / target resolver / profile isolation历史摘要见 `docs/archive/orchestration-history.md`
- Perception Layer Optimization Plan历史摘要见 `docs/archive/perception-layer-optimization-plan.md`
- Protocol Single Source Plan历史摘要见 `docs/archive/protocol-single-source-plan.md`
- Recent Completed Workstreams历史摘要见 `docs/archive/recent-completed-workstreams.md`
- Tmwd Cdp Bridge Legacy历史摘要见 `docs/archive/tmwd-cdp-bridge-legacy.md`
- 更细历史拆分建议与仍保持 future-facing 的非激活项见 `docs/archive-history-compression-plan.md`。

## 详细历史记录已迁出

逐条历史明细已迁到以下文件：

- `docs/archive/2026-06-02-real-session-fixes-verification.full.md`
- `docs/archive/bridge-esm-history.full.md`
- `docs/archive/execution-feedback-layer-plan.full.md`
- `docs/archive/governance-history.full.md`
- `docs/archive/memory-kernel-plan.full.md`
- `docs/archive/orchestration-history.full.md`
- `docs/archive/perception-layer-optimization-plan.full.md`
- `docs/archive/protocol-single-source-plan.full.md`
- `docs/archive/recent-completed-workstreams.full.md`
- `docs/archive/tmwd-cdp-bridge-legacy.full.md`

主 `ARCHIVE.md` 只保留阶段摘要与入口索引，避免继续膨胀。
