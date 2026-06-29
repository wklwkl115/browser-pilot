# Tasks

- [x] Task 1: 建立 item-like preview 判定规则
  - [x] SubTask 1.1: 在 ABML/observe 可复用位置实现或扩展 helper，用于判断候选文本是否过长、包含多字段业务明细、价格/倍率/计费 token、重复 key-value 或明显 card/item 内容。
  - [x] SubTask 1.2: 保持规则 deterministic、轻量、纯逻辑，不引入站点特定 hardcode 或业务数据抽取。
  - [x] SubTask 1.3: 为 helper 增加单元测试，覆盖长 pricing card、普通短 label、sidebar/group label、中文/英文混合文本。

- [x] Task 2: 收紧 collection 与 list region 命名
  - [x] SubTask 2.1: 更新 `buildRegionEntityFromListHint`，使 first item preview 只有在通过严格 concise-container-label 条件时才可作为 name，否则使用 container label 或 `list-${index}`。
  - [x] SubTask 2.2: 更新 `buildCollectionModels` 的 list hint draft/key，确保 `collection.containerName` 不使用长 item/card preview。
  - [x] SubTask 2.3: 保持 `firstItemPreview` 或安全 sample 继续出现在 evidence summary，不丢失诊断信息。
  - [x] SubTask 2.4: 确保 collection key 生成与新的 containerName 规则一致，避免同类列表因长 item 内容产生不稳定 key。

- [x] Task 3: 增强容器上下文 label 采集
  - [x] SubTask 3.1: 检查 `scanTemplate.ts` 当前 `containerLabelOf` 策略，优先复用 aria/labelled-by/heading/group label。
  - [x] SubTask 3.2: 在不引入复杂业务抽取的前提下，补充稳定的附近 heading、tab/filter/group context 候选。
  - [x] SubTask 3.3: 对候选 label 应用 concise-container-label 过滤，避免把整段卡片文本或大容器全文当 label。

- [x] Task 4: 增加回归测试
  - [x] SubTask 4.1: 增加 collection 测试，覆盖 Krill pricing 风格长卡片 preview 不会成为 `containerName`，但保留为 evidence sample。
  - [x] SubTask 4.2: 增加 list region entity 测试，覆盖长 preview fallback 为 `list-${index}` 或 container label。
  - [x] SubTask 4.3: 增加短 container label 正例测试，例如 `个人中心`、`全部供应商 30`、`所有最新话题` 仍可作为容器名。
  - [x] SubTask 4.4: 增加 scan template builder 或相关测试，确认 container label 候选存在且不会返回长 item/card 文本。

- [x] Task 5: 复验实际 Edge 页面
  - [x] SubTask 5.1: 重新构建扩展或相关 scan template 输出，确保 Edge 使用最新逻辑。
  - [x] SubTask 5.2: 对 Krill AI pricing 页面重新运行 no-mode observe。
  - [x] SubTask 5.3: 检查新 artifact 的 `envelope.collections` 和 `data.list_hints`，确认模型卡片列表不再以完整首个 pricing card 文本作为 `collection.containerName`。
  - [x] SubTask 5.4: 确认 item preview 仍可在 evidence/sample 中看到，且 `<path`/`<svg` 污染仍为 0 matches。

- [x] Task 6: 运行验证门禁
  - [x] SubTask 6.1: 运行与 ABML/collections/scan 相关 focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1。
- Task 3 can run after Task 1 and may proceed in parallel with Task 2 if helper contract is stable。
- Task 4 depends on Task 1-3 的行为定义，但可先写 characterization 测试。
- Task 5 depends on Task 1-4 的实现与扩展构建。
- Task 6 depends on Task 1-5。
