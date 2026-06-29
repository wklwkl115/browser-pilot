# Tasks

- [x] Task 1: 设计 benchmark case 格式与 fixture 位置
  - [x] SubTask 1.1: 调研现有 `tests/`、`scripts/run-tests.mjs` 和 observe/ABML 测试布局，选择最小侵入的 benchmark 文件位置。
  - [x] SubTask 1.2: 定义离线 case 结构，包含名称、fixture 输入、期望指标和断言配置。
  - [x] SubTask 1.3: 确认 benchmark 不依赖真实浏览器、extension、network 或外部站点。

- [x] Task 2: 实现 benchmark harness
  - [x] SubTask 2.1: 增加 observe regression benchmark 测试文件或 helper，能加载固定 case 并执行断言。
  - [x] SubTask 2.2: 实现通用指标断言：markup pollution、long name、duplicate collection name、sample preservation、canonical shape。
  - [x] SubTask 2.3: 保持 harness 纯测试/纯逻辑，不改变 production observe 输出契约。

- [x] Task 3: 增加首批 benchmark cases
  - [x] SubTask 3.1: 增加 SVG/path/HTML-like 污染防回归 case。
  - [x] SubTask 3.2: 增加长 pricing/model-card preview 不作为 `containerName` 的 case。
  - [x] SubTask 3.3: 增加 duplicate collection name 消歧 case。
  - [x] SubTask 3.4: 增加 item preview 被拒绝为容器名但 evidence/sample 保留的 case。
  - [x] SubTask 3.5: 增加 canonical no-mode PageObservation shape 保护 case 或复用现有测试并纳入 scope。

- [x] Task 4: 接入测试 runner 和验证门禁
  - [x] SubTask 4.1: 将 benchmark 纳入现有 Node test runner 或新增明确 scope。
  - [x] SubTask 4.2: 如新增 scope，同步更新 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md` 测试地图。
  - [x] SubTask 4.3: 确保 `mise run affected` 能覆盖 benchmark 相关变更。
  - [x] SubTask 4.4: 避免 benchmark 影响 extension build 或真实浏览器环境。

- [x] Task 5: 文档与维护说明同步
  - [x] SubTask 5.1: 如果测试流程、scope 或维护 workflow 发生变化，更新 `CODE_WIKI.md` 对应测试/维护章节。
  - [x] SubTask 5.2: 在 benchmark case 附近提供最小维护说明，说明如何新增 case 和常见指标含义。
  - [x] SubTask 5.3: 不新增重复架构文档，遵守现有文档 owner 规则。

- [x] Task 6: 运行验证门禁
  - [x] SubTask 6.1: 运行新增 benchmark/focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 depends on Task 2。
- Task 4 depends on Task 2-3。
- Task 5 depends on Task 4 是否改变测试 workflow 或 scope。
- Task 6 depends on Task 1-5。
