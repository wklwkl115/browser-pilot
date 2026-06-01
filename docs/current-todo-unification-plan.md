# CURRENT/TODO 统一整理分析计划

状态：已完成。

## 目标

统一整理 `TODO.md` / `CURRENT.md` / `ROADMAP.md` / `docs/*plan.md` 中仍标记为“当前、计划中、待实现、进行中”的非 MCP 队列，形成单一可信入口：

- 一个当前激活项；
- 一个短期 backlog；
- 一个已完成归档清单；
- 一个长期 roadmap；
- 无重复、无过期“当前”口径。

## 核查结果

MCP Phase 10 已完成，不再作为待办。非 MCP 队列已统一整理为：Active / Next backlog / Archived done。原混杂口径处理如下：

1. `M-001 ~ M-011 中严重度工程债收口`
   - 已在后续批次全部按收窄边界完成。
   - 其中 M-010 采用 core-only 完成定义：只收口 network summary/clear/HAR 主链显式类型，不做全仓 `JsonRecord` 清零。

2. `共享 helper 去重 / parse 策略 / 防漂移治理`
   - 已完成收窄批次。
   - `recordValue` 重复已清；`src/` 的 parse 热点已收口到共享 helper，并补 `JSON.parse` drift contract。

3. `bridge runtime hardening / command access schema / silent-catch governance`
   - broad 计划不再保留为当前项。
   - H-001/H-003/H-004/H-005 已完成；H-002 第二批也已按 targeted 可见化边界完成。

4. `H-002 第二批静默 catch 分类治理`
   - 已完成 targeted 可见化；剩余 silent catch 明确保留为 A 类 best-effort cleanup/probing。

5. `Web Security affordance / validation / recovery 收口`
   - 已完成并归档，不再作为当前/进行中。

6. `MV3 runtime state recovery`
   - Phase 1-5 已完成并归档，不再作为 current active queue。

7. 已完成计划已压缩到 `ARCHIVE.md` / `ROADMAP.md` 摘要，不再占当前队列。

## 边界

- 本轮只做真实性核查、计划归并、文档收口；不实现功能代码。
- 不新增公开 `browser_*` 工具。
- 不改变协议、schema、runtime 行为。
- 不把长期 roadmap 项升级为当前工作。
- 不把已完成项重新打开。
- 不做大规模文档重写；只改当前入口、状态、执行顺序和归档链接。

## 执行步骤

### Phase 1：事实核查

用源码和 contracts 验证每条队列的真实状态：

- M-001 ~ M-011：逐项搜索对应文件、测试、CHANGELOG，标记 `done / active / backlog / obsolete`。
- helper/parse 治理：统计重复 helper、内联 object guard、`JSON.parse` 热点。
- bridge hardening：核验 H-001/H-003/H-004/H-005/H-002 是否已完成或被其它 workstream 覆盖。
- H-002 第二批：统计目标文件中静默 catch 类型，确认是否仍需要独立计划。
- Web Security affordance：核验第 1-7 项是否全部已完成并通过 contracts。
- MV3 runtime recovery：核验 Phase 1-5 是否已完成，是否存在未完成后续阶段。

输出内部工作表字段：

- `id`
- `source`
- `claimedStatus`
- `evidence`
- `actualStatus`
- `decision`
- `targetDocLocation`

### Phase 2：归并决策

形成唯一当前队列模型：

- `Active`：最多 1 个，必须有明确下一步和验证命令。
- `Next backlog`：最多 3 个，按依赖顺序排列。
- `Archived done`：已完成项压缩到归档摘要。
- `Roadmap`：非近期项移动到 `ROADMAP.md`。
- `Obsolete / superseded`：被完成项覆盖的计划删除当前口径，只保留归档说明。

初始建议排序：

1. Active：`M-001 ~ M-011` 剩余真实项，当前先做 M-003 / M-006 / M-004。
2. Next：`共享 helper 去重 / parse 策略 / 防漂移治理`。
3. Next：合并后的 `bridge runtime / silent catch` 剩余项。
4. Archive：Web Security affordance、MV3 runtime recovery、MCP Phase 10、tool surface、architecture、tool parameter、lint debt 等已完成项。

### Phase 3：文档收口

修改文档：

- `TODO.md`
  - 改成短入口：Active / Next / Recently completed / Archive / Roadmap。
  - 删除重复“当前新增执行合同”。

- `CURRENT.md`
  - 顶部只保留当前真实状态。
  - 已完成长段落压缩并迁入 `ARCHIVE.md` 或保留摘要。
  - 计划中长段落只保留真正待执行的 1-3 个。

- `ROADMAP.md`
  - 接收非近期但仍有价值的计划。

- `ARCHIVE.md`
  - 接收已完成项摘要，避免 `CURRENT.md` 长期膨胀。

- `CHANGELOG.md`
  - 记录本轮只是文档状态统一，不是 runtime 行为变更。

如修改文档结构索引块，运行：

```bash
npm run docs:sync-indexes
```

### Phase 4：验证

已执行：

```bash
npm run check:doc-structure
npm run check:all:contracts
npm run check
```

结果：通过。

## 完成标准

- [x] `TODO.md` 中不再同时出现多个“当前新增执行合同”。
- [x] `CURRENT.md` 顶部的 current/active 口径与正文一致。
- [x] 已完成项不再写成 current/进行中/待实现。
- [x] 重叠计划已合并或标注 superseded。
- [x] MCP Phase 10 只作为已完成项出现。
- [x] 每个剩余 backlog 都有：范围、下一步、验证命令、非目标。
- [x] `npm run check:doc-structure` 通过；最终 `npm run check` 通过。
