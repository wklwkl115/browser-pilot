# Browser Workflow Eval Results

This directory is reserved for optional, hand-run browser workflow eval result records.

## Rules

- Do not commit raw browser dumps, HAR bodies, cookies, tokens, screenshots, or downloaded private files.
- Store concise result JSON only when it follows `../result-schema.json`.
- Prefer artifact path references over pasted artifact content.
- Redact sensitive values before writing notes.
- Keep result files local and deterministic enough for review.
- Do not treat these records as required CI output.

## Suggested filename

Use `<eval-id>.result.json`, for example:

- `01-readable-content-artifact.result.json`

## Required fields

Start from `../manual-result-template.json`. Each result records:

- status
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
- summary/artifact/diagnostic evidence references
- concise notes
