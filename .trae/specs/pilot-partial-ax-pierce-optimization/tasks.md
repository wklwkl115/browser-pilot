# Tasks

- [x] Task 1: 调研 `Accessibility.getPartialAXTree` 与现有 pierce/read 接入点
  - [x] SubTask 1.1: 检查 CDP `Accessibility.getPartialAXTree` 参数、返回形态、browser compatibility、timeout/error 行为与 `fetchRelatives` 成本。
  - [x] SubTask 1.2: 梳理当前 full AX 读取、geometry fallback、bootstrap backendNodeId、pierce runtime 与 diagnostics 接入点。
  - [x] SubTask 1.3: 选择最小触发场景：backendNodeId 已知的 local pierce/read refinement 或 action-adjacent enrichment；默认 no-mode observe 不改为 partial AX。
  - [x] SubTask 1.4: 记录方案、预算、fallback 和风险。
  - 调研结论：CDP `Accessibility.getPartialAXTree` 是 experimental 方法，输入可用 `nodeId`、`backendNodeId` 或 `objectId`，`fetchRelatives` 默认 true，返回目标 AXNode 以及按策略扩展的 ancestors/siblings/children；unsupported/error/timeout/empty 都应 fail-closed。现有 canonical read 路径仍由 full AX + DOMSnapshot + scan merge 负责页面级结构；pierce 当前也调用 full AX 并按目标点过滤。最小方案是在 browser runtime 层先实现 bounded partial AX helper，仅在 descriptor/ref 已有可靠 `backendNodeId` 的 local pierce/read refinement 或 action-adjacent enrichment 中尝试，默认 `fetchRelatives:false` 或小范围相对扩展、短 timeout、max node count 截断；失败时回落现有 full AX 或 scan-only，不改变 no-mode observe，不向 kernel 泄漏 CDP 类型，也不创建 scope 外 page-wide AX-only entities。

- [x] Task 2: 实现 bounded partial AX helper
  - [x] SubTask 2.1: 在 browser runtime 层新增或抽取 partial AX helper，使用 CDP 调用 `Accessibility.getPartialAXTree`，不进入 `src/kernels/*`。
  - [x] SubTask 2.2: 支持 backendNodeId/resolved target 输入、timeout、max node count、fetchRelatives policy 和 fail-closed fallback。
  - [x] SubTask 2.3: 将 partial AX 结果规范化为 kernel 可消费的 plain AX-like data，不泄漏 CDP/browser runtime 类型到 kernel。
  - [x] SubTask 2.4: 对 unsupported/error/timeout/empty/over-budget 结果返回 skipped/failed/degraded diagnostics。

- [x] Task 3: 接入 local pierce/read refinement 边界
  - [x] SubTask 3.1: 在最小 local pierce/read 路径中接入 partial AX enrichment，仅针对请求的 target/ref scope。
  - [x] SubTask 3.2: 保持 canonical no-mode observe 的 full AX fusion 默认路径不被替换。
  - [x] SubTask 3.3: 确保 partial AX 不创建请求 scope 外的 page-wide AX-only entities。
  - [x] SubTask 3.4: 保留 scan-backed selector/ref/actionability/evidence 执行权威。

- [x] Task 4: 增加测试与 benchmark 保护
  - [x] SubTask 4.1: 增加 focused tests，覆盖 partial AX 成功 enrichment。
  - [x] SubTask 4.2: 增加 focused tests，覆盖 unsupported/error/timeout/empty fallback。
  - [x] SubTask 4.3: 增加 focused tests，覆盖 max node count/budget truncation 和 degraded diagnostics。
  - [x] SubTask 4.4: 增加或更新 regression benchmark/fixture，确保 partial AX 不污染 canonical page-wide structural output；若不纳入 benchmark，记录原因。

- [x] Task 5: 同步文档和长期优化记录
  - [x] SubTask 5.1: 更新 `CODE_WIKI.md`，说明 full AX vs partial AX 的职责、触发条件、diagnostics 和 kernel/runtime boundary。
  - [x] SubTask 5.2: 更新 `.trae/notes/abml-observe-long-term-optimization.md`，将 P2 `getPartialAXTree` 关注项记录为已评估/试点，并写明后续关注项。
  - [x] SubTask 5.3: 如新增 diagnostics 字段或 artifact shape，更新相关 owner 文档或测试说明。

- [x] Task 6: 运行验证门禁
  - [x] SubTask 6.1: 运行新增/相关 AX/pierce focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 2-3。
- Task 5 depends on Task 1-4 的实际结论。
- Task 6 depends on Task 1-5。
