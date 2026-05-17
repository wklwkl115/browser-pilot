# Pi Browser Tools

Pi 原生浏览器工具扩展，提供真实浏览器 tab 控制、CSS/semantic DOM 操作、正文提取、网络证据、上传下载、截图、artifact 局部读取和原生 bridge 命令。

## 职责划分

- 安装、环境变量、浏览器扩展加载、reload、check/smoke、排障：见 `AI_INSTALL.md`。
- Pi 正式使用场景、工具选择、输出风格、安全边界：见全局 skill `D:/Pi/agent/skills/pi-browser-tools/SKILL.md`。
- 本 README 只作为项目入口、工具清单和维护入口。

## 工具清单

- `browser_tabs`：list / switch / create / close / selectBrowser。
- `browser_execute`：执行 JavaScript 或发送安全 bridge command；上传必须使用 `browser_upload`。
- `browser_scan`：简化 DOM/text 扫描，可包含同源 iframe。
- `browser_pick`：用户交互点选页面元素，返回 selector 和摘要。
- `browser_content`：提取当前页或指定 URL 的正文 Markdown。
- `browser_query`：按 CSS selector 查询元素摘要。
- `browser_click`：按 CSS selector 点击元素。
- `browser_type`：向 input/textarea/contenteditable 输入文本。
- `browser_dom_snapshot`：提取当前视口可见语义/交互 DOM，返回短期 `nodeId`、selector、role、文本和 bbox；若目标 tab 未显示导致空 viewport，先切换到该 tab 后重试。
- `browser_dom_click`：用 `browser_dom_snapshot` 返回的 `nodeId` 点击 DOM 节点，不按屏幕坐标。
- `browser_dom_type`：用 `browser_dom_snapshot` 返回的 `nodeId` 输入文本，不按屏幕坐标。
- `browser_download`：通过 selector click、media selector 或 URL 下载并回传 Chrome 本地路径；click 会优先用可提取 URL 或 tab-scoped 下载事件关联。
- `browser_upload`：通过文件选择器上传绝对本地文件路径，要求 `confirm:true`。
- `browser_wait`：导航、selector、load state、network idle 等等待。
- `browser_network`：Network recorder 的 start/list/get/body/exportHar/wait。
- `browser_hook`：页面事件 hook 的 install/collect/status/uninstall/evaluate 等。
- `browser_evidence`：聚合 hook/network/performance 证据。
- `browser_frame`：frame 列表、frame 内执行、新文档脚本。
- `browser_html`：HTML/text snapshot。
- `browser_screenshot`：截图并保存 artifact。
- `browser_artifact`：按行、JSON path、关键词或抽样读取 artifact。

## Pi 命令

- `/browser-status`：查看 bridge server、扩展连接、tabs、pending 请求。
- `/browser-install`：输出浏览器扩展安装路径。
- `/browser-reload`：请求浏览器扩展 reload 并等待重连。

## 维护入口

- 契约测试：`tests/contracts/`
- 真实浏览器 smoke：`tests/smoke/`
- 最终全量 smoke 结果：`.pi/browser-artifacts/final-smoke/results.json`
- 全局 skill 验证：`PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools`
- 生成器/loader：`scripts/`

```bash
npm run check
npm run smoke:browser
npm run smoke:browser:transfer
```

当前最终 smoke 覆盖 tabs/wait/scan/content/html/artifact/execute/query/type/click/semantic DOM/pick/network/hook/evidence/frame/screenshot/download/upload。

`bridge/native_command_schema.json` 是命令协议单一事实来源。修改协议后执行：

```bash
npm run sync:protocol
npm run check
```

## 参考

- 安装 SOP：`AI_INSTALL.md`
- 迁移说明：`docs/browser-usage.md`
- 资产同步：`docs/asset-sync.md`
