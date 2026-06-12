# Agent Harness Optimization Plan (ACI governance extension)

> Status: **decision draft — execution-ready, not yet active.** Architect pass 1
> (2026-06-12) from six read-only fact-scout reports; pass 2 (same day) from five
> more scouts over previously unexamined dimensions (turn economy, context-loss
> resilience, concurrency semantics, version skew, telemetry/cold-start); pass 3
> (same day) from four scouts over implementation structure (mixed-domain
> hotspots, git churn/co-change coupling, entrypoint thinness, prior structural
> decisions). Activation requires a `CURRENT.md` 当前激活项 entry per governance
> rules. The governance-mechanisms workstream that overlapped pass-1 files has
> since landed (working tree clean at pass 3). Pass-3 amendments: the static
> audit `agent-audits/runs/2026-06-12-agent-harness-plan-static.md`
> (AUDIT-001..005) was consumed same-day — all four code-level claims
> independently re-verified, with one precision correction (tabs `action=list`
> is already lease-stripped; only `action=snapshot` leaks) — and is folded into
> ACI-5/6/7/10/11 and the sync checklist. Red-team pass 2
> (`agent-audits/runs/2026-06-12-agent-harness-plan-redteam-pass2.md`,
> AUDIT-006..008) is also folded in: staged extension hashing, usage-log run
> attribution, and check-graph wiring precision. A third boundary-tightening
> review (operator-relayed, same day; AUDIT-009..012 plus one advisory) is
> folded in after independent re-verification of each code claim: explicit
> `buildId` `inputs[]` with stated exclusions (AUDIT-009), staging-caller env
> propagation with static enforcement at `check-eval-workflows` (AUDIT-010),
> single-truth-source usage-log run attribution via embedded `runId`
> (AUDIT-011), salt-scoped lease-id redaction — per-process, unlinkable across
> restarts (AUDIT-012), and the ACI-12/ACI-1 double-justification advisory.
> All decisions herein are closed — no placeholders, no pending items.
>
> Scope: the **harness for the user-facing agent** (the ACI: tool schemas and
> descriptions, skill SOP text, output envelope, error/recovery surface, runtime
> reliability as the agent perceives it, eval feedback loop) and — in pass 3 —
> the **implementation structure that keeps those properties cheap to maintain**.
> NOT the repo's development harness (checks/CI), which
> `docs/archive/governance-mechanisms-plan.full.md` already owns. This plan extends the same
> five proven gate patterns onto the agent-facing dimensions that are currently
> ungated, then restructures the two empirically hottest implementation files so
> future harness work stops serializing on them.

## Structural diagnosis

The project's token economy is one-sided. The **output** side is governed by a
four-kernel distillation pipeline with budget ladders (`src/distill-core/ladder.ts`),
a salience renderer, per-tool `maxChars` budgets (`src/tools/budgets.ts:1-23`), and
hard gates (`check:token-economy`, `check:token`, `bench:distill`). The **input**
side — 22 tool schemas, descriptions, `promptSnippet`s, and `promptGuidelines`
arrays authored as literal strings in `src/tools/register*.ts`, paid by the agent
at every session start — has no measurement and no gate: the only schema-side
assertion anywhere is `description.length > 0` (`tests/contracts/cli/check-cli-parity.mjs:29`).

Audit of the harness against the five gate patterns (single source + drift check,
source-text contract assertions, shrink-only ratchets, committed baselines, shadow
guards) finds eight ungated agent-facing dimensions, each with a concrete defect
already on it:

| # | Ungated dimension | Concrete evidence found |
|---|---|---|
| 1 | Input schema surface (size + truth) | `registerObserveTool.ts:133` advertises deprecated `--output-path` in the `baselinePath` description; `detailLevel` advertised with functional wording (`toolShared.ts:38`) while `prepareArguments.ts:5` strips it before validation |
| 2 | CLI skill text | `skills/pi-browser-cli/SKILL.md` duplicates ~60-65% of the Pi-native skill (Routes table 28 rows, Observe-products table, click snippet, Memory/Bounds/Recovery/Output sections) and is bound by **zero** contract tests; the Pi-native skill is bound by five |
| 3 | Error recovery coverage | Six codes return `recovery: undefined` (no branch in `src/distill-core/recovery.ts:138-164`): `INTERNAL_ERROR`, `BROWSER_EXECUTION_ERROR`, `BROWSER_COMMAND_FAILED`, `FRAME_DETACHED`, `SESSION_NOT_FOUND`, `TAB_CRASHED`; `recovery.nextActions` is byte-duplicated into `diagnostics.nextActions` on every error (`src/utils/errors.ts:169,194`) |
| 4 | Theme-level eval graduation | The `data.`-prefix artifact-hint defect class recurred across five findings (N1, E1, H3, adjacent B3/A1) before being treated as one class; the blind-eval skill triages per-finding, with no rule forcing class-level fixes |
| 5 | Version skew (bridge↔extension, dist↔running worker) | Zero detection: `ext_ready` carries only `manifest.version` with no comparison anywhere; no build hash exists in the dist bundle or `build-manifest.json` (only the static label `bridge-build-dist-v1`, `bridge_src/shared/buildInfo.ts:1`); blind finding W1 (3 real-session occurrences) was a skew failure, and its fix was a defensive driver-side reroute (`BrowserWaitSupervisor.ts:77-93`), not detection |
| 6 | Context-loss re-anchoring | A context-compacted agent receiving `delta:"session"` against a forgotten baseline has no per-call fresh-render escape: only `detailLevel:"full"` (which also disables relevance and memory augmentation, `observeRunners.ts:614-616`) or the process-wide `PI_BROWSER_SESSION_DELTA=0`; neither skill has a re-anchor recipe |
| 7 | Concurrency conflict diagnostics | `TAB_LEASE_CONFLICT` payload (`BrowserLeaseRegistry.ts:46`) exposes the holder's raw session UUID (audit finding AUDIT-005) and omits computed lease expiry — the agent can neither wait intelligently nor avoid leaking the foreign session id |
| 8 | Turn-economy measurement + telemetry consumption | Blind-eval call counts are hand-counted; `PI_BROWSER_USAGE_LOG` records per-call tool/result/duration/routing (`src/frontend/usageLog.ts:69-83`) but has **zero consumers** — every real-session friction extraction to date was manual transcript reading; tracked-operation heartbeats emit model-facing-shaped content at 1 Hz (`toolAdapter.ts:356-359`) with unmeasured conversation cost |

**Pass-3 structural evidence.** The harness behavior above is produced by an
orchestration layer whose two hottest files are empirical serialization points
for every workstream:

| File | Lines | Mixed domains | Touches in last 80 commits | Coupling |
|---|---|---|---|---|
| `src/tools/observeRunners.ts` | 1,287 | 12 (mode norm, memory warm-start, memory augmentation plan, relevance term fusion, entity salience/outline/gist, render cache, baseline resolution, ledger glue, causal delta, scan/content/html runners) | 24 (30%) | co-changes with resultMiddleware in 11 commits; present in 3 of the 4 largest commits |
| `src/tools/resultMiddleware.ts` | 599 | 8 (envelope assembly, budget-fit dispatch, artifact spill, nextActions, memory plane, redaction, diagnostics normalization, fact-rendering diagnostics) | 22 (27.5%) | same 3-of-4 largest commits |
| `cli/index.ts` | 808 | router + ~320 lines of inline command implementations (doctor, selftest, daemon lifecycle, validate/schema/commands, natural-routing engine, schema builders, main pipeline) | 8 (10%) | violates the project's own "entrypoints thin" rule, which has no mechanical gate anywhere |

Three corroborating facts: `observeRunners.ts` has exactly **one** importer
(`registerObserveTool.ts:3`), so its split radius is minimal; the dependency
graph is already strictly layered with no cycles (observeRunners → toolAdapter →
resultMiddleware → distill-core); and the split itself was **already sketched and
deferred** in `docs/agent-native-architecture.md:293-294` ("extract
`observe/{baseline,causal,scan,content,html}.ts`; glue only dispatches.
Behavior-preserving; can be done anytime"), gated on "real maintenance pain" —
the 30%-of-commits churn figure is that gate's evidence, so ACI-10 executes an
existing deferred contract rather than opening a new question. The prior
portfolio even had to *sequence workstreams around* this file (kernel-opt Tier A
ordered before salience V2 explicitly because both touched `observeRunners.ts`).

What is already healthy and needs no decision: the output envelope and its
budget/salience/session-delta machinery; the alias/normalization layers
(deprecated-param strip, top-level passthrough at
`registerNativeActionTools.ts:38-68`, `normalizeTabId`, observe mode inference);
the error normalization chokepoint (`errorResult()` → `compactError()`, one shape
for all 22 tools); CLI readiness (`connect`/`status` with `recovery.commands[]`);
the existing one-call combos (`observe url=` navigate+scan, `baseline=` diff+
treeDiff+causal in one call, `execute monitor:true`, `wait.any/all`); the observe
render cache and the F1 inline-value threshold (4,000 chars) that already removed
the worst forced round-trip; the implicit-baseline expiry path that silently
degrades to an I-frame (contract-tested in
`check-session-delta-long-conversation.mjs:97-101`); artifact/memory durability
(`browser_artifact mode=search glob=` rediscovery; `.pi/browser-memory` disk
persistence); the repo-root `index.ts` (50 lines, thin) and
`bridge_src/service-worker.ts` (103 lines, module-graph assembly only) — both
already obey the entrypoint rule; and the driver layer (facade + services split
landed and stable per `docs/driver-architecture.md`).

## ACI-1 — Input-surface budget + schema-truth gate

**Decision.** Bring the agent-facing input surface under the same measured,
ratcheted regime as the output surface.

**Mechanism A — measured budget ratchet.** A new gate `check:input-surface`
(`tests/contracts/drift/check-input-surface.mjs`) loads the 22 tool definitions
through the same loader `scripts/generate-tool-docs.mjs` already uses, computes
per-tool advertised chars (description + promptSnippet + promptGuidelines + param
schema with descriptions) and the 22-tool total, and compares against a committed
baseline `tests/contracts/drift/input-surface-budget.json`. Shrink is free; growth
fails unless the baseline is re-committed in the same diff (declared-growth
ratchet, the `check:summary-boundary` precedent). This makes every future "add a
param / lengthen a guideline" diff show its session-start token cost.

**Mechanism B — schema-truth pass.** In the same gate: (a) no advertised schema
property key may appear in `DEPRECATED_AGENT_PARAM_KEYS`
(`src/tools/prepareArguments.ts:3-23`) unless its description contains
"deprecated" — a param is either live or marked; the advertised-vs-stripped state
of each current violator (`detailLevel` wording at `toolShared.ts:38`, etc.) is
resolved to match actual runtime behavior, not the other way around; (b) no
description string may reference a stripped param or removed flag in functional
wording — first negative control is fixing the stale `--output-path` reference at
`registerObserveTool.ts:133` in the same diff that lands the gate.

**Boundary.** No schema shrinking beyond truth fixes in this slice: measurement
and honesty first; any deliberate surface reduction is a future contract with its
own blind-eval evidence (eval-driven evolution, not preemptive cutting).

**Rejected.** Preemptively demoting per-tool guidance into skill text before
measurement exists — no evidence yet that the surface is over budget; the ratchet
produces that evidence.

**Verification.** New gate green with committed baseline; negative control:
re-adding the `--output-path` text fails it; `npm run check:tool-docs`,
`check:all:contracts`, full `npm run check`.

## ACI-2 — Bind the CLI skill; gate the shared-methodology invariants

**Decision.** Close the drift exposure on `skills/pi-browser-cli/SKILL.md` by
gate, not by codegen.

**Mechanism.** (a) Parameterize the existing Pi-native skill bindings to run over
both skill files: tool-name completeness and forbidden-name absence from
`tests/contracts/drift/check-tool-doc-drift.mjs:33-59`, removed-security-name
absence from `check-tools-contract.mjs:116-118` (adapted to CLI subcommand names
via the `cli/registry.ts` mapping). (b) Add a cross-skill consistency assertion:
the intent-column row sets of the two Routes tables and the two Observe-products
tables must match — the call-syntax columns stay free per frontend. (c) Keep both
skills hand-authored.

**Rejected.** Generating both skills from a shared methodology source: the
two-file split was a deliberate 2026-06-09 decision because frontends deserve
hand-shaped prose; prose codegen trades authoring quality for a sync property a
drift gate provides at near-zero cost. This mirrors the project's choice of drift
checks over codegen for AGENTS.md/CLAUDE.md.

**Verification.** Extended contract tests green against both files; a synthetic
row removed from the CLI Routes table fails the new assertion;
`PYTHONUTF8=1 python D:/Pi/agent/skills/skill-creator/scripts/quick_validate.py`
on both skills; `check:all:contracts`.

## ACI-3 — Complete factual recovery coverage; single-home nextActions

**Decision.** Every error class with a mechanical remediation carries structured
`recovery.nextActions`; the duplicated copy is removed.

**Mechanism.** (a) Extend `recoveryForNormalized()`
(`src/distill-core/recovery.ts:138-164`) with branches for: `TAB_CRASHED` /
`SESSION_NOT_FOUND` → `browser_tabs action=list` re-resolution; `FRAME_DETACHED`
→ `browser_frame list`; `BROWSER_COMMAND_FAILED` → validate against the native
schema (`browser_command` with a validated command object — wording precedent at
`recovery.ts` protocol branch); `BROWSER_EXECUTION_ERROR` → factual pointer only:
the thrown page error is in the result, refresh selectors via
`browser_observe mode=scan` if the script targeted stale DOM. `INTERNAL_ERROR`
stays prose-only — it has no honest mechanical remediation, and inventing one
would violate the factual-remediation rule. (b) Remove the
`diagnostics.nextActions` duplication (`src/utils/errors.ts:169,194`);
`recovery.nextActions` is the single home. Same-diff sweep: migrate the
`check:errors` assertions that read `diagnostics.nextActions`
(`tests/contracts/tools/check-errors.mjs:40-44`) and any other reader found by
grep.

**Boundary.** Strictly factual remediation — no strategy, no retry policy, no
failure taxonomy expansion (the execution-feedback plan closed those). Pi-native
keeps prose-string actions; the CLI's richer `recovery.commands[{command,argv}]`
shape (`cli/connection.ts:14-15`) is **not** ported into Pi-native — closed: the
Pi-native frontend's actions are tool calls, not shell invocations, so an argv
array is the wrong shape there.

**Verification.** `check:errors` extended with the new branches as positive
assertions and one negative control (a code outside the set still yields
`recovery: undefined`); `test:unit`; `check:token-economy` confirms the
de-duplication shrinks error envelopes.

## ACI-4 — Class-graduation rule for blind-eval findings

**Decision.** Mirror G7's graduation rule onto the ACI feedback loop: when two or
more findings share a root-cause class, the fix must land at the class chokepoint
with a class-level regression, not as per-finding patches.

**Mechanism.** Add the rule to the triage section of
`skills/pi-browser-blind-eval/SKILL.md` and the convention header of
`evals/browser-workflows/blind-findings.md`: at triage, a new finding is first
matched against resolved findings' root-cause classes; on a second hit, the work
item is written against the shared chokepoint (e.g. all artifact-hint emission
paths, all CLI flag-error paths) and its regression must cover the class, with
the historical instances as named negative controls. The seven theme groups from
the 2026-06 ledger (envelope verbosity; artifact-path discoverability; CLI flag
ergonomics; universal output params; real-site perception fallback; bridge
reliability; memory-nudge adoption) seed the class list.

**Boundary.** No change to the true-defect/no-overfit bar, the n≥2 evidence bar,
or the WAI category — this rule only changes the *granularity* of the fix once a
finding clears those bars.

**Verification.** Skill quick-validate; `check:eval-workflows` (string additions
are append-safe against its existing assertions).

## ACI-5 — Extension build fingerprint + skew surfacing

**Decision.** Make bridge↔extension version skew detectable and agent-visible.
Today the only skew pair with detection is package↔daemon
(`isDaemonVersionCurrent`, auto-restart); bridge↔extension and
dist-on-disk↔running-worker are fully silent, and W1 proved the failure mode is
real (a fix that lives extension-side is defeated by a stale loaded extension;
the agent burned 3 calls on a hard `INVALID_RULE` with no skew signal anywhere).

**Mechanism.** (a) `npm run build:bridge` computes a **non-self-referential**
`buildId` (audit AUDIT-001 — naively hashing a bundle that contains its own hash
is circular): every dist file is first emitted with a fixed placeholder token in
the injected-constant slot (extending `bridge_src/shared/buildInfo.ts`, replacing
the static `bridge-build-dist-v1` label); the `buildId` is sha256 over a
**fixed, committed `inputs[]` list** in sorted-path order **with the
placeholder still in place** (audit AUDIT-009 — "whole dist set" was
underspecified): included are the five emitted bundles (`service-worker.js`,
`content.js`, `offscreen.js`, `hook_dispatcher.js`, `disable_dialogs.js`) plus
the extension `manifest.json` — exactly the bytes the browser loads. Excluded,
each for a stated reason: `dist/build-manifest.json` (it carries the `buildId`
— including it recreates the AUDIT-001 self-reference), `*.js.map`
(`sourcemap: true` at `scripts/build-bridge.mjs:62`; maps are dev-only, never
loaded by the browser, and can embed checkout-local paths that would break the
determinism assertion — a stale `.map` being undetectable is accepted), and
`.gitignore`/`.npmignore` (packaging meta, `build-bridge.mjs:51-52`). The hash
step fails on any dist `*.js` not in the list, so a sixth bundle cannot
silently escape the fingerprint. The placeholder is then substituted and the
same value written as a new `buildId` field in
`bridge/pi_browser_bridge/dist/build-manifest.json` (the manifest exists today
with build metadata only, `build-bridge.mjs:71-90`). Verification reverses the
substitution (re-replace the injected value with the placeholder, re-hash,
compare) so the verified object is exactly the shipped bytes. Loaded-bundle
scope is deliberate: W1-class skew can live in any loaded bundle, not only the
service worker. Runtime/staged copies are part of the same contract (audit AUDIT-006):
`tests/support/patchExtensionPort.mjs` stops being a blind text patcher and
becomes a build-id-aware staging helper. After it rewrites the copied
`service-worker.js`/`offscreen.js` port literals, it recomputes the staged
extension's `buildId` with the same reverse-substitution recipe, writes the
staged `dist/build-manifest.json`, and substitutes the staged hash into the
copied bundles. Its return value grows from `{ patched }` to
`{ patched, buildId, manifestPath, env }`, where `env` is the ready-to-spread
`{ PI_BROWSER_EXPECTED_EXTENSION_BUILD_MANIFEST: manifestPath }` override
(audit AUDIT-010 — the staging caller surface is wide, not just isolated
smoke/blind eval: `launch-blind.mjs:140`, `smoke-cli-full.mjs:215`,
`smoke-browser-isolated.mjs:75`, `runner.mjs:322`, and 20+ other
`tests/smoke/smoke-*.mjs`). Every staging caller propagates it from the
helper's return value: subprocess daemon/CLI spawns spread `...env` into their
existing spawn env (the same pattern they already use for
`PI_BROWSER_BRIDGE_PORT`); callers that start `BrowserBridgeServer` in-process
set it on `process.env` (or an equivalent explicit server option) before
construction. The bridge expected-hash source is explicit and cwd-independent:
normal package runs read the package-root
`bridge/pi_browser_bridge/dist/build-manifest.json`; the env override wins when
set, so staged runs compare against the actual extension copy loaded into
Chrome/Edge, not the repo source copy. Enforcement is static at the existing
chokepoint: `check-eval-workflows.mjs` already asserts structural hygiene over
every script that calls `patchExtensionDistPort`
(`check-eval-workflows.mjs:169-246`); it gains the assertion that each such
caller propagates the helper's `env`/manifest override, so a future smoke
script cannot stage an extension without wiring the expected-hash comparison. (b) The `ext_ready` payload
(`bridge_src/service_worker/transport.ts:171-173`, via `piBridgeInfo()` at
`bridge_info.ts:7-36`) gains a `build` field carrying that hash. (c) The bridge
server reads its expected hash at startup from the package-root manifest or the
stage-local manifest override and compares on every `ext_ready`
(`src/driver/BrowserBridgeClientRegistry.ts:76-86`); mismatch — **or absence of
the field, which is exactly what every currently-stale extension will send** —
sets `extensionStale: true` with `expectedBuild`/`reportedBuild` on the client
info. (d) Surfacing: `browser_tabs action=list|snapshot` exposes it in the
existing `bridge.extension` block; CLI `status`/`connect`/`doctor` envelopes gain
the same field next to the existing `daemon.versionStale`; both skills' Recovery
tables gain one row: unexplained `INVALID_RULE`/unsupported-action → check
`bridge.extension` staleness → reload the extension.

**Boundary.** Detection and surfacing only: no blocking, no auto-reload (the
bridge cannot reload the extension), no capability negotiation protocol. The
absence-is-stale rule makes the mechanism self-bootstrapping — it does not itself
suffer from the skew it detects.

**Verification.** `verify:bridge:dist` extended to assert the hash exists in both
bundle and manifest, that they match under the reverse-substitution recipe, and
that a clean rebuild of unchanged inputs reproduces the same `buildId`
(determinism assertion); a negative control plants a synthetic extra `*.js` in
dist and asserts the hash step fails (the `inputs[]` escape guard); a
staged-copy contract copies the extension, runs `patchExtensionDistPort()`,
asserts the staged manifest/bundles carry the recomputed staged hash, and
starts a fake daemon with the stage-local manifest override so the
expected/reported comparison is clean; the extended `check-eval-workflows`
caller-propagation assertion ships with its own negative control (a synthetic
staging script that drops the override fails); `tests/contracts/runtime/
check-fake-ws.mjs` extended with a fake `ext_ready` carrying a wrong/missing
`build` → `snapshot.extension.extensionStale === true`; unit test on the client
registry comparison; CLI envelope unit tests; `check:all:bridge`; skill
quick-validate.

## ACI-6 — Per-call fresh-render escape + context-loss re-anchor recipe

**Decision.** Give a context-compacted agent a one-call way back to a full
I-frame, and encode the re-anchor SOP in both skills.

**Mechanism.** (a) `browser_observe` gains one optional boolean param `fresh`:
when true, the implicit ledger baseline and the render cache are skipped for this
call only (`sessionDeltaEnabled` at `observeRunners.ts:614-616` and
`renderCacheMatches` at `observeRunners.ts:698-706` both gain the check), yielding
a full fresh render at the current `detailLevel` — unlike `detailLevel:"full"`,
it does not disable relevance scoring or memory augmentation, and unlike
`PI_BROWSER_SESSION_DELTA=0` it is per-call. `fresh:true` hard-rejects **all
three** baseline entry paths — `baseline`, `baselineSnapshotId`, `baselinePath`
(audit AUDIT-003): since the two by-reference params are coerced into
`observeParams.baseline` before validation runs
(`registerObserveTool.ts:149-155`), the rule is one
`fresh && baseline !== undefined` check in `validateObserveParams()`
(`registerObserveTool.ts:99-112`) and covers all three surfaces. A `fresh` render
still records a new ledger frame, so the next default observe deltas against it.
The param's input-surface cost is declared through the ACI-1 ratchet in the same
diff. (b) Both skills' Recovery tables gain a re-anchor row for
"lost prior context / summarized conversation": `browser_observe fresh:true` to
re-see the page, `browser_artifact mode=search glob=**/*.json` to rediscover own
artifacts (each carries `snapshot.url`/`capturedAt`/`snapshotId` for
re-orientation), `browser_memory action=recall` for durable SOP/facts.

**Boundary.** No ledger clearing, no new tool, no change to default behavior
(absent `fresh`, byte-identical output — contract-asserted). `pi-ref://`
irrecoverability after process restart is accepted: refs are content-addressed
(`refId.ts:21-55`), so a fresh observe re-mints identical ids for stable
elements; that *is* the recovery path, and the existing `REF_STALE` remediation
text already says so.

**Verification.** `check:session-delta-long-conversation` extended: a `fresh:true`
call after established delta state returns an I-frame (no `delta:"session"`,
inline entities present) and the no-`fresh` follow-up resumes delta against the
fresh frame; three invalid-rule negative controls — `fresh:true` combined with
each of `baseline`, `baselineSnapshotId`, `baselinePath`; byte-identity negative
control for `fresh:false`/absent; a live callable `browser_observe fresh:true`
smoke that writes an artifact (path summarized at closure); `docs:generate` +
`check:tool-docs`; ACI-1 baseline re-committed; both skills re-validated.

## ACI-7 — Lease-conflict diagnostics: computed expiry, redacted holder

**Decision.** `TAB_LEASE_CONFLICT` becomes fully actionable and stops leaking the
holder's raw session id.

**Mechanism.** (a) At the two throw sites (`BrowserLeaseRegistry.ts:46`,
`BrowserBridgeCommandService.ts:264-277`): include computed `expiresAt` and
`remainingMs` (from `lease.lastSeenAt + tabLeaseTtlMs` — the data exists, the
arithmetic is just never done for the agent) and replace the embedded lease's raw
`browserSessionId`/`tabSessionId` with short **salted** hashes (closing the kernel
audit's AUDIT-005 raw-UUID finding) from one new redaction helper — no such
utility exists today (every current `createHash` site in `src/` is a checksum or
key-derivation, none redacts ids). The helper holds a process-level random salt
generated at bridge-server startup; the short id is a truncated
sha256(salt ‖ rawId). The stability scope is deliberate (audit AUDIT-012):
stable within one daemon process, so a conflict error's holder correlates with a
snapshot lease entry during live troubleshooting, and unlinkable across
restarts — an unsalted stable hash would merely convert the raw UUID into a
durable cross-run pseudo-identifier, the same leak class one step removed.
`UI_LOCK_CONFLICT` gets the same treatment — it shares the raw-holder exposure
class. (b) The same redaction applies at the
**public snapshot surface** (plan audit AUDIT-002): `browser_tabs
action=snapshot` currently returns `server.snapshot()` verbatim
(`registerTabsTool.ts:121-123`), exposing raw `leases[]`
(`id`/`browserSessionId`/`tabSessionId` UUIDs, `src/driver/types.ts:57-66`) and
`uiLock.browserSessionId` — a public-snapshot/compact-lease layer hashes those
owner ids with the **same helper and salt** as the throw sites, so the agent can
correlate a conflict error's holder with a snapshot lease entry; `action=list`
already strips leases/uiLock via `compactBridgeForTabsList`
(`registerTabsTool.ts:45-51`) and needs no change; raw ids remain available
internally. (c) Extend the existing recovery branch (`recovery.ts:159`) with the
factual options: target another tab, use your own session's tabs via
`browser_tabs action=list`, or retry after `remainingMs`.

**Boundary.** No lease semantics change, no queueing/arbitration policy, no
auto-wait. Two adjacent design questions are **closed without action**, each with
a reopen bar: (1) auto-minting per-conversation `browserSessionId` for Pi-native
agents — stays as-is (shared `"default"` session is documented runtime behavior;
isolation is the host dispatcher's job); reopen on a real multi-agent run showing
interference the lease system cannot express. (2) The service-worker network
recorder keying by per-call `sessionId` rather than `browserSessionId`
(`network_model.ts:38`) — a latent collision class with zero observed instances;
reopen when any real run shows two sessions' recorders colliding, then fix at the
keying chokepoint per the ACI-4 rule.

**Verification.** `tests/unit/driver/BrowserLeaseRegistry.test.ts` extended
(expiry fields present, raw ids absent); a `browser_tabs action=snapshot`
contract asserting raw foreign `browserSessionId`/`tabSessionId` are absent
while `expiresAt`/`remainingMs` and the short hashes are present; a salt-scope
unit test on the redaction helper (same id hashes identically within one
process and to the same value at throw site and snapshot; two helper instances
with different salts diverge); `check:errors` updated; redaction asserted via
the existing secret-redaction test pattern.

## ACI-8 — Instrumented eval stages + usage-log distiller

**Decision.** Close the measurement gap: turn-economy and routing-adoption
numbers come from machine-read logs, not hand-counting; the dormant usage log
gains its first consumer.

**Mechanism.** (a) `evals/browser-workflows/launch-blind.mjs` creates a
stage-owned `runId`, `usageLogPath`, and `stagePath`, writes them into
`stage.json` with `startUrl`, fixture mode, bridge port, and the prompt/task id
when supplied, then starts the isolated daemon with
`PI_BROWSER_USAGE_LOG=<usageLogPath>` and `PI_BROWSER_USAGE_RUN_ID=<runId>`.
Every blind run now produces a JSONL record of calls, durations, error codes,
deprecated-param strips, and CLI `routing: natural|advancedCompatibility` per
call (`usageLog.ts:69-83`; redaction-by-default preserved). Run attribution has
exactly one truth source (audit AUDIT-011 — "embedded or joined from sidecar"
permitted two): `PI_BROWSER_USAGE_RUN_ID` enters `UsageLogOptions`
(`usageLog.ts:25-30`, beside the existing per-process `sessionId`) and every
JSONL record embeds `runId`; the stage sidecar never serves as a join key — it
only supplies run-level metadata (site, task, agent, goal) keyed by the
embedded `runId`. The distiller treats a log line without an embedded `runId`
as `unattributed` and does not merge it into per-run metrics. (b) New
`evals/browser-workflows/distill-usage-log.mjs`: aggregates one or more JSONL
files plus their stage sidecars into a compact report — total calls, calls per
tool, error-code histogram per tool, legacy-routing rate, p50/p95 durations, and
repeated-call patterns (same tool+params within the same `runId`, the
forced-round-trip smell). Aggregating multiple files is sectioned by embedded
`runId`; two files never collapse into one metric bucket unless their lines
carry the same embedded `runId` — sidecars annotate buckets, they never create
or merge them. The blind-eval skill's grading step
consumes this report instead of hand-counting; the report lands next to the run
report under the stage's artifacts. (c) Production stance unchanged:
`PI_BROWSER_USAGE_LOG` stays opt-in/off by default (a perf-audit decision); the
distiller equally accepts a user-provided log when an operator opts in for a
real session by setting both `PI_BROWSER_USAGE_LOG` and
`PI_BROWSER_USAGE_RUN_ID` (an optional sidecar adds metadata only), replacing
the manual transcript-mining used for sessions `019e8409` and `019eb646`.

**Boundary.** Local-only files, redacted input, no network, no automatic
collection outside explicitly-launched eval stages or operator opt-in. The
distiller reports facts; triage classification stays with the operator per the
blind-eval skill.

**Verification.** Unit test on the distiller against committed fixture JSONL plus
stage sidecars (known counts in → known report out), including a two-run fixture
that proves repeated-call detection stays per-run and a missing-sidecar negative
control that reports `unattributed`; `check:eval-workflows` still green; skill
quick-validate after the grading-step edit.

## ACI-9 — Heartbeat emissions become liveness-only

**Decision.** The 1 Hz tracked-operation heartbeat stops emitting
model-facing-shaped content.

**Mechanism.** `withTrackedOperation` (`toolAdapter.ts:352-371`): heartbeat ticks
emit `details`-only updates (no `content` text block); milestone updates (start,
progress checkpoints, completion) keep their current shape. Whether the host
streams intermediate updates into the conversation is host-dependent — making
heartbeats contentless is correct under every host behavior, and bounds the
worst case (a 30 s wait currently shapes 30 JSON progress strings as
conversation-eligible text).

**Boundary.** No change to heartbeat frequency (it serves host-side liveness) or
to milestone semantics.

**Verification.** Unit test asserting heartbeat `onUpdate` payloads carry no
`content` while milestone payloads do; existing tracked-operation tests stay
green.

## ACI-10 — Decompose the observe orchestration file (executes a deferred contract whose gate is now met)

**Decision.** Split `src/tools/observeRunners.ts` (1,287 lines, 12 domains, 30%
commit-touch rate, single importer) along its already-evident seams. This
executes the split sketched and deferred in
`docs/agent-native-architecture.md:293-294`; the deferral gate was "real
maintenance pain", and the pass-3 churn data (24 of the last 80 commits; 11
co-changes with `resultMiddleware.ts`; workstreams explicitly sequenced to avoid
colliding on this file) is that evidence.

**Mechanism.** New directory `src/tools/observe/`, behavior-preserving moves
along the measured seams (line ranges from the pass-3 inventory):

- `observe/baseline.ts` — baseline shape extraction, multi-strategy resolution,
  recovery hints (`observeRunners.ts:456-594`)
- `observe/renderCache.ts` — TTL, params signature, page-fingerprint match,
  cached-envelope extraction (`633-719`)
- `observe/memoryAugmentation.ts` — warm-start terms, recall tokenization, entry
  loading, strike tracking, `buildMemoryAugmentationPlan` + its test escapes
  (`138-285`)
- `observe/relevanceFusion.ts` — trace/url/intent/archetype/memory term assembly,
  `entityRelevanceInputs`, `buildObserveRelevance` (`104-136, 287-356`)
- `observe/entityViews.ts` — `entitySalienceRank`, `sortEntitiesBySalience`,
  `buildEntityOutline`, `buildPageGist` (pure `Entity[]` functions; `104-118,
  362-422`)
- `observe/scanRunner.ts`, `observe/contentRunner.ts`, `observe/htmlRunner.ts` —
  the three mode runners (`745-1140, 1142-1205, 1211-1287`)
- `observeRunners.ts` remains as a **façade** re-exporting the existing public
  surface (`runScanObservation`, `runContentObservation`, `runHtmlObservation`,
  `observeErrorResult`, types, constants, test escapes) — this keeps the single
  production importer and the five runtime-importing test files working
  unchanged (`check-session-delta-long-conversation.mjs:5`,
  `check-memory-plane.mjs:8`, `tests/unit/tools/observeRunners.test.ts:11`,
  `observe-salience.test.ts:7`, `observe-abml-integration.test.ts:6`).
- **Static-contract migration sub-step (audit AUDIT-004).** The façade does NOT
  cover source-text assertions: 13 contract files read
  `src/tools/observeRunners.ts` as text and grep it — the G3
  `check-compute-once.mjs:9-11` ledger plus
  `check-task-conditioned-salience.mjs:13`,
  `check-abml-internal-integration.mjs:9`, `check-abml-inference.mjs:234`,
  `check-abml-templating.mjs:103`, `check-abml-relation-graph.mjs:128`,
  `check-abml-diff.mjs:136`, `check-abml-snapshot-projection.mjs:82`,
  `check-abml-causal.mjs:153`, `check-abml-tree-diff.mjs:80`,
  `check-protocol-contract.mjs:101`, `check-content-pick.mjs:60`,
  `check-pi-browser-bridge.mjs:1690`. Each is re-pointed to the new module path
  (or converted to an import-based assertion where the check allows) **in the
  same diff** as the move it covers — never weakened, never left asserting the
  hollow façade. Two data registries name the path and are updated in-diff:
  `tests/contracts/drift/env-flags.json` `file:` entries and
  `docs/compaction-ledger.json:135`, plus the `check-recovery-boundary.mjs:62`
  grandfather entry. The pre-split inventory
  (`rg -n "observeRunners" tests scripts docs src`) is the checklist's source of
  truth and is re-run post-split to prove zero stale references.

**Boundary.** Behavior-preserving only: no logic edits ride along, no export
renames, no envelope/schema change, no kernel-boundary change (everything stays
inside `src/tools/`; side effects remain in tool orchestration per the closed
perception-renderer decision). The split does NOT extend to `src/abml/` — moving
entity-view or ledger glue into the runtime kernels is a separate question this
plan does not open.

**Verification.** The project's existing behavior locks are the proof:
`check:scan`, `check:summaries`, `test:observe-abml-integration`,
`check:session-delta-long-conversation`, `check:task-conditioned-salience`,
`check:token-economy` (byte-level), `check:memory-plane`, `bench:distill`,
`check:compute-once` (updated ledger), full `test:unit`, and
`smoke:browser:scan-summary` as the live confirmation. Acceptance includes a
post-split line-count statement per new module.

## ACI-11 — Thin the CLI entrypoint to router + modules

**Decision.** `cli/index.ts` (808 lines, ~320 of inline domain logic) is reduced
to parse → dispatch, conforming to the project's own entrypoint rule, which the
rest of the `cli/` directory already follows (12 focused modules, 18-404 lines).

**Mechanism.** Behavior-preserving extraction into three modules named after the
existing test layout: `cli/localCommands.ts` (the inline implementations of
`doctor`, `status`, `connect` arg-parsing, `commands`, `schema`, `validate`,
`selftest`, `daemon start|stop|status` — `cli/index.ts:447-744`; the existing
unit file `tests/unit/cli/local-commands.test.ts` already names this seam),
`cli/naturalRouting.ts` (the allowlist, routing-mode decisions, and
`translateNaturalActionArgv` — `141-227`), and `cli/commandMetadata.ts` (flag-spec
builders, JSON-schema builders, help rendering, `ARTIFACT_BEHAVIOR` — `40-122,
245-401`). `index.ts` keeps `main()` plus pure dispatch. Migration sub-step
(audit AUDIT-004): the six helpers that `tests/unit/cli/flags-render.test.ts:11`
imports from `cli/index.ts` (`applyCliOnlyParams`, `buildCommandFlagSpecs`,
`invocationFlagSpecs`, `nativeActionParamsHelp`, `selftestToolError`,
`translateNaturalActionArgv`) move with their modules and that test's import is
updated in the same diff; afterward `cli/index.ts` exports only `main` (sole
runtime importer: `cli/bin.ts`) — no compatibility re-exports linger.

**Boundary.** No CLI surface change: same subcommands, flags, envelopes, exit
codes, help text bytes. No new commands ride along.

**Verification.** Existing CLI tests are the lock: `tests/unit/cli/*`
(local-commands, flags-render, daemon-control), `check:cli-parity`,
`check:param-surface`, `check:cli-json-envelopes`, `check:cli-migration-drift`;
the perf-audit guard stays honored (`node dist/cli/bin.js --help` median ~56 ms —
re-measure after split); `smoke:cli` for live confirmation when a browser is
available.

## ACI-12 — Orchestration-size ratchet (the prose rule becomes a gate)

**Decision.** "Split files before they become mixed-domain maintenance
bottlenecks" and "keep entrypoints thin" currently have **no mechanical gate**
(no `max-lines` lint, no contract). Codify them as a declared-growth ratchet over
a small named set, so the next god-file is caught at +10% rather than at 1,287
lines.

**Mechanism.** New gate `check:file-ceilings`
(`tests/contracts/drift/check-file-ceilings.mjs`) with a committed table
`file-ceilings.json` covering exactly the orchestration and entrypoint set:
`src/tools/*.ts` (top level), `src/tools/observe/*.ts`, `src/tools/summaries/scan.ts`,
`cli/index.ts` plus the three ACI-11 modules, and the repo-root `index.ts`.
Ceilings are committed at post-ACI-10/11 sizes plus ~10% headroom; a file over
its ceiling fails with the remediation "split along documented seams or
re-commit the ceiling in this diff with a one-line justification" — the
`check:summary-boundary` declared-growth precedent, applied to structure.
Generated files and kernels are out of scope (kernels have their own boundary
gates; `bridge_src/service_worker/protocol.ts` is generated).

**Boundary.** Not a repo-wide `max-lines` lint — line counts are a crude proxy
and only earn a gate where churn evidence shows the cost (this named set). The
ratchet measures the symptom cheaply; the seam documentation in this plan is
what makes the remediation concrete. `resultMiddleware.ts` (599) and
`toolAdapter.ts` (479) are **deliberately not split now**: their domains are more
cohesive, their hot defect classes are already guarded by G3
(compute-once + serialization canary), and a split would be change-for-change
today. They enter the ceiling table at current size; the reopen bar for splitting
them is mechanical — needing to raise either file's ceiling twice within a
quarter. The inline mode-inference engine in `registerObserveTool.ts` (~145
lines, cohesive and contract-tested) is likewise accepted at current size.
Interplay with ACI-1 is defined up front (audit advisory): when a
`register*.ts` ceiling bump is driven by schema/description text growth already
declared through the input-surface ratchet, the one-line justification simply
cites that ACI-1 declaration — the two gates watch different symptoms (input
token cost vs structural mixing) and never demand two separate justification
processes for one declared change.

**Verification.** Gate self-test (synthetic over-ceiling file fails); baselines
committed; wired into the contracts group; full `npm run check`.

## Explicitly not reopened

This plan touches none of the closed decisions in `ROADMAP.md` and re-litigates
nothing: no public action verbs or new `browser_*` tools, no debugger/storage/
canvas tools, no orchestration, no renderer `line` granularity, no MCP, no
progressive-disclosure profiles. Additionally closed by this plan's own analysis:
no action+observe-diff combo tool (the chain is already served by
`execute monitor:true` and session-delta auto-baselining; an action-shaped combo
would cross the perception-first line); no Pi-native meta-discovery tool
(`schema`/`commands` equivalents) — the host delivers schemas and the skill is
the discovery layer, while teaching-quality errors (`noBrowserExtensionError`,
`tabNotFoundError`, named-enum guards) cover the skill-less cold path; no
porting of CLI `recovery.commands` argv arrays into Pi-native; usage logging
stays off by default in production. Pass 3 additionally leaves closed/deferred
ground untouched: the 31 grandfathered summary distillers (accepted boundary,
shrink-only, `check-summary-boundary.mjs:13`), kernel workspace-package promotion
(deliberate deferral, `docs/abml-kernel-manifest.md:120-139`), the ABML
`PageModel/ChangeModel` split and `DistilledEnvelope` field consolidation (both
deferred in `docs/agent-native-architecture.md:283-288`), the driver layer
(stable per `docs/driver-architecture.md`), and the test-directory
reorganization (rejected in `docs/archive/REFACTORING_PLAN.full.md:363-374`).
The two open eval items (VOC2 active-state n=1; G12/D6 nudge adjudication)
already carry explicit gates in `blind-findings.md`/`CURRENT.md` and get no new
decision here.

## Sync checklist (AGENTS.md Sync & Verification applied per ACI; audit AUDIT-005)

Material tool/bridge changes must sync beyond code and gates. Per-ACI artifacts,
each closed inside the ACI's landing diff or its closure record:

- **Every ACI**: `CURRENT.md` activation entry before work starts and a
  completion record at close; `CHANGELOG.md` entry; every new check wired into
  `package.json` and `scripts/check-graph.mjs` `CHECK_GROUPS` (the single graph
  source consumed by `scripts/run-check-groups.mjs`, `check:dag`, and
  `check:smart`) in the diff that adds it; run `npm run check:check-graph`.
  Edit `scripts/run-check-groups.mjs` only when runner behavior changes.
- **New env flags** (G6): every new `PI_BROWSER_*` flag registered in
  `tests/contracts/drift/env-flags.json` in the diff that introduces it —
  ACI-5 adds `PI_BROWSER_EXPECTED_EXTENSION_BUILD_MANIFEST`, ACI-8 adds
  `PI_BROWSER_USAGE_RUN_ID` (both `affectsOutput: false`); `check:env-flags`
  green.
- **ACI-1 / ACI-6** (schema text changes): `npm run docs:generate` +
  `check:tool-docs`; ratchet baselines committed.
- **ACI-2 / ACI-4 / ACI-5 / ACI-6** (skill text changes): both skills edited and
  quick-validated; skill-bound contract tests re-run.
- **ACI-5**: `README.md` + `AI_INSTALL.md` gain the extension-stale reload
  guidance; `docs/cli.md` documents the new `status`/`connect`/`doctor` field;
  isolated smoke / blind-eval staging docs mention the stage-local build-manifest
  override and hash-aware extension port patching.
- **ACI-6**: after runtime reload, an actual callable
  `browser_observe fresh:true` smoke that writes an artifact; artifact paths
  summarized in the closure record (the repo's enhanced-tool runtime rule).
- **ACI-7**: any doc enumerating snapshot fields updated for the redacted
  lease/uiLock shape.
- **ACI-8**: blind-eval skill grading step and the `blind-findings.md`
  convention header updated together; stage artifacts include `runId`,
  `usageLogPath`, and the distiller report path.
- **ACI-10 / ACI-11**: `docs/maintainer-map.md` re-pointed to the new module
  layout (it is the "first look" index); live smoke confirmations
  (`smoke:browser:scan-summary`, `smoke:cli`).

## Execution order and acceptance

Gates and small fixes first (they lock behavior), then the structure moves under
that lock, then the structural ratchet pins the result:

1. **ACI-9** — smallest change, immediate worst-case byte bound.
2. **ACI-3** — small blast radius, immediate envelope byte win, all files known.
3. **ACI-7** — two throw sites plus tests; closes an audit finding.
4. **ACI-1** — lands the measurement baseline plus the two truth fixes as its
   negative controls.
5. **ACI-6** — rides on ACI-1 (its param growth is the ratchet's first declared
   addition); skill edits batched with ACI-2's.
6. **ACI-2** — contract-test parameterization plus the cross-skill assertion.
7. **ACI-8** — eval-layer only; independent of the above.
8. **ACI-5** — largest behavioral slice (build script + extension + driver + CLI
   envelopes); requires `build:bridge` and an extension reload to verify live.
9. **ACI-10** — the observe decomposition, executed only after the above gates
   are green so the full behavior lock (token-economy byte checks, session-delta
   fixtures, compute-once ledger) stands guard over the move.
10. **ACI-11** — the CLI entrypoint thinning, under the existing CLI test lock.
11. **ACI-12** — last: ceilings committed at the post-split sizes.

Acceptance: all new/extended gates wired into the `contracts` group; each gate
ships with a negative control; ratchet baselines committed (ACI-1, re-committed
by ACI-6; ACI-12 at post-split sizes); both skills re-validated; full
`npm run check` + `npm run lint` green; added full-gate wall-clock ≤ +5s; ACI-5
verified through `verify:bridge:dist`, staged extension copy/hash fixtures, and
fake-ws skew fixtures (live stale-extension reproduction is not required — the
absence-is-stale rule is exercised by the fixture); ACI-8 verified with a
two-run attributed usage-log fixture; ACI-10/11 close with
`smoke:browser:scan-summary` and `smoke:cli` live confirmations respectively;
the sync checklist above is part of acceptance, including the callable
`fresh:true` runtime smoke artifact. Per the
graduation rule itself: any
future recurrence of an input-surface, skill-drift, recovery-coverage,
skew-detection, measurement-gap, or god-file defect class lands as a tighter
static gate, not a report.
