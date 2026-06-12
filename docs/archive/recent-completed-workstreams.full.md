# Recent Completed Workstreams

> Detailed historical stream migrated out of `ARCHIVE.md` to keep the archive
> entry page compact. Current state belongs in `CURRENT.md`; future/non-active
> routes belong in `ROADMAP.md`.

## CURRENT Migration Snapshot — 2026-06-12

The following completed-entry details were migrated out of `CURRENT.md` during
the agent-dev-harness C2 ceiling work. `CURRENT.md` now keeps only current state,
the active execution contract, and a compact archive pointer.

- **Agent dev-harness optimization plan**: completed and implemented
  `docs/agent-dev-harness-optimization-plan.md` as the development harness
  blueprint and execution record: fail-closed impact map, DAG closing gate,
  unit shards, docs sync managed blocks, generated code/concept maps,
  C4/C5 authoring helpers, five ledger `--propose` flows, and audit lifecycle
  indexing. The workstream is closed; `CURRENT.md` now has no active execution
  item.
- **Agent harness optimization plan**: completed ACI-1 through ACI-12 for the
  agent-facing harness: heartbeat byte bounds, recovery coverage, lease
  diagnostics, input-surface ratchet, fresh observe re-anchor, CLI-skill drift
  gates, usage-log distillation, build-skew surfacing, observe runner
  decomposition, CLI thinning, and file ceilings. Runtime artifact evidence was
  recorded under `.pi/browser-artifacts/`.
- **Living tab session architecture full closure**: completed
  `docs/living-tab-session-architecture-plan.md` S0-S3 under the 2026-06-13
  active contract. Landed stable `tabHandle` / `targetRef` identity,
  replacement/activation/lineage events, unambiguous numeric-id auto-follow,
  lease/queue/perception migration, connection readiness diagnostics, observe
  timing/fused fingerprint, AX DOMSnapshot geometry join, dirty-root standing
  perception with `PI_BROWSER_STANDING_PERCEPTION`, objective-substrate ledger
  metadata, stale-act execution feedback, and wait selector subscription
  contracts. Viewport-first/fused-template/speculative/channel experiments were
  closed by evidence without changing the public tool surface. Final evidence
  includes fixture workflow eval 28/28 and a fresh blind real-site linux.do run
  that completed the top-5-topic task via natural `wait selector`, `observe
  scan`, and saved `data.rows`; its residual stage disconnect was recorded as
  n=1 `LTS1` rather than promoted to a fix.
- **Check acceleration implementation**: completed graph-backed trace, DAG,
  cache, smart selection, miss recording, and workflow documentation while
  preserving `npm run check` as the final gate. The later dev-harness A4 work
  upgrades the cache to v2 per-node scopes.
- **Governance mechanisms implementation**: completed G1-G7 governance gates or
  operator procedures: spec truth, surface liveness, compute-once, purity
  vocabulary, kernel test map, env flags, and read-only audit escalation.
- **Value-ordered compaction**: moved model-facing presentation toward
  distill-core value-ordered projection while keeping full-fidelity artifacts
  local; added folded projection disclosure, frontier retrieval, and execute
  target URL correction.
- **Distill kernel hygiene**: locked distill-core purity, total allocation tie
  order, observe render-cache keying, scan entity build-once reuse, and
  result-middleware nextAction reuse.
- **Real-session friction plan**: consumed live session friction with scan SVG
  class normalization, artifact empty-array/nearest-path behavior, execute
  partial-effect honesty, content fingerprint fallback, and wrapper-control
  display labels.
- **Check acceleration plan (planning artifact)**: completed the reviewed design
  for trace/DAG/cache/smart acceleration before its implementation workstream.
- **G12 execute page-context nudge**: `browser_execute` summaries now surface a
  page URL from effect/monitor data when available so memory auto-surface can
  resolve page context without extra browser reads.
- **Agent audit inbox workflow**: added `agent-audits/` and
  `skills/pi-browser-audit-fix/SKILL.md` as the asynchronous audit-only/fix-agent
  role contract.
- **Memory kernel**: completed retain-kernel read/write split, profile
  persistence, IDF recall, structural-anchor verification, memory-plane
  injection, stale suppression, and memory gates.
- **Execution feedback layer**: completed cheap default execution-effect facts,
  physical input through coordinate-addressed `input.*`, internal `pi.*` stdlib,
  and execution journal artifacts without adding public semantic action verbs.
- **browser_observe mode-friction reduction**: kept explicit mode semantics but
  added deterministic mode inference from parameters, `intent` as a top-level
  signal, URL navigation support, and mode inference diagnostics.
- **Debt zeroing / debt clearance**: closed trigger-gated backlog into either
  deterministic implementation or closed decisions; landed scan rows,
  media candidates, edge-utility ranking, external SQLi wordlists, recovery
  ratchets, and ROADMAP honesty.
- **capture-core + fact allocator closure**: moved page-world template logic to
  `capture-src/` plus generated bundles, locked capture boundaries, and wired
  production fact allocator diagnostics into result details.
- **Task-conditioned salience v3**: added relevance pure core, tuning, taps,
  observe lookup consumption, inference/trace/intent sources, and no-signal
  neutrality.
- **ABML kernel optimization / identity plane / renderer default flip**: landed
  pure-kernel point fixes, identity graph artifact data, and staged salience plus
  session-delta defaults with rollback env controls.
- **Perception renderer + distill-core token economy**: established the
  distill-core kernel, salience renderer, artifact plan seam, fact allocator,
  recovery concentration, and distill/recovery/summary boundaries.
- **Performance and overhead execution**: completed the performance audit action
  line including bridge whitespace minify, scan/ABML reuse, redaction and CLI
  optimizations, readiness waits, artifact read dedupe, and compact tab list.
- **Agent-facing CLI connection control**: added `pi-browser connect/status`
  readiness protocol, compact health envelopes, user-local start lock, and CLI
  smoke coverage.
- **Agent-native CLI / durable bridge / skill split**: completed CLI product
  surface, offscreen durable transport, Pi-native vs CLI skill separation, and
  kept only `pi-browser-tools` in the Pi global skill junction.

## Agent-Native And CLI Surface

- Performance & overhead audit execution（2026-06-08）：完成全项目性能/开销审计与执行收口。已落地 bridge dist whitespace minify、AX box-model 并发、scan/ABML 复用、redaction first-hit、CLI render/registry/entrypoint 优化、TypeBox-compatible validation、daemon protocol-only compatibility、offscreen port probe、resource/ref store cap、scan summary budget 预计算、CJK budget guard、serialize-once safe subset、readiness event wait/negative cache、artifact read 去重、CLI-only details 省略、artifact read 建议去重、`browser_tabs list` compact+top-level bridge，以及 blind-eval 取证后的 scan `focus` entity refs-v1。关闭 2.1 single geometry pass、0.3 cheap recorder state、1.1 非默认 scan superset、1.7 stream signal ref reuse、2.2 默认等待缩短等无足够证据项。最终验证通过 `npm run check`；完成记录见 `docs/performance-overhead-audit.md`。
- Agent-facing CLI connection control protocol（2026-06-08）：完成 agent 主动连接/状态协议。新增 `pi-browser connect --json` / `connect --wait --timeout-ms ... --json` 与只读 `pi-browser status --json`；默认紧凑返回 `tabCount`/`activeTab`，`--tabs` 才展开完整 tabs；透出 `lastPingAt`、`lastPongAt`、`connectedForMs`、`tabSyncAgeMs` 等健康字段；daemon 冷启动加 user-local start lock；普通工具命令保留 auto-start 兼容，复杂任务 SOP 改为先 `connect`。验证覆盖 CLI unit/contract、isolated runtime smoke、`smoke:cli:full` 和最终 `npm run check`；完成记录见 `docs/archive/agent-cli-connection-control-plan.full.md`。
- Agent-native CLI 产品化（2026-06-08）：完成标准 agent CLI 外部面。`commands/schema --json` 暴露 `agentCli` + `artifactBehavior`；`wait/network/frame/hook` 高频动作有 natural routes；legacy `--action/--params` 保留为 advanced compatibility，`command --command @file` 保留为 native escape hatch；JSON envelope、doctor/selftest、文件化大输入、artifact follow-up、stale tab/snapshot/artifact/browser-result/ref recovery、npm wrapper JSON 边界和 frame/hook blind route-adoption 证据均已收口。验证通过 `npm run check`、`npm run smoke:cli` 与 skill validation。
- Agent-native 统一架构 Workstream A（2026-06-07）：合并原 CLI 优化线与内部架构线。`register*Tool` TypeBox schema 成为 Pi-native/CLI 单一契约源；移除 capability profile，22 工具 always-on；机械参数从公开 schema/CLI help 隐藏并通过 `prepareArguments` 兼容旧调用；summary/ref/resource 副作用边界、脱敏与 artifact raw pointer 由 contracts 锁定。权威设计见 `docs/agent-native-architecture.md`，外部面见 `docs/agent-native-cli-spec.md`。
- 盲 agent eval 机制（2026-06-06，2026-06-08 扩展 CLI route-adoption）：确定性 runner 负责本地 fixture 回归；blind real-agent layer 由 `pi-browser-blind-eval` skill 操作，隔离 `PI_BROWSER_DAEMON_STATE_DIR` + 18801+ 端口，真实站点只读执行，产出 command-log 与 `fixable|WAI|reliability` 三分类。wait/network/frame/hook natural route adoption 已纳入 prompt/triage，并反向驱动 schema discovery 与 hook targets ergonomics 修复。

## Bridge Runtime And Governance

- B5 durable connection reliability（2026-06-08）：完成 offscreen transport 迁移。真实 WebSocket 生命周期从 MV3 service worker 移到 `offscreen.html` / `dist/offscreen.js`；service worker 保留 offscreen lifecycle、command router、startup recovery、tab sync 与 socket adapter fan-out；移除 SW 5s keepalive interval。manifest/build/package/contracts/docs 已同步，边界保持不新增公开 `browser_*` 工具、不改 native WS wire protocol。验证通过 `npm run build:bridge`、`npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`、`npm run check`。
- 241：完成 jshookmcp 能力原生吸收闭环。边界冻结为“只吸收功能思想和证据模型，不新增被拒绝的五个公开工具面”；交付 5 个 synthetic eval、fixtures、closure ledger、`browser_hook listTargets/installTargets`、contracts、全量 `npm run check`。
- 242：完成 `browser_scan` high-entropy summary v2。默认 summary 升级为 Scan Manifest，新增 `focus.primary_actions/forms/lists/text_signals` 与 `artifact_hints` 精确 jsonPath 导航，保留 artifact-first 和 legacy `actionables/list_hints` 紧凑字段；新增 `16-scan-high-entropy-summary` eval、fixture、contracts、`smoke:browser:scan-summary` runtime smoke。
- 243：完成 Debugger evidence workflow 的 RFC/eval 收口。`browser_execute` + `persistent_cdp` 已能稳定提供 debugger evidence；剩余缺口收缩为 page-authored provenance 与 pause/breakpoint/step 生命周期，继续保持 RFC-only，不新增公开调试工具。
- 244-249：完成工具面治理收口：`browser_observe` 成为观察层 canonical surface；`browser_execute`/`browser_command` 拆分；recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata 与 Web Security exposure-boundary 决议落地，并通过本地 contracts 与文档同步门禁。后续 agent-native B1 已移除 capability profile，当前 22 工具 always-on。
- 250-256：完成 build/test/doc 工程治理首版收口：`verify:bridge:dist` 取代 `check` 隐式重建；新增 `test:unit`（Node `node:test`）并接入 `npm run check`；service worker entry 试开 tree-shaking；browser cookie binding 文案统一改为“HTTP request header injection”；build-manifest 模块清单改为 metadata-only 命名；补充 `docs/hook-dispatcher-multi-file-evaluation.md`；新增 `.github/workflows/check.yml` 作为外部 CI merge gate；package 边界继续以 `npm pack --dry-run --json` 验证。
- 257-261：完成维护入口图、protocol 单源剩余消费收口、纯逻辑 unit test 扩面、mature bridge 结构化预检诊断和顶层文档去重：新增 `docs/maintainer-map.md`；`bridge/native_command_schema.json` 与 generated protocol/runtime/docs 增加 mature bridge 错误码与 metadata helper；`src/tools/webSecurity/shared/matureBridge.ts` 收口 sqlmap/nuclei launcher probe/process timeout/failure record；`browser_sqlmap_bridge` / `browser_nuclei_bridge` 前移 target/template/launcher 失败；README/contracts/unit tests 全部同步，并通过 `npm run sync:protocol`、`npm run docs:generate`、`npm run test:unit`、`npm run check:web-security`、`npm run check`。
- 工具层参数契约执行合同：新增 `strictToolParameters()`、`enumParam()`、`enumOrEnumArrayParam()`，把主 tool surface 与 WebSecurity register 主链的顶层参数对象收口到 `additionalProperties:false`；新增框架行为夹具并将多处 WebSecurity 参数收口为显式枚举。验证通过 `npm run check:tool-parameter-framework-validation`、`npm run check:tool-parameter-contract`、`npm run check`、`npm run quality:local`。
- ESLint 遗留债务 ratchet 执行合同：将执行前 `0 errors / 172 warnings / 56 files` 基线清零到 `npm run lint` 的 `0 errors / 0 warnings`；合同内规则族从 `warn` 收紧为 `error`，CI 与 lefthook 同步。验证通过 `npm run lint`、`npm run check:all:bridge`、`npm run check:web-security`、`npm run test:unit`、`npm run check`、`npm run quality:local`。
- 工程债修复批次：Driver 端新增 WS JSON/handler 错误日志、heartbeat/stale client 清理、pending stop 全拒绝、queue depth 上限与 `QUEUE_FULL`、snapshot TTL prune；Bridge 端 CSP bypass 改为 tab-scoped TTL、WS listener 全路径 cleanup；工具层统一错误/枚举/trigger timeout 语义。验证：`npm run build:bridge`、`npm run check:all:bridge`、`npm run check:all:package`、`npm run check:all:contracts`、`npm run test:coverage`、global skill quick_validate。
- 第二轮深度缺陷修复批次：完成 callback OAST `sessionId` 安全 slug、动态 HTTPS 证书生成、stale-lock token 校验、`maxRuntimeMs` 生命周期上限；WebSecurity target/wordlist/launcher 安全收口；MV3 restart 轻量 runtime-state 诊断；阻断 unsafe navigation；新增有界 case/candidate 累积与 summary hard-cap。验证：`npm run check`、`npm run test:coverage`、`npm run smoke:browser:isolated`、skill quick validate。
- 近期状态整理：完成 CURRENT/TODO 统一核查与收口。MCP Phase 10、MV3 runtime state recovery、Web Security affordance、bridge runtime hardening 等已完成项从“当前”口径移出；随后继续完成剩余延后债的收窄批次。当前无新的工程债 active queue。

## Observation, Evidence, And Web/Security Primitives

- Cross-tool evidence correlation metadata：distilled envelope、artifact summary、workflow eval、sample result 与 runtime smoke 全部补齐，统一暴露 `operationId`、`snapshotId`、`requestId`、`waitId`、`listenerId`、`sessionId`、`selectionVersion*`、`sourceMode`；新增 `21-cross-tool-correlation-chain` eval 与 `smoke:browser:correlation-chain`。
- 请求/响应拦截与热补丁原语 phase 1：接入 `intercept.install` / `uninstall` / `status` / `listRules` / `addRule` / `removeRule` / `collect` / `pause` / `continue` / `fail` / `fulfill`，并完成手工 fulfill、自动 fulfill、`replaceScript` 与 uninstall fail-closed 的真实浏览器 smoke。
- 请求/响应拦截与热补丁原语 phase 2：`intercept.continue` / auto-`continue` 支持有界 request mutation 与 `mutationSummary`；`intercept.install` 支持 `stages`；driver 把 interception 写命令纳入 lease/queue；真实浏览器 smoke 验证 request-mutate、tab-close-cleanup、lease-conflict。
- JS AST / 反混淆分析原语 phase 1：落 internal-only parse/summary/reduction helpers、compact summary adapter、internal slash-command path，并通过 local fixtures 覆盖 imports/exports/function inventory、可疑模式摘要、string-array/decoder/constant folding、alias propagation、object-dispatch readability reduction、artifact output convention 与 eval/sample-result。
- DOM 事件链 / sink-flow 分析辅助 phase 1：在既有 `browser_hook` canonical surface 下落 internal/native actions `getNodeListeners`、`getListenerChain`、`getSinkHints`；补 selector-scoped listener/source/sink evidence、compact summary adapter、本地 fixture、eval spec 与 sample result。
- Wasm 逆向桥接 phase 1：落 Wasm metadata helpers、mature-bridge-first `.wat` helper、compact summary adapters、internal slash-command path，并通过本地 fixtures 覆盖 Wasm header/version/hash/section/import/export counts、launcher-unavailable diagnostics、`.wat` bridge artifact path、eval/sample-result。
- Stateful WebSocket replay/fuzz primitives phase 1：落 tab-scoped session/transcript model、internal/native `ws.open/status/send/replay/wait/collect/close`、Node-side explicit helper/shell、compact summary adapter、internal slash-command path，并补 bounded replay、failure diagnostics、partial transcript artifact、eval/sample-result 以及真实浏览器 smoke。
