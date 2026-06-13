# 词典与 wordlist 治理 plan（future / 未激活）

> Status: **future plan — NOT ACTIVE**。当前主线仍是 ABML 感知层；本 plan 不与 ABML 主线并行激活，
> 需用户显式改优先级、另开执行合同后才进入执行队列（口径同 `CURRENT.md` / `ROADMAP.md`）。
> 来源：2026-06-04 在 ABML `login` 推理去过拟合工作中，对全仓"硬编码词典/关键词表/payload 表"
> 做的一次性盘点（约 44 处，5 类）。结论是其中几项确有更权威的外部来源，但**均不在 ABML 主线上**，
> 故沉淀为本 future plan，不搭车主线。

## 背景

`login` scorer 去掉站点拟合 token（GitLab/GitHub class、provider 名单）后引出一个更大的问题：
项目多处用"硬编码词典"做分类/匹配，其中哪些该换成权威开源库或社区 wordlist、哪些应继续硬编码？
盘点结论是 —— **因类而异，不能一刀切**，且受一条决定性架构约束限制。

## 决定性约束：纯核零运行时依赖

`tests/contracts/drift/check-abml-core-boundary.mjs:137` 明令：`src/abml-core/` 任一文件 `import` 任何
npm 包即 CI 失败（"pure core must have zero runtime deps"）。而感知层词典（ARIA 词表
`ax.ts`/`entity.ts`/`relations.ts`、意图词 `inference.ts`）**全部位于纯核**。

推论：**在感知层"引库"这条路被直接堵死**。纯核内的任何词典治理方案必须是"零运行时依赖"——
要么继续内联静态数据，要么走**构建期 codegen 生成静态常量**（见 W2）。安全/utils 层（`webSecurity`、
`utils`）不受此约束，可自由使用文件/依赖。

## 治理判断框架（三问）

判断某个硬编码词典是否该换外部来源：

1. **有没有权威、会持续演进的真相源？**（spec 或活跃社区维护）—— 有则"换"可防漂移。
2. **它所在的层能否容纳外部依赖？**—— 纯核（`abml-core`）不能；安全/utils 层能。
3. **换了会不会牺牲确定性 / 安全性？**—— 脱敏等安全关键路径必须确定性、不依赖启动期外部文件。

## 现状盘点（约 44 处，5 类）

| 类别 | 处数 | 代表位置 | 在哪层 | 权威外部源 | 结论 |
|---|---|---|---|---|---|
| A. ARIA/HTML 标准词表（role/landmark/state） | ~10 | `abml-core/ax.ts`、`entity.ts`、`relations.ts` | 纯核 | `aria-query`（W3C 维护） | 有漂移风险，但禁运行时依赖 → 只能构建期 codegen（W2） |
| B. 意图启发式词（login/filter/actionable） | ~9 | `abml-core/inference.ts`、`scan/actionableRules.ts` | 纯核 + scan | 无合适轻量库 | **不引库**；演进方向是 i18n 静态化 |
| C. 安全 payload/签名（SQLi/error） | ~6 | `webSecurity/browserNative/sqliProbe.ts` | webSecurity（无约束） | PayloadsAllTheThings / sqlmap | **最该外部化**（W1） |
| D. 脱敏敏感字段 | ~3 | `utils/redaction.ts` | utils | OWASP SecLists（仅参考） | 保持内置，对照校准一次（W3） |
| E. 工具特定噪声/调优（翻译插件选择器、scan 跳过标签、阈值） | ~16 | `scan/noiseRules.ts`、`scan/buildScanScript.ts` 等 | 各层 | 无 | 硬编码正确，引库是 over-engineering |

## 工作项（按 ROI 排序）

### W1 — 安全 payload/签名外部化（最高 ROI，建议作为首个独立执行合同）

- **范围**：`src/tools/webSecurity/browserNative/sqliProbe.ts` 的 `DEFAULT_SQLI_ERROR_PAYLOADS`（:14）、
  `DEFAULT_SQLI_TIME_PAYLOADS`（:15）、`SQLI_DBMS_PAYLOAD_PACKS`（:24-30）、DBMS error 签名（:19-23）。
- **为什么值得**：内置 payload 是"冻结"的，而 SQLi 向量 / WAF 绕过在社区 wordlist 中持续演进。
- **现有基础设施已就位**：`readWordlist()`（`webSecurity/shared/normalize.ts:86`，沙箱限 CWD + `.pi/`，
  已被 fuzz 使用）。把内置 payload 降为"默认种子"，支持从社区 wordlist 覆盖/追加。
- **约束**：webSecurity 层无纯核限制，可读文件、可加依赖；保持 local-only、沙箱路径、无默认外部拉取。
- **验收口径**：内置默认行为不变（无 wordlist 时与现状一致）；可传社区 wordlist 覆盖；契约
  `check:web-security` 通过；新增"种子 + 外部覆盖"回归用例。

### W2 — ARIA 标准词表 codegen（中 ROI，非紧急）

- **范围**：`abml-core/ax.ts`（role/landmark/state 集合，约 :91-153/:307）、`entity.ts`（control role / tag 映射）、
  `relations.ts`（table/relation 词表）中的 ARIA 标准枚举。
- **做法（贴合项目已有范式）**：禁止运行时 `import aria-query`；改为
  `aria-query`（devDependency）→ `scripts/sync-aria.mjs` → 生成纯常量 `abml-core/ariaVocab.ts`（零 import）
  → `check:aria-drift`。与 `native_command_schema.json → sync:protocol → check:protocol` 同构。
- **诚实评估**：ABML 只用了一小撮极稳定的 role（button/link/textbox/landmark…），ARIA 1.1/1.2 这块多年
  无大变 → **当前实际漂移风险低**。本项属"防未来 + 工程整洁"，不紧急。
- **验收口径**：生成文件纳入 `check-abml-core-boundary` 仍判定为纯核（零 import）；drift check 可发现
  与 `aria-query` 的偏离；感知契约（`check:abml-*`）无回归。

### W3 — 脱敏敏感字段对照校准（低成本一次性）

- **范围**：`src/utils/redaction.ts`（敏感字段集合 + 文本正则）。
- **做法**：**保持内置**（安全关键、需确定性、启动不依赖外部文件）；一次性对照 OWASP SecLists 的
  sensitive-parameters，补全可能缺项（jwt / refresh_token / 各云厂商 key 等），然后继续内置。**不引运行时依赖。**
- **验收口径**：补全后 `check:token` / 相关脱敏契约通过；无新依赖。

## 明确不做

- **B 类意图词引库**：纯核禁库 + 意图分类无合适轻量库（NLP/ML 过重）。这类风险是**过拟合**，
  治理手段是"通用模式 + 回归测试"（已在 `inference.ts` login 上验证），不是换数据源；语言变多时
  抽到 i18n 静态资源文件，仍非"库"。
- **E 类工具噪声引库**：Google Translate / Immersive Translate / Read Frog 等是具体工具的稳定标识，
  硬编码本就正确。

## 激活条件与边界

- 本 plan 默认非激活。任一工作项启动前须**另开独立执行合同**（建议从 W1 起，收益最大、约束最少、
  管道已有），并在 `CURRENT.md` 记录决策/边界/契约/验收，**不得搭车 ABML 主线**。
- 不因本 plan 扩公开 `browser_*` 工具面；不改变纯核零依赖边界（W2 走 codegen 而非运行时依赖）。
