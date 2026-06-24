# Tasks

- [x] Task 1: 建立重构前基线与候选审计清单：采集代码量、模块规模、验证耗时、依赖/引用关系与公共入口清单，形成后续删除和简化的证据基础。
  - [x] SubTask 1.1: 统计 `src/`、`tests/`、`scripts/`、`capture-src/`、`native/` 中的源文件数量与有效代码行数，排除 `dist/` 和 `bridge/browser_pilot_bridge/`。
  - [x] SubTask 1.2: 运行或记录当前可用的 `mise run affected`/相关 dev gate，采集验证结果与耗时。
  - [x] SubTask 1.3: 审计 public/半 public 边界：`index.ts`、CLI/daemon/extension 入口、`src/commands/commandCatalog.ts`、native protocol schema、package exports/bin。
  - [x] SubTask 1.4: 生成候选清单，按“可删除、可合并、可简化、仅记录暂缓”分类，并附证据、风险和验证方式。

- [x] Task 2: 清理低风险无引用或过时实现：优先处理无公共契约、无运行时引用、无测试依赖且不属于生成产物的代码。
  - [x] SubTask 2.1: 删除确认无引用的源文件、内部导出、死分支或过时辅助函数。
  - [x] SubTask 2.2: 更新受影响 import、测试引用和权威文档引用，避免留下悬空路径。
  - [x] SubTask 2.3: 对删除项运行范围内验证，确保核心命令和桥接链路未受影响。

- [x] Task 3: 合并重复逻辑与简化复杂路径：将重复的参数处理、错误包装、结果裁剪、路径/JSON/文本处理、web security 共享逻辑收敛到既有 canonical owner。
  - [x] SubTask 3.1: 识别至少一组有明确重复证据的 helper 或流程，选择风险最低的合并目标。
  - [x] SubTask 3.2: 更新调用点并删除重复实现，保持行为兼容。
  - [x] SubTask 3.3: 为被合并行为补充或调整特征化测试，防止行为漂移。

- [x] Task 4: 优化依赖边界和模块职责：检查跨层 import、kernel/runtime/command/bridge 关系，减少不必要依赖并保持 owner 清晰。
  - [x] SubTask 4.1: 检查 `src/kernels/*` 是否保持纯逻辑边界，无 browser、Node、npm runtime、bridge、commands 或 browser-runtime 依赖。
  - [x] SubTask 4.2: 检查 command/runtime/bridge 层是否存在可收敛的反向依赖、重复 owner 或不必要中转。
  - [x] SubTask 4.3: 调整低风险依赖方向或抽取到既有共享位置，不新增重复架构文档。

- [x] Task 5: 同步测试、文档与最终重构说明：确保行为保持、门禁通过，并交付用户要求的对比数据和说明。
  - [x] SubTask 5.1: 根据实际删除/合并/边界变化更新 `CODE_WIKI.md`、`REPO_GOVERNANCE.md` 或模块本地 owner 文档中的既有权威段落。
  - [x] SubTask 5.2: 运行 `mise run verify`；若修改治理或工作流文档，额外运行 `mise run dev-governance`。
  - [x] SubTask 5.3: 汇总重构前后代码量对比、验证耗时或性能改进数据、删除/合并清单、保留原因、未处理候选项和残余风险。

# Task Dependencies
- Task 2 depends on Task 1 的候选清单与公共边界审计。
- Task 3 depends on Task 1 的重复逻辑识别；可与 Task 2 在不同模块内并行执行。
- Task 4 depends on Task 1 的依赖/引用关系摘要；可与 Task 2、Task 3 的低耦合部分并行执行。
- Task 5 depends on Task 2、Task 3、Task 4 的实际变更结果。
