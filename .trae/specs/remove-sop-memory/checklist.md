# Checklist

- [x] `browser_memory` 的公开 schema、参数说明和执行路径不再接受或广告 `kind=sop`。
- [x] 新记录的 memory entry 只能是 fact，生成 fact id，写入 facts 存储，并保持 fact record/validate/recall/read 可用。
- [x] `.browser-pilot/memory/sop/` 不再被扫描、索引、召回、自动注入或新写入，但实现不主动删除用户已有磁盘文件。
- [x] `browser-memory://sop/<id>` 不再作为受支持 memory URI 返回内容，相关错误行为清晰且不破坏 fact URI。
- [x] frontmatter 解析不再把未知或缺失 kind fallback 为 SOP。
- [x] `browser_observe` 的 memory augmentation 不会 surface SOP 内容，仍以 live observation 为执行基础。
- [x] result middleware 不再生成 `kind=sop` record candidate 或任何可复用操作流程记录提示。
- [x] `src/kernels/memory/*` 保持纯逻辑边界，没有 Node、browser、bridge、commands、runtime 或 daemon 依赖。
- [x] memory 的文件系统、profile、secret、index、frontmatter 等持久化职责仍集中在 `src/memory/*` 或窄接口中，没有散落到 observe/result middleware。
- [x] 测试覆盖 SOP 拒绝/忽略路径和 fact memory 正常路径。
- [x] `CODE_WIKI.md` 和相关公开文档已移除 SOP/procedure memory 承诺，并描述 fact-only memory 与内核化边界。
- [x] 未编辑生成产物 `dist/` 或 `bridge/browser_pilot_bridge/`。
- [x] `mise run affected` 已通过。
- [x] `mise run verify` 已通过；若修改治理或工作流规则，`mise run dev-governance` 也已通过。
