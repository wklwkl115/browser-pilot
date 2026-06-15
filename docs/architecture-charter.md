# Browser Pilot Architecture Charter

本文档是 Browser Pilot 下一阶段重构的执行宪章。它不是愿景草案，而是迁移期间的约束、验收标准和 TODO 表。

本次重构按 **breaking architecture release** 执行：功能能力保持不缩水，但旧 Pi/MCP 命名、旧状态路径、旧 ref scheme、旧 extension path、旧 control headers 不提供 alias/fallback。

## 1. 架构目标

Browser Pilot 的长期形态是：

- `browser-pilot` CLI + skill 是唯一 agent 使用面。
- 业务能力由 command layer 编排，不再通过 tool host、registerCommand、adapter 模拟多宿主。
- ABML、时序、记忆、证据、session、ref、安全规则是独立内核。
- 内核不依赖 CLI、daemon、bridge、extension、filesystem、HTTP、WebSocket、process/env。
- 浏览器、文件系统、daemon、CLI、extension 都是外层 adapter。
- 协议、schema、docs、skill、CLI metadata 都从单一源生成。
- 旧主干迁完即删，不保留长期 wrapper。

目标不是“把文件放进新目录”，而是减少概念数量、压平逻辑链路、让每个模块只有一个变更理由。

## 2. Breaking 决策

本次迁移不保留旧兼容名。

| 旧名 | 新名 | 说明 |
|---|---|---|
| `PI_BROWSER_*` | `BROWSER_PILOT_*` | 环境变量统一重命名 |
| `.pi/` | `.browser-pilot/` | runtime/auth/artifacts/memory/smoke 状态目录统一迁移 |
| `pi-ref://` | `bp-ref://` | ABML/runtime ref scheme 统一迁移 |
| `x-pi-daemon-token` | `x-browser-pilot-daemon-token` | daemon control header 重命名 |
| `x-pi-pairing-token` | `x-browser-pilot-pairing-token` | pairing header 重命名 |
| `bridge/pi_browser_bridge` | `bridge/browser_pilot_bridge` | 发布/加载 extension 目录重命名 |
| `bridge_src` | `src/bridge/extension` | extension 源码纳入主 TS 架构 |
| `__pi_browser_*` | `__browser_pilot_*` | DOM/page bridge 内部标识重命名 |
| `piBrowser*` / `PiBrowser*` | `browserPilot*` / `BrowserPilot*` | 内部 symbol 统一重命名 |

用户可见后果：

- 需要重新加载 extension。
- 需要重新 pair。
- 旧 `.pi` 状态不自动迁移。
- 旧 `pi-ref://` handle 不再可用。
- 旧环境变量和旧 control headers 不再生效。

## 3. 目标架构

```text
src/
  apps/
    cli/
    daemon/

  commands/
    index.ts
    defineCommand.ts
    observe.ts
    execute.ts
    command.ts
    wait.ts
    screenshot.ts
    network.ts
    hook.ts
    evidence.ts
    artifact.ts
    memory.ts
    upload.ts
    download.ts
    web-security/

  kernels/
    refs/
    abml/
    temporal/
    memory/
    evidence/
    session/
    security/

  ports/
    BrowserRuntimePort.ts
    ArtifactStorePort.ts
    MemoryStorePort.ts
    ClockPort.ts
    IdPort.ts
    LogPort.ts
    HttpClientPort.ts

  adapters/
    browser-runtime/
    artifacts-fs/
    memory-fs/
    logging/
    http/

  bridge/
    protocol/
    server/
    extension/

bridge/
  browser_pilot_bridge/
    manifest.json
    popup.html
    offscreen.html
    dist/

docs/
  generated/
```

依赖方向：

```text
apps -> commands -> kernels
apps -> adapters
commands -> ports
adapters -> ports
adapters -> bridge/server
bridge/server -> bridge/protocol
bridge/extension -> bridge/protocol
kernels -> shared types only
```

禁止方向：

```text
kernels -> apps
kernels -> commands
kernels -> adapters
kernels -> bridge/server
kernels -> bridge/extension
kernels -> filesystem/http/ws/process/env
commands -> apps
commands -> daemon route helpers
commands -> other commands
bridge/extension -> Node-only modules
```

## 4. 核心概念

### Command

Command 是唯一公共业务入口。CLI、daemon、schema、docs 都消费同一个 `CommandManifestIndex`。

Command 负责 use case 编排：

- 读取输入 schema。
- 调用 kernels。
- 通过 ports 使用外部能力。
- 返回结构化 `CommandResult`。

Command 不负责：

- 直接读写 filesystem。
- 直接操作 WebSocket。
- 互相调用其他 command。
- 承载复杂领域规则。
- 拼接最终 CLI 文本。

### Kernel

Kernel 是独立领域内核。它只表达规则和状态转移。

Kernel 必须满足：

- 显式输入，显式输出。
- 无 hidden global state。
- 不读 `process.env`。
- 不读写文件。
- 不发 HTTP/WebSocket。
- 不依赖 CLI/daemon/bridge/extension。
- 可在无浏览器、无 daemon、无 filesystem 的单元测试里运行。

### Port

Port 是 command 需要的外部能力接口。

典型 port：

- `BrowserRuntimePort`
- `ArtifactStorePort`
- `MemoryStorePort`
- `ClockPort`
- `IdPort`
- `LogPort`
- `HttpClientPort`

Kernel 不拿 port。Command 拿 port。Adapter 实现 port。

### Adapter

Adapter 是副作用实现。

Adapter 可以访问：

- filesystem
- HTTP
- WebSocket
- browser bridge
- process/env
- daemon state

Adapter 不放领域规则。规则必须进入 kernel 或 command。

### Evidence

所有 command 输出统一走 `EvidenceEnvelope`。

```ts
type CommandResult<T> = {
  data: T;
  evidence: EvidenceEnvelope;
};
```

Evidence 负责表达证据，不负责执行 workflow。

### Protocol

Protocol 是外部合同，不是实现细节。

`src/bridge/protocol` 是唯一协议源。extension、server、docs、generated files 都从这里派生。

## 5. 内核宪章

### Refs Kernel

职责：

- mint `bp-ref://`
- parse `bp-ref://`
- validate ref kind/id/scope
- normalize runtime/entity/artifact refs

禁止：

- 散落字符串拼接 `` `bp-ref://${kind}/${id}` ``
- 散落正则 `/bp-ref:\/\//`
- command/evidence/resource 各自实现 ref parser

验收：

- repo 内除 refs kernel 和测试外，不存在手写 `bp-ref://` parser/mint 逻辑。

### ABML Kernel

职责：

- perception model
- DOM/AX/entity/relation merge
- actionability
- collection completeness
- diff
- causal hints
- ref materialization

输入：

- 标准化观察事实
- DOM/AX/text/html/network/event facts

输出：

- `PerceptionFrame`
- `PerceptionDiff`
- `CausalGraph`
- typed runtime refs

禁止：

- import bridge/server
- import extension runtime
- import artifact store
- import memory store
- import CLI/daemon
- 发浏览器命令

### Temporal Kernel

职责：

- staleness classification
- wait plan
- effect freshness decision
- retry/reobserve/fail-closed decision

输入：

- selector state
- navigation state
- target state
- tab/session replacement facts
- network/load facts
- ack/timeout facts

输出：

- `TemporalDecision`
- `TemporalPlan`
- `EffectFreshness`

禁止：

- setTimeout/polling
- WebSocket
- BrowserBridgeServer
- command execution

### Memory Kernel

职责：

- memory card model
- scope derivation
- recall ranking
- conflict/expiry/validation rules
- provenance requirement rules

禁止：

- filesystem
- artifact reads
- embedding/network calls
- owning evidence payloads

规则：

- memory 只引用 evidence，不拥有 evidence。
- 无可解析 evidence 的 memory 只能作为提示，不能作为可引用事实。

### Evidence Kernel

职责：

- `EvidenceEnvelope`
- summary blocks
- artifact hints
- resource hints
- runtime refs
- redaction results
- recovery hints
- causal evidence expression

禁止：

- 执行 browser command
- 读写 filesystem
- 调用 memory recall
- 决定 command workflow

子模块：

```text
kernels/evidence/
  envelope.ts
  refs.ts
  summary.ts
  redaction.ts
  recovery.ts
  artifactHints.ts
```

### Session Kernel

职责：

- browser sessions
- selected browser/tab state
- leases
- operations
- observation snapshots
- target resolution
- queue ownership

禁止：

- WebSocket listen
- HTTP daemon route
- CLI output
- pairing auth
- artifact summary
- direct extension protocol handling

### Security Kernel

职责：

- HTTP replay diff
- fuzz baseline clustering
- SQLi oracle classification
- template matcher evaluation
- cookie/JWT analysis
- OAST correlation rules

禁止：

- sqlmap/nuclei process execution
- HTTP fetch
- browser capture
- artifact write

这些副作用由 commands + ports + adapters 组合。

## 6. 执行铁律

1. **合同先行**
   - 大规模迁移前必须先冻结 contracts。
   - 没有 contract 的行为，不允许声称“效果不变”。

2. **不保留旧兼容主干**
   - 不写 alias。
   - 不写 fallback。
   - 不写 legacy wrapper。
   - 迁完旧入口必须删除。

3. **内核纯净**
   - kernels 不能 import apps/commands/adapters/bridge/cli/daemon。
   - kernels 不能直接使用 filesystem/http/ws/process/env。
   - kernels 必须可独立单元测试。

4. **Command 不互调**
   - `browser_sqli` 不调用 `browser_http_replay` command。
   - 共享能力进入 kernel 或 port。

5. **Adapter 不沉淀业务规则**
   - adapter 只实现副作用。
   - recovery、classification、redaction、scope、ranking 不放 adapter。

6. **Protocol 单源**
   - 协议定义只存在一个 source of truth。
   - generated files 不手改。

7. **Schema 单源**
   - CLI schema、command metadata、docs generated reference 从 command manifest 派生。
   - 不允许 README/skill 手写参数合同。

8. **Evidence 单流**
   - summary/artifact/resource/recovery/memory evidence 都通过 `EvidenceEnvelope`。
   - 不允许每个 command 自己发明输出 hint 格式。

9. **命名一次性清零**
   - `BROWSER_PILOT`
   - `bp-ref`
   - `browser_pilot`
   - `browserPilot`
   - `BrowserPilot`
   - Browser Pilot / Browser Pilot / MCP 相关公开残留

10. **边界用工具强制**
    - ESLint boundary rules 最早建立。
    - 不靠人工 code review 记忆依赖方向。

11. **每阶段必须可验证**
    - 每个阶段结束必须跑对应 contracts。
    - 失败先修，不向下推进。

12. **不做顺手产品重设**
    - command count 短期保持 22。
    - command 能力不缩水。
    - 删除/合并命令另开产品设计，不混进架构迁移。

13. **旧目录不能长期共存**
    - 新主干接管后，旧目录同阶段删除或变成极薄入口。
    - 极薄入口只能用于 bin/export 兼容，不允许承载逻辑。

14. **状态路径统一**
    - runtime/auth/artifacts/memory/smoke 都进入 `.browser-pilot/`。
    - 不允许新代码写 `.browser-pilot/`。

15. **不要制造新上帝对象**
    - `CommandManifestIndex` 只是索引。
    - `EvidenceEnvelope` 只是证据合同。
    - `SessionKernel` 管状态，不管 transport。
    - `BridgeServer` 管连接，不管业务。

## 7. Contracts

新增：

```text
contracts/
  cli/
    commands.snapshot.json
    schema.observe.snapshot.json
    schema.execute.snapshot.json
    schema.command.snapshot.json
    schema.upload.snapshot.json
  protocol/
    native-command.schema.snapshot.json
  package/
    package-files.snapshot.json
  output/
    observe.scan.snapshot.json
    execute.result.snapshot.json
    network.summary.snapshot.json
```

新增脚本：

```text
npm run contract:record
npm run contract:verify
```

合同分类：

- behavior snapshot：字段结构、命令数量、能力合同必须保持。
- breaking-name snapshot：旧名到新名的变化必须明确，不能夹带非预期变更。

最低验收：

```text
npm run typecheck
npm run lint
npm run build
npm run build:bridge
npm run verify:package
npm run verify:pairing
npm run contract:verify
```

## 8. 执行 TODO 表

### Phase 0: 冻结现状合同

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P0.1 | 新增 contract snapshot 目录 | `contracts/**` | snapshot 可生成 |
| P0.2 | 新增 `contract:record` | package script + script file | 能记录 commands/schema/protocol/package |
| P0.3 | 新增 `contract:verify` | package script + script file | clean tree 下可通过 |
| P0.4 | 记录 CLI commands snapshot | `contracts/cli/commands.snapshot.json` | command count = 22 |
| P0.5 | 记录关键 schema snapshot | observe/execute/command/upload | schema 可稳定比较 |
| P0.6 | 记录 native protocol snapshot | `contracts/protocol/native-command.schema.snapshot.json` | 和协议源一致 |
| P0.7 | 记录 package files snapshot | `contracts/package/package-files.snapshot.json` | package public surface 可比较 |
| P0.8 | 标记 expected breaking names | breaking allowlist | pi->bp delta 可解释 |

### Phase 1: 建立新边界骨架

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P1.1 | 创建 `src/kernels` | refs/abml/temporal/memory/evidence/session/security placeholders | typecheck 通过 |
| P1.2 | 创建 `src/ports` | port interfaces | commands 可依赖 ports |
| P1.3 | 创建 `src/commands` | `defineCommand.ts`, `index.ts` | registry 空壳可编译 |
| P1.4 | 创建 `src/adapters` | browser/artifact/memory/logging placeholders | 无业务逻辑 |
| P1.5 | 创建 `src/apps` | cli/daemon placeholders | bin 迁移前不接管 |
| P1.6 | 增加 boundary lint | ESLint rules | 违规 import 会失败 |
| P1.7 | 写 architecture tests | import boundary smoke | kernels 不能 import 外层 |

### Phase 2: Ref Kernel + 命名基础迁移

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P2.1 | 实现 refs kernel | parse/mint/validate/types | 单测覆盖 |
| P2.2 | `pi-ref://` -> `bp-ref://` | ABML/resources/summary/execute 全部迁移 | `rg "pi-ref"` 只剩 migration docs 或为 0 |
| P2.3 | 删除散落 ref 正则 | 全部改用 refs kernel | `rg "bp-ref://"` 只在 refs kernel/tests/docs 出现 |
| P2.4 | `PI_BROWSER_*` -> `BROWSER_PILOT_*` | env reads/writes/docs/scripts | `rg "PI_BROWSER"` 为 0 或只在 migration notes |
| P2.5 | `.pi` -> `.browser-pilot` | daemon/auth/artifacts/memory/smoke | package verify 使用新路径 |
| P2.6 | headers rename | daemon/client/pairing tests | pairing smoke 通过 |

### Phase 3: Temporal Kernel 独立

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P3.1 | 搬迁 temporal pure types | `src/kernels/temporal/types.ts` | 无 driver imports |
| P3.2 | 搬迁 classify/plan/effect | `src/kernels/temporal/*` | 单元测试通过 |
| P3.3 | command/driver 只采事实 | 调用 temporal kernel | 输出 decision 不变 |
| P3.4 | recovery hint 使用 decision | evidence/recovery 接入 | output snapshot 可解释 |
| P3.5 | 删除旧 temporal 散点 | old imports 清理 | `rg temporal-kernel` 按计划归零 |

### Phase 4: Evidence Envelope

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P4.1 | 定义 `EvidenceEnvelope` | `src/kernels/evidence/envelope.ts` | typecheck |
| P4.2 | 统一 summary blocks | `summary.ts` | 关键 output snapshot 通过 |
| P4.3 | 统一 artifact hints | `artifactHints.ts` | artifact refs 一致 |
| P4.4 | 统一 recovery hints | `recovery.ts` | temporal recovery 一致 |
| P4.5 | 统一 redaction result | `redaction.ts` | sensitive output 不泄露 |
| P4.6 | command result 改为 `CommandResult<T>` | command runtime 使用 | CLI JSON contract 通过 |
| P4.7 | 删除旧分散 middleware | resultMiddleware/summaries/distill-core 收敛 | 无重复后处理路径 |

### Phase 5: Command Runtime 替换 ToolHost

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P5.1 | 实现 `defineCommand` | command manifest type | command 可声明 schema/cli/run |
| P5.2 | 迁移 22 个 command manifest | `src/commands/**` | command count = 22 |
| P5.3 | CLI commands 从 registry 派生 | no tool collection | `browser-pilot commands --json` 合同通过 |
| P5.4 | CLI schema 从 command 派生 | no command schema adapter | schema snapshots 通过 |
| P5.5 | daemon invoke 从 command registry 执行 | no CommandManifestIndex | verify package 通过 |
| P5.6 | 删除旧 tool host/registrar/adapter 主干 | remove frontend host/tool collector/registrar/adapter host paths | legacy runtime name scan 清零或仅测试 |
| P5.7 | docs generated 从 command 派生 | generated reference | docs snapshot 可解释 |

### Phase 6: Session Kernel 独立

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P6.1 | 定义 SessionKernel API | status/selectTarget/operations/leases/observations | 单测覆盖 |
| P6.2 | 搬迁 tab/session state | `kernels/session` | bridge 不再拥有业务 state |
| P6.3 | 搬迁 leases | `kernels/session/leases.ts` | pairing/lease smoke 通过 |
| P6.4 | 搬迁 operations | `kernels/session/operations.ts` | active operation 行为不变 |
| P6.5 | 搬迁 observation snapshots | `kernels/session/observations.ts` | observe/execute contract 通过 |
| P6.6 | BridgeServer 降级为 transport | `bridge/server` | no ABML/memory/evidence imports |
| P6.7 | BrowserRuntimeAdapter 实现 runtime port | `adapters/browser-runtime` | commands 通过 port 发浏览器命令 |

### Phase 7: Apps/Daemon 重构

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P7.1 | 迁移 CLI app | `src/apps/cli` | `browser-pilot --help` 不变 |
| P7.2 | 迁移 daemon app | `src/apps/daemon` | daemon start/status 正常 |
| P7.3 | 拆 control routes | invoke/status/pairing/lease/shutdown | route 单测/verify pairing |
| P7.4 | auth/pairing 只在 app 层 | no bridge auth coupling | bridge server 无 pairing state |
| P7.5 | bin 变 thin entry | `cli/bin.ts` 只转发 | no business logic |
| P7.6 | daemon state 使用 `.browser-pilot/runtime` | no `.browser-pilot` | status/stop/restart 正常 |

### Phase 8: Bridge Protocol + Extension 迁移

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P8.1 | 建立 `src/bridge/protocol` 单源 | schema/messages/errors | generated docs 从此生成 |
| P8.2 | 删除重复 schema 源 | old schema copies removed or generated only | sync script 简化 |
| P8.3 | 迁移 extension 源码 | `src/bridge/extension` | browser-side tsconfig 通过 |
| P8.4 | extension 发布目录重命名 | `bridge/browser_pilot_bridge` | build:bridge 通过 |
| P8.5 | `__pi_browser_*` -> `__browser_pilot_*` | page/offscreen/service worker | extension smoke 通过 |
| P8.6 | bridge UI 品牌统一 | popup/offscreen/manifest | package verify 通过 |
| P8.7 | old `src/bridge/extension` 删除 | no source left | `rg "src/bridge/extension"` 为 0 或 build docs only |

### Phase 9: Memory + Artifact State 独立

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P9.1 | 实现 MemoryKernel | model/scope/ranking/validation | 单测 |
| P9.2 | 实现 MemoryStorePort | no fs in kernel | adapter 单测 |
| P9.3 | memory fs adapter 使用 `.browser-pilot/memory` | state path 新结构 | memory command 通过 |
| P9.4 | artifact fs adapter 使用 `.browser-pilot/artifacts` | no `.browser-pilot/artifacts` | artifact command 通过 |
| P9.5 | evidence refs 与 memory refs 解耦 | memory 只引用 evidence | provenance 验证通过 |

### Phase 10: Security Kernel 收口

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P10.1 | replay diff 进入 kernel | `kernels/security/replayDiff.ts` | replay tests |
| P10.2 | fuzz clustering 进入 kernel | `fuzzCluster.ts` | fuzz tests |
| P10.3 | SQLi oracle 进入 kernel | `sqliOracle.ts` | SQLi tests |
| P10.4 | template matcher 进入 kernel | `templateMatch.ts` | template tests |
| P10.5 | cookie/JWT rules 进入 kernel | `cookieAnalyze.ts` | cookie tests |
| P10.6 | sqlmap/nuclei/OAST 保持 adapter/workflow | no process in kernel | boundary lint |

### Phase 11: 删除旧主干

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P11.1 | 删除 `src/frontend` 旧 host 语义 | no tool host | rg clean |
| P11.2 | 删除 `src/tools` 旧 command registry 主干 | commands 接管 | rg clean |
| P11.3 | 删除 `src/driver` 上帝对象残留 | bridge/session 接管 | no old imports |
| P11.4 | 删除 `src/adapters/resources-fs` 分散 resource 主干 | artifacts/evidence 接管 | no old imports |
| P11.5 | 删除 `src/kernels/evidence/distill` | evidence 接管 | no old imports |
| P11.6 | 删除 `src/bridge/extension` | extension 接管 | build 通过 |
| P11.7 | 删除旧 docs/skill 残留 | docs 更新 | rg clean |

### Phase 12: 最终验收

| ID | TODO | 产物 | 验收 |
|---|---|---|---|
| P12.1 | 全量静态扫描旧名 | rg scripts | 旧名清零 |
| P12.2 | 全量 contracts verify | `npm run contract:verify` | 通过 |
| P12.3 | 全量 check | `npm run check` | 通过 |
| P12.4 | package smoke | `npm run verify:package` | consumer CLI 正常 |
| P12.5 | pairing smoke | `npm run verify:pairing` | 29+ assertions 通过 |
| P12.6 | extension load manual checklist | docs | Browser Pilot Bridge 可加载 |
| P12.7 | migration notes | breaking changes doc | 用户知道需重载/重配 |

## 9. 旧名清零清单

最终必须为 0 的搜索：

```text
rg -n "PI_BROWSER|pi-ref://|\\bpi-ref\\b|\\.pi/|pi_browser|piBrowser|PiBrowser|Pi Browser|MCP|FastMCP|structuredContent|@earendil|pi-coding-agent|pi-ai" .
```

允许例外：

- 本文档的历史决策表，迁移完成后也可以移入 archive 或删除。
- release notes 中的 breaking migration 说明。

## 10. 开发者工作流

每个阶段遵循：

```text
1. 更新 TODO 状态
2. 加/更新 contract
3. 实现最小垂直切片
4. 删除被替代旧路径
5. 跑阶段验收
6. 扫描旧名/边界违规
7. 写阶段总结
```

禁止：

- 只新增新架构，不删除旧架构。
- 为赶进度绕开 boundary lint。
- 在 command 中复制 kernel 规则。
- 在 adapter 中写 recovery/classification/scope/ranking。
- 手写 generated docs。
- 未更新 contracts 就声明行为不变。

## 11. 成功标准

本次重构成功不是“目录变漂亮”，而是达到以下结果：

- 开发者新增/修改 command 时，只需要理解 command manifest、相关 kernel、必要 ports。
- ABML 可独立测试。
- Temporal 可独立测试。
- Memory 可独立测试。
- Evidence 可独立测试。
- Bridge server 不再是业务上帝对象。
- Daemon route 不再和 tool/bridge/session 细节混在一起。
- Extension runtime 作为 browser-side kernel 独立构建。
- CLI/schema/docs/skill 不再漂移。
- 旧 Pi/MCP 心智从代码主干和公开文档中消失。
- `npm run check` 与 `npm run contract:verify` 是合并前硬门禁。

## 12. 执行状态

| Phase | Status | 验证 |
|---|---|---|
| Phase 0: 冻结现状合同 | Done | `npm run contract:record`; `npm run contract:verify` |
| Phase 1: 建立新边界骨架 | Done | `npm run verify:boundaries`; `npm run typecheck` |
| Phase 2: Ref Kernel + 命名基础迁移 | Done | old Pi/ref/path/header scan clean; `bp-ref://` mint/parse centralized in refs kernel |
| Phase 3: Temporal Kernel 独立 | Done | temporal core under `src/kernels/temporal`; boundary lint clean |
| Phase 4: Evidence Envelope | Done | `EvidenceEnvelope` command result enrichment; `npm run contract:verify` |
| Phase 5: Command Runtime 替换旧 host/registrar | Done | `npm run check`; command count = 22; stale `dist/src/commands/commandAdapter*` / `register*Tool*` package gate clean |
| Phase 6: Session Kernel 独立 | Done | `src/kernels/session/SessionKernel.ts` owns browser sessions, leases, operations, observation snapshots; bridge consumes it through `BrowserBridgeSessionState`; boundary lint clean |
| Phase 7: Apps/Daemon 重构 | Done | CLI main flow lives in `src/apps/cli/main.ts`; daemon auth/control/lease helpers live in `src/apps/daemon`; `verify:pairing` 29/29 passed |
| Phase 8: Bridge Protocol + Extension 迁移 | Done | `src/bridge/protocol` single source; `src/bridge/extension`; `bridge/browser_pilot_bridge`; `npm run build:bridge` |
| Phase 9: Memory + Artifact State 独立 | Done | memory kernel under `src/kernels/memory`; resource/artifact state under adapters; `.browser-pilot/artifacts` verified by package smoke |
| Phase 10: Security Kernel 收口 | Done | replay diff/baseline and SQLi oracle under `src/kernels/security`; boundary lint clean |
| Phase 11: 删除旧主干 | Done | `src/driver`, `src/resources`, `src/distill-core`, `src/tools`, `src/frontend`, `src/abml*`, `src/*-core`, `src/protocol`, `bridge_src`, old bridge package removed |
| Phase 12: 最终验收 | Done | `npm run check`; `npm run contract:verify`; package smoke commandCount=22; pairing smoke 29/29; old-name scan only hits migration notes |
