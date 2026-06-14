# Browser Memory v1

本文件描述 `browser_memory` 的运行时边界、写入门槛、召回规则和自动浮现行为。

## 范围

- 本地 only：写入 `.pi/browser-memory/`
- actions：`record | recall | read | validate`
- local-only scopes：`scopeKind:"origin" | "task" | "project"`
- 不支持：repo promote/export、embeddings/语义检索、prompt injection

## 写入门槛（GA 式：成功即可结晶，证据可选）

对齐 GA——任务成功就把执行路径结晶成 SOP,**不强制** durable evidence。`record` 只要求:title、非空 triggers、HOW-only body、scope,且通过密钥扫描与尺寸上限。

- `evidenceRefs` **可选**:提供则作为 provenance 记录,且仍会校验真实性(artifact 可读 / snapshot 非 stale / browser-result 可解析)——引用了就必须真;不提供也放行。
- 蒸馏器是 agent 自己:它手里有完整轨迹,record 时据此写 SOP。无需另建会话轨迹采集。

## 返回形态

- `recall`：返回**已排序**的 bounded cards;卡片带 `updatedAt`(判时效);**单条明显占优时**(唯一命中或得分≥次名 2 倍)在 top 卡内联其有界正文(≤60 行/4000 字),省去一次 `read`
- `read`：其余卡片正文按 `id` 或 `browser-memory://...` 有界读取

> 设计取向:保持 GA 式简单——record / recall / supersede。坏 SOP 不靠打分衰减,而靠下次成功时**重新 record 一版自然 supersede** 自愈。

## L1 路由索引（insight index）

`index.json` 里物化一个**倒排 token 索引** `routing: { token: [id...] }`——由活跃条目的 title+triggers 分词(≥3 字符、去重、每条上限 24)派生(纯函数 `src/tools/memory/routing.ts`)。它把"情境→相关记忆"做成**按 token 重叠路由**,取代原来的子串扫描:

- **recall(query)**:query 分词后经索引路由,按重叠 token 数排序(`route×N` 计入 `matchReason`),跨 scope 召回;原 exact-scope(+100)与子串信号保留。
- **auto-surface 的 task/project**:用页面(url+title)的 token 与条目路由 token 重叠(≥1)判定,**token 边界正确**(不再有 "cat" 命中 "category" 之类子串误判)。
- origin scope 仍走精确主机匹配,不经路由。
- 不是 embeddings——纯 token 路由,无语义;语义检索仍延后。它也让规模变大时的路由有了现成接口。

## 写入显著性 / 去重（dedup）

避免记忆库被琐事与近重复稀释:

- **record/validate** 会与同 scope、同 kind 的活跃条目算 token 重叠相似度(标题 0.5 / triggers 0.3 / body 0.2 加权)。
- 精确同标题或**近乎相同**(相似度 ≥ `0.8`)→ 自动 supersede(写 tombstone),不堆积近重复;返回 `supersededIds`。
- **相似但不同**(`0.5` ≤ 相似度 < `0.8`)→ 不合并,作为 `duplicateCandidates` 软提示返回,agent 可自行决定是否显式替换。
- 不同流程(如 `login flow` vs `checkout payment`)相似度低,正常共存。
- **催记仅在"做了事"时**:纯读工具(observe / screenshot / wait / frame / pick / artifact)即便带 evidence 也不触发 `record candidate`——只是看页面不值得结晶;recall 浮现不受此限。

## 自动召回（memory kernel）

`browser_observe mode=scan|text` 会在 runner 内预构建 `MemoryAugmentationPlan`：按当前 URL/intent token 对本地 `index.json` 做 IDF recall，再用当前 origin profile 的 structural anchors 验证，最后通过 `envelope.memory` 注入。自动注入必须有当前 URL/intent token overlap；仅同源不会弹出旧任务记忆。这个路径不再使用 `nextActions` recall 提示。

- no-hit / disabled：默认 observe envelope 字节不变，且不物化 `.pi/browser-memory/`。
- 命中：最多 2 张 card，带 `verification:"fresh"|"unverified"|"stale"`；首次同 conversation+origin 可 inline 有界 body，后续折叠为 `browser-memory://...` handle。
- 预算保护：`livePlaneSignature()` 验证 inline→handle→omit，每个 accepted variant 都不得改变 live page planes。
- stale 反馈：structural anchors drift 会走 profile strikes；3 次后 stale card 不再带 body。
- `PI_BROWSER_MEMORY=0` 关闭 kernel 自动读写；显式 `browser_memory record|recall|read|validate` 不受影响。

### 写入侧催记（record candidate）

当结果带 durable evidence(`saved.path` 或 snapshot `saved.path`)、且其 origin 尚无活跃记忆时，追加一条 `record candidate:` 提示，把可用的 evidence path 直接写进建议的 `record` 调用：

- 每个 origin 每会话至多催一次；该 origin 一旦录过即不再催。
- evidence refs 是推荐 provenance，不是硬前置；没有 durable evidence 时 hint 省略 `evidenceRefs`。
- `PI_BROWSER_MEMORY=0` 或 `PI_BROWSER_MEMORY_AUTOSURFACE=0` 会关闭写入侧催记。

## 使用示例

```text
browser_memory {action:"recall", scopeKind:"origin", scopeKey:"xiaohongshu.com"}
browser_memory {action:"read", id:"sop_...", mode:"text", offset:1, limit:80}
browser_memory {action:"validate", kind:"sop", url:"https://www.xiaohongshu.com/explore", title:"...", triggers:[...], body:"...", evidenceRefs:["/abs/path/to/artifact.json"]}
browser_memory {action:"record", kind:"sop", scopeKind:"task", scopeKey:"web-recon", title:"...", triggers:[...], body:"...", evidenceRefs:["/abs/path/to/artifact.json"]}
```
