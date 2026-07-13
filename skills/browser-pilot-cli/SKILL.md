---
name: browser-pilot-cli
description: Drive and inspect real Chrome or Edge tabs through the expert Browser Pilot CLI. Use when Codex needs to connect to Browser Pilot, choose and pin a tab, observe the canonical page model, execute JavaScript or trusted input programs, capture page-load network evidence, inspect saved artifacts progressively, troubleshoot the daemon or extension, or discover and validate the live CLI contract.
---

# Browser Pilot CLI

Control the user's connected browser through `browser-pilot` and its user-local daemon. Prefer structured JSON, stable target references, bounded reads, and the live CLI contract.

## Trust the Live Contract

Choose one available prefix and keep it consistent:

- Use `browser-pilot` for an installed package.
- Use `npx browser-pilot` for package-local execution.
- Use `npx tsx src/apps/cli/bin.ts` inside an unbuilt source checkout.

Discover syntax before using an unfamiliar surface:

```text
browser-pilot commands --json
browser-pilot <command> --help
browser-pilot schema <command> --json
browser-pilot schema <command> <kebab-subcommand> --json
browser-pilot validate <command> <kebab-subcommand> --params @params.json --json
```

Treat `commands --json`, live help, schema, validate, generated contracts, and command definitions as authoritative over this Skill. If they disagree, correct the Skill; do not add CLI compatibility for a stale example. Expect closed schemas and rejection of unknown parameters. Use kebab-case CLI subcommands while preserving schema-defined raw action spelling in JSON.

## Follow the Core Loop

1. Check installation and readiness.

   Run `browser-pilot --help`, then `browser-pilot connect --wait --json`. On failure, inspect `browser-pilot status --json` and `browser-pilot doctor --json`. Reuse the managed daemon instead of starting parallel instances.

2. List tabs and pin the target.

   ```text
   # browser-pilot-executable
   browser-pilot tabs list --json
   ```

   Preserve the returned `targetRef` and pass it to later tab-scoped calls. Prefer it over numeric `tabId`; omit both only when intentionally using the selected active tab.

3. Observe current state without a redundant mode.

   ```text
   # browser-pilot-executable
   browser-pilot observe --target-ref <targetRef> --json
   ```

   Omit `--mode` for the canonical `browser-page-observation/v3` root. Treat explicit modes as legacy/debug projections. Read `gist`, structure, entities, compact actionable refs, relations, collections, providers, `frontier`, `saved`, `artifact_hints`, and `nextActions`; do not infer state from an old observation. Anchor deltas by browser session, tab, target generation, and `pageEpoch`; when `reanchorReason` reports discontinuity, consume the full observation as the new anchor.

4. Act with `execute` or the native `command` escape hatch.

   ```text
   # browser-pilot-executable
   browser-pilot execute --target-ref <targetRef> --script "document.title" --json
   ```

   Use `execute --script` for JavaScript or `execute --program @program.json` for trusted CDP mouse/key/text/program frames. Supply exactly one input. For a non-idempotent mutation, also supply a stable `--intent-id` and keep it unchanged across every recovery attempt. Use `command --command '<inline-json>'` only when the normal command surface cannot express a required native operation; pass inline JSON only.

   A physical program that does not navigate or download should finish with exactly one explicit postcondition frame:

   ```json
   {"eval":"document.querySelector('[aria-pressed=true]') !== null","verify":true}
   ```

   The verification frame must be the sole final verifier and passes only when it resolves to `true` or an object containing `{"verified":true}`. Browser Pilot revalidates the fully expanded frame sequence, preserves physical-frame acknowledgement even when the result transport is lost, and returns `completed/program-verified` only after that proof. Within the current daemon process, a completed `intentId` is reused only for the same script/program payload; an uncertain repeat is blocked and a different payload is rejected as an intent conflict.

5. Classify the returned operation before continuing.

   Require the same state-changing call to return `browser-operation/v2`. Treat only `status:"completed"` with `classification:"success"`, `completionVerified:true`, and `ok:true` as success. Treat `effect_observed`, `ambiguous`, `target_lost`, and `deadline` as inconclusive; treat `no_effect`, `stalled`, and `failed` as failures.

   Read `dispatch`, `completion.source`, `signals`, `diagnostics`, `continuation`, `saved`, and `artifact_hints`. Never equate acknowledgement or a visible effect with verified completion. Do not blindly replay an acknowledged mutation; follow `observe`, `reacquire_target`, `inspect_diagnostics`, `verify_command_state`, or `inspect_artifact` guidance according to the returned continuation. Browser Pilot serializes writes on the same owner/session/stable target. After an acknowledged but unverified mutation, later `execute` or native-command writes remain blocked until a fresh canonical `observe` begins after settlement and verifies the same page identity; reusing the same `intentId` remains blocked even after observation. Mint a new intent only after read-only evidence proves the prior intent did not take effect.

6. Expand large evidence progressively.

   Start from the exact `saved.path` returned by the preceding call. Inspect metadata, list verified paths, then read only the needed JSON value.

## Keep Temporary JavaScript in Memory

Treat this as a mandatory operating rule, not a preference: pipe generated, multiline, complex, or quote-sensitive JavaScript through stdin:

```text
browser-pilot execute --target-ref <targetRef> --script - --json
```

- Temporary, generated, multiline, complex, or quote-sensitive JavaScript MUST be piped directly to `browser-pilot execute --script -` over stdin.
- Agents MUST NOT create a temporary `.js`, `.mjs`, text, or other local file merely to invoke `execute`.
- `--script @file` MAY be used only for durable source that already exists or that the user explicitly asked to preserve.
- Keep short shell-safe source inline; use the caller's stdin API when a shell pipe is inconvenient.

## Capture Page-Load Network Evidence

Arm capture before reload/navigation with the one-shot route:

```text
# browser-pilot-executable
browser-pilot network capture-reload --session-id <sessionId> --target-ref <targetRef> --json
```

Use canonical CLI action `capture-reload`; it maps to raw `{"action":"captureReload"}`. Do not treat camelCase as a CLI alias. Use lower-level recorder start/list/export/stop only for a deliberately persistent capture session.

## Read Artifacts Incrementally

Use the preceding result's path in this order:

```text
# browser-pilot-executable
browser-pilot artifact inspect --path <saved.path> --json
# browser-pilot-executable
browser-pilot artifact paths --path <saved.path> --json
# browser-pilot-executable
browser-pilot artifact json --path <saved.path> --json-path <verifiedPath> --json
```

Follow `frontier.items[].read` and `artifact_hints.jsonPaths` exactly. Substitute the returned `saved.path`, preserve verified JSON paths and offsets, and prefer bounded `json`, `pick`, `search`, `sample`, offset, or limit reads over loading a whole artifact. Do not guess paths, invent filenames, or interpolate untrusted paths into shell templates.

## Respect Interaction and Security Boundaries

- Add `--json` to agent-facing calls and parse the structured response.
- Preserve `targetRef`, browser session identity, operation IDs, snapshot IDs, and artifact paths needed by follow-up calls.
- Re-observe when refs are stale, missing, invalid, or covered; reacquire a target after replacement or loss.
- Use `execute` or `command` for page interaction. No standalone click, type, or wait tool exists.
- Keep native escape-hatch and security crawl, fuzz, injection, replay, cookie, callback, and related capabilities strictly within targets and scope explicitly authorized by the user.
- Avoid printing cookies, authorization values, request bodies, secrets, or large raw artifacts; prefer redacted summaries and targeted reads.

## Recover Deliberately

- For bridge or extension unavailability, run `connect --wait`, then inspect `status` or `doctor`.
- For invalid arguments, query live help/schema and run offline `validate` before retrying.
- For a stale target, run `tabs list`, select a current `targetRef`, and observe again.
- For `ARTIFACT_SAVE_FAILED`, trust the settled browser status while treating omitted large evidence as unavailable; do not replay the mutation to recreate evidence.
- For compacted results, follow `saved.path` and verified hints rather than increasing broad output limits.

When changing Browser Pilot itself, follow `AGENTS.md`, `REPO_GOVERNANCE.md`, and `CODE_WIKI.md` for repository workflow and gates. Keep those contributor rules separate from live operational syntax.
