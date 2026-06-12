# Audit Run Report

## Scope

- Requested scope: red-team pass 2 on revised `docs/agent-harness-optimization-plan.md`, after the previous five static findings were folded into the draft.
- Agent / run id: codex-redteam-pass2-agent-harness-plan
- Date: 2026-06-12
- Audit type: static
- Commit / worktree basis: `75d694e Implement check acceleration graph`; worktree also had untracked `docs/agent-harness-optimization-plan.md` and `agent-audits/runs/2026-06-12-agent-harness-plan-static.md` before this report.

## Commands Run

| Command | Purpose | Result | Artifact |
|---|---|---|---|
| `Get-Content -Path skills\pi-browser-audit-fix\SKILL.md` | Confirm audit-only workflow boundaries | Passed | n/a |
| `Get-Content -Path agent-audits\AGENTS.md` | Confirm audit directory rules | Passed | n/a |
| `Get-Content -Path agent-audits\templates\run-report.md` | Confirm report template | Passed | n/a |
| `rg -n "ACI-\|buildId\|usage\|fresh\|lease\|check-graph\|run-check-groups\|blind\|runtime smoke\|CURRENT\|CHANGELOG\|dist" docs\agent-harness-optimization-plan.md` | Locate revised plan sections | Passed | n/a |
| `rg -n -C 14 "fixed placeholder token\|whole extension dist set\|verified object is exactly the shipped bytes\|verify:bridge:dist" docs\agent-harness-optimization-plan.md` | Inspect ACI-5 build fingerprint mechanics | Passed | n/a |
| `rg -n -C 12 "PI_BROWSER_USAGE_LOG\|distill-usage-log\|forced-round-trip\|stage-local\|user-provided log" docs\agent-harness-optimization-plan.md` | Inspect ACI-8 usage-log mechanics | Passed | n/a |
| `rg -n "^|EXTENSION_PORT_PATCH_BUNDLES|patchExtensionDistPort|PI_BROWSER_BRIDGE_PORT|replace" tests\support\patchExtensionPort.mjs` | Inspect post-build extension patch helper | Passed | n/a |
| `rg -n -C 8 "patchExtensionDistPort\|extensionSource\|extensionDir\|daemonEnv\|PI_BROWSER_USAGE_LOG\|writeStage\|stage" evals\browser-workflows\launch-blind.mjs` | Inspect blind-stage extension copy and metadata | Passed | n/a |
| `rg -n -C 7 "patchExtensionDistPort\|extensionSource\|extensionDir\|startNodeSmoke\|PI_BROWSER_BRIDGE_PORT" tests\smoke\smoke-browser-isolated.mjs` | Inspect isolated-smoke extension copy and patching | Passed | n/a |
| `rg -n -C 8 "export type UsageLogRecord\|UsageLogRecord\|record\|details\|args\|method\|session\|createUsageLogHook\|resolveUsageLogOptions\|PI_BROWSER_USAGE_LOG" src\frontend\usageLog.ts` | Inspect usage log record schema | Passed | n/a |
| `Get-Content -Path cli\connection.ts` | Inspect CLI status/connect extension surfacing | Passed | n/a |
| `Get-Content -Path src\driver\BrowserBridgeServer.ts` | Inspect bridge server construction and current absence of build-manifest logic | Passed | n/a |
| `Get-Content -Path src\driver\BrowserBridgeClientRegistry.ts` | Inspect current extension info ingestion | Passed | n/a |
| `git log -1 --oneline` | Capture commit basis | Passed: `75d694e Implement check acceleration graph` | n/a |
| `git status --short` | Capture dirty/untracked basis | Passed | n/a |
| PowerShell line-number slicing commands with `Get-Content ... | ForEach-Object` | Attempt precise line extraction | Blocked by Windows sandbox `CreateProcessAsUserW failed: 5`; replaced with `rg -n` | n/a |

## Findings

| ID | Severity | Confidence | Area | Status |
|---|---|---|---|---|
| AUDIT-006 | P1 | high | ACI-5 extension build fingerprint | unverified |
| AUDIT-007 | P2 | medium-high | ACI-8 usage-log distiller | unverified |
| AUDIT-008 | P3 | high | Sync checklist / check graph wiring | unverified |

## Finding Details

### AUDIT-006 - ACI-5 buildId is incompatible with staged post-build extension patching

- Severity: P1
- Confidence: high
- Area: ACI-5, bridge build hash, isolated smoke, blind eval
- Evidence:
  - `docs/agent-harness-optimization-plan.md:224-234` defines `buildId` as a sha256 over the whole extension dist set and says reverse-substitution verifies "exactly the shipped bytes".
  - `docs/agent-harness-optimization-plan.md:239-243` says the bridge reads the expected hash from packaged `build-manifest.json` and marks mismatch or absence stale.
  - `docs/agent-harness-optimization-plan.md:255-261` verifies clean rebuild/fake-ws mismatch, but does not exercise a staged post-build patched extension copy.
  - `tests/support/patchExtensionPort.mjs:5,13-35` mutates `dist/service-worker.js` and `dist/offscreen.js` after build to rewrite bridge port literals.
  - `evals/browser-workflows/launch-blind.mjs:136-140` copies the built extension into a temp `extensionDir` and then calls `patchExtensionDistPort(extensionDir, bridgePort)`.
  - `tests/smoke/smoke-browser-isolated.mjs:70-75` does the same for isolated smoke.
- Reproduction:
  1. Follow the current blind/smoke staging path: copy `bridge/pi_browser_bridge` to a temp extension dir.
  2. Run `patchExtensionDistPort()` on the copy. It writes new bytes into `dist/service-worker.js` and `dist/offscreen.js`.
  3. Under ACI-5 as written, the embedded `buildId` and packaged `dist/build-manifest.json` were computed before this mutation, while the running worker bytes are now different.
  4. If the temp extension continues to report the original embedded `buildId`, bridge expected and reported hashes can still match even though the running bytes no longer match the hash's claimed "whole extension dist set". If the patcher later updates only one side, the same path can become a false stale positive.
- Expected:
  - ACI-5 must explicitly define what happens to build identity after port patching. Either port/config literals are excluded from the byte identity contract, or staged extension copies recompute/update both the embedded `buildId` and staged `build-manifest.json`, and the bridge compares against the stage-local expected manifest.
- Actual:
  - The plan currently has no stage-copy/hash update contract and no verification that runs through `patchExtensionDistPort()`.
- Impact:
  - The main runtime eval paths can bypass or distort the exact stale-state signal ACI-5 is meant to prove. This weakens the "dist-on-disk to running worker" claim and can make blind-eval/isolated-smoke evidence overstate skew coverage.
- Suggested fix direction:
  - Add an ACI-5 subtask for staged extension copies. Choose one closed design:
    - hash only semantic build inputs and explicitly exclude environment-specific bridge port config from `buildId`; or
    - make `patchExtensionDistPort()` a build-id-aware transformer that rewrites the staged manifest and embedded build field consistently; or
    - stop patching generated dist bytes and build the staged extension with its final port before hashing.
  - Add a contract fixture that copies an extension, patches the port, then asserts the reported/expected build comparison behaves as intended.
  - Anchor the expected manifest path to package/stage metadata, not caller cwd.
- Verification command:
  - `npm run verify:bridge:dist`
  - A new targeted staged-copy contract, plus `npm run smoke:browser:isolated` if runtime confirmation is required.
- Notes:
  - This is not the previous circular-hash issue. The revised non-self-referential recipe is sound for an immutable dist set; the new risk is mutation after the dist set is hashed.

### AUDIT-007 - ACI-8 usage logs lack a run/task attribution contract

- Severity: P2
- Confidence: medium-high
- Area: ACI-8, blind eval telemetry, usage-log distiller
- Evidence:
  - `docs/agent-harness-optimization-plan.md:353-366` says `launch-blind.mjs` sets a stage-local `PI_BROWSER_USAGE_LOG` and a new distiller aggregates one or more JSONL files into call counts, routing rates, duration stats, and repeated-call patterns "within a run".
  - `src/frontend/usageLog.ts:69-82` records only `ts`, daemon-generated `session`, `method`, `result`, `ms`, optional `tool`, `cli`, `args`, `bytes`, and `details`.
  - `src/frontend/usageLog.ts:57` derives `sessionId` from daemon startup time plus PID, not blind eval run id, target, task, stage path, or child-agent identity.
  - `evals/browser-workflows/launch-blind.mjs:116-124` creates a local `runId` and isolated daemon state, but the current stage JSON at `launch-blind.mjs:151-161` and `194-208` does not carry `runId`, `usageLogPath`, task id, goal, or child-agent id.
  - `evals/browser-workflows/pb-blind.mjs:31-38` forwards only `PI_BROWSER_DAEMON_STATE_DIR` from `stage.json`.
- Reproduction:
  1. Launch two blind stages or run two child agents against one stage, then distill both JSONL logs together.
  2. The raw log records can distinguish daemon startup sessions but not which target URL, goal, operator task, child agent, or stage artifact they belong to unless the distiller relies on external filename/path conventions.
  3. Repeated-call detection "within a run" is therefore implicit and can collapse across agent/task boundaries when files are aggregated or a daemon is reused.
- Expected:
  - ACI-8 should define an auditable join key. Either each record includes `runId`/`stageId`/`targetUrl`/`taskId` or the distiller must require and validate sidecar metadata (`stage.json`, prompt manifest, result report) and output one section per run.
- Actual:
  - The plan says "stage-local path" but does not specify a durable run manifest, per-record identity fields, or a sidecar join contract.
- Impact:
  - The distiller can improve raw call counting, but it cannot fully replace manual transcript grading for multi-target or multi-agent blind evals. Aggregated routing rates and repeated-call smells can be misattributed.
- Suggested fix direction:
  - Extend ACI-8 with a minimal run metadata contract:
    - `launch-blind.mjs` writes `runId`, `usageLogPath`, `targetUrl/startUrl`, fixture mode, and stage path into `stage.json`.
    - Distiller accepts `{logPath, stagePath, resultPath?}` entries, or embeds run metadata into each log line.
    - The blind-eval skill records the distiller artifact path beside the human report.
  - Add a two-run fixture test proving output remains separated per run and fails or warns on missing attribution metadata.
- Verification command:
  - Unit test for `evals/browser-workflows/distill-usage-log.mjs` with two run sidecars.
  - `npm run check:eval-workflows`
- Notes:
  - This does not argue for collecting more data by default. The privacy/off-by-default boundary in ACI-8 can stay unchanged.

### AUDIT-008 - Sync checklist names the check graph consumer as an edit target

- Severity: P3
- Confidence: high
- Area: Sync checklist, check acceleration graph
- Evidence:
  - `docs/agent-harness-optimization-plan.md:564-567` says every new check must be wired into `package.json`, `scripts/run-check-groups.mjs`, and the check-graph node list.
  - `scripts/check-graph.mjs:16-22` is the actual single source for `CHECK_GROUPS`, including the `contracts` group.
  - `tests/contracts/drift/check-check-graph.mjs:32-35` asserts `scripts/run-check-groups.mjs` reads `CHECK_GROUPS`; it does not define the group list itself.
- Reproduction:
  1. Add a new check by editing `scripts/run-check-groups.mjs` per the checklist wording.
  2. The graph-backed DAG/smart runners still source obligations from `scripts/check-graph.mjs`, so the new check can be absent from `check:dag`/`check:smart` unless `CHECK_GROUPS` is updated.
- Expected:
  - The checklist should name `scripts/check-graph.mjs` `CHECK_GROUPS` as the edit target, plus `package.json` and `npm run check:check-graph`.
- Actual:
  - The checklist names `scripts/run-check-groups.mjs`, which is a consumer unless runner behavior changes.
- Impact:
  - Low direct runtime risk, but it can send implementation work to the wrong file and create graph drift during ACI-12/new-check wiring.
- Suggested fix direction:
  - Change the sync checklist wording to: `package.json`, `scripts/check-graph.mjs` `CHECK_GROUPS`, and `npm run check:check-graph`; edit `scripts/run-check-groups.mjs` only when runner behavior changes.
- Verification command:
  - `npm run check:check-graph`
- Notes:
  - This finding is precision-only. The revised draft's broader requirement that new gates join `check:dag`/`check:smart` is correct.

## Non-Issues / Rejected Leads

- Previous pass findings AUDIT-001 through AUDIT-005 appear folded into the revised draft: non-self-referential ACI-5 hash, `fresh:true` rejecting `baseline`/`baselineSnapshotId`/`baselinePath`, public snapshot lease redaction, source-text migration for ACI-10/11, and repo sync/runtime-smoke checklist.
- ACI-5 `browser_tabs action=list` surfacing is likely implementable as written because `registerTabsTool.ts:45-48` already hoists `snapshot.extension` under top-level `bridge`.
- CLI `status`/`connect`/`doctor` surfacing needs concrete code work in `cli/connection.ts` and `cli/index.ts`, but the plan already names those envelopes and unit tests; no separate finding.

## Handoff Summary

- Highest-risk finding: AUDIT-006. ACI-5 must account for `patchExtensionDistPort()` or the build fingerprint will not mean what the plan says it means in the primary runtime eval paths.
- Fastest verification: add a staged-copy contract around `patchExtensionDistPort()` and the build-id comparison.
- Files most likely affected:
  - `docs/agent-harness-optimization-plan.md`
  - `tests/support/patchExtensionPort.mjs`
  - `evals/browser-workflows/launch-blind.mjs`
  - `tests/smoke/smoke-browser-isolated.mjs`
  - `scripts/build-bridge.mjs`
  - `tests/contracts/protocol/check-bridge-build.mjs`
  - `src/frontend/usageLog.ts`
  - `evals/browser-workflows/distill-usage-log.mjs`
  - `scripts/check-graph.mjs`
