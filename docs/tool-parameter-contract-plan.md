# 工具层参数契约执行合同

> Status: completed planning contract.
> 本文取代 `.plan/tool-parameter-contract.md` 作为唯一执行合同；`.plan/...` 仅保留为讨论输入，不再直接作为执行源。

## 目标

在不扩公开 `browser_*` 工具面、不改变既有 WebSecurity TypeBox-外层 / Zod-内层 分工的前提下，收口“参数写不对→工具起不来 / 拿到错结果”的真实缺口。

本合同只覆盖 3 个主工作流：

1. 顶层未知参数名响亮拒绝（Gap A）
2. 裸字符串枚举收紧为显式枚举契约（Gap B）
3. `browser_sqli` 的复杂对象 Zod 内层校验补齐，并核对 `browser_crawl` 无漏项（Gap C 窄）

以上 3 项全部必做；不因为工作量大删项，也不把后续工效学设计混入本合同。

## 现状确认

仓库当前已形成稳定双层参数校验模式：

- **TypeBox 外层工具契约**：由 Pi 框架在 execute 前执行 `Value.Convert + Check`
- **Zod 内层复杂对象校验**：`src/validation/{middleware,schemas}.ts` + `validateOptionalParams()`

已确认现状：

- `registerFuzz.ts`、`registerHttpReplay.ts`、`registerTemplate.ts`、`registerCookieAnalyze.ts` 已有复杂对象 Zod 校验
- Zod schema 已按来源分级：
  - `.strict()`：构造型对象（如 `HttpRequestSchema` / `MultipartSchema` / `FuzzMutationsSchema`）
  - `.passthrough()`：透传型对象（如 `CookieSchema` / `TemplateSchema`）
  - `z.record(z.unknown())`：真开放对象（如 `ClaimMutationsSchema` / `VariablesSchema` / `JsonValuesSchema` / `TechHintsSchema`）

因此，本合同**不做复杂对象 schema 回迁 TypeBox**，只补真实缺口。

## 非目标

- 不重复框架已覆盖的严格标量类型校验
- 不对抗 `Value.Convert`
- 不碰框架内部 `prepareArguments()`
- 不把复杂对象从 Zod 全量迁回 TypeBox
- 不新增参数错误码族（继续复用 `INVALID_BROWSER_COMMAND` / `INVALID_RULE`）
- 不引入 profile/预设/高层工效学抽象；如需做，另立 RFC（例如 `tool-ergonomics-presets.md`）
- 不扩公开 `browser_*` 工具面
- 不把参数契约治理扩成“全仓风格统一运动”

## 问题边界

### Gap A：顶层未知字段无统一拒绝机制

当前大量工具使用裸 `Type.Object({ ...fields })`，顶层未知字段是否会被框架剥离或放过，需要先通过仓库内夹具确认。若未知顶层字段未被拒绝，则：

- 参数名 typo 会静默忽略，如 `urls` 误写为 `url` 的近似问题
- 这是 agent 最高频且最不可见的参数失败来源

### Gap B：枚举型参数仍写成裸 `Type.String()` 或宽字符串集合

当前已确认的高优先级枚举缺口至少包括：

| 参数 | 位置 | 应有枚举 |
|---|---|---|
| `cookieMode` | `src/tools/webSecurity/register/shared.ts` | `merge | replace | preserve` |
| `payloadMode` | `src/tools/webSecurity/register/registerSqli.ts` | `append | replace` |
| `defaultScheme` | crawl / fuzz / httpReplay / template / shared | `http | https` |
| `locations` | `registerFuzz.ts` / `registerSqli.ts` | `query | json | form | multipart | header | all` |
| `probeTypes` | `registerSqli.ts` | `boolean | error | time | union | all` |
| `baselineStrategy` | `registerFuzz.ts` | `exact | cluster | auto` |
| `sniMode` | `registerFuzz.ts` | `target | host | custom | none` |
| `knownFiles` | `registerCrawl.ts` | `none | robotstxt | sitemapxml | all` |

本合同要求对这批“已确认的枚举缺口”收紧；实现过程中若再发现同类裸字符串枚举，可在本合同范围内一并收口。

### Gap C（窄）：`browser_sqli` 缺少与兄弟工具一致的复杂对象 Zod 校验

当前 `registerSqli.ts` 只有 `validateSqliParams()` 语义层检查，但没有像 `registerTemplate.ts` / `registerHttpReplay.ts` 一样，对：

- `request`
- `mutations`

执行 `validateOptionalParams(HttpRequestSchema/FuzzMutationsSchema)`。

此外需核对 `registerCrawl.ts` 是否存在应补而未补的复杂对象缺口；若无，则明确记录“核对完成，无需修改”。

## 执行顺序

### W0. 前置确认：框架未知键行为夹具

状态：已完成并固定证据。夹具已落到 `tests/contracts/drift/check-tool-parameter-framework-validation.mjs`。

目标：确认 Gap A 的实现路线。

已确认结论：

1. `Type.Boolean()` 对 `"true"` 会在框架 execute 前被转换为 `true`
2. `Type.Number()` 对 `"30"` 会在框架 execute 前被转换为 `30`
3. `additionalProperties:false` 在当前 Pi 框架链路里有效；未声明顶层字段会被 validator 响亮拒绝，而不是被静默 clean
4. `Literal union` 非法值会在框架层被响亮拒绝

因此 Gap A 的路线已冻结为：
- **路线 A：统一 schema helper (`strictToolParameters`)**
- 不需要走 execute 前 inspector 路线

影响文件：

- 新增一到两个小型 contract 文件（放在 `tests/contracts/drift/` 或 `tools/`）
- 如需说明，再同步 `docs/tool-parameter-contract-plan.md`

完成标准：

- Gap A 的路线不再靠推断，而是有仓库内可重复验证证据

### W1. 顶层参数名收口（Gap A）

目标：让顶层未知参数名响亮失败，而不是静默忽略。

#### 路线 A：`additionalProperties:false` 生效

实施项：

1. 新增统一 helper，例如：
   - `strictToolParameters(fields)`
   - 或在 `toolAdapter`/`toolShared` 提供等价 helper
2. 用该 helper 替换工具注册层裸 `Type.Object({ ... })` 的顶层参数定义
3. 范围覆盖：
   - 核心 browser 工具
   - WebSecurity tool register 层
4. 逐个核对：execute 中读取的字段必须都已在 schema 声明

#### 路线 B：框架会 clean 未知键

实施项：

1. 新增统一 inspector 挂点，在**工具 execute 入口前**或统一 shell 层对原始入参键集与 schema 声明键集比对
2. 发现未知顶层参数时：
   - 复用 `INVALID_RULE`
   - 在 `details` 中带 `unknownField` / `allowedFields`
   - 给出 `recovery.nextActions`
3. inspector 必须集中实现，不能散落到各工具手写

共同要求：

- 不处理复杂对象的内层未知字段；那一层继续交给既有 Zod strict/passthrough/open 分级
- 不破坏 verbatim 透传类对象的组合性

建议实现落点：

- 顶层 helper/inspector 应放在共享层：`src/tools/toolShared.ts` / `src/tools/toolAdapter.ts` / 新增专用模块
- 不允许每个工具各自发明实现

验证：

- 针对代表性工具传未声明顶层字段，断言响亮失败
- `npm run check:tools`
- `npm run check:web-security`
- `npm run check`

完成标准：

- 顶层参数名 typo 不再静默忽略
- 实现路径集中、可复用、可 contract 化

### W2. 枚举型参数收口（Gap B）

目标：让非法枚举值在框架层就响亮失败。

实施项：

1. 新增共享 helper，例如：
   - `enumParam(values, description)`
   - `enumOrEnumArrayParam(values, description)`
2. 替换已确认的裸字符串枚举：
   - `cookieMode`
   - `payloadMode`
   - `defaultScheme`
   - `locations`
   - `probeTypes`
   - `baselineStrategy`
   - `sniMode`
   - `knownFiles`
3. 扫描同目录/同层的同类“description 写了枚举，schema 仍是 `Type.String()`”参数；若发现同类项，在本合同内一并收口
4. 不改真正开放字符串参数，不滥用枚举

实现要求：

- 标量枚举用 `Type.Union([Type.Literal(...)])`
- 数组/单值混合枚举用统一 helper，成员也必须受限
- 描述文本与 schema 值保持同步，不能出现“文案一个集合、类型另一个集合”

验证：

- 非法枚举值 contract：
  - `cookieMode:"mrege"`
  - `defaultScheme:"ftp"`
  - `probeTypes:"blind"`
  - 等代表性错误值
- `npm run check:tools`
- `npm run check:web-security`
- `npm run check`

完成标准：

- 已确认枚举缺口全部收口
- 非法枚举值不再落到 execute 内再默默归桶

### W3. `browser_sqli` Zod 内层校验补齐（Gap C 窄）

目标：让 `browser_sqli` 与 `browser_template` / `browser_http_replay` / `browser_fuzz` 的复杂对象校验保持一致。

实施项：

1. 在 `src/tools/webSecurity/register/registerSqli.ts` 中补：
   - `validateOptionalParams(HttpRequestSchema, current.request)`
   - `validateOptionalParams(FuzzMutationsSchema, current.mutations)`
2. 视真实需要决定是否补 `booleanPayloadPairs` 的结构校验：
   - 只有在确认它主要作为对象构造输入且当前错误体验差时才补
   - 否则保持现状，不强行扩 scope
3. 核对 `src/tools/webSecurity/register/registerCrawl.ts`：
   - 如无复杂对象缺口，写明“已核对，无需修改”
   - 如有真实缺口，仅补最小必要校验

要求：

- 继续复用现有 Zod schema / middleware
- 不把复杂对象迁回 TypeBox
- 不新增错误码，继续用 `INVALID_BROWSER_COMMAND`

验证：

- 给 `browser_sqli` 传 `request:{ methdo:"GET" }`，断言响亮失败
- 给 `browser_sqli` 传带额外透传字段的 captured request，断言通过（若 schema 设计允许）
- `npm run check:web-security`
- `npm run test:unit`
- `npm run check`

完成标准：

- `browser_sqli` 的复杂对象校验与兄弟工具一致
- 无额外 schema 双源维护负担

### W4. 维持现有错误面，只补 details（必要时）

目标：不扩错误码，同时保证错误信息足够可操作。

实施项：

1. 保持：
   - `INVALID_BROWSER_COMMAND`：对象 shape / Zod 路径型错误
   - `INVALID_RULE`：存在性/互斥/模式语义错误
2. 仅在信息明显不足时补充 `details` 字段，例如：
   - `field`
   - `invalidValue`
   - `expected`
   - `allowedFields`
3. 继续复用 `recovery.nextActions`
4. 不修改 protocol taxonomy，不新增 generated docs 同步面

验证：

- `npm run check:errors`
- `npm run check:web-security`
- `npm run check`

完成标准：

- 参数错误能定位到字段/值/预期
- 不引入新的 protocol 维护面

### W5. （可选收尾）机制 clamp 留痕

此项不是主阻塞，但若实现成本低，可同批完成。

目标：对仍保留的机制型 clamp / fallback 留痕可见。

实施项：

- 对仍存在的 `orderByMax` / `harMaxEntries` / 同类 bounded 参数，在结果 `limits` 或 `diagnostics` 里回报“请求值 vs 实际值”
- 不对意图参数做静默修正留痕；意图参数应在 W1/W2/W3 被收紧后直接失败

验证：

- `npm run check:summaries`
- `npm run check:errors`

## 文档同步要求

至少同步：

- `CURRENT.md`
- `TODO.md`
- `CHANGELOG.md`

按范围同步：

- `README.md`（若用户可见参数行为/错误体验有变化）
- `docs/maintainer-map.md`（若新增统一 helper / inspector 入口）
- `docs/tool-boundaries.md`（仅当用户可见工具契约口径变化时）

如文档结构索引块受影响，再执行：

- `npm run docs:sync-indexes`

## 验证策略

### 分项窄门

- W0：新增最小 contract 夹具
- W1：`npm run check:tools && npm run check:web-security`
- W2：`npm run check:tools && npm run check:web-security`
- W3：`npm run check:web-security && npm run test:unit`
- W4：`npm run check:errors`
- W5：`npm run check:summaries && npm run check:errors`

### 最终门禁

- `npm run check`
- `npm run quality:local`

## 最终验收标准

只有同时满足以下条件，才算本合同完成：

1. Gap A：顶层未知参数名已能响亮失败（通过 schema helper 或 inspector 二选一）
2. Gap B：已确认的裸字符串枚举缺口全部收口
3. Gap C：`browser_sqli` 已补齐 `request/mutations` 的 Zod 内层校验，`browser_crawl` 已完成核对
4. 继续保持 TypeBox-外层 / Zod-内层 的既有分工，不产生双源 schema 漂移
5. 未新增参数错误码族
6. `npm run quality:local` 通过

## 收尾与归档

完成后：

1. 将 `CURRENT.md` 中该执行项改为已完成摘要
2. 结果迁入 `ARCHIVE.md` / `docs/archive/*`
3. 参数预设 / 工效学方向若继续推进，另立独立 RFC，不回写本合同
