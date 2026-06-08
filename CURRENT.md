# CURRENT

## 当前状态

- 当前 shipping 外部前端是 **Pi-native entry (`index.ts`) + `pi-browser` CLI (`cli/`)**；MCP shell 已移除（CLI 用法见 `docs/cli.md`）。
- 文档结构规范：`docs/document-structure.md`；archive 摘要/详档入口由 `npm run docs:sync-indexes` 同步。
- 当前主链路：`browser_tabs list|switch|create` -> 显式 `tabId` -> `browser_observe` -> `browser_execute` / `browser_wait` -> `browser_network` / `browser_evidence` -> `browser_artifact`。
- 当前工具边界：22 个 `browser_*` 工具 always-on；Web Security 是 scoped follow-up 分组，不再有 capability profile / compact mode / discovery mode；不新增公开 `browser_*` 工具，不恢复 orchestration / target resolver。
- ABML 是内部 substrate，不是公开工具面：继续增强 `browser_observe` / `browser_execute monitor` / `browser_frame` / AX/vision/monitor 盲区；公开 ABML verb surface 仍 deferred。
- jshookmcp 原生吸收边界见 `docs/jshookmcp-native-absorption.md`：只吸收能力模型与证据路径，不新增被拒绝的公开工具 `browser_sources` / `browser_debugger` / `browser_intercept` / `browser_storage` / `browser_canvas`。
- 仓库单一源码根：`D:/Pi/agent/extensions/pi-browser-tools` 是唯一正式源码仓库；`.pi/public-export/` 仅作本地导出/归档产物。
- 修改协议/工具后先跑 `npm run check`；局部回归优先 `npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`。

## 当前激活项

暂无。最近两条执行线（Performance & overhead audit execution、Agent-facing CLI connection
control protocol）均已完成并通过最终验证；后续新能力或重大重构必须先在本文件补决策、
边界、契约与验证计划，再另开执行合同。

## 最近完成且仍影响当前规则

### Performance & overhead audit execution

决策：
- `docs/performance-overhead-audit.md` 是已完成的性能/开销优化审计与执行记录。落地顺序按证据和风险分层：先做非 agent-facing contract 的 CPU/latency/byte 优化，再做需 live smoke 的扫描路径优化，最后才评估会改变 agent JSON/token contract 的输出瘦身。
- 已完成当前执行项：bridge dist service-worker/offscreen whitespace minify（保留 symbol names）、AX `DOM.getBoxModel` 并发批处理、observe network/hook seq 并发读取、default scan 的 ABML read 复用首个 `scan_extract` payload、`containsSensitiveEvidence` first-hit predicate、CLI JSON render parse-once、network diagnostics cap、intercept paused cap+overflow continue、`browser_execute` 去掉普通路径 200ms 固定等待、CLI command registry memoize 与实际 bin 顶层 help 轻量动态导入、nested validation 从 zod 迁到 TypeBox-compatible wrapper 并移除 zod 依赖、daemon 版本兼容改为只按 `DAEMON_PROTOCOL_VERSION` 判断、offscreen 端口并发 probe、resource/ref store 容量 cap + amortized prune、scan summary 跨 budget rung 预计算复用并补高熵 byte/shape golden、scan summary 剩余 per-rung loop collapse、CJK budget `String.length` guard、`fitEnvelopeBudget`/`fitSummaryBudget` serialize-once safe subset、extension readiness event-driven wait + no-extension negative cache、artifact text/search/sample 减少重复读、CLI-only success details 省略、CLI artifact read 建议去重、`browser_tabs list` compact+top-level bridge、scan `focus` entity refs-v1 输出瘦身（blind-eval 取证后落地）。
- `DAEMON_PROTOCOL_VERSION` 仍是控制/工具契约变化的强制 bump 点；普通 package version 变化不再自动重启 daemon。

边界：
- Tier 0/Tier 1 的性能优化不得改变公开 `browser_*` 工具名、CLI command surface、默认 JSON envelope 字段含义或 agent SOP。
- Tier 3 token/output shape 优化必须先做 blind eval / transcript 检查，证明 agent 不依赖被裁字段；当前已落地有兼容 guard 的 3.1 artifact 建议去重、3.2 `browser_tabs list` compact，以及 3.3 scan `focus` refs-v1（完整实体仍在 `envelope.entities` / artifacts）。
- full minify / syntax minify 若需要放宽 dist bundle 字符串合同，必须作为单独改动处理；当前只采用 whitespace minify + size budget。

验证：
- 已通过：`npm run build`、`npm run build:bridge`、`npm run verify:bridge:dist`、`npm run check:src:types`、`npm run check:deps`、`npm run check:summaries`、`npm run check:token`、`npm run check:token-economy`、`node tests/contracts/protocol/check-pi-browser-bridge.mjs`、聚焦 validation/redaction/CLI render/daemon-control/driver connection/artifactReader/resourceReader/ref-registry/CLI local 单测/契约；本轮剩余项收口还通过 `npm run check:tool-parameter-contract`、`npm run check:tool-docs`、`npm run check:doc-structure`、`npm run check`；`node dist/cli/bin.js --help` 重建后 median 约 56ms。
- 后续每个新 P0/P1 项至少补一个 guard 或 regression；扫描路径优化需补 live smoke（至少 `smoke:browser:scan-summary`）或 token-economy 对比。当前 audit 中 0.3、1.1 非默认路径、1.7 stream signal ref reuse、2.2 默认等待缩短均已由 eval 证据关闭为 future protocol/contract/eval gate；3.3 已完成 targeted blind eval 并落地 refs-v1。

### Agent-facing CLI connection control protocol

决策：
- 已新增 agent-facing 连接控制面，让 agent 主动执行 readiness gate，而不是被动依赖普通命令触发 `ensureDaemon()` 后再从失败里推断连接状态。
- 推荐入口是 `pi-browser connect --json` / `pi-browser connect --wait --timeout-ms <ms> --json`：幂等启动或复用 user-local singleton daemon，显式启动 bridge，等待扩展连接，返回机器可读 connection envelope。
- 已新增 `pi-browser status --json` 只读 agent 状态面：不启动 daemon/bridge，只报告 daemon lockfile、reachable、bridgeRunning、extensionConnected、tabCount、activeTab、health、staleLockfile、recovery commands；`--tabs` 才展开完整 `tabs[]`。
- `connect` / `status` 默认紧凑，避免多标签页 profile 把完整 tab 列表塞进每次 readiness envelope；已透出 `lastPingAt`、`lastPongAt`、`connectedForMs`、`tabSyncAgeMs` 等健康字段。
- daemon 冷启动已加 user-local start lock，避免两个 agent 同时发现无 daemon 后各自 spawn detached daemon 抢端口。
- 保留 `pi-browser daemon start|stop|status` 作为高级生命周期/诊断面；不把 `daemon stop` 写成常规 agent 收尾步骤。
- 普通工具命令保留 auto-start 兼容行为；agent SOP 改为复杂任务前先 `connect`，后续自然命令直接执行。是否增加 `--no-auto-start` / `PI_BROWSER_REQUIRE_CONNECTED=1` 作为严格手动模式，留作后续 eval 证明确有需要时另开执行合同。

边界：
- 不新增公开 `browser_*` 工具，不恢复 MCP，不改变 Pi-native `index.ts` 工具面。
- 不把策略塞入 CLI；`connect` 只承担 deterministic readiness：daemon reachable、bridge running、extension connected、tab visibility/health visible。
- 不实现 one-shot/direct transport 作为首批目标；它会牺牲跨命令状态。先把 singleton daemon 的连接控制变成 agent 显式协议，后续再用 eval 判断是否需要 `--transport direct`。
- 不泄露 daemon token；stale lockfile 继续只暴露非敏感字段。

已落地契约：
- `connect --json` 输出单一 JSON envelope，包含 `command:"connect"`、`ready`、`startedDaemon`、`startedBridge`、`waitedMs`、`daemon{pid,controlPort,version,expectedVersion,versionStale}`、`bridge{port,running}`、`extension{connected}`、`tabCount`、`activeTab`、`health`、`recovery.commands[]`；显式 `--tabs` 时才包含完整 `tabs[]`。
- `connect --wait` 在 timeout 后仍未连接扩展时返回 parseable error envelope，exit code `3`，code 类似 `CLI_EXTENSION_NOT_CONNECTED`，并给出可执行 recovery commands。
- `status --json` 永远只读、不 auto-start；daemon 不存在时 exit code `0` 且 `ready:false`，除非参数错误。
- `doctor --json` 可继续保留更宽诊断；`status` 面向 agent 快速 loop，`doctor` 面向排障。

验证：
- 完成计划：`docs/agent-cli-connection-control-plan.md`。
- 已补 CLI unit/contract：local `status` 不启动 daemon；`connect` 可启动 daemon/bridge；默认紧凑 status/connect 与 `--tabs` 展开；健康字段透出；start lock 等待并发启动；extension timeout JSON envelope；stale lockfile 不泄 token；ordinary commands 兼容 auto-start。
- 已补 runtime smoke：隔离 `PI_BROWSER_DAEMON_STATE_DIR` + patched extension port，验证 `connection.status.initial -> connection.connect-wait -> connection.status.ready -> tabs list`，agent path 不需要手动 stop；测试 cleanup 仍停止隔离 daemon。
- 已更新 `docs/cli.md`、`skills/pi-browser-tools/SKILL.md`、`CHANGELOG.md`、`TODO.md`；skill validation、focused CLI checks、package/smoke diagnostics、`smoke:cli:full` 和最终 `npm run check` 已通过。

- **Agent-native CLI 产品化主线已完成**：`docs/agent-native-cli-spec.md` 是外部面契约，`docs/agent-native-cli-execution-plan.md` 已完成。`commands/schema --json` 暴露 `agentCli` + `artifactBehavior`；推荐 `standard`/`natural` 路径覆盖 wait/network/frame/hook 高频动作；legacy `--action/--params` 保留为 advanced compatibility；`command --command @file` 保留为 native escape hatch。
- **Agent-native 统一架构 Workstream A 已落地**：`register*Tool` TypeBox schema 是 Pi-native 与 CLI 的单一契约源；机械参数从 schema/CLI help 隐藏并通过 `prepareArguments` 兼容旧调用；summary/ref/resource 副作用边界、脱敏与 artifact raw pointer 由 contracts 锁定。权威设计见 `docs/agent-native-architecture.md`。
- **盲 agent eval 机制已 live 验证**：确定性 runner 负责回归；blind real-agent layer 由 `pi-browser-blind-eval` skill 操作，隔离 `PI_BROWSER_DAEMON_STATE_DIR` + 18801+ 端口，不属于 `npm run check`。发现与三分类记录见 `evals/browser-workflows/blind-findings.md`。
- **B5 durable connection reliability 已完成**：扩展侧 WebSocket 生命周期迁到 offscreen document；native WS wire protocol 与公开工具面不变。验证、历史和后续候选见 `ARCHIVE.md` / `ROADMAP.md`。

## 后续路线

- future-facing 能力方向只放在 `ROADMAP.md` 与对应 RFC/eval 文档中。
- 已完成历史不再写回本文件；压缩摘要见 `ARCHIVE.md`，长详档见 `docs/archive/*.full.md`。
- 若后续重新打开 ABML public surface、debugger workflow、incognito/profile isolation 等方向，必须另开新的执行合同，不得搭车既有主线。
