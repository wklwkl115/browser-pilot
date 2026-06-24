# Tasks

- [x] Task 1: 审计 SOP 引用与 memory 分层边界：确认所有 `sop`、SOP 文案、`browser-memory://sop`、`sop_` id、`.browser-pilot/memory/sop/` 扫描和自动提示位置。
  - [x] SubTask 1.1: 搜索并分类 SOP 相关代码引用，区分 public schema、存储、读取、召回、observe 自动注入、result auto-surface、summary、错误/协议、文档和测试。
  - [x] SubTask 1.2: 确认 `src/kernels/memory/*`、`src/memory/*`、`src/commands/memory*`、observe/result middleware 的当前依赖方向和应保留 owner。
  - [x] SubTask 1.3: 标记必须删除、必须保留、需兼容忽略和需文档同步的项目。

- [x] Task 2: 将 memory 数据模型和公共命令收紧为 fact-only：删除 SOP kind 的可创建、可验证、可索引和可读取入口。
  - [x] SubTask 2.1: 更新 memory 类型、command schema、record/validate payload、id 生成和 body 限额逻辑，使新 memory entry 只能是 fact。
  - [x] SubTask 2.2: 更新 storage/index/frontmatter/reader，停止扫描 `sop/`、停止支持 `browser-memory://sop/<id>`，并移除未知 kind 默认转 SOP 的 fallback。
  - [x] SubTask 2.3: 确保旧 `.browser-pilot/memory/sop/` 文件不会被应用写入、索引、召回或通过 memory URI 暴露，同时不主动删除用户磁盘数据。

- [x] Task 3: 解耦 observe/result 与 SOP 行为并收拢 memory 接口：保留必要 fact memory 能力，移除过程复用暗示。
  - [x] SubTask 3.1: 更新 observe memory augmentation，使 warm-start、recall、inline/handle memory 只基于 fact memory，并不复制 storage/routing/staleness 逻辑。
  - [x] SubTask 3.2: 移除 result auto-surface 中 `kind=sop` 的 record candidate；如保留提示，改为事实型且避免操作流程复用措辞。
  - [x] SubTask 3.3: 检查 summaries、result envelope、daemon/profile flush 等 memory 集成点，确保依赖窄接口且不残留 SOP 语义。

- [x] Task 4: 更新测试与文档：覆盖 fact-only 行为、SOP 拒绝/忽略行为和 memory 内核边界。
  - [x] SubTask 4.1: 补充或调整测试，验证 `kind=sop` 不能 record/validate、SOP URI 不受支持、SOP 文件不进入 index/recall/observe memory。
  - [x] SubTask 4.2: 补充或调整测试，验证 fact memory 仍可 record/recall/read，并且 observe 自动 memory 仍只暴露 fact。
  - [x] SubTask 4.3: 更新 `CODE_WIKI.md` 和相关公开文档，删除 SOP/procedure 记忆承诺，描述 fact-only memory 与分层边界。

- [x] Task 5: 运行验证并收口：确认实现、文档和规格一致。
  - [x] SubTask 5.1: 运行 `mise run affected`，修复发现的问题。
  - [x] SubTask 5.2: 运行 `mise run verify`，若修改治理或工作流规则则同时运行 `mise run dev-governance`。
  - [x] SubTask 5.3: 汇总变更文件、SOP 移除范围、fact memory 保留能力、验证证据和残余风险。

# Task Dependencies
- Task 2 depends on Task 1 的引用审计和边界分类。
- Task 3 depends on Task 1 的集成点审计；可与 Task 2 的类型/存储收紧在不同文件上并行推进，但最终需统一接口。
- Task 4 depends on Task 2 和 Task 3 的实际行为变化。
- Task 5 depends on Task 2、Task 3、Task 4 完成。
