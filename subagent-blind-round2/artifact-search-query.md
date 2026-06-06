# browser_artifact search query 与默认脱敏复测（黑盒 round2）

结论：**FAIL**

## 环境/方式

- 使用当前已构建 CLI：`node dist/cli/bin.js artifact ...`
- 未读取源码判断；未传 `--redact false`。
- 临时 artifact：`C:\Users\HUAWEI\AppData\Local\Temp\tmp.grexGnhk69\artifact-search-redaction.txt`

## 创建 artifact 命令

```bash
TMP_ROOT="$(mktemp -d)"
ART="$TMP_ROOT/artifact-search-redaction.txt"
cat > "$ART" <<'EOF'
fruit line: pineapple
berry line: 蓝莓
phrase line: token economy
phrase line: password reset
phrase line: secret santa
phrase line: cookie banner
cookie line: Cookie: sessionid=ck_live_A1B2C3D4E5F6G7H8I9J0
header line: Authorization: Bearer auth_live_Z9Y8X7W6V5U4T3S2R1Q0
json line: {"token":"json_token_P0Q1R2S3T4U5V6W7X8Y9","secret":"json_secret_L1M2N3O4P5Q6R7S8T9U0"}
EOF
```

## 搜索命令

```bash
node dist/cli/bin.js artifact --path "$ART" --mode search --query "pineapple" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "蓝莓" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "token economy" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "password reset" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "secret santa" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "cookie banner" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "json_secret_L1M2N3O4P5Q6R7S8T9U0" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "ck_live_A1B2C3D4E5F6G7H8I9J0" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "auth_live_Z9Y8X7W6V5U4T3S2R1Q0" --json
node dist/cli/bin.js artifact --path "$ART" --mode search --query "json_token_P0Q1R2S3T4U5V6W7X8Y9" --json
```

## PASS 项

- `pineapple`：`query` 原样可见，snippet 原样包含 `fruit line: pineapple`。
- `蓝莓`：`query` 原样可见，snippet 原样包含 `berry line: 蓝莓`。
- `token economy`：普通含敏感关键词短语原样可见。
- `password reset`：普通含敏感关键词短语原样可见。
- `secret santa`：普通含敏感关键词短语本身原样可见。
- `cookie banner`：普通含敏感关键词短语本身原样可见。
- JSON 字段 secret/token 原值搜索时，`query` 显示为 `[redacted]`，JSON snippet 值显示为 `[redacted]`。

## FAIL / 可复现失败

### 1) Cookie 原值搜索泄露 query 和 snippet

命令：

```bash
node dist/cli/bin.js artifact --path "$ART" --mode search --query "ck_live_A1B2C3D4E5F6G7H8I9J0" --json
```

输出关键片段：

```json
{
  "query": "ck_live_A1B2C3D4E5F6G7H8I9J0",
  "matches": 1,
  "snippets": [
    {
      "text": "5: phrase line: secret santa\n6: phrase line: cookie banner\n7: cookie line: Cookie: sessionid=ck_live_A1B2C3D4E5F6G7H8I9J0\n8: header line: Authorization: Bearer [redacted]\n9: json line: {\"token\":\"[redacted]\",\"secret\":\"[redacted]\"}"
    }
  ]
}
```

判定：默认输出泄露 Cookie secret 原值，**FAIL**。

### 2) Authorization 原值搜索泄露 query

命令：

```bash
node dist/cli/bin.js artifact --path "$ART" --mode search --query "auth_live_Z9Y8X7W6V5U4T3S2R1Q0" --json
```

输出关键片段：

```json
{
  "query": "auth_live_Z9Y8X7W6V5U4T3S2R1Q0",
  "matches": 1,
  "snippets": [
    {
      "text": "6: phrase line: cookie banner\n7: cookie line: Cookie: sessionid=ck_live_A1B2C3D4E5F6G7H8I9J0\n8: header line: Authorization: Bearer [redacted]\n9: json line: {\"token\":\"[redacted]\",\"secret\":\"[redacted]\"}"
    }
  ]
}
```

判定：默认输出泄露 Authorization secret 原值于 `query`，且上下文泄露 Cookie secret，**FAIL**。

### 3) 普通短语搜索上下文泄露 Cookie secret

命令：

```bash
node dist/cli/bin.js artifact --path "$ART" --mode search --query "cookie banner" --json
```

输出关键片段：

```json
{
  "query": "cookie banner",
  "matches": 1,
  "snippets": [
    {
      "text": "4: phrase line: password reset\n5: phrase line: secret santa\n6: phrase line: cookie banner\n7: cookie line: Cookie: sessionid=ck_live_A1B2C3D4E5F6G7H8I9J0\n8: header line: Authorization: Bearer [redacted]"
    }
  ]
}
```

判定：普通 query 本身原样可见，但默认 snippet 上下文泄露 Cookie secret，**FAIL**。

### 4) JSON secret/token 搜索上下文泄露 Cookie secret

命令：

```bash
node dist/cli/bin.js artifact --path "$ART" --mode search --query "json_secret_L1M2N3O4P5Q6R7S8T9U0" --json
```

输出关键片段：

```json
{
  "query": "[redacted]",
  "snippets": [
    {
      "text": "7: cookie line: Cookie: sessionid=ck_live_A1B2C3D4E5F6G7H8I9J0\n8: header line: Authorization: Bearer [redacted]\n9: json line: {\"token\":\"[redacted]\",\"secret\":\"[redacted]\"}"
    }
  ]
}
```

判定：目标 JSON secret 被脱敏，但默认上下文仍泄露 Cookie secret，**FAIL**。

## 汇总判定

- 普通 query 原样可见：**PASS**。
- 中文 query 原样可见：**PASS**。
- 普通含敏感关键词短语原样可见：**PASS**。
- secret query/snippet 默认不泄露：**FAIL**，Cookie secret 未默认脱敏；Authorization 原值 query 未脱敏；上下文 snippet 可泄露 Cookie secret。
