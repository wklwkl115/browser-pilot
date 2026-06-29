# Tasks

- [x] Task 1: 调研依赖与扩展构建兼容性
  - [x] SubTask 1.1: 检查 `dom-accessibility-api` package 入口、license、browser compatibility 和 bundle 体积影响。
  - [x] SubTask 1.2: 确认当前 extension scan bundle 构建方式是否能打包该依赖，不引入 Node-only API。
  - [x] SubTask 1.3: 记录接入策略：直接 import、薄 wrapper、或 build-time embed，并选择最小可行方案。

- [x] Task 2: 引入 accessible name provider
  - [x] SubTask 2.1: 添加 `dom-accessibility-api` 依赖并更新 lockfile。
  - [x] SubTask 2.2: 在 browser-side scan 入口中创建 bounded accessible-name wrapper，用于调用 `computeAccessibleName`。
  - [x] SubTask 2.3: 在 `labelOf(el)` 或等价路径中优先使用 safe accessible name，再 fallback 到现有手写逻辑。
  - [x] SubTask 2.4: 将使用范围限制为 actionables、list container candidates、heading/container label candidates。

- [x] Task 3: 保留安全清洗与 fallback 语义
  - [x] SubTask 3.1: 确保 computed accessible name 经过现有 semantic sanitizer / concise label 过滤。
  - [x] SubTask 3.2: 当 computed name 为空、不安全或低价值时，保留现有 aria/title/alt/label/sr-only/nearby text fallback。
  - [x] SubTask 3.3: 确保 editable value、long item/card preview、SVG/path、HTML-like、selector-like 字符串不会通过 computed name 进入 ABML。

- [x] Task 4: 增加测试与 benchmark 覆盖
  - [x] SubTask 4.1: 增加 scan template/build 测试，确认 accessible-name provider 被打包或 wrapper 存在。
  - [x] SubTask 4.2: 增加 labelled-by/icon-only/actionable fixture，验证 safe computed name 优先。
  - [x] SubTask 4.3: 增加 fallback fixture，验证 computed name 为空或不安全时仍使用现有逻辑。
  - [x] SubTask 4.4: 更新 observe regression benchmark，加入 accessible-name behavior 或 fallback safety case。

- [x] Task 5: 构建、实测与性能/体积检查
  - [x] SubTask 5.1: 运行 `npm run build:bridge`，确认 MV3 extension 构建成功。
  - [x] SubTask 5.2: 检查 bridge extension dist 体积变化，记录是否可接受。
  - [x] SubTask 5.3: 在 Edge 当前页面运行 no-mode observe，确认扩展仍能连接并完成 scan。
  - [x] SubTask 5.4: 对 artifact 检查 accessible naming 行为和已有安全指标：无 `<path`/`<svg` 污染、collection names 安全、actionables 未明显退化。

- [x] Task 6: 文档与维护说明同步
  - [x] SubTask 6.1: 如新增依赖或 scan naming pipeline 发生变化，更新 `CODE_WIKI.md` 或相关 owner 文档。
  - [x] SubTask 6.2: 在长期优化记录中标记 P1 已进入试点，并记录后续关注项：bundle size、latency、命名质量。
  - [x] SubTask 6.3: 不新增重复架构文档，遵守现有文档 owner 规则。

- [x] Task 7: 运行验证门禁
  - [x] SubTask 7.1: 运行新增 accessible-name/benchmark focused tests。
  - [x] SubTask 7.2: 运行 `mise run affected`。
  - [x] SubTask 7.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 7.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 2-3。
- Task 5 depends on Task 2-4。
- Task 6 depends on Task 1-5 的实际变更。
- Task 7 depends on Task 1-6。
