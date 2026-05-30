# GA 到 Pi 浏览器资产同步

## 方向

- `bridge/pi_browser_bridge/` 是 Pi 原生桥的唯一运行入口。
- `tmwd_cdp_bridge` 已迁出工作树源码目录，只在 `docs/archive/tmwd-cdp-bridge-legacy.md` / `.full.md` 中保留归档说明；历史源码通过 git 历史查看，不再由 Pi 工具加载。
- 从 GA 同步能力时，先迁移到原生命令域：`wait`、`network`、`hook`、`frame`、`html`、`screenshot`。

## 流程

1. 在 GA 资产中定位行为与边界条件。
2. 在 `bridge/pi_browser_bridge/` 实现原生命令或页面 dispatcher 能力。
3. 在 `src/tools/toolRegistry.ts` 登记工具注册器，并由 `src/tools/registerTools.ts` 组合入口暴露 TypeBox schema。
4. 把契约回归沉淀到 `tests/contracts/check-*.mjs`；真实浏览器 smoke 放到 `tests/smoke/`。
5. 执行 `npm run check`。

## 禁止

- 不把 `browser_pro.*` 作为新能力主入口。
- 不把 GA/TMWD 命名复制进 `bridge/pi_browser_bridge/`。
- 不从 Pi 运行时直接加载任何 `tmwd_cdp_bridge` legacy 资产；需要历史参考时只查阅归档文档或 git 历史。
