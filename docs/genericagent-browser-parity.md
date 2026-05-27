# GenericAgent 浏览器能力对照

对照来源：

- `C:/Users/HUAWEI/AppData/Local/Temp/GenericAgent/assets/tools_schema_cn.json`
- `C:/Users/HUAWEI/AppData/Local/Temp/GenericAgent/ga.py`
- `C:/Users/HUAWEI/AppData/Local/Temp/GenericAgent/simphtml.py`
- `C:/Users/HUAWEI/AppData/Local/Temp/GenericAgent/TMWebDriver.py`

## 结论

当前项目已经覆盖 GenericAgent 暴露给 Agent 的浏览器工具面：

- GenericAgent `web_scan` → Pi `browser_observe mode=scan|text|tabs` + `browser_tabs`
- GenericAgent `web_execute_js` → Pi `browser_execute`

Pi 项目额外保留了正文提取、pick、wait、network、hook/evidence、frame、html、screenshot、upload/download、artifact 读取等能力。当前不应恢复 `browser_query` / `browser_click` / `browser_type` / `browser_dom_*` 动作拆分层。

GenericAgent 内部体验级能力也已对齐为 Pi 风格：

1. GenericAgent `web_execute_js` 默认自动做页面变化监控；Pi 以 `browser_execute monitor:true` 提供可选执行前后 scan diff，默认关闭以控制 token 和延迟。
2. GenericAgent `web_scan` 有 `findMainList` + `[FAKE ELEMENT]` 列表压缩提示；Pi 以 `list_hints` 暴露重复列表、隐藏项数量和样例，完整内容仍进 artifact。
3. GenericAgent `optHTML` 标注 `:-webkit-autofill` 受保护输入；Pi scan 现在输出 `data-autofilled="true"` 与 `protected-autofill` 提示。

## 工具面映射

| GenericAgent 能力 | GenericAgent 实现 | Pi 当前实现 | 状态 |
| --- | --- | --- | --- |
| 标签页列表 | `web_scan(tabs_only=True)` | `browser_tabs list` / `browser_observe mode=tabs` | 已覆盖 |
| 切换目标页 | `switch_tab_id` 设置默认 session | 每个工具显式 `tabId`，`browser_tabs switch` 可切换 | 已覆盖，Pi 更严格 |
| 简化 DOM 扫描 | `simphtml.get_html(... optHTML)` | `browser_observe mode=scan` 简化 DOM + top-layer + actionables | 已覆盖 |
| 纯文本扫描 | `web_scan(text_only=True)` | `browser_observe mode=text` | 已覆盖 |
| 同源 iframe | `optHTML` 读取 iframe body | `browser_observe mode=scan includeIframes:true` | 已覆盖 |
| shadow DOM | `optHTML` 遍历 shadowRoot | `browser_observe mode=scan` 遍历 shadowRoot | 已覆盖 |
| 表单值 | input/textarea value、checked、select data-selected | input/textarea value、checked、select value | 已覆盖 |
| 自动填充保护提示 | `:-webkit-autofill` → `data-autofilled` / warning | `data-autofilled="true"` / `protected-autofill` | 已覆盖 |
| 可见性过滤 | rect/style/opacity/area | CSS + rect + hit-test diagnostics | 已覆盖 |
| overlay/top-layer | overlay/partition/mainInteractive/floatingAd | topLayerRoot + ordinary player non-modal 契约 | 已覆盖 |
| 列表压缩 | `findMainList` + `[FAKE ELEMENT]` | `list_hints` + maxNodes/maxChars + artifact + actionables | 已覆盖（Pi 表格化表达） |
| 智能截断 | `smart_truncate` 树级截断 | 输出预算 + artifact | 部分覆盖 |
| 执行 JS | `web_execute_js` | `browser_execute` JS | 已覆盖 |
| 执行期间新 tab | TMWebDriver/newTabs | `BrowserBridgeServer` / bridge `newTabs` | 已覆盖 |
| reload/超时提示 | TMWebDriver closed/ACK timeout | `BRIDGE_TIMEOUT` + ACK diagnostics | 已覆盖 |
| 页面变化 diff | `execute_js_rich` 前后 HTML diff | `browser_execute monitor:true` 可选 scan diff；默认关闭 | 已覆盖 |
| 临时文本捕获 | `temp_monitor_js` | 显式 hook/evidence；execute monitor 聚焦稳定 DOM diff | 替代覆盖 |
| 跳过监控 | `no_monitor` | 默认不监控；传 `monitor:true` 才开启 | 已覆盖 |

## 当前 Pi 对 GenericAgent 的增强

- `browser_wait`：selector/navigation/loadState/networkIdle typed wait。
- `browser_network` / `browser_hook` / `browser_evidence`：比 GenericAgent 自动 diff 更可控的证据链。
- `browser_frame`：frame 列表和 frame 内执行。
- `browser_observe mode=content|html`：正文和 HTML 定向抽取。
- `browser_pick`：用户可视点选。
- `browser_download` / `browser_upload`：文件传输，一等工具，上传有 `confirm:true` 安全门。
- `browser_artifact`：大结果局部读取。
- `detailLevel` / summary table / artifact：Pi token 预算确定性更强。

## 后续建议

1. 不新增动作工具；继续坚持 `scan -> execute -> wait -> verify`。
2. `browser_execute monitor:true` 只在需要紧凑的前后 DOM diff 时使用；常规动作仍显式 wait/verify。
3. `browser_observe mode=scan` 的 `list_hints` 是 Pi 表格化列表压缩提示，不应替代 artifact 原文。
