---
name: browser-pilot-cli
description: Operate and inspect real Chrome or Edge tabs through the Browser Pilot CLI. Use when Codex needs to connect to Browser Pilot, select or inspect tabs, observe the canonical page model, execute JavaScript or trusted input programs, wait for browser conditions, capture screenshots or network traffic, inspect saved artifacts, troubleshoot the local daemon or extension, or discover and validate browser-pilot CLI commands and schemas.
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
   browser-pilot tabs --action list --json
   ```

   Preserve the returned `targetRef` or tab handle and pass it with `--target-ref` when the workflow must stay on a specific tab. Prefer it over numeric `tabId`; omit both only when the selected active tab is intentional.

3. Observe before acting.

   ```text
   browser-pilot observe --target-ref <targetRef> --json
   ```

   Omit `--mode` for the canonical ABML `PageObservation`. Any explicit mode, including `scan`, is a legacy/debug/projection override. Read `gist`, `outline`, entities, refs, relations, collections, diagnostics, `saved`, and `nextActions` instead of assuming DOM state.

4. Act through `execute`.

   ```text
   browser-pilot execute --target-ref <targetRef> --script "document.title" --json
   browser-pilot execute --target-ref <targetRef> --program @program.json --json
   browser-pilot execute --target-ref <targetRef> --script-file <script-path> --json
   ```

   Use `--script` for JavaScript and `--program` for trusted CDP mouse/key/text/wait frames. Provide only one of them. There are no dedicated click or type commands. Use the low-level `command` escape hatch only when the public CLI surface cannot express the required native operation.

5. Wait for a meaningful condition after state-changing actions.

   ```text
   browser-pilot wait selector --selector "#result" --target-ref <targetRef> --json
   browser-pilot wait navigation --target-ref <targetRef> --json
   browser-pilot wait network-idle --target-ref <targetRef> --json
   ```

   Prefer natural wait subcommands. Use `browser-pilot wait --help` and its schema for composite `any` or `all` waits.

6. Verify with a fresh observation or targeted evidence read. Do not treat command acknowledgement alone as proof that the page reached the intended state.

## Capture Network Evidence

Prefer the one-shot page-load flow:

```text
browser-pilot network captureReload --session-id <session-id> --target-ref <targetRef> --json
```

Use `captureReload` instead of manually starting capture after navigation; it arms the recorder before reload/navigation and avoids missing early requests. Use lower-level `start`, `list`, `wait`, `export-har`, and `stop` only when persistent recorder control is required.

## Read Artifacts Incrementally

Always start from the `saved.path` returned by the preceding command:

```text
browser-pilot artifact --mode inspect --path <saved.path> --json
browser-pilot artifact --mode paths --path <saved.path> --json
browser-pilot artifact --mode json --path <saved.path> --json-path <verified-path> --json
```

Inspect metadata or list available JSON paths before targeted reads. Do not guess JSON paths, invent fixed artifact filenames, or load a large artifact wholesale when `pick`, `search`, `sample`, offsets, or limits can answer the question.

## Apply CLI Boundaries

- Add `--json` to agent-facing calls and parse the structured result.
- Preserve `targetRef`, `browserSessionId`, operation IDs, snapshot IDs, and returned artifact paths when a follow-up call depends on them.
- Use `--program @file` for large structured input on Windows.
- Use `--script-file <path>` for JavaScript files. `--script-file @file` is not file-loading syntax.
- Pass `browser-pilot command --command` as inline JSON only. Do not use `--command @file`.
- Prefer `network captureReload` for page-load capture.
- Re-observe when refs are missing, stale, covered, or invalid instead of retrying a mutating action blindly.
- Keep security crawl, fuzz, SQLi, template, replay, cookie, and callback operations within the target scope explicitly authorized by the user.
- Avoid printing full request bodies, cookies, authorization values, or large raw artifacts. Use the CLI's bounded summaries, redaction, and targeted artifact reads.

## Recover from Failures

Read structured `error`, `diagnostics`, `nextActions`, `target`, and `saved` fields first.

- Bridge or extension unavailable: run `connect --wait`, then `status` or `doctor`.
- Stale or missing target: list tabs again and re-run canonical `observe`.
- Wait timeout: use `wait diagnose` when applicable and inspect temporal diagnostics.
- Truncated inline result: follow `saved.path` and `artifact_hints`; increase limits only when a targeted artifact read is insufficient.
- Invalid arguments: query `schema <command> --json` or validate a parameter file before retrying.

When working inside the Browser Pilot source repository, follow `AGENTS.md`, `REPO_GOVERNANCE.md`, and `CODE_WIKI.md` for code changes and validation. Those contributor rules do not replace the live CLI help for operational command syntax.
