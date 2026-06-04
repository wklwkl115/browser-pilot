# Artifact + JS Bundle Readability Execution Plan

> **Status: ACTIVE — opened 2026-06-04.** 用户显式切换到浏览器工具工程优化。目标是修复真实使用中暴露的通用短板：压缩 JS / 大 artifact 难读、source map 后续检索链不顺、JS AST 对大包不友好、hook 安装状态偶发不顺。不得过拟合单个 CTF 站点。

## Decision source

用户方向（2026-06-04）：基于真实使用反馈优化 browser 工具，但必须先把方案落成执行合同再编码。

已观察到的代码事实：

- `src/tools/artifactReader.ts` 当前按行读取/搜索；单行压缩 JS 命中时只返回行前缀，命中点可能不可见。
- `src/tools/webSecurity/shared/jsAstArtifact.ts` 当前 `JS_AST_MAX_INPUT_BYTES = 2 * 1024 * 1024`，整文件 AST 不适合现代大 bundle。
- `src/tools/webSecurity/browserNative/crawlExtractors.ts` 已归档 source map `sourcesContent`，但缺少后续检索友好的 manifest / preferred reads。
- `bridge_src/service_worker/hook.ts` 的 hook recovery 是 status-only；install/reinstall/fingerprint 场景可更幂等。
- `src/tools/registerExecuteTool.ts` 适合页面动作与小 JS，不应承担大文件分析。

## Goal

提升现有 canonical tools 的通用可用性：

- `browser_artifact` 能稳定定位、读取单行/超长行/压缩 JS 的命中窗口。
- `browser_crawl` 的 source map 归档链能直接进入后续 artifact 搜索与 JS 分析。
- `/browser-js-ast` 保持 internal-only，但对大 JS 有明确降级路径。
- `browser_hook installTargets` 对重复安装、版本/目标一致性和恢复状态给出可复用诊断。

## Non-goals

- 不新增公开 `browser_*` 工具。
- 不新增 XSS/CTF 专用扫描器。
- 不恢复任何 withdrawn 的 source/debugger/intercept 类公开工具面。
- 不把战略判断、漏洞评级、站点特化 payload 写进工具。
- 不让 `browser_execute` 成为大 JS/大 artifact 分析工具。

## Public contract changes

允许扩展既有 `browser_artifact` 参数；保持所有旧参数和输出字段兼容。

候选新增参数：

- `contextChars?: number`：`mode=search` 命中行内窗口大小。
- `columnOffset?: number`：`mode=text` 时从目标行的字符列偏移开始读取。
- `columnLimit?: number`：`mode=text` 时限制目标行内读取长度。

候选新增 snippet 字段：

- `columnStart`
- `columnEnd`
- `lineLength`
- `truncatedBefore`
- `truncatedAfter`

字段只补充，不删除旧字段。

## Phase plan

### P0 · Activate execution contract

- [x] 新增本执行合同。
- [x] 更新 `CURRENT.md` 当前激活项。
- [x] 更新 `TODO.md` 顶层导航。

Gate:

- 文档结构仍保持 compact；无代码行为变化。

### P1 · `browser_artifact` long-line/window support

> Status: COMPLETE — implemented with long-line search windows, text column windows, single-line sample windows, tool schema/docs, and artifact reader contracts.

实现范围：

- `src/tools/artifactReader.ts`
  - 搜索命中返回命中附近字符窗口，而非只返回行前缀。
  - 对普通 substring 与 regex 都返回列信息。
  - `text` 支持 `columnOffset/columnLimit`。
  - `sample` 对单行大文件返回 head/middle/tail 字符窗口，避免三段都退化为同一前缀。
  - 多文件搜索复用同一 snippet 结构。
- `src/tools/registerArtifactTool.ts`
  - 加参数 schema 与描述。
- contracts/tests/docs/skill 同步。

Acceptance:

- 单行 1MB JS 中搜索 `innerHTML`，返回片段必须包含命中字符串。
- `contextChars` 增大时返回窗口变大，但仍受 `maxChars` 总预算约束。
- 旧的 line-based offset/limit 行为不回归。
- redaction 仍作用于最终 snippet。

Gate:

- `npm run check:artifact`
- `npm run check:tool-docs`
- `npm run check:protocol`

### P2 · Source map archive manifest + artifact hints

> Status: COMPLETE — source map manifests are written beside archived sources and crawl summaries expose `sourceMapManifests` plus preferred reads.

实现范围：

- `src/tools/webSecurity/browserNative/crawlExtractors.ts`
  - 为每个 parsed source map 写入 manifest artifact。
  - manifest 记录 map URL、sourceName、artifactPath/relativePath、bytes、sha256、endpointHintCount。
- `src/tools/summaries/webSecurity/crawl.ts`
  - 暴露 source map manifest / archived sources / endpoint hints preferred reads。
- tests/contracts 覆盖 artifact hint 与 manifest 结构。

Acceptance:

- `browser_crawl` 发现 source map 后，summary 能直接指向 manifest。
- agent 可通过 `browser_artifact mode=search root=<crawl-dir> glob=source-maps/**/*.js` 搜源。
- 不扩大 crawl 默认网络范围。

Gate:

- `npm run check:web-security`
- `npm run check:summaries`
- `npm run check:all:contracts`

### P3 · `/browser-js-ast` large-bundle graceful fallback

> Status: COMPLETE — large default-bounded inputs return lexical inventory, explicit `maxBytes` still rejects, and `/browser-js-ast` supports `--slice offset:length`.

实现范围：

- 保持 `/browser-js-ast` internal-only，不新增公开 tool。
- 对超过 AST 上限的输入返回结构化错误或自动 lexical inventory，二选一需在实现前固定。
- 优先方案：新增 internal lexical inventory：扫描 endpoints/sinks/storage/eval/sourceMappingURL，不构建 TS AST。
- 支持显式 slice：只分析本地文件的指定 byte/char 范围，避免整包 parse。

Acceptance:

- 大 bundle 不再只给 `JS_AST_INPUT_TOO_LARGE` 死路；必须给可执行恢复动作。
- 小 JS 的现有 AST summary 不回归。
- internal-only 边界不漂移。

Gate:

- `npm run check:browser-commands`
- `npm run test:unit -- tests/unit/webSecurity/shared/jsAst.test.ts`（或等价局部 gate）

### P4 · Hook install idempotence diagnostics

> Status: COMPLETE — same fingerprint installs are idempotent/reused and different fingerprints return structured recovery for force/uninstall.

实现范围：

- `bridge_src/service_worker/hook.ts`
  - install 前可选 status 探测。
  - fingerprint 相同则 `reused:true`。
  - fingerprint 不同返回明确恢复动作：`force:true` 或先 uninstall。
  - recovery 结果暴露 `historyLost`/reason，不静默。
- 不引入策略 preset。

Acceptance:

- 重复安装同 target 不失败。
- 不同 target/fingerprint 不被静默覆盖。
- uninstall/reinstall 流程可诊断。

Gate:

- `npm run check:all:bridge`
- `npm run check:pi-browser-bridge`

### P5 · Final docs + full verification

> Status: COMPLETE — README, AI_INSTALL, skill, generated tool docs, and execution state were updated; final checks pass.

- [x] 更新 `README.md`、`AI_INSTALL.md`、`skills/pi-browser-tools/SKILL.md`、generated tool docs。
- [x] 如改文档索引，运行 `npm run docs:sync-indexes`。
- [x] 最终运行 `npm run check`。

## Implementation order

默认只先执行 P1。P2–P4 在 P1 验证通过后逐个推进；不得并行大改。

## Risk controls

- Token 预算：默认 summary 保持 compact；长内容继续 artifact-first。
- 性能：所有新增窗口逻辑必须 streaming；不得为 text/search/sample 整文件读入。
- 安全：regex safety 与 redaction 不放松。
- 兼容：旧字段、旧参数、旧 tests 必须继续通过。
- 范围：所有行为基于文件形态与通用 Web bundle 特征，不写入站点/CTF 专用规则。
