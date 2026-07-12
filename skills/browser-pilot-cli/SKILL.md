---
name: browser-pilot-cli
description: Operate and inspect real Chrome or Edge tabs through the Browser Pilot CLI. Use when Codex needs to connect to Browser Pilot, select or inspect tabs, observe the canonical page model, execute event-driven JavaScript or trusted input transactions, capture screenshots or network traffic, inspect saved artifacts, troubleshoot the local daemon or extension, or discover and validate browser-pilot CLI commands and schemas.
---

# Browser Pilot CLI

Use the `browser-pilot` CLI to control a connected real browser through the user-local daemon. Prefer structured JSON, stable tab references, and the live command schema over remembered flags.

## Resolve the CLI

Choose one invocation prefix and use it consistently:

- Installed package: `browser-pilot`
- Package-local execution: `npx browser-pilot`
- Source checkout without a usable build: `npx tsx src/apps/cli/bin.ts`

Discover the live contract before using an unfamiliar command:

```text
browser-pilot --help
browser-pilot <command> --help
browser-pilot schema <command> --json
browser-pilot validate <command> --params @params.json --json
```

Treat live help and schema output as authoritative. Command definitions reject unknown parameters. Do not treat the examples in this skill as an exhaustive command catalog.

## Follow the Operating Loop

1. Establish readiness.

   ```text
   browser-pilot connect --wait --json
   ```

   On failure, inspect `browser-pilot status --json`, then `browser-pilot doctor --json`. The CLI normally auto-starts the user-local daemon; do not start parallel daemons casually.

2. Select a stable target.

   ```text
   # browser-pilot-executable
   browser-pilot tabs --action list --json
   ```

   Preserve the returned `targetRef` or tab handle and pass it with `--target-ref` when the workflow must stay on a specific tab. Prefer it over numeric `tabId`; omit both only when the selected active tab is intentional.

3. Observe before acting.

   ```text
   # browser-pilot-executable
   browser-pilot observe --target-ref <targetRef> --json
   ```

   Omit `--mode` for the canonical ABML `PageObservation`. Any explicit mode, including `scan`, is a legacy/debug/projection override. Read `gist`, `outline`, entities, refs, relations, collections, diagnostics, `saved`, and `nextActions` instead of assuming DOM state.

4. Act through `execute`.

   ```text
   # browser-pilot-executable
   browser-pilot execute --target-ref <targetRef> --script "document.title" --json
   browser-pilot execute --target-ref <targetRef> --program @program.json --json
   browser-pilot execute --target-ref <targetRef> --script-file <script-path> --json
   ```

   Use `--script` for JavaScript and `--program` for trusted CDP mouse/key/text/wait frames. Provide only one of them. There are no dedicated click or type commands. Use the low-level `command` escape hatch only when the public CLI surface cannot express the required native operation.

5. Consume the terminal outcome from the same operation call.

   ```text
   {"schema":"browser-operation/v2","operationId":"...","status":"completed","classification":"success","completionVerified":true,"ok":true,"continuation":null,...}
   ```

   State-changing commands arm browser and page listeners before dispatch and keep the invocation open until `completed`, `effect_observed`, `no_effect`, `stalled`, `ambiguous`, `target_lost`, `failed`, or `deadline`. Do not issue a separate wait or sleep. Only `completed` is success and returns `classification:"success"`, `completionVerified:true`, `ok:true`, and CLI exit 0. All other terminal statuses return `completionVerified:false`, `ok:false`, a stable `OPERATION_*` code, and CLI exit 1; `effect_observed`, `ambiguous`, `target_lost`, and `deadline` are inconclusive, while `no_effect`, `stalled`, and `failed` are failures.

   Read `continuation` before choosing the next mutation. `observe` requests a fresh canonical page model; `reacquire_target` requests a fresh tab/target selection; `inspect_diagnostics` is returned only when diagnostics exist; `verify_command_state` requests the command domain's read-only status/list query; `inspect_artifact` means the operation completed but its large result was compacted. None of these decisions authorize replaying an acknowledged mutation.

   Oversized outcomes still keep the `browser-operation/v2` root, classification, terminal status, target, dispatch state, signals, `continuation`, and `completion.source`. A typed object/array/string summary may replace `completion.evidence.result`; follow `saved.path` and the verified `artifact_hints.jsonPaths` (usually `completion.evidence.result`) for the complete redacted outcome.

6. Continue from the returned evidence, observing again only when the next decision needs a fresh page model. Do not treat command acknowledgement or `effect_observed` as proof that the intended business state was reached. Late effects from the previous operation are surfaced automatically on the same owner's next related operation. Treat `nextActions` as required recovery/continuation guidance and `artifact_hints` as optional progressive expansion; the absence of an artifact read in `nextActions` does not make the saved evidence unavailable.

## Capture Network Evidence

Prefer the one-shot page-load flow:

```text
# browser-pilot-executable
browser-pilot network capture-reload --session-id <session-id> --target-ref <targetRef> --json
```

Use canonical CLI action `capture-reload` instead of manually starting capture after navigation; it translates to raw `{"action":"captureReload"}`, arms the recorder before reload/navigation, and avoids missing early requests. CLI action tokens are kebab-case and camelCase tokens are not aliases. Use lower-level `start`, `list`, `export-har`, and `stop` only when persistent recorder control is required; start and stop return only after the recorder is armed or flushed.

## Read Artifacts Incrementally

Always start from the `saved.path` returned by the preceding command:

```text
# browser-pilot-executable
browser-pilot artifact --mode inspect --path <saved.path> --json
# browser-pilot-executable
browser-pilot artifact --mode paths --path <saved.path> --json
# browser-pilot-executable
browser-pilot artifact --mode json --path <saved.path> --json-path <verified-path> --json
```

Inspect metadata or list available JSON paths before targeted reads. Do not guess JSON paths, invent fixed artifact filenames, or load a large artifact wholesale when `pick`, `search`, `sample`, offsets, or limits can answer the question.

For a compacted operation outcome, prefer the exact path named by `artifact_hints.jsonPaths` over generic artifact defaults. The saved operation artifact embeds the same hints, so `artifact --mode inspect` can validate paths before the targeted read.

## Apply CLI Boundaries

- Add `--json` to agent-facing calls and parse the structured result.
- Preserve `targetRef`, `browserSessionId`, operation IDs, snapshot IDs, and returned artifact paths when a follow-up call depends on them.
- Use `--program @file` for large structured input on Windows.
- Use `--script-file <path>` for JavaScript files. `--script-file @file` is not file-loading syntax.
- Pass `browser-pilot command --command` as inline JSON only. Do not use `--command @file`.
- Prefer `network capture-reload` for page-load capture.
- Re-observe when refs are missing, stale, covered, or invalid instead of retrying a mutating action blindly.
- Keep security crawl, fuzz, SQLi, template, replay, cookie, and callback operations within the target scope explicitly authorized by the user.
- Avoid printing full request bodies, cookies, authorization values, or large raw artifacts. Use the CLI's bounded summaries, redaction, and targeted artifact reads.

## Recover from Failures

Read structured `error`, `diagnostics`, `nextActions`, `target`, and `saved` fields first.

- Bridge or extension unavailable: run `connect --wait`, then `status` or `doctor`.
- Stale or missing target: list tabs again and re-run canonical `observe`.
- Operation `target_lost`: inspect `dispatch`, `signals`, `target`, diagnostics, and any automatically surfaced `lateEffects`; reacquire a current target instead of replaying the action against the lost one.
- Operation `effect_observed`, `no_effect`, `stalled`, `ambiguous`, or `deadline`: follow the returned domain-aware `continuation`. Re-observe only for page-state uncertainty; reacquire changed targets, inspect present diagnostics, or use a read-only command status/list operation for non-page state.
- `ARTIFACT_SAVE_FAILED`: trust the returned operation status and `completion.source`; the browser action already reached its terminal state, but the omitted large evidence is unavailable. Do not replay it to recreate the artifact.
- Truncated inline result: follow `saved.path` and `artifact_hints`; a compact typed `completion.evidence.result` is a pointer summary, not the full value. Increase limits only when a targeted artifact read is insufficient.
- Invalid arguments: query `schema <command> --json` or validate a parameter file before retrying.

Offline `validate` and daemon invocation run the same strict pipeline. Unknown, internal, removed, and illegal cross-field/action combinations return a complete issue list and exit 2; Browser Pilot does not silently strip them. Use `schema <command> <kebab-action> --json` and `validate <command> <kebab-action> --params @params.json --json` for action-specific checks.

Observe deltas and caches are anchored by `browserSessionId + tabId + targetGeneration + pageEpoch`, never URL. When a returned `reanchorReason` says `document_changed`, `target_replaced`, `session_changed`, `identity_unproven`, or `baseline_missing`, consume the full observation as the new anchor; do not reuse refs or assumptions from the discarded baseline.

When working inside the Browser Pilot source repository, follow `AGENTS.md`, `REPO_GOVERNANCE.md`, and `CODE_WIKI.md` for code changes and validation. Those contributor rules do not replace the live CLI help for operational command syntax.
