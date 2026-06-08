# Agent-Native CLI Specification

## Status

Draft execution contract for making `pi-browser` a first-class external-agent frontend.

This spec applies to the `pi-browser` CLI only. Pi-native `browser_*` tool registration remains the
canonical in-process surface, and this work must not add new public `browser_*` tools or fork browser
capability logic.

## Goal

Make any shell-capable agent able to discover, invoke, recover from, and verify browser operations
through `pi-browser` with low hidden dependency cost.

The CLI should behave like a stable machine interface first, with human rendering as a secondary
presentation layer.

## Non-Goals

- Do not replace Pi-native tool calls.
- Do not reintroduce MCP.
- Do not add strategy-shaped workflow tools.
- Do not hide expensive browser actions, scanning, crawling, fuzzing, or external-engine runs inside
  broad automatic helpers.
- Do not weaken cookie/token/body redaction defaults.

## Design Principles

1. **Same core, two frontends.** Pi-native and CLI both execute the same registered `browser_*` tool
   core. CLI differences are transport, parsing, diagnostics, and agent ergonomics only.
2. **Discover locally.** `--help`, command listing, schema listing, and input validation help must not
   start a browser or daemon.
3. **Machine mode is stable.** `--json` must always emit one parseable JSON document to stdout for
   success and errors. Human text belongs on stderr or in `--text`.
4. **No quoting tax for large inputs.** Every parameter class that can become large or structured must
   accept file and stdin input.
5. **Actionable failure.** Every non-usage failure should say what prerequisite is missing, what handle
   or artifact can be reused, and the next concrete command when that is knowable.
6. **Artifacts over payload dumps.** Large or sensitive evidence is written locally and read back with
   bounded `artifact` calls.
7. **Caller cwd is authority.** Request-scoped artifacts, memory, wordlists, OAST state, and bridge
   evidence use the invoking cwd, not daemon cwd.
8. **Mechanical params are internalized.** Defaults encode deterministic mechanical expertise.
   `docs/agent-native-architecture.md` (the authority) sharpens this: mechanical params
   (`detailLevel`/`maxChars`/`timeoutMs`/`browserSessionId`/`outputPath`/websec bounds) are
   **hidden from the advertised surface and tolerated at input** (hide+tolerate, not deleted), and
   surfaced in results when they apply; only strategic params stay visible. Internalized behavior must
   still be visible-in-result, overridable at the operator/config layer, and never silently swallow.

## Required CLI Surface

### Discovery

- `pi-browser --help`
  - Lists subcommands and global flags.
  - Does not start daemon/browser.
- `pi-browser <cmd> --help`
  - Lists flags, accepted enum values, required fields, object/file/stdin input forms, exit codes
    where relevant, and at least one agent-safe example.
  - Does not start daemon/browser.
- `pi-browser commands --json`
  - Returns machine-readable command metadata for the always-on tool surface: name, toolName,
    description, flags, required params, input modes, output artifact behavior, security group, and
    `agentCli` routing role (`standard`, `natural`, `advancedCompatibility`, or
    `nativeEscapeHatch`).
  - Does not start daemon/browser.
- `pi-browser schema <cmd> --json`
  - Returns the TypeBox-derived parameter schema and CLI flag mapping.
  - For action-tool root schemas, returns the low-level route as `advancedCompatibility` and includes
    `subcommands[]` for the recommended natural routes.
  - For natural action schemas (`schema wait selector --json`), returns the narrowed flag mapping and
    `agentCli.mode:"natural"`.
  - Does not start daemon/browser.

### Invocation

- Every registered `browser_*` tool maps to one subcommand by dropping `browser_` and converting `_`
  to `-`.
- Tool execution posts to the user-local daemon with `{ toolName, args, cwd }`.
- `--json` forces JSON stdout. Non-TTY stdout should default to JSON. TTY may default to human text.
- Global `--timeout-ms`, tool-specific timeout params, and daemon control timeouts must be
  distinguishable in docs and errors.

### Input Forms

All structured or large values must support:

- inline flag value: `--params '{"action":"list"}'`
- file value: `--params @params.json`
- stdin value: `--params -`

Action-specific natural routes may add narrower CLI ergonomics when the protocol shape is known and
auditable. Example: `hook install-targets --targets console,error` is equivalent to repeated
`--targets console --targets error` and to the underlying JSON `params.targets:["console","error"]`.

Required specific support:

- `execute --script-file <path>` for JavaScript.
- `command --command @command.json` or equivalent for native command objects.
- raw HTTP/request/HAR/template payload parameters via `@file` and stdin.
- repeated array flags, plus file/stdin JSON array where the schema accepts an array.
- object params should reject malformed JSON with a usage-envelope error, not a stack trace.

### Output Envelope

With `--json`, every command must return exactly one JSON object on stdout.

Success envelope requirements:

- `ok: true`
- `tool` and `command`
- `summary`
- `target` when tab/session scoped
- `saved` or `artifacts` when local evidence is written
- `nextActions` as structured entries when possible, with CLI command forms
- `operation` / `correlation` identifiers when available
- `privacy` classification when evidence may be sensitive

Error envelope requirements:

- `ok: false`
- `code`
- `message`
- `exitCode`
- `taxonomy`
- `diagnostics`
- `recovery`
- `nextActions` when concrete commands are known
- no stack trace unless an explicit debug flag is set

Human rendering may be compact, but it must be derived from the same envelope.

### Exit Codes

- `0`: success
- `1`: tool/runtime error with valid JSON envelope under `--json`
- `2`: CLI usage/validation error with valid JSON envelope under `--json`
- `3`: daemon/bridge unavailable with valid JSON envelope under `--json`
- `4`: local file/stdin input error with valid JSON envelope under `--json`

Exit code meanings must not drift by command.

### Diagnostics

Required diagnostic commands:

- `pi-browser daemon status --json`
  - Current singleton daemon state.
- `pi-browser doctor --json`
  - One-shot external-agent readiness check: CLI version, cwd, command count, daemon lockfile, daemon
    reachability, bridge port, extension connectivity, active/selected tab summary, artifact root,
    common recovery commands.
  - Must not mutate browser state.
- `pi-browser selftest --json`
  - Bounded local/live smoke. It may create and close a temporary safe tab only when explicitly
    confirmed or when documented as safe. It must report artifacts and cleanup status.
- `pi-browser validate <cmd> --params @file --json`
  - Parses and validates parameters locally without executing the browser tool.

### Artifacts

- Every result that writes an artifact must include a normalized artifact descriptor:
  - `path`
  - `kind`
  - `bytes`
  - `chars` when text/JSON
  - `privacy`
  - suggested bounded read commands
- `nextActions` should prefer executable CLI forms:
  - `pi-browser artifact --path <path> --mode json --json-path data.content --json`
  - `pi-browser observe --mode scan --baseline-snapshot-id <id> --json`
- Artifact reads must support bounded JSON path, text offsets, single-line column windows, search,
  sample, and multi-artifact bounded search.

### Stateful Handles

- Short-lived handles such as `tabId`, `snapshotId`, `pi-ref://`, `browser-result://`, `waitId`,
  `requestId`, listener/session ids must include freshness or recovery hints when possible.
- Stale-handle errors must include a concrete re-capture command.

### Privacy and Security

- Default summaries redact cookies, tokens, authorization headers, request/response bodies, postData,
  websocket payloads, and equivalent sensitive fields.
- Redaction is internalized (per `docs/agent-native-architecture.md`): output is always redacted and
  raw evidence always persists to a local artifact. The `--redact false` agent toggle is being retired
  in favor of **targeted retrieval** — an explicit single-value `artifact` path read (`--json-path` /
  `--pick`) returns that value; bulk/search output stays redacted. (`--redact` is hide+tolerated during
  the deprecation window.)
- Local raw artifacts remain local-only and must be labeled with retention/cleanup guidance.
- Launcher overrides for mature tools stay gated by explicit allow flags.
- Private/link-local/metadata target access remains explicitly gated.

## Compatibility Requirements

- High-frequency action tools may expose natural action subcommands as the recommended agent path,
  but the `--action/--params` interface must remain available as an advanced compatibility path unless
  a migration explicitly proves it can be removed.
- `browser_command` / `pi-browser command --command` is the complete native bridge escape hatch for
  command objects that are not modeled as ergonomic CLI flags.
- `commands --json` and `schema --json` must label these roles with `agentCli` metadata so skills and
  eval runners can distinguish recommended paths from escape hatches without reading human help text.
- Opt-in usage logging must preserve local-only, redacted route-adoption evidence for CLI calls
  (`standard`, `natural`, `advancedCompatibility`, `nativeEscapeHatch`) so legacy-path reduction can
  be evaluated from real use rather than guessed.
- `npm run check:cli-parity` must prove every registered tool has a CLI command.
- Pi-native registration count and CLI command count must stay aligned at 22 tools, with WebSecurity
  represented as group metadata rather than a profile gate.
- Generated docs must not describe future commands as callable before implementation.
- Existing command names remain stable unless a migration plan documents aliases and deprecation.

## Verification Matrix

Minimum gates for this workstream:

- Unit: flag parsing, `@file`/stdin inputs, JSON rendering, error envelopes, daemon control.
- Contract: CLI parity, schema/commands metadata, output schema conformance, no browser startup for
  discovery paths, cwd propagation.
- Runtime smoke: daemon -> bridge -> extension -> temporary page -> execute -> observe -> artifact.
- Regression: known failure cases such as malformed JSON, missing script file, stale tab,
  unavailable daemon, and `observe --mode tabs`.
- Skill validation: `skills/pi-browser-tools/SKILL.md` remains concise and matches shipped CLI.

## Acceptance Definition

The CLI is agent-native when a fresh shell-capable agent can:

1. Read the skill.
2. Run `pi-browser doctor --json`.
3. Discover commands without browser startup.
4. Create/select a target tab.
5. Observe, execute, wait, verify, and read artifacts using only JSON outputs and bounded reads.
6. Recover from common stale state and daemon/bridge failures using returned commands.
7. Complete the live CLI smoke with no hidden manual intervention beyond browser extension setup.
