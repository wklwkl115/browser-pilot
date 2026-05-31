# MCP 标准化 + 渐进式披露方案（评审输入）

状态：已评审并迁入正式执行合同。

正式 source of truth：`docs/mcp-standardization-progressive-disclosure-plan.md`

本 `.plan` 文件仅保留为讨论入口，禁止作为实现依据。实施时必须以 `docs/mcp-standardization-progressive-disclosure-plan.md` 为准，尤其是以下已修正边界：

- 不把 TypeBox 顶层参数契约迁移到 Zod。
- MCP 入口必须先补与 Pi 框架等价的 TypeBox 参数校验。
- outputSchema 使用显式 distiller schema registry，不从 TypeScript 返回类型反射派生。
- `browser-result://...` 先落 opaque resource store，再接 resources/read 与 ingress handle。
- `browser_artifact` 只允许在 MCP 路按 capability gate 退役；Pi 路保留。
- 阶段顺序以正式合同 Phase -1 → Phase 9 为准。
