# Pi Browser Tools SOP：安装与环境配置

本 SOP 只覆盖项目安装、浏览器桥安装、环境配置、reload、验证和排障。正式使用方式由全局 skill `D:/Pi/agent/skills/pi-browser-tools/SKILL.md` 负责。

## 适用路径

- 项目目录：`D:/Pi/agent/extensions/pi-browser-tools`
- 浏览器扩展目录：`D:/Pi/agent/extensions/pi-browser-tools/bridge/pi_browser_bridge`
- 全局 Pi skill：`D:/Pi/agent/skills/pi-browser-tools/SKILL.md`

## 安装依赖

```bash
cd D:/Pi/agent/extensions/pi-browser-tools
npm install
```

## 配置 Bridge

默认配置通常无需修改：

- `PI_BROWSER_BRIDGE_HOST=127.0.0.1`
- `PI_BROWSER_BRIDGE_PORT=18765`

如需改端口：

1. 设置 Pi 进程环境变量 `PI_BROWSER_BRIDGE_PORT`。
2. 同步 `bridge/browser_bridge_config.json` 后运行 `npm run build:bridge`，确认 dist runtime 内的 WebSocket 地址与端口一致。
3. 重新加载 Pi 会话和浏览器扩展。

## 安装浏览器扩展

方式一：在 Pi 中执行：

```text
/browser-install
```

然后按提示在 Chrome/Edge 打开扩展管理页，加载目录：

```text
D:/Pi/agent/extensions/pi-browser-tools/bridge/pi_browser_bridge
```

方式二：手动安装：

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `bridge/pi_browser_bridge`。
5. 确认扩展名称为 `Pi Native Browser Bridge`。
6. 确认扩展权限包含 downloads 和 webNavigation；更新后需重新加载扩展才能启用 `browser_download` 路径回传和 `wait.navigation` 事件完成监听。
7. 如需 `browser_upload` 读取本地文件路径，在扩展详情中启用「允许访问文件网址」。

## Reload 流程

- 修改 Pi extension TypeScript 后：在当前 Pi 会话执行 `/reload`，或新开会话。
- 修改浏览器扩展文件后：执行 `/browser-reload`，或在浏览器扩展页点击重新加载。
- 修改全局 skill 后：执行 `/reload`，或新开 Pi 会话。

## 验证

项目静态与契约验证（脚本位于 `tests/contracts/`）：

```bash
npm run check
```

Bridge ESM TypeScript 构建管线（生成当前 manifest 使用的 service worker 与 content/hook/disable-dialogs dist bundles；修改 `bridge_src/**` 后先 build 再 reload 扩展）：

```bash
npm run build:bridge
```

全局 skill 变更后按 skill-creator 要求验证：

```bash
PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py D:/Pi/agent/skills/pi-browser-tools
```

真实浏览器 smoke（可选，需浏览器扩展已连接，且端口未被其它 bridge 占用）：

```bash
npm run smoke:browser
```

如果 `127.0.0.1:18765` 已被占用，smoke 会失败并在 `.pi/browser-artifacts/smoke-browser-results.json` 写入 `bridge.port` 诊断：

- `agent_occupies`：常驻 Pi agent/bridge 正在使用扩展固定端口；先停止该 agent 或空闲时再跑 smoke。
- `orphan_socket`：疑似遗留 node/smoke 进程占用端口；按输出 PID/命令行人工确认后关闭。
- `unknown_owner`：其它进程占用端口；按输出 PID/命令行排查。

smoke 只报告占用原因，不会自动 kill 用户进程。

上传/下载真实浏览器 smoke（显式执行，会创建临时上传文件并触发下载）：

```bash
npm run smoke:browser:transfer
```

输出 artifact 默认写入：

```text
.pi/browser-artifacts/
```

当前发布前全量手动 smoke 结果保留在：

```text
.pi/browser-artifacts/final-smoke/results.json
```

该结果覆盖 tabs/wait/scan/content/html/artifact/execute/query/type/click/semantic DOM/pick/network/hook/evidence/frame/screenshot/download/upload；临时 tab/server/upload fixture/download 文件已清理。

## 排障

1. 在 Pi 中执行 `/browser-status`，确认 bridge、扩展、tabs、pending 状态。
2. 如果扩展未连接，检查端口、扩展是否启用、浏览器扩展是否重新加载。
3. 如果 tab 不可用，先用 `browser_tabs list` 确认目标 tab。
4. 如果命令超时，检查 `/browser-status` 的 pending 请求和目标页面是否阻塞。
5. 如果 `browser_dom_snapshot` 返回空 viewport/nodes，先切换到目标 tab，确认页面可见后重试。
6. 如果 artifact 读取失败，确认相对路径位于 `.pi/browser-artifacts/`；读取其它文件使用绝对路径。
7. 如果 `browser_download` 没有返回路径，重新加载浏览器扩展并确认 downloads 权限。
8. 如果 `browser_upload` 返回 file access 错误，在扩展详情启用文件网址访问后重试。

## 安全约束

- 不把 API key、cookie、密码、token 写入项目文件。
- 不把个人浏览器 profile、下载文件、截图 artifact 提交为项目代码。
- 真实浏览器 smoke 会创建临时页面和 artifact；完成后按需清理 `.pi/browser-artifacts/`。
