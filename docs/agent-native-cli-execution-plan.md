# Agent-Native CLI Execution Plan

## Status

Draft active plan. No implementation is authorized by this document alone; use it as the task queue
for the next workstream.

This is the **external-face queue** under the `docs/agent-native-architecture.md` mainline (the
authority). Its P0–P8 interlock with that document's batches: B1 (profile removal) simplifies P1
command metadata and `check:cli-parity`; B2 (param hide+tolerate) shrinks `commands`/`schema`
discovery output; B3/B4 align with P2/P6. Where this plan and the architecture document disagree, the
architecture document wins.

## Decision

External agents such as Codex should use `pi-browser` through **skill + CLI**. The project will
optimize the CLI as a complete agent-native frontend while preserving Pi-native `browser_*` as the
first-class in-process tool surface.

## Boundaries

- Keep one browser capability core: `registerBrowserTools`.
- Keep Pi-native `index.ts` behavior unchanged except shared-contract updates needed by CLI parity.
- Do not add public `browser_*` tools.
- Do not restore MCP.
- Do not merge strategy into CLI commands.
- Do not weaken default redaction, private-target gating, or launcher override gating.

## Task Queue

### P0 - Contract and Baseline

- [ ] Adopt `docs/agent-native-cli-spec.md` as the CLI contract.
- [ ] Add JSON output schema fixtures for CLI success, usage error, runtime error, and unavailable
  daemon.
- [ ] Capture current CLI baseline:
  - [ ] `pi-browser --help`
  - [ ] `pi-browser <cmd> --help` for all commands
  - [ ] `pi-browser daemon status --json`
  - [ ] `pi-browser tabs --action list --json`
  - [ ] `pi-browser observe --mode tabs --json`
  - [ ] `pi-browser execute --script-file ... --json`
- [ ] Record known friction:
  - [ ] `observe --mode tabs` internal `operation` initialization failure.
  - [ ] Shell quoting risk for inline JavaScript/HTML.
  - [ ] Missing one-shot readiness diagnosis.
  - [ ] Human/npm wrapper text can contaminate JSON when invoked through `npm run`.
  - [ ] `nextActions` are not consistently executable CLI command forms.

### P1 - Machine-Readable Discovery

- [ ] Add `pi-browser commands --json`.
- [ ] Add `pi-browser schema <cmd> --json`.
- [ ] Add local-only command metadata tests proving these paths do not start daemon/browser.
- [ ] Include command group metadata (`core`, `security`) and artifact behavior in command metadata;
  groups are organizational only, not capability profiles.
- [ ] Update `docs/cli.md` and skill examples to prefer discovery commands for external agents.

### P2 - Stable JSON Envelopes

- [ ] Define shared CLI envelope types for success and errors.
- [ ] Ensure `--json` writes exactly one JSON object to stdout for:
  - [ ] successful tool result
  - [ ] CLI usage error
  - [ ] local input/file error
  - [ ] daemon unavailable
  - [ ] tool/runtime error
- [ ] Move non-JSON human diagnostics to stderr or `--text`.
- [ ] Add output-schema contract tests for all envelope classes.
- [ ] Add regression tests for malformed object JSON, unknown flags, missing required params, and
  missing `--script-file`.

### P3 - Input Ergonomics

- [ ] Generalize `@file` and stdin support across string/object/array parameters where schema permits.
- [ ] Keep `execute --script-file` and add examples for PowerShell, bash, and cmd-safe usage.
- [ ] Add command-object file input examples for `command`.
- [ ] Add raw request/HAR/template file input examples for web-security commands.
- [ ] Add local validation-only command:
  - [ ] `pi-browser validate <cmd> --params @params.json --json`
  - [ ] local-only, no daemon/browser startup
- [ ] Add tests proving large inputs avoid argv quoting and still validate through the shared
  frontend validator.

### P4 - Diagnostics and Readiness

- [ ] Add `pi-browser doctor --json`.
- [ ] Doctor output must include:
  - [ ] CLI/package version
  - [ ] cwd
  - [ ] command groups / WebSecurity count
  - [ ] command count
  - [ ] daemon lockfile path
  - [ ] daemon reachability
  - [ ] bridge port
  - [ ] extension connectivity
  - [ ] selected/active tab summary
  - [ ] artifact root
  - [ ] recovery commands
- [ ] Add `pi-browser selftest --json` as an explicit bounded live smoke.
- [ ] Keep doctor read-only; selftest may create/close a temporary safe tab and must report cleanup.
- [ ] Add tests for daemon stopped, daemon stale lockfile, daemon running without extension, and
  extension connected.

### P5 - Runtime Bug and Recovery Fixes

- [ ] Fix `observe --mode tabs` internal operation initialization error.
- [ ] Normalize stale tab/snapshot/ref errors into CLI JSON recovery envelopes.
- [ ] Ensure daemon unavailable errors under `--json` are parseable JSON, not plain stderr text.
- [ ] Ensure tool runtime errors include `code`, `taxonomy`, `diagnostics`, and concrete next actions
  when available.
- [ ] Add regression coverage for the bugs above.

### P6 - Artifact and Next-Action UX

- [ ] Normalize artifact descriptors in CLI output.
- [ ] Convert high-value `nextActions` into structured entries with executable CLI examples.
- [ ] Add direct artifact read suggestions for common paths:
  - [ ] `data.content`
  - [ ] `data.actionables`
  - [ ] `data.list_hints`
  - [ ] `operation.operationId`
  - [ ] `snapshot.snapshotId`
- [ ] Keep raw payloads out of summaries; route large reads through `pi-browser artifact`.
- [ ] Add contract tests for next-action command rendering.

### P7 - Docs, Skill, and Agent SOP

- [ ] Update `docs/cli.md` from a basic CLI reference into the shipped agent-native CLI reference.
- [ ] Update `skills/pi-browser-tools/SKILL.md` to a concise external-agent SOP:
  - [ ] doctor
  - [ ] commands/schema discovery
  - [ ] tabs/observe/execute/wait/verify
  - [ ] artifact reads
  - [ ] recovery table
  - [ ] safe `--script-file` examples
- [ ] Update `README.md`, `AI_INSTALL.md`, `CURRENT.md`, `TODO.md`, and `CHANGELOG.md` when behavior
  lands.
- [ ] Run skill validation after skill edits.

### P8 - Verification and Release Gates

- [ ] `npm run check:cli-parity`
- [ ] CLI unit tests
- [ ] CLI output-schema contracts
- [ ] no-browser-startup discovery contract
- [ ] cwd propagation contract
- [ ] `npm run smoke:cli`
- [ ] `npm run check:all:package`
- [ ] `npm run check`
- [ ] Optional blind external-agent eval using the updated skill and CLI.

## Acceptance Criteria

- A shell-capable agent can use only `SKILL.md`, `pi-browser doctor --json`, local discovery commands,
  and JSON outputs to complete a live browser observe/execute/verify/artifact workflow.
- All CLI failure classes produce parseable JSON under `--json`.
- Complex JS/JSON/request payloads do not require shell quoting.
- Recovery commands are concrete enough for an agent to execute without guessing hidden prerequisites.
- Pi-native tool behavior remains stable and parity checks stay green.
