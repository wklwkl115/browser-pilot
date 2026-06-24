# Tasks

- [x] Task 1: 覆盖率热点复核与补测切片确认：运行覆盖率报告，确认本轮优先补测文件与不可测边界。
  - [x] SubTask 1.1: 运行 `mise run coverage` 或等价命令，记录当前行/分支/函数覆盖率。
  - [x] SubTask 1.2: 从覆盖率输出中确认 Web Security shared/bridges、ABML、temporal/evidence distill、memory/profile/resource 的具体低覆盖文件。
  - [x] SubTask 1.3: 明确本轮不做真实浏览器、真实网络、外部 scanner 或生成产物测试。

- [x] Task 2: 补充 Web Security shared 与 bridge helper 测试：覆盖不依赖外部工具和网络的解析、归一化、diff、token、multipart、HAR 或 bridge adapter 逻辑。
  - [x] SubTask 2.1: 为 `src/commands/webSecurity/shared/*` 中至少三个低覆盖 helper 补充正常、空、畸形或边界输入测试。
  - [x] SubTask 2.2: 为 `src/commands/webSecurity/bridges/*` 或 browser-native adapter 中至少一个可隔离 helper 补充命令构造、错误解析或 fallback 测试。
  - [x] SubTask 2.3: 确认新增测试不执行真实 scanner、浏览器或网络请求。
  - [x] SubTask 2.4: 运行相关测试和 `node scripts/run-tests.mjs all`。

- [x] Task 3: 补充 ABML kernel 测试：覆盖 `src/kernels/abml/*` 低覆盖 helper 的纯逻辑边界。
  - [x] SubTask 3.1: 覆盖 collections、stream、snapshot projection、accessibility mapping 或 identity graph 中至少两个子域。
  - [x] SubTask 3.2: 覆盖空树、重复节点、缺失属性、畸形关系或边界大小输入。
  - [x] SubTask 3.3: 确认测试不引入 browser、bridge、command 或 runtime 依赖。
  - [x] SubTask 3.4: 运行相关 bootstrap/all 测试。

- [x] Task 4: 补充 temporal 与 evidence distill 测试：覆盖 estimate、budget、relevance、salience envelope 等低覆盖纯逻辑。
  - [x] SubTask 4.1: 为 temporal estimate/budget helper 补充缺失时间、异常预算、边界 clamp 或 fallback 测试。
  - [x] SubTask 4.2: 为 evidence distill relevance/salience helper 补充低相关性、高相关性、超长输入或摘要预算测试。
  - [x] SubTask 4.3: 运行相关 bootstrap/all 测试。

- [x] Task 5: 补充 memory/profile/resource 服务边界测试：覆盖 profile service、secret、staleness、resource resolver 等剩余低覆盖服务逻辑。
  - [x] SubTask 5.1: 覆盖 malformed profile、缺失 profile、跨 cwd/profile 作用域或损坏数据恢复。
  - [x] SubTask 5.2: 覆盖 secret redaction、敏感值不回显、staleness 计算或缺失 resource resolver 行为。
  - [x] SubTask 5.3: 运行 memory/artifacts/all 测试。

- [x] Task 6: 验证、覆盖率对比与收口：运行覆盖率报告、全量测试和 canonical gates，记录覆盖率变化与剩余热点。
  - [x] SubTask 6.1: 运行 `node scripts/run-tests.mjs all`。
  - [x] SubTask 6.2: 运行 `mise run coverage` 并记录最新行/分支/函数覆盖率。
  - [x] SubTask 6.3: 运行 `mise run affected` 和 `mise run verify`。
  - [x] SubTask 6.4: 若测试 scope、coverage 流程或文档说明变化，同步 `CODE_WIKI.md` 并验证本地 Markdown 链接。
  - [x] SubTask 6.5: 在验收清单中记录本轮仍需后续关注的低覆盖热点。

# Task Dependencies

- Task 2、Task 3、Task 4、Task 5 depends on Task 1。
- Task 2、Task 3、Task 4、Task 5 可在 Task 1 完成后并行推进，但不得编辑同一测试文件或生产文件造成冲突。
- Task 6 depends on Task 2、Task 3、Task 4、Task 5。
