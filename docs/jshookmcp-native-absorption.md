# jshookmcp Native Absorption Closure Plan

本文件定义 TODO 241 的闭环结果。jshookmcp 只作为能力发现来源；本包不复制其 AGPL 源码、文本、schema、payload、fixture、MCP registry 或 workflow。

## 完成定义

TODO 241 归档条件：

1. 每个已评审的 jshookmcp 浏览器相关能力都在能力账本中明确归类为：已由现有工具承载、由 `browser_hook` 增强承载、拒绝迁入、或独立 RFC。
2. eval 基线覆盖 5 个 jshookmcp 类 synthetic 任务，并记录现有工具路径、拟增强路径、call 数、成功率、恢复质量、artifact 可复现性。
3. 代码层只增强现有 canonical tools；本轮拒绝新增 `browser_sources`、`browser_debugger`、`browser_intercept`、`browser_storage`、`browser_canvas` 公开工具。
4. eval 证明需要实现的页面侧观察缺口只进入 `browser_hook` 显式 hook targets / 静态 target 展开；其它能力以 recipe、artifact/evidence、现有工具参数或拒绝记录闭环。
5. 所有 contract/docs/README/CHANGELOG 更新和验证命令完成。
6. 最终归档前执行公开工具面审计，确认未注册被拒绝的五个工具名，且没有未决“后续再说”的工程债。

## 非目标

- 不迁移 jshookmcp MCP 架构、registry、workflow、工具名、schema、payload、测试数据或文档结构。
- 不新增策略型黑盒工具、自动逆向、自动漏洞判断、stealth/captcha/human behavior、binary/process/memory/adb/frida 能力。
- 不恢复固定 DOM action 工具，不建立第二套 browser automation/debugging DSL。
- 不把 CDP domain 逐个提升为公开 `browser_*` 工具。

## 任务账本

| 任务 | 状态 | 交付物 | 范围 | 不做 | 验证与关闭条件 |
|---|---|---|---|---|---|
| TODO 241.1 决策冻结与边界文档 | 完成 | `CURRENT.md`、`ROADMAP.md`、`docs/tool-boundaries.md`、README、CHANGELOG、本文件 | 记录 OMO 结论、许可边界、公开工具拒绝清单、canonical mapping | 不改协议、不注册工具、不生成 dist | 文档互相引用一致；`rg` 能定位 TODO 241、拒绝工具名和 mapping |
| TODO 241.2 能力账本与 eval 准入 | 完成 | `evals/browser-workflows/11-15-jshook-*.md`、本地 fixtures、`evals/browser-workflows/jshook-closure-ledger.md` | 5 个本地 synthetic eval 覆盖 hook/source-map/storage/replay/canvas；记录工具序列、成功条件、证据、失败恢复点、指标 | 不访问外网、不启动 scanner/OAST、不写 strategy workflow | `npm run check:eval-workflows` 通过；每项结论为“已有工具闭环 / 需要 hook 增强 / 拒绝 / RFC” |
| TODO 241.3 `browser_hook` 原生增强 | 完成 | native schema、bridge service worker、generated protocol/docs、contracts、README/边界文档 | 新增 `browser_hook` actions：`listTargets`、`installTargets`；只展开静态显式 hook targets，返回 `expanded_targets`、boundary、拒绝策略 preset 诊断 | 不做 `all/auto/aggressive/ctf/exploit/stealth` preset；不做 storage CRUD、source map、Debugger pause、Fetch intercept | `npm run sync:protocol`、`npm run build:bridge`、`npm run docs:generate`、`npm run check` 通过；contract 覆盖 target 展开和拒绝策略名 |
| TODO 241.4 证据链与 artifact 闭环 | 完成 | `browser_evidence`/`browser_artifact` 继续作为事件和大证据闭环；eval specs 要求 artifact-first | 只补足 jshook 类任务的证据可复现性和隐私脱敏要求 | 不扩大默认采集面，不返回大源码/大 payload inline | 既有 artifact/redaction 合同 + jshook eval/closure 合同通过 |
| TODO 241.5 最终审计与归档 | 完成 | 本文件、CHANGELOG、CURRENT/ROADMAP、closure contract | 确认每项能力已有闭环结果 | 不保留开放式 TODO、占位工具、未验证文档承诺 | `rg`/contract 确认拒绝工具名未注册；`npm run check` 通过 |

## 能力归属表

| 能力类 | 归属 | 闭环结果 |
|---|---|---|
| 页面侧 JS API 观察、DOM sinks、console/error、storage/websocket/crypto/canvas events | `browser_hook` + `browser_evidence` + `browser_artifact` | 通过 `listTargets` / `installTargets` 实现 bounded static target expansion；事件继续进入 hook/evidence/artifact 链路 |
| 一次性 source/debugger/storage/runtime/CDP 读取 | `browser_execute` / `browser_frame` | 以 focused JS/CDP recipe 闭环；不足项只能单独 RFC，不进入 TODO 241 默认实现 |
| 被动 request/response/HAR 证据 | `browser_network` | 通过现有 recorder/evidence/artifact 闭环 |
| request replay、mutation、sequence、baseline delta | `browser_http_replay` 及 Web Security follow-up | 通过 replay eval 闭环；不新增 live intercept 公开工具 |
| JS endpoint、source map、service worker、OpenAPI/GraphQL hints | `browser_crawl` + `browser_artifact` | 通过 bounded crawl artifact 闭环；大源码/source-map 只走 artifact |
| storage 内容证据 | `browser_execute` focused JS/CDP + `browser_hook` storage events + artifact | 不新增 `browser_storage`；CRUD/state 专用工具需另开 RFC |
| canvas/WebGL 页面感知 | `browser_hook` events + `browser_screenshot`/`browser_execute` focused read | 不新增 `browser_canvas`；复杂 scene/hit-test 需另开 RFC，无 solver 语义 |
| Debugger pause/breakpoint/scope workflow | `browser_command` for one-shot CDP only | 独立 RFC-only；本轮不新增 `browser_debugger` |
| stealth/captcha/human behavior、macro workflow、LLM deobfuscation、binary/process/memory/frida/adb | 无 | 拒绝迁入 |

## 新公开工具 RFC 准入

任何被 TODO 241 拒绝或未覆盖的新公开工具必须重新进入 RFC，且同时满足：

- 有 eval 数据证明现有 canonical tools 无法以可接受 call/token/恢复成本完成任务。
- 给出非重叠边界、contract、budget、summary、artifact、privacy、cleanup 和 rollback 方案。
- 更新 `CURRENT.md`、`docs/tool-boundaries.md`、README、CHANGELOG、global skill、contracts 和 smoke。
- 未实现前不得注册工具名或生成文档承诺。
