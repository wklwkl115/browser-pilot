# Tasks

- [x] Task 1: 建立 80% 覆盖率基线与机械化阈值验证：运行当前 coverage，确认缺口，并让 coverage 命令能够验证三项指标均 ≥80%。
  - [x] SubTask 1.1: 运行 `mise run coverage`，记录当前行、分支、函数覆盖率与最低覆盖文件。
  - [x] SubTask 1.2: 调整 coverage 脚本或新增检查逻辑，使其能在任一指标低于 80% 时清晰失败或报告未达标。
  - [x] SubTask 1.3: 若需要排除不可执行文件、生成文件或纯类型文件，必须最小化排除范围并记录理由。
  - [x] SubTask 1.4: 同步 `CODE_WIKI.md` 和 `mise.toml` 中覆盖率阈值说明。

- [x] Task 2: 深度补测 Web Security browserNative/shared/bridges：集中覆盖当前最大低覆盖热点，不执行真实浏览器、网络或外部 scanner。
  - [x] SubTask 2.1: 为 browserNative 中 `crawl`、`httpReplay`、`cookieAnalyze`、`templateCheck`、`callbackOast`、`fuzz*`、`sqliProbe`、`crawlExtractors`、`oastWorkerManager` 中的可隔离逻辑补充测试。
  - [x] SubTask 2.2: 为 shared 中 `replay`、`requestTemplate`、`railsCookieTokens`、`jsAstReductionContext`、`har`、`multipart`、`cookieTokens` 的低覆盖分支补充测试。
  - [x] SubTask 2.3: 为 bridges 中 `matureBridge`、`nucleiBridge`、`sqlmapBridge` 的命令构造、输出解析、错误/fallback 分支补充测试。
  - [x] SubTask 2.4: 运行相关测试、`node scripts/run-tests.mjs all` 和 coverage，确认 Web Security 热点覆盖率显著提升。

- [x] Task 3: 深度补测 ABML kernel：覆盖仍偏低的 ABML 纯逻辑和分支。
  - [x] SubTask 3.1: 为 `ax`、`inference`、`entity`、`relations`、`collections`、`stream`、`snapshotProjection`、`identityGraph` 中未覆盖分支补充测试。
  - [x] SubTask 3.2: 覆盖空树、重复节点、缺失属性、异常 roles、畸形关系、边界大小输入和 fallback 行为。
  - [x] SubTask 3.3: 确认 `src/kernels/*` 仍不引入 browser、bridge、command 或 runtime 依赖。
  - [x] SubTask 3.4: 运行相关 bootstrap/all 测试和 coverage。

- [x] Task 4: 深度补测 temporal、evidence distill、memory/profile/resource 及其他新热点：补齐函数和分支覆盖缺口。
  - [x] SubTask 4.1: 补测 temporal `estimate`、`budget`、wait/continuity/staleness 相关未覆盖分支。
  - [x] SubTask 4.2: 补测 evidence distill `relevance`、`salienceEnvelope`、`fit`、projection/budget 相关未覆盖分支。
  - [x] SubTask 4.3: 补测 memory/profile/resource 中 profile service、secret、staleness、resource store/resolver 的未覆盖分支。
  - [x] SubTask 4.4: 根据 coverage 新热点补测其他高收益纯逻辑或服务边界。

- [x] Task 5: 覆盖率迭代冲刺到三项 ≥80%：循环运行 coverage，按报告继续补测直到三项指标达标。
  - [x] SubTask 5.1: 每轮 coverage 后记录三项指标与剩余最低覆盖文件。
  - [x] SubTask 5.2: 优先补函数覆盖和分支覆盖，因为当前函数覆盖缺口最大。
  - [x] SubTask 5.3: 若发现真实 bug，做最小生产修复并补回归测试。
  - [x] SubTask 5.4: 达到三项 ≥80% 后，确认 coverage 阈值检查通过。

- [x] Task 6: 最终验证、文档与验收收口：运行全量测试、coverage 阈值、affected 和 verify，并更新验收记录。
  - [x] SubTask 6.1: 运行 `node scripts/run-tests.mjs all`。
  - [x] SubTask 6.2: 运行 `mise run coverage`，确认行、分支、函数覆盖率均 ≥80%。
  - [x] SubTask 6.3: 运行 `mise run affected` 和 `mise run verify`。
  - [x] SubTask 6.4: 验证 `CODE_WIKI.md` 本地 Markdown 链接。
  - [x] SubTask 6.5: 在 checklist 中记录最终覆盖率、验证结果、任何排除项理由和剩余风险。

# Task Dependencies

- Task 2、Task 3、Task 4 depends on Task 1。
- Task 5 depends on Task 2、Task 3、Task 4。
- Task 6 depends on Task 5。
- Task 2、Task 3、Task 4 可并行推进，但不得编辑同一测试文件或生产文件造成冲突。
