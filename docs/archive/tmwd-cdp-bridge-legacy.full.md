# tmwd_cdp_bridge 遗留桥归档详档

## 背景

`tmwd_cdp_bridge` 是项目早期从 GA/TMWD 浏览器桥原型迁移阶段遗留的参考实现。它曾作为旧桥接方案的源码副本保留在 `bridge/` 目录下，用于对照迁移行为和协议思路。

随着 `bridge/pi_browser_bridge/` 成为唯一正式运行入口，这份遗留目录已经不再承担任何运行职责。

## 归档前已确认事实

- 旧目录中存在大体量手写 JS 文件，核心单体 `background.js` 超过 2600 行。
- 旧实现含宽范围 CSP 移除逻辑，包括 response header 级 `content-security-policy` / `content-security-policy-report-only` 移除，以及页面 meta CSP 清理。
- 旧实现未接入当前主桥的 TypeScript 类型边界、协议单源、runtime contracts、unit tests 与 smoke 主线。
- 旧实现内部版本号体系独立于 `bridge/pi_browser_bridge/manifest.json` 的当前版本。
- 当前 contracts 已明确：生产代码不得引用 `tmwd_cdp_bridge`。

## 归档决策

1. 不再把 `tmwd_cdp_bridge` 作为 `bridge/` 下的原始目录保留。
2. 不再通过 npm/package 分发该 legacy bridge 源码副本。
3. 仅在 `docs/archive/` 中保留归档说明。
4. 如需查看原始源码，以 git 历史为唯一真源，而不是继续在工作树中保留一份静态副本。

## 历史源码查看方式

- 查看该目录历史：
  - `git log -- bridge/tmwd_cdp_bridge`
- 查看某次提交中的核心文件：
  - `git show <commit>:bridge/tmwd_cdp_bridge/background.js`
  - `git show <commit>:bridge/tmwd_cdp_bridge/manifest.json`
- 导出完整历史目录快照：
  - `git archive --format=zip <commit> bridge/tmwd_cdp_bridge -o tmwd-cdp-bridge.zip`

## 与当前桥的边界

- 当前正式桥：`bridge/pi_browser_bridge/`
- 当前正式源码：`bridge_src/`、`src/`
- 当前正式验证：`npm run check`
- 当前正式迁移规则：`docs/asset-sync.md`

## 维护要求

- 不恢复 `bridge/tmwd_cdp_bridge/` 目录作为工作树源码副本。
- 不在 runtime、scripts、tests、generated docs 中重新引入对该 legacy 路径的依赖。
- 若未来确需公开保留原始资产，应另开归档方案，并明确 package 排除、只读边界和维护责任。
