# Tasks

- [x] Task 1: 建立 observe 语义文本清洗规则
  - [x] SubTask 1.1: 在 ABML/observe 可复用位置实现安全语义文本 helper，过滤 SVG/path/HTML-like、selector-like、低价值技术 token 和空白候选。
  - [x] SubTask 1.2: 将 helper 接入 `buildDomEntityFromScanActionable` 与 `buildActionableLocators`，确保 `entity.name`、ref semantic name、textAnchor locator 使用清洗后的候选。
  - [x] SubTask 1.3: 保持 editable 字段隐私边界，不将输入值提升为语义名或 entity value。

- [x] Task 2: 修复 list hint 与 collection 命名
  - [x] SubTask 2.1: 在 scan list hint 采集中避免将 SVG/path outerHTML 作为 `firstItemPreview` 的语义候选。
  - [x] SubTask 2.2: 为 list hints 增加或归一化安全的 `containerLabel` / container semantic 候选，优先来自 aria、labelled-by、附近 heading 或稳定容器文本。
  - [x] SubTask 2.3: 更新 `buildRegionEntityFromListHint`，使 list region name 优先使用安全 container label，再使用安全 fallback，不再直接使用未清洗 first item preview。
  - [x] SubTask 2.4: 更新 `buildCollectionModels` 的 list hint draft/key，使 `collection.containerName` 使用安全 container label/fallback，first item preview 只作为 sample/evidence。

- [x] Task 3: 改善 icon/SVG-heavy 控件命名
  - [x] SubTask 3.1: 增强 scan 控件 label 候选，优先使用 aria/title/alt/labelled-by/sr-only 等安全可访问文本。
  - [x] SubTask 3.2: 确保 icon-only 控件无安全名称时不暴露 SVG/path markup，可保留 role/generic fallback。
  - [x] SubTask 3.3: 对 summary display name 与 ABML entity semantic name 使用一致的安全候选策略，避免两层命名明显不一致。

- [x] Task 4: 增加专项测试覆盖
  - [x] SubTask 4.1: 增加 ABML entity 测试，覆盖 SVG/path/HTML-like 候选不会进入 `entity.name`、semantic descriptor 或 textAnchor locator。
  - [x] SubTask 4.2: 增加 list hint / collection 测试，覆盖 `containerLabel` 优先、first item SVG markup 被过滤、fallback 为安全 generic name。
  - [x] SubTask 4.3: 增加 scan summary 或 helper 测试，覆盖 icon-heavy control 使用 accessible label，且无 accessible label 时不使用 SVG/path markup。
  - [x] SubTask 4.4: 根据现有测试布局选择最小测试文件改动，避免引入浏览器依赖或 fixture 过度复杂化。

- [x] Task 5: 复验 observe 实际页面效果
  - [x] SubTask 5.1: 重新构建扩展或相关 scan template 输出，确保浏览器端使用最新 scan 逻辑。
  - [x] SubTask 5.2: 对当前 Edge 页面重新运行 no-mode `browser_observe --json`。
  - [x] SubTask 5.3: 检查 observe artifact 中 `envelope.collections`、`envelope.entities`、`data.actionables`，确认不再出现 SVG/path markup 作为语义名称。

- [x] Task 6: 运行项目验证门禁
  - [x] SubTask 6.1: 运行与 ABML/observe/scan 相关 focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected` 或更窄但符合仓库规则的相关 gate。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因、已通过验证和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1 的语义文本清洗规则。
- Task 3 depends on Task 1，并可与 Task 2 部分并行。
- Task 4 depends on Task 1-3 的行为定义，但可先写 RED/characterization 测试。
- Task 5 depends on Task 1-4 的实现与扩展构建。
- Task 6 depends on Task 1-5。
