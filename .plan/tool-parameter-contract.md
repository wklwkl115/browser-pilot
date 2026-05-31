# 工具层参数契约方案（可靠性）v2

> 独立方案。目标:消除"参数写不对→工具起不来 / 拿到错结果"。
> **v2 修订(基于重扫真实现状):** 仓库已形成成熟的双层校验模式,原 v1 的缺口盘点已过期,且 P3/P4/P6 与现状冲突。本版收窄到真实缺口,对齐既有模式。
> 核心立场不变:**不是"补一层校验"(会和现有两层重复),而是把少数被放宽的 schema 收紧,让已有校验生效。**

---

## 0. 现状:已经有两层校验,各司其职(动工前必须认清)

### 第一层 —— TypeBox(外层工具契约,框架 execute 前强制)

Pi 框架在 execute **之前**对 `tool.parameters`(TypeBox)做 `Value.Convert + Compile.Check`(已最小复现确认:`tabId:{}` → `executeCalled=false`,框架直接报错)。因此:

- **严格标量已被框架保护:** `Type.Boolean`(allowPrivateTargets/followRedirects/bindBrowserSession)、`Type.Number`(timeoutMs/maxBodyBytes)、`Type.Union([Literal])`(mode/engine/action)——非法值被 `Value.Convert` 归一或被 `Check` 响亮拒绝。对这些再校验 = 重复,不做。
- `Value.Convert` 是盟友(`"true"`→`true`),不对抗;`prepareArguments()` 在校验前、属框架内部,不碰。

### 第二层 —— Zod(复杂对象 runtime validation,execute 内,已落地)

`src/validation/{middleware,schemas}.ts`(Zod 4)+ `validateOptionalParams()` 已在 **4 个工具**对复杂对象做内层校验:

| 工具 | 已校验的复杂对象 | 用的 Zod schema |
|---|---|---|
| `registerFuzz` | request / mutations / jsonValues | HttpRequestSchema / FuzzMutationsSchema / JsonValuesSchema |
| `registerHttpReplay` | request / multipart / mutations / variables | HttpRequestSchema / MultipartSchema / FuzzMutationsSchema / VariablesSchema |
| `registerTemplate` | request / mutations / templates / variables / tech | HttpRequestSchema / FuzzMutationsSchema / TemplatesSchema / VariablesSchema / TechHintsSchema |
| `registerCookieAnalyze` | cookies / setCookies / claimMutations / claimReplay | CookiesInputSchema / ClaimMutationsSchema |

**关键:Zod 层已经实现了"按数据来源分级"的精确策略**(这正是 v1 想在 TypeBox 重造的东西,但 Zod 做得更好):

- **构造型对象 → `.strict()`**:`HttpRequestSchema`、`MultipartSchema`、`FuzzMutationsSchema`。**typo 的内层键已被拒绝**(`request:{methdo}` → "Unrecognized key")。→ **Gap C 对这些工具已关闭。**
- **摄取型对象 → `.passthrough()`**:`CookieSchema`(注释明写 "Allow additional browser-specific fields")、`TemplateSchema`。verbatim 透传 browser_network 捕获不破——**组合性已保住。**
- **真开放对象 → `z.record(z.string(), z.unknown())`**:`ClaimMutationsSchema`(JWT claims)、`VariablesSchema`、`JsonValuesSchema`、`TechHintsSchema`。

**错误表达已经够用:** `validateOptionalParams` 失败抛 `BrowserBridgeError('INVALID_BROWSER_COMMAND', "Parameter validation failed: request.method: Expected string, received number", { validationErrors, received })`——路径前缀 + 具体原因 + details,可操作。语义/存在性校验(`validateXxxParams`)走另一码 `INVALID_RULE` + `recovery.nextActions`。**两类错误、两个码、都带 details,已成体系。**

---

## 1. 真实缺口(重扫后,只剩三处,且都很窄)

### Gap A —— 顶层无 `additionalProperties:false`(`src/` 中仍 0 处)

typo 的**参数名**被静默忽略:`browser_sqli({ urls:"..." })`(本意 `url`)→ `urls` 被无视、`url` 缺失 → 错结果。这是 agent 最高频、最不可见的错误,**与 Zod 内层校验无关**(Zod 只管被声明的复杂对象内部,管不到顶层未知键)。**仍是最高杠杆缺口。**

### Gap B —— 本质枚举却写成裸 `Type.String()`(顶层契约,Zod 不覆盖)

| 参数 | 位置 | 合法值 | 现状 |
|---|---|---|---|
| `cookieMode` | shared.ts:119 | merge\|replace\|preserve | 裸 String ❌ |
| `payloadMode` | registerSqli:40 | append\|replace | 裸 String ❌ |
| `defaultScheme` | crawl/fuzz/httpReplay/template + shared:146 | http\|https | 裸 String ❌ |
| `locations` | registerFuzz:61 / registerSqli:37 | query\|json\|form\|multipart\|header\|all | 宽 union ❌ |
| `probeTypes` | registerSqli:39 | boolean\|error\|time\|union\|all | 宽 union ❌ |

正例:`registerCallbackOast.ts:35` 的 `mode` 已是 `Type.Union([Literal])`。**同项目有正确做法,只是没贯彻。** 你已明确认可"裸字符串枚举收紧"。

### Gap C(收窄)—— Zod 内层校验的覆盖缺口,**只剩 sqli(+核对 crawl)**

- **`registerSqli.ts` 根本没调用 `validateOptionalParams`**(只有 `validateSqliParams` 做存在性/互斥)。它的 `request`/`mutations`(来自 `rawRequestParams`,`additionalProperties:true`)与 fuzz/template/httpReplay **同形**,却没跑 `HttpRequestSchema`/`FuzzMutationsSchema`。→ sqli 是唯一 `request:{methdo}` 会被静默接受的工具。**这是真正的不一致缺口。**
- **`registerCrawl.ts`** 只有 `validateCrawlParams`,需核对它是否有应校验的复杂对象(headers 已是 TypeBox Record,可能无缺口)。
- `registerCallbackOast` 的 `externalMetadata`(`additionalProperties:true`)是 provider 自定义元数据,属"真开放",**保留开放,不算缺口**(与 TechHints 同理)。

**所以 Gap C 不是"全量回迁",而是"补 sqli 这一个工具的 Zod 调用,与它的兄弟一致"。**

---

## 2. 设计原则:机制 vs 意图 × 三层校验边界

| 参数类别 | 谁来保护 | 我们要做的 |
|---|---|---|
| 机制参数(timeout/maxChars/orderByMax/threads...) | TypeBox 严格标量 → 框架已保护 | 不重复;残余 clamp/drop 留痕可见(P5,可选) |
| 意图·顶层标量(url/engine/cookieMode...) | 严格标量已保护;**裸 string 枚举未保护** | 收紧成 `Union([Literal])`(Gap B) |
| 意图·顶层名字 | **无人保护**(顶层未设 `:false`) | 顶层收紧 / 未知名拦截(Gap A) |
| 意图·复杂对象(request/mutations/templates...) | **Zod 已保护(strict/passthrough/open 分级)**,仅 sqli 漏调 | 补 sqli 的 Zod 调用(Gap C 窄) |

一句话仍是:**机制——藏 + 容忍;意图——显式 + 收紧到响亮失败。但"收紧"要分别落到正确的层:顶层名字与枚举落 TypeBox,复杂对象落已有的 Zod,绝不跨层重造。**

---

## 3. 实施方案(收窄后)

### P0. 确认 `Value.Clean` 行为(前置门,~30 分钟)

框架是否在 `Check` 前运行 `Value.Clean`(剥离未知属性)?决定 Gap A 修法。复现:任意工具传 `{ url:"x", bogusField:1 }` → 响亮报错 = `additionalProperties:false` 有效;静默成功 = Clean 已剥离,需换 inspector 钩子。

### P1. 顶层未知字段响亮拒绝(Gap A,最高杠杆)

- 若 `:false` 有效:封装 `toolParameters(fields)` helper(替代裸 `Type.Object(fields)`),内部统一加 `additionalProperties:false`,集中保证不漏。
- 若框架 Clean 剥离了未知键:加 execute 前轻量 inspector,对比原始 args 键集与声明键集,未知键 → 复用 `INVALID_RULE` + `recovery.nextActions`("unknown param 'urls', did you mean 'url'?")。
- **安全:** 顶层参数名永远 LLM 现编,无 verbatim 透传,`:false` 安全。
- **回归核对(必做):** 逐 register 确认"execute 读取的字段 ⊆ schema 声明的字段"再开;合并工具(sqli 等)声明了 builtin+sqlmap 全集,子集调用不受影响。
- **验证:** 契约测试——每工具传未声明字段,断言响亮报错且消息含字段名。

### P2. 枚举精确化(Gap B,顶层 TypeBox)

- 标量枚举(cookieMode/payloadMode/defaultScheme)→ `Type.Union([Literal])`。
- 列表枚举(locations/probeTypes)→ 新增 `enumOrEnumArrayParam(values, desc)` helper,替换枚举场景的 `stringOrStringArrayParam`,成员受限。
- 收益:框架自动拒绝 `cookieMode:"mrege"`,消息 `must be one of ...`——**零自定义代码**;散文约束升级为类型约束(AGENTS.md 第 29 行)。
- **验证:** 契约测试——每枚举参数传非法值,断言框架响亮拒绝。
- **注:** 在 P0 一并验证 `Value.Convert` 对 Literal-union 的归一行为(大小写/裸值),决定是否需统一小写。

### P3(收窄). 补 sqli 的 Zod 内层校验,与兄弟工具一致

- **不迁移、不双源。** 保持 TypeBox-外层 / Zod-内层 的既有模式。
- `registerSqli.ts` 的 execute 内,对 `request`/`mutations` 加:
  ```ts
  validateOptionalParams(HttpRequestSchema, current.request);
  validateOptionalParams(FuzzMutationsSchema, current.mutations);
  ```
  与 `registerTemplate`/`registerHttpReplay` 完全对齐。复用现有 `INVALID_BROWSER_COMMAND` 错误路径,零新增。
- 核对 `registerCrawl` 是否有应校验的复杂对象;有则同法补,无则跳过。
- `booleanPayloadPairs`(sqli 的开放 union):若属"构造型",可定义一个 `BooleanPayloadPairsSchema`(`.strict()` 的 {truePayload,falsePayload})补校验;若沿用字符串语法,保持现状 + 文档。按实际用法定,**非必须**。
- **验证:** 契约测试——sqli 传 `request:{methdo:"GET"}` 断言响亮拒绝(与 template 行为一致);传 browser_network 捕获(passthrough 字段)断言通过。

### P4(改). 复用现有错误表达,**不新增错误码**

- **撤销 v1 的 `UNKNOWN_PARAM/MISSING_REQUIRED_PARAM/INVALID_PARAM_VALUE/PARAM_CONFLICT`。** 这组扩码会放大 protocol / generated docs / contracts / CHANGELOG / README / skill 的同步面(AGENTS.md 第 72 行),收益不抵成本。
- 现状已有两码覆盖两类:`INVALID_BROWSER_COMMAND`(Zod shape,路径前缀消息 + validationErrors)、`INVALID_RULE`(语义存在性/互斥 + recovery.nextActions)。**够用。**
- 仅在**现有表达明显不足**时,在 `details` 内补结构化字段(如 `details.field`、`details.invalidValue`、`details.expected`),仍走旧码、零协议churn。
- 保留并标准化 `validateXxxParams`(存在性/互斥),这是框架做不到的语义层,本就不重复。

### P5(可选,低优先). 残余 coercion 留痕

经 P2 收紧后,多数枚举已不再静默 drop。仅对仍存在的机制 clamp(`orderByMax` 顶 64、`harMaxEntries` 顶 100)在结果 `limits` 里回报"请求 N,实际 M"。**机制可被改但要可见;意图经收紧后失败而非被改。** 范围小,可并入其他改动或后置。

### ~~P6. profile 预设~~ → **移出本方案**

profile 预设属**工具工效学/产品层**设计,不是"参数写错→起不来/错结果"的可靠性核心,且改变 agent 调用习惯、需 eval 门控。**另立 RFC:`tool-ergonomics-presets.md`(eval 驱动)**,与本方案解耦。

---

## 4. 实施顺序

```
P0  确认 Value.Clean / Convert-on-union          ← 前置门
P1  顶层未知字段拦截 (Gap A)                       ← 最高杠杆, 治"typo 参数名→错结果"
P2  枚举精确化 (Gap B, TypeBox Union[Literal])     ← 治"非法枚举值静默归桶"
P3  补 sqli(+核对 crawl) 的 Zod 调用 (Gap C 窄)    ← 补一致性, 不迁移
P4  复用现有错误码 + 按需补 details                ← 不扩码
P5  (可选) clamp 留痕
```

P1-P3 是核心。每阶段后 `npm run quality:local` + 补契约测试。

---

## 5. 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| 框架运行 `Value.Clean` 剥离未知键,`:false` 失效 | P1 主路线作废 | P0 先确认;失效则改 inspector 钩子 |
| `:false` 暴露某工具读取未声明字段 | P1 上线即报错 | 逐 register 核对"读取 ⊆ 声明"后再开 |
| `Value.Convert` 对 Literal-union 行为未知 | P2 归一不如预期 | P0 一并验证;必要时枚举统一小写 + 文档 |
| sqli 补 Zod 后,历史调用传了 HttpRequestSchema 不接受的字段 | sqli 调用回归 | 与 template/httpReplay 同 schema,已在生产用;先跑 smoke/eval 比对 |
| crawl 误判有/无复杂对象缺口 | 漏补或多改 | P3 先核对再动手 |

---

## 6. 不做的事(对齐现状 / 避免重复与越界)

1. **不重复框架的形状/类型校验**(严格标量已被 `Value.Convert + Check` 保护)。
2. **不把复杂对象迁回 TypeBox**——保留 TypeBox-外层 / Zod-内层 的成熟分工,避免双源维护。Zod 已实现 strict/passthrough/open 分级,比 TypeBox 表达更准。
3. **不新增参数错误码**——复用 `INVALID_BROWSER_COMMAND` / `INVALID_RULE` + details + recovery.nextActions;仅在明显不足时补 details 字段。
4. **不广泛对抗 `Value.Convert`,不碰 `prepareArguments()`。**
5. **不隐藏意图/范围参数**(allowPrivateTargets 永远显式 + 响亮校验)。
6. **profile 预设不在本方案**,另立 eval 驱动的 RFC。
7. **不把校验散回各工具**——顶层收紧用共享 helper,复杂对象沿用 Zod,壳层统一。

---

## 7. 一句话总结

仓库已有两层校验各司其职:TypeBox 外层(框架 execute 前强制,保护严格标量)+ Zod 内层(复杂对象 runtime,已实现 strict/passthrough/open 分级)。所以真实缺口只剩三处很窄的地方:**①顶层未拦未知参数名(Gap A,最高杠杆)、②枚举写成裸 string(Gap B,顶层收紧)、③ sqli 漏调 Zod(Gap C,补一致性)**。修法是收紧这三处让已有校验生效,**不迁移、不扩码、不做预设**——预设另立 RFC。机制参数藏+容忍,意图参数显式+收紧到响亮失败。
