# Protocol Single Source Plan

## 决策

- 单源继续使用 `bridge/native_command_schema.json`，不引入新的 IDL 文件或外部 schema 编译器。
- 本轮只迁移 wait/network/transfer 代表域与错误码表；其它 hook/frame/html/screenshot/evidence 后续按域迁移。
- 外部 callable tool 名称、参数、summary/saved envelope、bridge command 名称与错误码不迁移、不重命名。

## 单源结构

`bridge/native_command_schema.json` 维护以下人工字段：

- `domains`：native command 分域顺序。
- `commands`：command 的 `domain`、`tabScoped`、`required`、`requiredAny`、`methods`、`methodSpecs`、`canonical`。
- `aliases`：native command alias。
- `errorCodes`：公开结构化错误码、类别、retryable 标记和短摘要。
- `toolMetadata.nativeActionTools`：从 callable native action 工具到 command 的 action alias 映射，本轮覆盖 `browser_wait`、`browser_network`。
- `toolMetadata.transferTools`：transfer callable tool 到 native command、参数清单和 artifact prefix 的映射，本轮覆盖 `browser_download`、`browser_upload`。

## 生成产物

`npm run sync:protocol` 调用 `scripts/sync-native-protocol.mjs`，从单源生成：

- `bridge/pi_browser_bridge/native_command_schema.json`：浏览器扩展随包 schema 副本。
- `bridge_src/service_worker/protocol.ts`：MV3 runtime 内嵌 protocol schema、canonical map 和 validator。
- `src/protocol/nativeProtocol.ts`：Node driver/tool 侧内嵌 protocol schema、validator 和 command list。
- `src/protocol/nativeActionMetadata.ts`：wait/network action alias 与 transfer tool metadata。
- `src/protocol/nativeErrorCodes.ts`：错误码 taxonomy 表。
- `docs/generated/native-protocol.generated.md`：native command、tool metadata、错误码、README/skill 文档片段。

`npm run check:protocol` 先执行 `node scripts/sync-native-protocol.mjs --check`，再运行 protocol contract；手改任一生成产物会失败。

## 人工维护边界

- 人工编辑：`bridge/native_command_schema.json`、领域实现代码、tool 注册的说明文案。
- 禁止人工编辑：`bridge/pi_browser_bridge/native_command_schema.json`、`bridge_src/service_worker/protocol.ts`、`src/protocol/nativeProtocol.ts`、`src/protocol/nativeActionMetadata.ts`、`src/protocol/nativeErrorCodes.ts`、`docs/generated/native-protocol.generated.md`。
- 工具注册层只消费生成 metadata；不在 `actionCommands.ts` 或 transfer 工具里重复 wait/network/transfer command 字符串映射。

## 兼容策略

- command 名、tool 名、参数名和错误码保持原值。
- `hook.clear` / `hook.ping` 等 alias 继续通过 schema `aliases` 解析。
- wait/network/transfer 先读生成 metadata，但执行路径、timeout、artifact、summary 仍保留现有实现。
- Node driver 与 MV3 runtime 使用同一 schema 文本生成 validator，避免一侧接受、一侧拒绝。

## 回滚方式

1. 从最近通过门禁的版本恢复 `bridge/native_command_schema.json`。
2. 执行 `npm run sync:protocol` 重新生成所有产物。
3. 执行 `npm run check:protocol` 和 `npm run check`。
4. 若 runtime 行为受影响，再执行 `npm run smoke:browser:isolated` 并保留 `.pi/browser-artifacts/smoke-browser-isolated-results.json`。

## 后续迁移顺序

1. hook/frame/html/screenshot/evidence action metadata 继续迁入 `toolMetadata.nativeActionTools`。
2. 将更多 tool 参数描述和 artifact 行为迁入 schema 后再更新 `scripts/generate-tool-docs.mjs`。
3. 错误码 details/retryability 细分留给 TODO 213 taxonomy 收口。
