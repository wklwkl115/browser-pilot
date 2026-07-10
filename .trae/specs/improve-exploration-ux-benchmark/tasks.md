# Tasks

- [x] Task 1: 盘点 network、artifact、latency 与 benchmark 现状
  - [x] SubTask 1.1: 调研现有 network start/read/stop、reload/navigation、wait 和 artifact 保存路径，确认最小 capture reload 接入点。
  - [x] SubTask 1.2: 调研现有 `browser_artifact`、result `artifact_hints`、saved artifact shape 和 CLI metadata/help，确认 inspect/paths 最小命令形态。
  - [x] SubTask 1.3: 调研 bridge/client/command 层已有 timing 或 diagnostics 字段，确认可安全暴露的 latency telemetry。
  - [x] SubTask 1.4: 调研现有 observe regression benchmark case 格式，挑选适合本轮扩样的离线 page archetypes。

  Task 1 盘点结论：
  - Network：`browser_network` 目前是通用 native action 包装，公开 `start | stop | status | clear | list | get | body | exportHar | wait`，实现经 `defineNativeActionCommand` 进入 bridge；`network.start` 在扩展侧启用 `Network`/`Page` CDP domain 并订阅事件，`network.stop` 可保留或清空 buffer，`network.list/get/body/exportHar/wait` 读取 recorder 内存数据。`browser_wait` 已有 `navigate | navigateAndWait | navigation | loadState | networkIdle | selector | any | all | cancel | diagnose`，因此最小 capture reload 接入点应在 command 层编排 `network.start` → `wait.navigate` 或 reload 等价 native command → `network.wait` bounded idle/count/response → `network.list`/`network.exportHar`，最后通过现有 result middleware 保存 artifact；低层 start/read/stop 保持不变。当前缺口是没有单一用户入口保证 start-before-reload，也没有 network command 专属的 early-load capture guidance。
  - Artifact：默认保存路径由 `resolveArtifactPath` 解析为 `<cwd>/.browser-pilot/artifacts/<fallbackName>`，network native action fallback 为 `network-result-<timestamp>.json`。`browser_artifact` 现有能力是 `text | json | search | sample`，支持 `jsonPath`、`pick`、bounded multi-artifact search、redaction、missing path 显式结果；还没有 `inspect`/`paths` mode。result middleware 已输出 `artifact_hints`，shape 为 `kind`、`schemaVersion: 1`、`jsonPaths`、`preferredReads`、`saved`，并会过滤 raw artifact 中不存在的 JSON path、避免复制大 payload。CLI render 已根据 `saved.path` 合成常见 readCommands，但目前主要是固定 `data`、`data.content`、`data.actionables`、`data.list_hints` 和 search 命令，尚未复用 `artifact_hints` 生成 inspect/paths 输出。最小命令形态可在 `browser_artifact` 增加 `mode: "inspect" | "paths"` 或等价参数，读取 saved artifact/envelope，输出 kind/schemaVersion、saved path、可存在的 jsonPaths、preferredReads、compact summary 与 path descriptions，不 inline raw 大对象。
  - Latency/timing：command 层已有 `withTrackedOperation` 的 `startedAt/updatedAt`、progress、queueDepth 等操作元数据；native action 完成后记录 temporal profile sample，`BrowserBridgeCommandService` 对写操作队列路径会合并 `diagnostics.temporalProfile.elapsedMs/deadlineMs` 和 queue temporal diagnostics；`BrowserBridgePendingRequests` timeout 详情包含 ack、ackAt、elapsedMs；wait supervisor 也会产出 wait temporal diagnostics。observe 还有 `diagnostics.observeTimings`，result middleware 只在存在 observeTimings 时追加 `serializeMs`。当前缺口是普通成功 bridge/client 往返没有统一 bounded `latency`/`timing` diagnostics；安全暴露字段应限于 total/client/bridge/queue/runtime/serialize 毫秒、deadline、acked 和 bounded counts，不包含 command payload、headers、body、URL query 等敏感数据。
  - Observe benchmark：现有 `tests/memory/observeRegressionBenchmark.test.ts` 的 case 格式为 `{ name, fixture, expect }`；fixture 支持 `entities`、`scanEvidence`、`pageObservation`，通过 `buildCollectionModels` 与 `buildPageObservation` 构造离线 PageObservation；expect 支持 canonical shape、provider telemetry、AX/readability 状态、collection names/evidence、role boundary、markup pollution 等断言。当前已有样本偏 semantic pollution、collection naming、AX/readability/provider diagnostics、role boundary；本轮扩样应优先加入 docs/article-like、dashboard/table/form、virtualized list、iframe/shadow DOM 离线模型。GitHub-like repo/PR fixture 可作为可选扩展；若成本超出本轮，应记录暂缓并留后续扩展点。

- [x] Task 2: 实现 network capture reload UX
  - [x] SubTask 2.1: 设计并实现最小用户入口，例如 network capture/reload flag 或等价 command 参数，保持现有 low-level start/read/stop 可用。
  - [x] SubTask 2.2: 确保 capture 在 reload/navigation 前启动，并在 bounded wait 后返回 summary 与 saved artifact path。
  - [x] SubTask 2.3: 增加 timing/recovery guidance，提示用户如何捕获早期 page-load 请求。
  - [x] SubTask 2.4: 增加 focused tests，覆盖 start-before-reload 顺序、summary shape、artifact path 和失败恢复。

- [x] Task 3: 实现 artifact inspect / paths 命令
  - [x] SubTask 3.1: 在现有 artifact command 或 CLI 层增加 inspect/paths 能力，优先复用 `artifact_hints` 与 saved artifact metadata。
  - [x] SubTask 3.2: 输出 kind/schemaVersion、saved path、jsonPaths、preferredReads、compact summary 和 path descriptions。
  - [x] SubTask 3.3: 避免 inline 大型 raw payload，并对不存在路径进行过滤或标注不可用。
  - [x] SubTask 3.4: 增加 focused tests，覆盖 observe/crawl/execute artifact paths 与 malformed/missing artifact recovery。

- [x] Task 4: 增加 bridge latency telemetry 与最小 batch UX
  - [x] SubTask 4.1: 在可用层级记录 bounded total/bridge/client/runtime timing，不记录敏感 payload。
  - [x] SubTask 4.2: 将 timing 以 diagnostics/telemetry 形式加入相关结果或 summary，保持向后兼容。
  - [x] SubTask 4.3: 为 network capture reload flow 提供 one-shot batch/compound 执行路径，减少手动 round-trip。
  - [x] SubTask 4.4: 增加 focused tests，覆盖 telemetry shape、字段 bounding、batch 顺序和 observe sensing-only 边界不变。

- [x] Task 5: 扩展 observe regression benchmark 样本
  - [x] SubTask 5.1: 增加 docs/article-like fixture，保护 heading/outline/content hint 与 semantic name 稳定性。
  - [x] SubTask 5.2: 增加 dashboard/table/form fixture，保护 collections/actionables/control relations 与 container names。
  - [x] SubTask 5.3: 增加 virtualized list fixture，保护 sample/evidence、row/item hints 与 bounded output。
  - [x] SubTask 5.4: 增加 iframe/shadow DOM fixture 或等价离线模型，保护跨域/不可访问状态表达和不越权读取。
  - [x] SubTask 5.5: 如成本允许，增加 GitHub-like repo/PR fixture；否则记录暂缓原因和后续扩展点。

  Task 5 完成记录：`tests/memory/observeRegressionBenchmark.test.ts` 已新增 docs/article-like、dashboard table/form、virtualized list、iframe/shadow DOM 和 GitHub-like PR/files 离线 fixture。新增断言覆盖 outline/content preview、actionable semantic names/roles、collection properties、relation text、virtual-window continuation、cross-origin iframe 不读取私有内容，以及 canonical PageObservation/provider telemetry 兼容路径；benchmark 仍只使用离线 fixture 与纯逻辑构造，不依赖真实浏览器、extension、network 或外部站点。

- [x] Task 6: 同步文档/help 和治理检查
  - [x] SubTask 6.1: 更新 README/CODE_WIKI 或 CLI help，说明 network capture reload 推荐流程、artifact inspect/paths、latency telemetry 和 benchmark 扩样维护方式。
  - [x] SubTask 6.2: 增加或更新 governance tests，防止文档继续只推荐易漏早期请求的手动 network flow。
  - [x] SubTask 6.3: 确保 artifact path guidance 不推荐不存在 JSON 路径。

- [x] Task 7: 运行验证门禁并修复失败
  - [x] SubTask 7.1: 运行 network/artifact/latency/benchmark focused tests。
  - [x] SubTask 7.2: 运行 `mise run affected`。
  - [x] SubTask 7.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 7.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 1。
- Task 4 depends on Task 1 and should align with Task 2。
- Task 5 depends on Task 1 but can run in parallel with Task 2-4。
- Task 6 depends on Task 2-5。
- Task 7 depends on Task 2-6。
