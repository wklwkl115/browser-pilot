# Tasks

- [x] Task 1: 统一 extension command dispatch：在 `core_commands.ts` 中消除 top-level dispatch 与 batch dispatch 的支持集重复，保持现有 command handler、validation、error response 和 batch `$N` 参数替换行为兼容。
  - [x] SubTask 1.1: 增加或调整 characterization tests，覆盖直接 dispatch、batch dispatch、unknown command、native command validation、CDP batch 特殊路径。
  - [x] SubTask 1.2: 抽出共享 dispatch definition 或共享 dispatch helper，使直接与 batch 路径复用同一命令支持集。
  - [x] SubTask 1.3: 运行 extension 相关 typecheck/lint/test 或 `mise run affected`，确认 bridge extension 行为未漂移。

- [x] Task 2: 拆 daemon `/invoke` 路由 seam：在 `server.ts` 中抽离 invoke authorization、参数准备/验证、执行与日志响应 pipeline，不改变 daemon HTTP 协议和响应格式。
  - [x] SubTask 2.1: 增加或调整 daemon invoke characterization tests，覆盖 legacy allowed、pairing required、invalid token、revoked token、lease busy、unknown tool、validation error、command throw 与 success response。
  - [x] SubTask 2.2: 抽出 `/invoke` 专用 helper 或小型 pipeline，保持 `startDaemon()` 只负责组装和路由。
  - [x] SubTask 2.3: 运行 daemon/control API 相关测试或 `mise run affected`，确认 pairing、lease、usage logging 和 invoke envelope 兼容。

- [x] Task 3: 明确 kernel Node API 规则：在权威文档和治理测试中统一 `src/kernels/session/*` 对 `node:crypto` 的规则，避免文档与源码标准摇摆。
  - [x] SubTask 3.1: 决定采用“迁出/注入 Node crypto”还是“session kernel 显式例外并受测试保护”的最小变更方案。
  - [x] SubTask 3.2: 更新 `CODE_WIKI.md` 中 kernel 依赖边界说明，并同步相关治理测试断言。
  - [x] SubTask 3.3: 运行 `mise run dev-governance`，确认文档、治理测试和源码规则一致。

- [x] Task 4: 为 observe scan runner 建立 seam：先用 characterization tests 锁住 `browser_observe` 关键输出，再从 `scanRunner.ts` 中抽离 summary/enrichment/artifact 相关 builder，避免重写主流程。
  - [x] SubTask 4.1: 增加或调整 observe characterization tests，覆盖 ABML integrated/non-integrated、baseline diff/treeDiff、causal block、artifact hints、memory augmentation、ledger recording 关键契约。
  - [x] SubTask 4.2: 抽出 enrichment/summary projection helper，保持输入输出显式，避免 helper 直接扩大 runtime port 依赖。
  - [x] SubTask 4.3: 抽出 artifact mirror/hints builder，减少 summary、envelope、artifactValue 之间的重复字段组装。
  - [x] SubTask 4.4: 运行 observe/scan/ABML 相关测试或 `mise run affected`，确认输出兼容。

- [x] Task 5: 拆 result middleware 内部模块：保持 `jsonCommandResult`、`textCommandResult` 等入口稳定，把 `resultMiddleware.ts` 内部 redaction、budget、evidence、nextActions 逻辑拆为小 helper 或模块。
  - [x] SubTask 5.1: 增加或调整 result envelope characterization tests，覆盖 redaction、summary budget fitting、saved artifact、evidence refs、memory fitting、nextActions。
  - [x] SubTask 5.2: 抽出 redaction 与 budget fitting helper，保持 `responseEnvelope()` 行为兼容。
  - [x] SubTask 5.3: 抽出 evidence 与 nextActions helper，保持 envelope 字段顺序和语义兼容。
  - [x] SubTask 5.4: 运行 commands/result middleware 相关测试或 `mise run affected`。

- [x] Task 6: 拆 execute monitor adapter：在 `executeCommand.ts` 中把 monitor before/after scan 与 diff 逻辑收敛到窄 adapter，降低 execute 主体与 observe/ABML 直接耦合。
  - [x] SubTask 6.1: 增加或调整 `browser_execute` characterization tests，覆盖 program monitor、script/program without monitor、ABML read fallback、legacy scan fallback、navigation warning。
  - [x] SubTask 6.2: 抽出 monitor adapter，保持 `MonitorMetadata` 字段和错误容忍行为兼容。
  - [x] SubTask 6.3: 运行 execute/program/effect 相关测试或 `mise run affected`。

- [x] Task 7: 收窄 `BrowserBridgeServer` public surface 的迁移路径：先定义更窄内部 port 或 dependency interface，并迁移低风险内部调用方，不删除既有 public 方法。
  - [x] SubTask 7.1: 审计 `BrowserBridgeServer` 调用方，分类 commands、daemon、bridge internal service、tests 对方法的依赖。
  - [x] SubTask 7.2: 定义一个或多个窄接口用于 command/runtime 或 bridge internal service 注入，优先迁移低风险调用点。
  - [x] SubTask 7.3: 补充或调整 bridge server characterization tests，覆盖 snapshot、tabs/session、leases、queues、pending、consent、operation 关键行为。
  - [x] SubTask 7.4: 运行 bridge/server 相关测试或 `mise run affected`。

- [x] Task 8: memory store 分层：在 `store.ts` 周边拆分 domain validation、repository、ranking、evidence/profile enrichment，保留 fact-only 边界测试和用户磁盘数据兼容策略。
  - [x] SubTask 8.1: 增加或调整 memory characterization tests，覆盖 fact record/recall/read、dedup、freshOnly/profile anchors、evidence expiry warnings、SOP/non-fact 拒绝或忽略。
  - [x] SubTask 8.2: 抽出 memory validation/enrichment helper，使 payload validation、evidence resolution、profile anchors、dedup scoring 的职责更清晰。
  - [x] SubTask 8.3: 抽出 persistence/repository 与 ranking helper，保持 index/frontmatter/URI 行为兼容。
  - [x] SubTask 8.4: 运行 memory 相关测试或 `mise run affected`。

- [x] Task 9: 最终收口验证与文档同步：确保所有 seam、规则、测试和文档一致，并完成全量门禁。
  - [x] SubTask 9.1: 检查 `CODE_WIKI.md`、`REPO_GOVERNANCE.md` 或模块本地 owner 文档是否需要随实际边界变化同步，避免新增重复架构文档。
  - [x] SubTask 9.2: 运行 `mise run verify`；若治理或 workflow 文档发生变化，确认 `mise run dev-governance` 已通过。
  - [x] SubTask 9.3: 汇总实际变更文件、保持兼容的公共契约、测试证据、未完成的长期迁移点与残余风险。

# Task Dependencies
- Task 1、Task 2、Task 3 是第一优先级；Task 1 与 Task 2 可并行，Task 3 可独立推进但最终需与文档/治理测试一致。
- Task 4、Task 5、Task 6 是第二优先级；每项必须先完成 characterization tests，再实施拆 seam。
- Task 7、Task 8 是第三优先级；应在前两组低/中风险整改稳定后推进。
- Task 9 depends on Task 1 through Task 8 的实际完成结果。
