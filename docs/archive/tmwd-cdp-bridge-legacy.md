# tmwd_cdp_bridge 遗留桥归档摘要

## 状态

已归档，不再保留为仓库内可运行桥实现目录。

## 结论

- `bridge/pi_browser_bridge/` 是唯一正式运行入口。
- 旧 `tmwd_cdp_bridge` 来自 GA/TMWD 浏览器桥原型迁移期资产。
- 该实现已不参与 Pi 当前 runtime、测试主路径或打包分发。
- 遗留源码细节改由 git 历史承担；仓库内只保留归档说明，不再保留原始目录副本。

## 归档原因

- 代码体量大，核心逻辑集中在手写 JS 单体。
- 使用宽松的 CSP 移除策略，不符合当前 Pi 原生桥边界。
- 无当前主桥的类型安全、协议单源和行为契约覆盖。
- 版本体系与当前 `pi_browser_bridge` 独立，容易误导维护者。
- 继续把原始目录放在 `bridge/` 下，会增加误引用、误打包和认知噪音。

## 当前仓库策略

- runtime、脚本、文档入口、contracts 一律不得依赖 `tmwd_cdp_bridge`。
- npm/package 不再分发原始 legacy bridge 目录。
- 需要历史源码时，使用 git 历史查看：
  - `git log -- bridge/tmwd_cdp_bridge`
  - `git show <commit>:bridge/tmwd_cdp_bridge/background.js`

## 关联文档

- 详档：`docs/archive/tmwd-cdp-bridge-legacy.full.md`
- 资产迁移规则：`docs/asset-sync.md`
