# Tasks

- [x] Task 1: 设计并实现 collection 同名检测
  - [x] SubTask 1.1: 在 collection modeling 阶段识别同一 PageObservation 内相同 `containerName` 的 collection 组。
  - [x] SubTask 1.2: 保持非重复名称不变，避免对已清晰的 collection 产生不必要改名。
  - [x] SubTask 1.3: 确保同名检测在 collection key 和输出排序上 deterministic。

- [x] Task 2: 实现安全消歧上下文提取
  - [x] SubTask 2.1: 从现有 list hint/entity/selector/evidence 中提取 bounded structural context，例如 sidebar/main/nav/aside/filter/group/section。
  - [x] SubTask 2.2: 从安全 sample category 或 item role 中提取短 generic qualifier，但不得使用长 item/card preview。
  - [x] SubTask 2.3: 对所有 qualifier 应用已有安全语义文本和 concise-container-label 过滤。
  - [x] SubTask 2.4: 当无安全上下文时使用 deterministic ordinal/generic suffix。

- [x] Task 3: 应用 collection 和 list region 名称消歧
  - [x] SubTask 3.1: 更新 `collection.containerName`，对重复 base name 生成可区分短名称。
  - [x] SubTask 3.2: 保留 base name 和 disambiguation reason 到 evidence/hints，方便诊断。
  - [x] SubTask 3.3: 对来自 list hint 的 region entity name 应用一致或可追踪的消歧规则。
  - [x] SubTask 3.4: 确保 pricing/model-card 长 preview 仍只作为 evidence/sample，不作为 suffix。

- [x] Task 4: 增加回归测试
  - [x] SubTask 4.1: 增加 duplicate `筛选` collection 测试，确认输出名称可区分。
  - [x] SubTask 4.2: 增加非重复短 label 测试，确认名称不被改动。
  - [x] SubTask 4.3: 增加无安全上下文 fallback 测试，确认 ordinal/generic suffix deterministic。
  - [x] SubTask 4.4: 增加 evidence/hints 测试，确认 base name 或 disambiguation reason 保留。
  - [x] SubTask 4.5: 增加长 pricing card sample 不作为消歧 suffix 的测试。

- [x] Task 5: 复验实际 Edge 页面
  - [x] SubTask 5.1: 重新构建扩展或相关输出并重启 daemon，确保运行最新逻辑。
  - [x] SubTask 5.2: 对 Krill AI pricing 页面重新运行 no-mode observe。
  - [x] SubTask 5.3: 检查 `envelope.collections`，确认两个原本同名的 `筛选` collection 已经可区分。
  - [x] SubTask 5.4: 确认 pricing card preview 仍保留在 evidence/sample，且不进入 `containerName` 或 suffix。
  - [x] SubTask 5.5: 确认 `<path`/`<svg` 污染仍为 0 matches。

- [x] Task 6: 运行验证门禁
  - [x] SubTask 6.1: 运行与 ABML/collections/observe/scan 相关 focused tests。
  - [x] SubTask 6.2: 运行 `mise run affected`。
  - [x] SubTask 6.3: 完成前运行 `mise run verify`；若环境无法完成，记录明确原因和剩余风险。
  - [x] SubTask 6.4: 修复验证中发现的失败，直到相关检查通过。

# Task Dependencies

- Task 2 depends on Task 1 的重复分组和数据来源确认。
- Task 3 depends on Task 1-2。
- Task 4 depends on Task 1-3 的行为定义，但可先写 characterization 测试。
- Task 5 depends on Task 1-4 的实现与构建。
- Task 6 depends on Task 1-5。
