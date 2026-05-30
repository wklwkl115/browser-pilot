# ROADMAP

> 后续路线与下一步建议。当前状态见 `CURRENT.md`；历史完成项见 `ARCHIVE.md`。

## 当前状态

1. TODO 244-249 已完成：`browser_observe`、`browser_command`、recovery hints、bounded artifact multi-search、tool-level progress、explicit snapshots/operation metadata、Web Security capability profiles 均已落地并通过本地合同检查。
2. TODO 243 已完成 Debugger evidence workflow RFC/eval 收口：Debugger 仍作为问题域，默认由 `browser_command`、`persistent_cdp`、`browser_frame`、`browser_artifact` 承载；不新增公开 `browser_debugger`。
3. TODO 242 已完成 `browser_scan` high-entropy summary v2。该成果已完整迁移到 `browser_observe mode:"scan"`，保留 Scan Manifest v2、`artifact_hints`、legacy actionables/list hints。
4. TODO 241 已完成 jshookmcp 能力原生吸收闭环，闭环账本见 `docs/jshookmcp-native-absorption.md`。后续 `browser_sources`、`browser_debugger`、`browser_intercept`、`browser_storage`、`browser_canvas` 仍默认拒绝，必须另开 RFC 并证明现有 canonical tools 不足。
5. TODO 250-256 首版已落地：已拆分 check/build 副作用、建立 `node:test` unit test 基础设施并接入 `npm run check`、service worker entry 试开 tree-shaking、收口 browser cookie binding 文案、将 build-manifest 模块清单改为 metadata-only 命名、补充 hook dispatcher 多文件注入评估文档，并新增 `.github/workflows/check.yml` 作为外部 CI merge gate。
6. TODO 257-261 已完成：维护入口图、protocol 单源剩余消费收口、mature bridge 预检诊断与 unit test 扩面已落地；后续新增重大能力仍需先补 `CURRENT.md` 决策与 contracts，不再把 launcher/缺 target/缺模板选择的 bridge 失败留到晚期执行阶段。
7. `browser_hook` 后续只能增加显式 hook targets 或静态 target 展开；禁止策略型 preset 名称与黑盒判断。
8. TODO 240 已撤回 `browser_orchestrate` / orchestration coordinator / target resolver 工具面；operation metadata 只能做诊断，不能复活旧 Desired State/Logical Target 默认入口。
9. Incognito/profile 隔离不在当前主干路线内；如需要，另开独立能力设计，不挂到默认浏览器会话入口。
10. Workstream E 后续如要执行真实 ACI eval，按 `evals/browser-workflows/future-runner.md` 另开 opt-in runner/fixture server：ephemeral port、local-only、无默认浏览器启动、无 scanner/OAST、结果写入 manual result schema。
11. 发布/合并前继续复跑 `npm run quality:local`；需要 runtime 证据时复跑 `npm run smoke:browser:isolated`、`npm run smoke:browser:scan-summary`、`npm run smoke:browser:debugger-evidence` 或 `npm run release:local:smoke`。当前 `smoke:browser:scan-summary` 已用于验证 `browser_observe mode=scan`。
12. `cross-tool evidence correlation metadata` 已完成：不扩公开工具面，已把 `operationId / snapshotId / requestId / waitId / listenerId / sessionId / selectionVersion / sourceMode` 统一上浮到 distilled envelope，并把 artifact-side correlation jsonPath 导航、workflow eval、sample result 与 `smoke:browser:correlation-chain` runtime smoke 一并补齐。
13. 当前 active queue 是 MV3 runtime state recovery，执行合同见 `docs/mv3-runtime-state-recovery-plan.md`；先做 state store、restart fixtures、network/intercept recoverer，再推进 hook/ws/CDP 诊断硬化与 network/intercept artifact 增量证据。
14. 下阶段已冻结的新能力方向见 `docs/next-phase-web-reversing-and-security-primitives-plan.md`：
   - 请求/响应拦截与热补丁原语（phase 1/2 已完成，执行合同：`docs/request-response-interception-and-hotpatch-plan.md`）
   - JS AST / 反混淆分析原语（phase 1 已完成，执行合同：`docs/js-ast-and-deobfuscation-primitives-plan.md`）
   - DOM 事件链 / sink-flow 分析辅助（phase 1 已完成，执行合同：`docs/dom-event-chain-and-sink-flow-plan.md`）
   - Wasm 逆向桥接（phase 1 已完成，执行合同：`docs/wasm-reversing-bridge-plan.md`）
   - Stateful WebSocket replay/fuzz primitives（phase 1 已完成，执行合同：`docs/stateful-websocket-replay-and-fuzz-plan.md`）
   新能力继续保持 RFC/eval-first；在 MV3 runtime state recovery 收口前，不建议开启新的 runtime/debug/trace 主线。

## 历史 TODO 复核结论

当前仓库中未发现“忘记收口但仍标记为进行中”的历史 TODO 主线。剩余项主要分为两类：

1. **明确保持 RFC-only / future-facing 的设计题**
   - Debugger workflow 更强能力：page-authored provenance、pause/breakpoint/step lifecycle
   - hook dispatcher 多文件注入评估
   - 更细粒度的 protocol metadata 继续向更多 internal-only helper 收口（公开 tool/command 名称保持不变）
   - real ACI eval runner
   - Incognito/profile isolation

2. **明确不作为当前主线的可选项**
   - popup/HUD 后续演进
   - 更高层 orchestration/tooling 回归（当前已撤回）

这些不是“遗漏未完成 bug”，而是**明确延后或保持未激活**的 future work；需要新需求时再开新 TODO/RFC，不建议重新塞回当前执行队列。历史压缩后的阶段归档见：`docs/archive/bridge-esm-history.md`、`docs/archive/governance-history.md`、`docs/archive/orchestration-history.md`、`docs/archive/tmwd-cdp-bridge-legacy.md`；逐条详档见对应 `*.full.md` 文件。
