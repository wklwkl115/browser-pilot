# Tasks

- [x] Task 1: 建立覆盖率观测报告：为现有 Node test runner 测试提供可重复运行的覆盖率报告入口，先只报告不设置全仓库硬阈值。
  - [x] SubTask 1.1: 调研 Node 22 内置 V8 coverage 或轻量覆盖率工具是否适合当前 ESM/tsx 测试体系。
  - [x] SubTask 1.2: 新增或复用脚本生成覆盖率输出，并保证不改变 `node scripts/run-tests.mjs all` 的默认行为。
  - [x] SubTask 1.3: 在 `mise.toml` 增加非阻塞覆盖率报告任务，或明确记录不新增任务的理由。
  - [x] SubTask 1.4: 如新增覆盖率命令，同步更新 `CODE_WIKI.md` 测试体系说明。

- [x] Task 2: 补充 commands 执行层测试：在已有 command catalog/schema 测试基础上，覆盖代表性核心命令的执行行为。
  - [x] SubTask 2.1: 为 `browser_artifact`、`browser_memory` 或其他可隔离命令补充成功 envelope、错误 envelope、distiller/summary 行为测试。
  - [x] SubTask 2.2: 为 `browser_tabs`、`browser_command`、`browser_execute` 中可通过 mock runtime port 隔离的路径补充执行测试。
  - [x] SubTask 2.3: 覆盖至少一种 runtime port 调用失败、参数合法但运行失败、结果压缩或 recovery metadata 的路径。
  - [x] SubTask 2.4: 运行相关 CLI/bootstrap/memory/artifact scope，并确认测试被 `node scripts/run-tests.mjs all` 发现。

- [x] Task 3: 补充 kernels 纯逻辑测试：继续覆盖 `src/kernels/*` 中最适合单测的 parser、classifier、builder 或 normalization helper。
  - [x] SubTask 3.1: 选择至少两个当前未充分覆盖的 kernel 子域，不引入 browser、bridge、command 或 runtime 依赖。
  - [x] SubTask 3.2: 覆盖正常输入、空输入、畸形输入、大输入或边界输入。
  - [x] SubTask 3.3: 若 native 与 TS kernel 存在 fallback 或一致性关系，补充至少一个一致性或退化路径测试。
  - [x] SubTask 3.4: 运行相关 bootstrap 或新增 scope 测试。

- [x] Task 4: 补充 daemon/server 状态机测试：覆盖 daemon 可隔离状态边界，优先处理 pairing、lease、state dir、token 与 route validation。
  - [x] SubTask 4.1: 覆盖 pairing lifecycle 的过期、撤销、无效或冲突状态。
  - [x] SubTask 4.2: 覆盖 lease lifecycle 的过期、竞争、释放或恢复路径。
  - [x] SubTask 4.3: 覆盖 state dir/token/lockfile 缺失、损坏或权限失败时的受控结果。
  - [x] SubTask 4.4: 确认错误响应不会回显敏感 token 或本地隐私路径。

- [x] Task 5: 补充 bridge/extension/runtime helper 测试：覆盖无需真实浏览器的协议 helper、message envelope、runtime adapter 与错误 shaping。
  - [x] SubTask 5.1: 抽查 bridge/extension service worker、offscreen transport 或 page script 中可隔离 helper，并补充畸形 message 测试。
  - [x] SubTask 5.2: 覆盖 browser-runtime 或 browser-command-runtime adapter 的成功、失败、timeout 或 malformed-result 行为。
  - [x] SubTask 5.3: 确认测试不依赖真实 Chrome/Edge、外部网络或 live extension 状态。

- [x] Task 6: 验证与文档收口：运行所有相关 scope、覆盖率报告、`mise run affected` 和 `mise run verify`，并同步必要文档。
  - [x] SubTask 6.1: 运行新增测试对应的最小 scope。
  - [x] SubTask 6.2: 运行 `node scripts/run-tests.mjs all`。
  - [x] SubTask 6.3: 运行覆盖率报告命令并记录低覆盖热点。
  - [x] SubTask 6.4: 运行 `mise run affected` 和 `mise run verify`。
  - [x] SubTask 6.5: 若新增脚本、scope 或验证说明变化，同步 `CODE_WIKI.md`，并确认 Markdown 链接有效。

# Task Dependencies

- Task 2、Task 3、Task 4、Task 5 depends on Task 1。
- Task 2、Task 3、Task 4、Task 5 可在 Task 1 完成后并行推进，但不得编辑同一测试文件或同一生产模块造成冲突。
- Task 6 depends on Task 2、Task 3、Task 4、Task 5。
