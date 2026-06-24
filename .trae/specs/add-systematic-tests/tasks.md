# Tasks

- [x] Task 1: 测试覆盖盘点与补测边界确认：基于 `CODE_WIKI.md`、现有 `tests/`、`scripts/run-tests.mjs` 和高风险源码目录，列出本轮优先补测模块与不纳入范围。
  - [x] SubTask 1.1: 统计现有测试 scope 与测试文件覆盖的模块类别。
  - [x] SubTask 1.2: 识别缺少稳定测试的高风险区域，优先考虑 command catalog、bridge/daemon 可隔离逻辑、memory/artifact/resource 边界、kernel 纯逻辑。
  - [x] SubTask 1.3: 明确不做真实浏览器端到端测试、不改生成产物、不引入新测试框架。

- [x] Task 2: 补充命令与 schema 契约测试：为公开 `browser_*` 命令目录、命令定义结构、参数 schema 和分发边界增加 characterization tests。
  - [x] SubTask 2.1: 覆盖命令目录导出的工具名稳定性、唯一性和命名约束。
  - [x] SubTask 2.2: 覆盖关键命令参数 schema 的必填字段、严格参数行为和错误输入路径。
  - [x] SubTask 2.3: 验证新增测试可通过对应 scope 和 `node scripts/run-tests.mjs all` 执行。

- [x] Task 3: 补充 bridge/daemon 可隔离逻辑测试：为无需真实浏览器连接的 bridge server、client registry、pending request、port/config、daemon invoke 边界补充测试。
  - [x] SubTask 3.1: 覆盖连接状态、请求生命周期、超时/失败清理或端口选择边界。
  - [x] SubTask 3.2: 覆盖 daemon invoke 的输入校验、受控错误结果和不会泄露敏感 token 的行为。
  - [x] SubTask 3.3: 验证相关测试纳入 bootstrap/cli 或合适 scope。

- [x] Task 4: 补充 memory/artifact/resource 持久化边界测试：为 cwd/profile 作用域、文件路径边界、envelope shaping、ranking/dedup、畸形输入处理补充测试。
  - [x] SubTask 4.1: 覆盖跨 cwd/profile 隔离和非法路径输入。
  - [x] SubTask 4.2: 覆盖 memory fact-only validation、recall 排序/去重和 malformed record 处理。
  - [x] SubTask 4.3: 覆盖 artifact/resource 读取、缺失文件、无效 metadata 或 envelope 边界。

- [x] Task 5: 补充纯逻辑 kernel/runtime helper 测试：为不依赖浏览器、Node 外部状态或网络的 kernel、scan、capture、browser-page-runtime helper 增加稳定测试。
  - [x] SubTask 5.1: 选择当前最关键且可隔离的纯函数或 builder/parser。
  - [x] SubTask 5.2: 覆盖正常输入、空输入、畸形输入和边界大小输入。
  - [x] SubTask 5.3: 若新增测试 scope，同步更新 `scripts/run-tests.mjs`、`mise.toml` 和 `CODE_WIKI.md`。

- [x] Task 6: 验证与收口：运行相关 scope、`mise run affected`，完成前运行 `mise run verify`，并修复所有由新增测试或门禁暴露的问题。
  - [x] SubTask 6.1: 运行新增测试对应的最小 scope。
  - [x] SubTask 6.2: 运行 `node scripts/run-tests.mjs all`。
  - [x] SubTask 6.3: 运行 `mise run affected` 和 `mise run verify`。
  - [x] SubTask 6.4: 若测试体系、scope 或门禁说明发生变化，同步更新 `CODE_WIKI.md`。

# Task Dependencies

- Task 2、Task 3、Task 4、Task 5 depends on Task 1。
- Task 2、Task 3、Task 4、Task 5 可在 Task 1 完成后并行推进，但不得编辑同一测试文件产生冲突。
- Task 6 depends on Task 2、Task 3、Task 4、Task 5。
