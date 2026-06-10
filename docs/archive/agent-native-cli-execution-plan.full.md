# Agent-Native CLI Execution Plan

## Status

Completed execution plan. P0-P8 started as a draft queue; items are marked complete only where
current-state implementation, docs, eval evidence, or tests prove the behavior.

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

- [x] Adopt `docs/agent-native-cli-spec.md` as the CLI contract.
- [x] Add JSON output envelope fixtures/tests for CLI success, usage error, runtime error, and unavailable
  daemon.
- [x] Capture current CLI baseline:
  - [x] `pi-browser --help`
  - [x] `pi-browser <cmd> --help` for all commands
  - [x] `pi-browser daemon status --json`
  - [x] `pi-browser tabs --action list --json`
  - [x] `pi-browser observe --mode tabs --json`
  - [x] `pi-browser execute --script-file ... --json`
- [x] Record known friction:
  - [x] `observe --mode tabs` internal `operation` initialization failure.
  - [x] Shell quoting risk for inline JavaScript/HTML.
  - [x] Missing one-shot readiness diagnosis.
  - [x] Human/npm wrapper text can contaminate JSON when invoked through `npm run`.
  - [x] `nextActions` are not consistently executable CLI command forms.

### P1 - Machine-Readable Discovery

- [x] Add `pi-browser commands --json`.
- [x] Add `pi-browser schema <cmd> --json`.
- [x] Add local-only command metadata tests proving these paths do not start daemon/browser.
- [x] Include command group metadata (`core`, `security`) and artifact behavior in command metadata;
  groups are organizational only, not capability profiles.
- [x] Include command group metadata (`core`, `security`).
- [x] Include `agentCli` route metadata so agents can distinguish recommended `standard`/`natural`
  routes from `advancedCompatibility` and `nativeEscapeHatch` routes without parsing human help.
- [x] Update `docs/cli.md` and skill examples to prefer discovery commands for external agents.

### P1a - Natural Routing, Compatibility, and Escape Hatch

- [x] Keep low-level `--action/--params` for native action tools as an advanced compatibility path.
- [x] Add scoped natural action routing for `wait` and `network` high-frequency paths.
- [x] Add scoped natural action routing for `frame list/evaluate` and selected `hook` lifecycle /
  collection actions.
- [x] Keep `pi-browser command --command @file` as the full native bridge command-object escape
  hatch.
- [x] Surface natural routes in `wait/network/frame/hook --help`, `commands --json`, root
  action-tool schema `subcommands[]`, and natural schemas such as `schema wait selector --json`,
  `schema frame evaluate --json`, and `schema hook install-targets --json`.
- [x] Add usage-log route metadata (`standard`, `natural`, `advancedCompatibility`,
  `nativeEscapeHatch`) so real adoption can be measured.
- [x] Expand natural routing only where current evidence justifies it: `frame list/evaluate` and
  selected `hook` actions are recommended; complex frame script lifecycle and hook listener/selector
  inspection actions remain advanced compatibility.
- [x] Add blind-eval prompt/triage tasks that measure route adoption, schema lookups, fallback to
  `--action/--params`, and recovery quality across `wait`, `network`, `frame`, and `hook`.
- [x] Run blind frame/hook adoption checks and feed findings back into schema discovery and
  `hook install-targets --targets` ergonomics.

### P2 - Stable JSON Envelopes

- [x] Define shared CLI envelope types for success and errors.
- [x] Ensure `--json` writes exactly one JSON object to stdout for:
  - [x] successful tool result
  - [x] CLI usage error
  - [x] local input/file error
  - [x] daemon unavailable
  - [x] tool/runtime error
- [x] Move non-JSON human diagnostics to stderr or `--text`.
- [x] Add output-schema contract tests for all envelope classes.
- [x] Add regression tests for malformed object JSON, unknown flags, missing required params, and
  missing `--script-file`.

### P3 - Input Ergonomics

- [x] Generalize `@file` and stdin support across string/object/array parameters where schema permits.
- [x] Keep `execute --script-file`.
- [x] Add examples for PowerShell, bash, and cmd-safe usage.
- [x] Add command-object file input support for `command`.
- [x] Add command-object file input examples for `command`.
- [x] Add raw request/HAR/template file input examples for web-security commands.
- [x] Add local validation-only command:
  - [x] `pi-browser validate <cmd> --params @params.json --json`
  - [x] local-only, no daemon/browser startup
- [x] Add tests proving large inputs avoid argv quoting and still validate through the shared
  frontend validator.

### P4 - Diagnostics and Readiness

- [x] Add `pi-browser doctor --json`.
- [x] Doctor output must include:
  - [x] CLI/package version
  - [x] cwd
  - [x] command groups / WebSecurity count
  - [x] command count
  - [x] daemon lockfile path
  - [x] daemon reachability
  - [x] bridge port
  - [x] extension connectivity
  - [x] selected/active tab summary
  - [x] artifact root
  - [x] recovery commands
- [x] Add `pi-browser selftest --json` as an explicit bounded live smoke.
- [x] Keep doctor read-only; selftest may create/close a temporary safe tab and must report cleanup.
- [x] Add tests for daemon stopped, daemon running without extension, and extension connected.
- [x] Add stale lockfile diagnostic coverage without leaking daemon tokens.

### P5 - Runtime Bug and Recovery Fixes

- [x] Fix `observe --mode tabs` internal operation initialization error.
- [x] Normalize stale tab/snapshot/artifact errors into CLI JSON recovery envelopes.
- [x] Audit browser-result/ref stale recovery envelopes against the agent CLI JSON contract.
- [x] Ensure daemon unavailable errors under `--json` are parseable JSON, not plain stderr text.
- [x] Ensure daemon invoke/runtime errors include `code`, `taxonomy`, `diagnostics`, and concrete next actions
  when available.
- [x] Add regression coverage for stale tab/snapshot/artifact recovery bugs above.

### P6 - Artifact and Next-Action UX

- [x] Normalize artifact descriptors in CLI output.
- [x] Convert high-value `nextActions` into structured entries with executable CLI examples.
- [x] Add direct artifact read suggestions for common paths:
  - [x] `data.content`
  - [x] `data.actionables`
  - [x] `data.list_hints`
  - [x] `operation.operationId` / `snapshot.snapshotId` were validated for targeted correlation
    artifacts, then removed from the generic CLI artifactBehavior/readCommands hot path by the
    performance audit because most saved artifacts do not contain those paths.
- [x] Keep raw payloads out of summaries; route large reads through `pi-browser artifact`.
- [x] Add contract tests for next-action command rendering.

### P7 - Docs, Skill, and Agent SOP

- [x] Update `docs/cli.md` from a basic CLI reference into the shipped agent-native CLI reference.
- [x] Update `skills/pi-browser-tools/SKILL.md` to a concise external-agent SOP:
  - [x] doctor
  - [x] commands/schema discovery
  - [x] tabs/observe/execute/wait/verify
  - [x] artifact reads
  - [x] recovery table
  - [x] safe `--script-file` examples
- [x] Update `README.md`, `AI_INSTALL.md`, `CURRENT.md`, `TODO.md`, and `CHANGELOG.md` when behavior
  lands.
- [x] Run skill validation after skill edits.

### P8 - Verification and Release Gates

- [x] `npm run check:cli-parity`
- [x] CLI unit tests
- [x] CLI output-schema contracts
- [x] no-browser-startup discovery contract
- [x] cwd propagation contract
- [x] `npm run smoke:cli`
- [x] `npm run check:all:package`
- [x] `npm run check`
- [x] Optional blind external-agent eval using the updated skill and CLI.

## Acceptance Criteria

- A shell-capable agent can use only `SKILL.md`, `pi-browser doctor --json`, local discovery commands,
  and JSON outputs to complete a live browser observe/execute/verify/artifact workflow.
- All CLI failure classes produce parseable JSON under `--json`.
- Complex JS/JSON/request payloads do not require shell quoting.
- Recovery commands are concrete enough for an agent to execute without guessing hidden prerequisites.
- Pi-native tool behavior remains stable and parity checks stay green.
