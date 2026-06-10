# ESLint 遗留债务 Ratchet 执行合同

> Status: completed execution contract.
> 本文取代 `.plan/lint-debt-ratchet.md` 作为唯一执行合同；`.plan/...` 仅保留为讨论输入，不再直接作为执行源。

## 目标

在不扩公开 `browser_*` 工具面、不引入格式化器、不把“严格类型 RFC”混入本轮的前提下，分批清零当前 ESLint warn backlog，并按规则族逐类把 `warn` 收紧为 `error`，最终把 ESLint 从“非阻断信号”收紧为“可阻断防线”。

本合同只覆盖当前已启用且已产生告警的规则族，不追加 `no-unsafe-*` / `@typescript-eslint/no-explicit-any` 一类新方向。

## 执行前基线与完成结果

执行前仓库 ESLint 入口与行为已核对：

- `eslint.config.js` 为 flat config，分别对 `src/**/*.ts` / `bridge_src/**/*.ts` / `mcp/**/*.ts` 做 type-aware 解析。
- 债务规则执行前全部是 `warn`；`npm run lint` 默认不阻断。
- `lefthook.yml` 的 `pre-commit` 会对 staged 源文件执行 `npx eslint {staged_files}`。
- `.github/workflows/check.yml` 的 `lint-static` job 会执行 `npm run lint`，执行前保留 `continue-on-error: true`。
- `package.json` 里的 `check:lint` 是 boundary / page-script contracts，**不是** ESLint debt gate；本合同不改它的职责。

执行完成结果：

- `npm run lint` = **0 errors / 0 warnings**。
- 本合同内规则族已在 `eslint.config.js` 从 `warn` 收紧为 `error`。
- `.github/workflows/check.yml` 的 `Run ESLint` 步骤已移除 `continue-on-error: true`，转为阻断。
- `lefthook.yml` 的 staged ESLint 增加 `--no-warn-ignored`，保持 pre-commit 可用性。

执行前基线：

- `npx eslint . -f json` = **0 errors / 172 warnings / 56 files**

按规则分布如下：

| 规则 | 数量 | 性质 | 热点文件 |
|---|---:|---|---|
| `no-empty` | 94 | silent-catch 债 | `hook_dispatcher.ts`(25)、`wait_coordinator.ts`(8)、`ws.ts`(7)、`network.ts`(5)、`wait.ts`(5)、`wsSession.ts`(4) |
| `@typescript-eslint/no-unused-vars` | 36 | 死代码/遗留导出 | `wait.ts`(4)、`resultMiddleware.ts`(4)、`network_model.ts`(3)、`register/shared.ts`(3) |
| `@typescript-eslint/no-misused-promises` | 8 | async 安全 | `transfer.ts`(4)、`runtime.ts`、`wait_navigation.ts`、`mcp/index.ts`、`BrowserBridgeClientMessageService.ts` |
| `preserve-caught-error` | 5 | 错误链 | `callbackOastWorker.mjs`(3)、`oastWorkerManager.ts`(2) |
| `@typescript-eslint/no-floating-promises` | 3 | async 安全 | `bridge_info.ts`、`router.ts`、`wait_selector.ts` |
| `prefer-rest-params` | 7 | 机械类 | `hook_dispatcher.ts`(6)、`disable_dialogs.ts` |
| `prefer-const` | 4 | 机械类 | `hook_dispatcher.ts`(2)、`transfer.ts`、`BrowserBridgePendingRequests.ts` |
| `no-useless-escape` | 4 | 机械类 | `replay.ts`(2)、`dom_flow.ts`、`artifactReader.ts` |
| `no-useless-assignment` | 4 | 机械类 | `ws.ts`(2)、`hook.ts`、`wait_selector.ts` |
| `no-fallthrough` | 2 | 需复核 | `webSecurity/shared/http.ts` |
| `@typescript-eslint/no-unsafe-function-type` | 2 | 类型边界 | `hook_dispatcher.ts` |
| `no-sparse-arrays` | 1 | 需复核 | `wait_network_idle.ts` |
| `@typescript-eslint/no-unused-expressions` | 1 | 需复核 | `webSecurity/shared/jsAst.ts` |
| `no-control-regex` | 1 | 需复核 | `webSecurity/shared/normalize.ts` |

## 行为边界

允许的可观察变化仅限：

1. 原本被空 `catch {}` 吞掉的路径，改为显式注释、显式诊断或显式失败；
2. async 悬空/误用 Promise、错误链丢失、switch 落空等真实风险被修正；
3. 死代码、无用赋值、无用 escape、`Function` 宽类型等低价值噪声被清理；
4. 随着某一规则族清零，该规则在 `eslint.config.js` 中从 `warn` 收紧到 `error`；
5. 仅在所有本合同内规则族清零后，`.github/workflows/check.yml` 中 `npm run lint` 步骤才移除 `continue-on-error: true`，转为真正阻断。

除上述范围外，不主动引入工具契约、协议、runtime 行为或公开文档语义漂移。

## 非目标

- 不引入 Prettier / Biome / 其他格式化器。
- 不开启 `no-unsafe-*` 家族，不启用 `recommendedTypeChecked` 的更大噪声面。
- 不把 `@typescript-eslint/no-explicit-any` 纳入本轮债务。
- 不以新增 ignore、全局 disable、局部 `eslint-disable` 批量压告警代替真实修复。
- 不执行全仓 `eslint . --fix`；只允许**文件级或规则级**的有界 autofix，且必须绑定当前修改范围。
- 不把 `check:lint` 改造成 ESLint 入口，也不在本合同内重命名其现有 contracts 语义。
- 不在未确认源码归属前，顺手把 `bridge/pi_browser_bridge/popup.js` 强行纳入 lint。

## Ratchet 机制

每一类规则都遵循同一套收口顺序：

1. 清零该规则族当前全部命中；
2. 用 `npm run lint` 确认对应规则计数归 0；
3. 在 `eslint.config.js` 中把该规则从 `warn` 改为 `error`；
4. 仅在该类真正清零后才允许提交该 ratchet。

说明：

- 某条规则切到 `error` 后，本地 `pre-commit` 对新回归会立刻阻断；
- 在最终全量清零前，CI 中 `npm run lint` 步骤仍可暂时保留 `continue-on-error`，以避免在 backlog 未清空前把整个仓库全局阻断；
- 最终“转阻断”只针对 workflow 里的 ESLint step，不涉及 `check:lint` 语义变更。

## 实施顺序

### W0. 执行入口收口

范围：

- `docs/lint-debt-ratchet-plan.md` 作为正式执行合同
- `CURRENT.md` / `TODO.md` / `CHANGELOG.md` 记录计划入口与边界

要求：

- 后续实现、评审、归档一律引用本文
- `.plan/lint-debt-ratchet.md` 不再作为 source of truth

### W1. 正确性类优先收口

范围：

- `@typescript-eslint/no-misused-promises`
- `@typescript-eslint/no-floating-promises`
- `preserve-caught-error`
- `no-fallthrough`
- `no-sparse-arrays`
- `@typescript-eslint/no-unused-expressions`
- `no-control-regex`

原则：

- 逐处人工复核，不做机械替换。
- Promise 问题必须按真实生命周期修复：`await`、显式 `void`、包装同步回调、调整 API 期望签名，按具体语义选最小正确方案。
- `preserve-caught-error` 一律补真实错误链，优先 `{ cause }` 或等价事实字段，不吞原始异常。
- `no-fallthrough` 只能二选一：补 `break/return`，或显式 `// falls through` 注释并确保行为有意。
- `no-sparse-arrays`、`no-unused-expressions`、`no-control-regex` 必须确认不是语义 bug 再定稿。

热点：

- `bridge_src/service_worker/transfer.ts`
- `bridge_src/service_worker/bridge_info.ts`
- `bridge_src/service_worker/wait_selector.ts`
- `bridge_src/service_worker/wait_navigation.ts`
- `mcp/index.ts`
- `src/driver/BrowserBridgeClientMessageService.ts`
- `src/tools/webSecurity/shared/http.ts`
- `src/tools/webSecurity/browserNative/callbackOastWorker.mjs`
- `src/tools/webSecurity/browserNative/oastWorkerManager.ts`

收口后 ratchet：

- 以上规则全部从 `warn` → `error`

验证：

- `npm run lint`
- `npm run check:all:bridge`
- `npm run check:web-security`
- `npm run test:unit`

### W2. 低风险机械类收口

范围：

- `prefer-const`
- `prefer-rest-params`
- `no-useless-escape`
- `no-useless-assignment`
- `@typescript-eslint/no-unsafe-function-type`

原则：

- 允许使用**文件级或规则级** bounded autofix；禁止执行全仓 `eslint . --fix`。
- `prefer-rest-params` 与 `no-unsafe-function-type` 虽偏机械，但仍要保持 page script / bridge 注入边界不变，不为了过 lint 擅自改变调用协议。
- `no-useless-assignment` 必须确认不是为了中间态诊断或后续分支保留的赋值。

热点：

- `bridge_src/page_scripts/hook_dispatcher.ts`
- `bridge_src/content/disable_dialogs.ts`
- `bridge_src/service_worker/ws.ts`
- `bridge_src/service_worker/hook.ts`
- `bridge_src/service_worker/transfer.ts`
- `src/tools/artifactReader.ts`
- `src/tools/webSecurity/shared/replay.ts`
- `src/tools/summaries/webSecurity/domFlow.ts`

收口后 ratchet：

- 以上规则全部从 `warn` → `error`

验证：

- `npm run lint`
- `npm run check:all:bridge`
- `npm run test:unit`

### W3. `no-empty` / silent-catch 债收口

范围：

- 当前 94 条 `no-empty`

原则：

- 复用现有 runtime hardening 分类，不把所有空 `catch` 一律改成同一种处理：
  - A 类：确属 best-effort cleanup / tab 已关闭 / listener 已不存在 / WS 已断开，可保留但必须写出事实性注释，例如 `/* best-effort: tab already closed */`；
  - B 类：应可见的失败（如 storage / file I/O / CDP / DNR / recovery 主路径）必须至少 `console.warn(...)` 或回传结构化诊断，不能只靠注释消音；
  - C 类：关键路径失败必须上抛或转结构化错误，不能注释掩盖。
- 对已被 `H-002` 治理覆盖的 runtime 主路径，lint 收口必须服从该路径的真实错误语义，禁止为了清 warning 退化为“只加注释”。
- 先清热点文件，再扩到同类文件，避免全仓扩散式修改。

优先文件：

1. `bridge_src/page_scripts/hook_dispatcher.ts`
2. `bridge_src/service_worker/wait_coordinator.ts`
3. `bridge_src/service_worker/ws.ts`
4. `bridge_src/service_worker/network.ts`
5. `bridge_src/service_worker/wait.ts`
6. `src/tools/webSecurity/shared/wsSession.ts`

收口后 ratchet：

- `no-empty` 从 `warn` → `error`

验证：

- `npm run lint`
- `npm run check:all:bridge`
- `npm run check:web-security`
- `npm run test:unit`

### W4. `no-unused-vars` 死代码与遗留导出收口

范围：

- 当前 36 条 `@typescript-eslint/no-unused-vars`

原则：

- 优先删除真实死代码；只有在保留参数位/签名兼容性确有必要时，才允许使用 `_` 前缀。
- 删除前先确认不是契约、再导出或外部消费入口。
- 特别关注以下疑似重构残留：
  - `src/tools/resultMiddleware.ts` 的 `summarize*` re-export
  - `src/tools/webSecurity/register/shared.ts` 的 `STRING_OR_*` 常量
  - `bridge_src/service_worker/network_model.ts` 与 `wait.ts` 的局部遗留绑定

收口后 ratchet：

- `@typescript-eslint/no-unused-vars` 从 `warn` → `error`

验证：

- `npm run lint`
- `npm run check:all:bridge`
- `npm run check:web-security`
- `npm run test:unit`
- `npm run check`

### W5. 最终 gating 收口

前提：

- 本合同内所有规则族已清零；
- `eslint.config.js` 中对应规则均已切到 `error`；
- `npm run lint` 无 warning / error。

实施项：

1. `.github/workflows/check.yml` 中 `Run ESLint` 步骤移除 `continue-on-error: true`，转为阻断；
2. 如 pre-commit 因 ignored file 噪声影响可用性，在同批次把 `lefthook.yml` 的 lint 命令补成 `--no-warn-ignored`；
3. 若 README 中仍写着“ESLint baseline non-blocking”，同步改成当前真实 gating 口径。

明确不做：

- 不在 W5 顺手开启新的 ESLint 规则族；
- 不把 `check:lint` 改名或并入 `npm run lint`。

验证：

- `npm run lint`
- `npm run check`
- `npm run quality:local`

## 验证矩阵

按修改范围执行最窄充分验证：

- 任何阶段：`npm run lint`
- 触及 `bridge_src/**`、`src/driver/**`、page script / service worker 运行链：`npm run check:all:bridge`
- 触及 `src/tools/webSecurity/**`：`npm run check:web-security`
- 触及 `src/**` 逻辑或错误传播：`npm run test:unit`
- 阶段性全量回归：`npm run check`
- 最终门禁：`npm run quality:local`

## 文档同步要求

- 至少同步 `CURRENT.md`、`TODO.md`、`CHANGELOG.md`。
- 若 `eslint.config.js`、`lefthook.yml`、`.github/workflows/check.yml` 的行为口径变化影响维护者入口，同步 `README.md`。
- 若索引块结构发生变化，再执行 `npm run docs:sync-indexes`；本合同本身不要求为新增计划文档单独跑索引同步。

## 最终判定标准

- 本合同内全部规则族计数清零；
- 对应规则已在 `eslint.config.js` 中从 `warn` 收紧为 `error`；
- `.github/workflows/check.yml` 中 `npm run lint` 步骤已转为阻断，不再 `continue-on-error`；
- 未执行全仓 `eslint . --fix`，未通过新增 ignore / disable 机械压平告警；
- 额外 `no-unsafe-*` 与 `@typescript-eslint/no-explicit-any` 仍保持本合同外；基线已有的 `@typescript-eslint/no-unsafe-function-type` 已按合同收口；
- `npm run quality:local` 通过。
