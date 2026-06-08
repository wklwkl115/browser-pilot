# Agent-Native Unified Architecture

## Status

**ACTIVE execution contract — activated 2026-06-07.** This is the authority for the merged
"agent-native architecture + CLI" mainline. It defines the internal architecture; the external CLI
face is contracted in `docs/agent-native-cli-spec.md` and queued in
`docs/agent-native-cli-execution-plan.md` (both subordinate to this document — where they disagree,
this document wins, see "Relationship to the CLI docs").

No implementation is authorized by this document alone. Each batch lands behavior-preserving, with its
own verification, per `CURRENT.md` change-workflow.

## Why one mainline (not two)

The architecture redesign and the CLI optimization are the **same contract seen from two ends**:

- The architecture defines the **internal** contract (engines, parameter zones, result envelope).
- The CLI spec defines the **external** contract (commands, JSON envelope, discovery, input).
- The **strategic parameter surface** and the **result envelope** are literally one artifact viewed
  from inside vs outside. Designing them on two lines guarantees drift — the disease this repo spent
  effort removing. Merging makes the tool registration the single source both faces derive from.

**Verified foundation (this is already true, not to be built):** `register*Tool` typebox `parameters`
is the single contract. Pi-native uses it directly; the CLI derives subcommands + flags from it via
`cli/registry.ts` `buildCliCommands` → `cli/flags.ts` `buildFlagSpecs(def.parameters)`;
`check:cli-parity` locks the relationship. **Editing the registration schema propagates to both faces
automatically.** The redesign edits the contract source + the envelope plane; both faces follow.

## Diagnosis: unhealthy but localized

A three-stream audit (2026-06-07) found the architecture is **much healthier than it felt** — the
mess is concentrated, not systemic.

- **Clean, keep as-is (the skeleton):** `src/driver/` (facade + 8 sub-registries, zero reverse deps),
  `src/protocol/` (generated leaf, CI-locked), `src/tools/memory/` (self-contained), `src/scan` /
  `src/content` / `src/pick` (one-way script generators), `webSecurity` shared→engines→register
  (correct one-way layering), and ABML's `abml-core`/`abml` boundary (CI-locked single-direction).
- **The 3 real hotspots:** (1) the tool parameter surface (mechanical params not internalized); (2) the
  observe glue (`observeRunners.ts` 783-line god-file + `summaries/scan.ts` side effects); (3) ABML
  dead weight + the `templating` coupling knot. The former zod/typebox double validation stack has
  since been collapsed to a TypeBox-compatible local validation wrapper for nested objects; the
  remaining boundary is top-level public schema vs nested runtime validation, not two schema
  libraries.

The redesign is **targeted refactor, not rewrite.**

## Target model: 4 planes, thin facade, two parameter zones

```
┌ Tool Facade (register*Tool, thin) ── public browser_*, strategic params only ──┐
├ Envelope plane (resultMiddleware + summaries, pure / side-effect-free) ─────────┤ uniform shape/redact/artifact/budget
├ Capability engines (black-box domain engines, narrow interfaces) ───────────────┤
│   · Perception:  PageModel (AX↔DOM entities) + ChangeModel (diff/treeDiff/causal) │
│   · WebSecurity: shared primitives → engines/bridges                              │
│   · Memory                                                                        │
│   · Injection:   scan / content / pick                                            │
├ Transport/Session plane (driver + protocol) ── already clean, the chassis ──────┤
└──────────────────────────────────────────────────────────────────────────────────┘

Parameters live in two zones:
  [ mechanical core = internal ExecutionContext, hidden from the agent ]
  [ strategic surface = per-tool, the ONLY params the agent sees ]
```

## Core principle: mechanical vs strategic parameters (Brain–Hand Separation, made operational)

The classifier for every agent-facing parameter:

- **Mechanical** — its correct answer is knowable from the page/context **without the agent's task
  goal**. The tool owns it; the agent must not be forced to choose it.
- **Strategic** — its correct answer **depends on what the agent is trying to do**. The agent owns it;
  the skill guides it.

This is the principle that makes a skill+CLI surface teachable: the skill teaches strategy; the CLI
invocation carries only strategy; mechanical choices are black-boxed. In a CLI, every parameter is a
flag the agent must spell out and wade through in `--help`, so internalizing mechanical params is
**more valuable for the CLI than for in-process** calls.

### Black-box boundary (the B2 lesson)

Black-box only choices whose correct answer is task-independent. A black box that judges
task-dependent success (the reverted B2 action arm: auto JS→CDP escalation that could not tell
"swallowed" from "slow-but-working") is the failure mode. Internalized defaults must stay **visible in
results, overridable, and diagnosable on failure** — never silently swallow.

### Implementation: lean schema + `prepareArguments` shim (harness-native, VERIFIED)

Verified 2026-06-07 against the Pi harness type defs (`@earendil-works/pi-coding-agent` `ToolDefinition`):
- The model sees the registered schema **as-is** — `ToolInfo = Pick<ToolDefinition,"name"|"description"|"parameters">`; there is **no hidden/visibility annotation** on tool params. So "keep in schema but hide from the model" is impossible on the Pi-native face.
- Validation is strict (`strictToolParameters` = `additionalProperties:false`, `toolShared.ts:47`); both faces reject unknown keys (`src/frontend/validation.ts` replicates the harness `Value.Convert`+`Value.Check`). So naively deleting a param re-breaks the C2/C3/H2 "accept instead of hard-reject" fixes.
- **BUT** `ToolDefinition.prepareArguments?(args)` is an official *"compatibility shim to prepare raw tool call arguments **before schema validation**"* — purpose-built for exactly this. (Secondary path: `pi.on("tool_call")` with mutable `event.input`, "no re-validation after mutation".)

Therefore flattening = **lean schema + `prepareArguments`** (no hand-rolled hidden marker):

1. Remove the mechanical param from the registered schema (lean) → the model no longer sees it (Pi-native) AND `buildCliCommands`/`buildFlagSpecs` (`cli/flags.ts:60`) emit no flag (CLI `--help` shrinks). Single source, both faces follow.
2. Add the deprecated-param strip as **ONE central shim** — a `withDeprecatedParamStrip(keys)` helper applied uniformly in `defineBrowserTool`/the adapter and wired as each tool's `prepareArguments`, **not copy-pasted per tool** (duplication is the anti-pattern). It strips the known deprecated allowlist from raw args **before** validation → habit-callers are tolerated, not hard-rejected (C2/C3/H2 preserved). Defaults are already applied internally (toolAdapter budgets/timeouts).
2b. **Evidence-driven removal (not a guessed window):** the shim records each stripped key through the daemon's existing usage log (`createUsageLogHook`, `daemon.ts:53-57`). When a key's strip-count reaches zero across real sessions, it is safe to delete from the tolerance list — the deprecation window closes on data, matching the project's eval-driven ethos rather than a calendar guess.
3. CLI: add `ABSENT_FLAG_HINTS` (`cli/flags.ts:163`) entries so a legacy `--detail-level` gets a helpful redirect.
4. Operator-level overrides (e.g. a longer global timeout for slow CI/sites) move to config/env, not per-call agent params.

**CLI wiring — verified gap (2026-06-07):** `cli/daemon.ts:183` validates RAW params
(`validateToolArgs(def.parameters, params)`) and then `execute`s — it does **NOT** call
`prepareArguments` (only the Pi harness does). So B2 tolerance on the CLI face needs one explicit line
in the daemon: `const prepared = def.prepareArguments?.(params) ?? params;` before
`validateToolArgs(def.parameters, prepared)`. With that single line, the **same shim serves both faces**
(harness on Pi-native, daemon on CLI). Without it, CLI callers passing a lean-removed key hard-reject.

This fits BOTH faces via a first-class harness hook + that one daemon line; the advertised surface
flattens immediately, existing callers do not break, migration is auditable — satisfying the
constitution's "wrapper compatibility window + exit steps" rule.

## Design principle: result-driven affordance (not passive docs, not new params)

The project's strongest eval lesson: **passive documentation does not move adoption** (agents loaded a
new skill verbatim and still skipped the product 4/4); **a low-noise, result-driven `nextActions` hint
does** (the treeDiff/causal hint is the proven case). Generalize this into an architecture rule for
every under-adopted-but-valuable capability:

- Surface it as a **low-noise `summary.nextActions` hint fired only when it actually applies** — never
  as passive prose, never as a new param/tool.
- The hint names the existing capability + the exact next call; it does **not** auto-execute or decide
  strategy (the Brain–Hand line holds).
- This unifies today's scattered cases under one mechanism: the treeDiff/causal hint (shipped),
  the `http_replay.mutations` hint (B2 adjacent finding — used 2/39), and B4's raw-location pointer.

**Adoption is an architecture concern, not a docs concern** — encode it in the result, measure it by
blind eval. (Corollary: do not "fix" under-adoption by adding a tool or a param — that widens the
surface; fix it by a result hint, gated on real applicability.)

## Decided boundary points (2026-06-07)

1. `browserSessionId` — hidden on the 21 tab-scoped tools; **visible only on `browser_tabs`** (the
   session-management tool).
2. `outputPath` — hidden (result returns `saved.path`); **kept on `browser_artifact` / `browser_memory`**
   where the path is the subject.
3. Redaction retrieval — **reuse `browser_artifact` targeted read**: an explicit single-value path
   (`jsonPath`/`pick`) returns the value (the agent naming it = intent); `text`/`search`/bulk stays
   redacted. No new "reveal" tool. (This changes today's behavior where path reads also redact;
   targeted access is auditable, far better than the `redact:false` firehose. Iteration-to-extract is a
   mild accepted risk.)
4. Batch 3 is descoped: the agent line does **only** the `summaries` side-effect removal; full envelope
   field consolidation moves to the maintainer track.
5. ABML this round strips only the safe dead weight (below); the execution ladder is deferred.

## Architecture invariants + their guards (what makes it durable, not just correct)

An excellent agent-native architecture is **self-preserving**: each invariant has a CI guard so drift
becomes structurally hard. This whole effort was triggered by doc/code drift — the architecture must
not re-accrue it. Drift-proofing is a first-class architecture feature, not an afterthought.

| Invariant | Why it matters | Guard |
|---|---|---|
| **I1 — single contract source**: `register*Tool` typebox is the only param/result truth | both faces derive; nothing hand-maintained | `check:cli-parity` |
| **I2 — two faces derive, never diverge**: CLI flags + Pi-native schema both come from the registration | no per-face param drift (the disease this session fixed) | `check:cli-parity` + B2a backward-compat test |
| **I3 — mechanical internal / strategic exposed**: the advertised surface is strategic-only | spends agent cognition on strategy, not knobs | C2/H1/C4 re-asserted as *tolerance* (B2) + a param-surface audit check |
| **I4 — envelope/distillers pure**: no side effects in the result/summary layer | long-lived daemon correctness (cross-request bleed) | **NEW guard needed** — `summaries/*` must not import `resources`/`abml` ref-writers (B3 + a boundary check, mirroring `check:abml-core-boundary`) |
| **I5 — safety gates internal, never removed**: redaction / private-target / confirm / lease / launcher operate, not agent-toggled | safety must not be flattenable away | existing gate contracts stay; B4 keeps redaction operating |
| **I6 — execution = JS + CDP, ABML observation-only**: no action verbs/params | the B2 action-arm revert lesson | `check:tools-contract` (no `browser_click`/`type`/`action`) |
| **I7 — no new public `browser_*` without RFC + eval** | surface stays thin | `check:cli-parity` count + `tool-boundaries` |

The one **missing** guard today is I4 (the `summaries/scan.ts` side-effect this session uncovered
proves it). Adding it is part of B3 — an excellent architecture ships the guard with the fix so the
class of bug cannot return.

## Workstream A — agent line (ACTIVATED)

All four batches are agent-facing, leverage the single contract (both faces follow), and are
low/medium risk. Order: **B1 → B2a → B2b → (B2c/B2d) → B3 → B4.** B2a is the gate that B4 reuses.

### B1 — remove the capability profile
- Blast radius verified 2026-06-07 (grep `PI_BROWSER_TOOL_PROFILE`/`securityToolsEnabled`): delete
  `capabilityProfile.ts` (40 lines, self-contained); merge `CORE_/WEB_SECURITY_` arrays in
  `toolRegistry.ts`; drop `securityToolsEnabled` from `registerTools.ts`, `cli/registry.ts:39`,
  `index.ts:16-17,53`, `cli/{index,daemon}.ts`, and **`BrowserBridgeServer.setCapabilityProfile` (+ the
  `browser_tabs snapshot` capability-profile field)**; `generate-tool-docs.mjs`; change
  `check-cli-parity.mjs` 15/22 → constant 22; update/remove `capabilityProfile.test` /
  `parity-differential.test` / `toolRegistry.test` / profile-setting smokes; update
  README/skill/AI_INSTALL/CURRENT/tool-boundaries.
- ~10 code/test files + 1 snapshot output field + ~8 docs. Bounded but wider than the param batches —
  ship as its own clean commit.
- Done: 22 tools always; `PI_BROWSER_TOOL_PROFILE` fully removed; parity asserts 22; snapshot no longer
  carries a capability profile.

### B2 — parameter flattening (hide + tolerate)
- **B2a (mechanism, no surface change):** add a shared `prepareArguments` shim (harness-native, runs
  before schema validation) that strips a known deprecated-param allowlist, on every tool; add the
  backward-compat test (passing `detailLevel` still succeeds on both faces). Ships and is verified
  before any schema goes lean.
- **B2b (core 4 shared params):** via `sharedTabScopedToolParams`, hide `detailLevel` / `maxChars` /
  `timeoutMs`; hide `browserSessionId` on the 21, keep it on `browser_tabs`.
- **B2c (`outputPath`):** hide (rely on `saved.path`); keep on artifact/memory.
- **B2d (websec mechanical knobs):** hide the full mechanical set via the same mechanism. **Flatten
  `--help`, do NOT nest into a `bounds` object** (hostile on a command line). Keep
  `confirm` / `allowPrivateTargets` / `allowLauncherOverride` / `bindBrowserSession` visible.
- Done: `--help` shrinks; Pi-native still tolerates old params (compat test green); skill drops them.

**Full mechanical-param inventory (code-grounded + log-confirmed 2026-06-07).** All mechanical params
are injected from TWO builders — flatten there, both faces follow:
- `sharedTabScopedToolParams` (`toolAdapter.ts:160`) — already has `includeTabId/includeDetailLevel/
  includeTimeout/includeMaxChars/includeRedact/includeOutputPath` switches; a `hidden` marker is the
  natural extension. Injects: `detailLevel`(164) `maxChars`(167) `timeoutMs`(166) `browserSessionId`(162)
  `outputPath`(165) — all **hide**; `tabId`(163) **keep** (disambiguation); `redact`(168) **keep**
  (strategic for security — see B4).
- `sharedWebSecurityParams` + per-param builders (`shared.ts:120-222`): `maxBodyBytes`(126)
  `maxDepth`(206) `maxPages`(212) `maxCases`(194) `maxCandidates`(200) `maxTemplates`(218)
  `rateLimitPerSecond`(188) `timeoutSeconds`(175) `harMaxEntries`(144) `followRedirects`/`maxRedirects`(181)
  `defaultScheme`(161) — all **hide**; `cookieMode`(134) borderline-hide (default merge);
  `allowPrivateTargets`(127) **keep** (SSRF gate).
- Log evidence (session `019ea05a`, a heavy 222-call security session): `detailLevel`/`maxChars`/
  `timeoutMs`/`maxBodyBytes` passed as their defaults on nearly every call; the websec knobs
  `maxDepth`/`maxPages`/`rateLimitPerSecond` passed **0 times** → hiding is zero-loss. `redact:false`
  passed ~199× (strategic, kept). `bindBrowserSession` 53× (strategic, kept).

**Adjacent log finding (not B2, route to skill/ergonomics):** `browser_http_replay`'s `mutations`
("vary one field and resend") was used 2/39 times — the agent hand-rebuilds whole requests instead.
Same under-adoption pattern as observe/causal; address via skill routing or a result `nextActions`
hint, not a new param.

**Contract impact — verified 2026-06-07 (B2 must update these gates):** `check-tools-contract.mjs:88-100`
currently asserts the OPPOSITE of B2 — it locks that tools *include* `detailLevel`/`maxChars`/`redact`
in their schema (the C2/H1/C4 "accept instead of hard-reject" fixes). B2 must **invert** these from
mechanism ("schema includes detailLevel") to behavior ("passing a deprecated param is tolerated via
`prepareArguments`, not hard-rejected"). `check-tool-parameter-contract.mjs:12,21`
(`additionalProperties:false` strict reject) **stays** — B2 keeps strict schemas, just leaner +
shim-stripped. The C2/H1/C4 contracts encode a hard-won lesson (agents pass these everywhere); B2
preserves the lesson (still tolerate) while changing the mechanism — so the gates re-assert tolerance,
not schema inclusion. Add the B2a backward-compat tolerance test alongside.

### B3 — summaries side-effect removal (daemon correctness)
- Move the `registerRefDescriptor` side effect out of `summaries/scan.ts` up into the orchestration
  layer; the distiller becomes pure. This is a latent-bug fix for the long-lived daemon (shared global
  ref Map written from distillers across requests), not a feature.
- Call-graph verified (2026-06-07): 5 mint sites in `summaries/scan.ts:337-363` (each
  `registerRefDescriptor` + `withRegisteredRef`); the other writers (`abml/verbs/*`,
  `abml-core/entity`) are legitimate runtime minters and stay. **Nuance:** `scan.ts` is a DISTILLER
  (runs in the `resultMiddleware` pipeline, not inside `observeRunners`), so the fix = split
  entity-build (pure, stays in scan.ts) from ref-mint (move to where the scan data originates, before
  distillation). Bounded (5 sites) but moderate — not a one-liner.
- Done: golden envelope test proves output unchanged; distiller has no write dependency.

### B4 — redaction: internalize the default, keep one-step raw access (log-revised, application point verified)
- **Application point verified:** redaction is applied at `resultMiddleware` via
  `redactSensitiveValue(envelope)` (`resultMiddleware.ts:426,430`) — whole-envelope, single `redact`
  flag; `browser_artifact` has its own read-path redaction.
- **Log evidence (session 019ea05a) overturned the original "retire `redact:false`" plan:** `redact:false`
  was used ~199× on security tools (http_replay 40/40, network 44/46) — raw token/cookie/body is the
  **working norm** in security work, with many values pulled by `pick:["response.body.text"]`+search
  (no predictable path). Forcing per-field targeted retrieval would create multi-step groping.
- **Revised design — prefer minimal leakage (resultMiddleware body unchanged):** summaries stay
  **uniformly redacted on ALL tools** (no per-tool default-raw → no tokens-in-context-by-default), BUT
  each redacted sensitive field carries an **inline raw-location pointer**
  (`{redacted:true, raw:"<artifact-path>", jsonPath:"<field>"}`). The agent sees exactly where each raw
  value lives and pulls only the ones it needs in **one step** via `browser_artifact` — no path
  groping, because the redacted field self-locates. Raw always persists to artifact;
  `browser_artifact` named-field read (`jsonPath`/`pick`, incl. whole `response.body.text`) returns it
  raw. Hide the per-call `redact` toggle via B2a (tolerated).
- **Eval-gated fallback (decide on data, not armchair):** the log shows `redact:false` ~199× — IF a
  blind-eval shows the pointer round-trip is real friction (the agent genuinely needs raw inline on
  most security calls), fall back to **per-tool default-raw for security tools** (accepting
  tokens-in-context as the cost). Ship the lower-leakage design first; loosen only on evidence.
- Why this is better than "security tools default raw": uniform redaction has no per-tool default
  divergence (simpler, one rule), leaks nothing by default (safer), and the self-locating pointer
  removes the groping risk — pay one artifact read only per value actually needed, not a blanket leak
  on every call.
- Done: all summaries masked by default; every redacted value is one-step retrievable via its inline
  pointer; no `redact:false` firehose; the looser default is gated behind eval evidence.

## Workstream B — maintainer track (mostly DEFERRED)

Agent-invisible. Does not block Workstream A. Only the cheap, isolated ABML dead-weight cut is done now.

### Done now — ABML dead-weight strip (isolated to `abml/`; deletion gate VERIFIED 2026-06-07 via re-grep: 0 production consumers)
- Deleted `abml/verbs/streamRuntime.ts` plus its dedicated unit/contract coverage; removed the
  corresponding `check:abml-stream-runtime` gate from grouped checks.
- Deleted `abml-core/resolveModel.ts` plus its shim/barrel export and unit coverage.
- Deleted `abml-core/verbs/router.ts` `dispatchAbmlVerb` while keeping the verb types used by
  runtime.ts and the shared failure helpers.
- Kept `buildInferenceSummary` intent output because `entitiesForInferenceEvidence` still consumes it
  to feed `referenced_entities`.
- Synced `tests/contracts/drift/check-abml-core-boundary.mjs`, `docs/abml-kernel-manifest.md`, and
  `src/abml-core/README.md`; `refId.ts` is now classified as pure core.

### Deferred (gated on real maintenance pain)
- **ABML PageModel/ChangeModel split** — highest risk, agent-invisible. Requires first extracting
  read/action shared helpers from the 1242-line `abml/verbs/runtime.ts`, then the execution ladder
  (`actionabilityModel`, `verbs/{click,type,scroll}`, runtime action half) can be removed. Start only
  with its own contract when maintenance cost justifies the risk.
- **Envelope field consolidation** — the ~25-field `DistilledEnvelope` + budget-compression overload.
- **Validation stack — collapsed at library level (2026-06-08).** Top-level public tool parameters
  remain TypeBox schemas consumed by the Pi framework and CLI discovery. Nested runtime validation
  now uses `src/validation/typeboxCompat.ts`, preserving the local `.safeParse()` contract without
  carrying a separate Zod runtime dependency.
- **`observeRunners.ts` split** — extract `observe/{baseline,causal,scan,content,html}.ts`; glue only
  dispatches. (Behavior-preserving; can be done anytime.)

### Never touch (engine hidden but feeds visible output)
`templating` (feeds treeDiff/snapshotProjection), `semanticRefAnchor` (cross-observation stable refs),
`entitiesForInferenceEvidence` (feeds referenced_entities).

## Verification spine (required for a live-system refactor)

- **Golden envelope tests** — capture current tool envelopes; assert byte-stable where behavior must be
  preserved (the safety net for B3 and any envelope work).
- **Backward-compat tolerance test** — deprecated params still tolerated (accept-and-ignore), not
  hard-rejected, on both faces.
- **Per-batch contract gates** — `check:tools` / `check:summaries` / `check:cli-parity` /
  `check:output-schema-conformance`, updated per batch.
- **Blind eval for agent-facing batches** — param flattening's success criterion is agent experience;
  contract-green is not sufficient. Validate via a blind-eval pass (`pi-browser-blind-eval`).
- **No-browser discovery contract + cwd propagation** — preserved (already enforced).
- **Distiller/envelope purity guard (I4 — the one currently-MISSING guard, ships with B3):** a boundary
  check that `src/tools/summaries/*` must not import `resources` ref-writers or `abml` side-effecting
  builders — mirrors `check:abml-core-boundary`. Without it the `summaries/scan.ts` side-effect class
  can silently return; shipping the guard with the fix is what makes B3 durable, not just done.

## Guard & test specifications (concrete — buildable without further guessing)

**I3 guard — param-surface audit (`check:param-surface`, NEW):** for every tool, assert
`buildFlagSpecs(def.parameters)` contains **no** name from a `MECHANICAL_PARAM_DENYLIST`
(`detailLevel`/`maxChars`/`timeoutMs`/`browserSessionId`/`outputPath`/`maxBodyBytes`/
`maxDepth`/`maxPages`/`maxCases`/`maxCandidates`/`maxTemplates`/`rateLimitPerSecond`/`timeoutSeconds`/
`harMaxEntries`/`followRedirects`/`maxRedirects`/`defaultScheme`). Natural extension of
`check-cli-parity.mjs` (already calls `buildFlagSpecs`). Allowlisted exceptions: `browser_tabs.browserSessionId`,
`browser_artifact`/`browser_memory.outputPath` (boundary points 1–2). This is the I3 enforcement.

**Golden-envelope test (`check:envelope-golden`, NEW — the B3/envelope safety net):** for each
(tool, command), store `tests/fixtures/golden/<tool>.<command>.json` = a canned raw bridge result +
its expected distilled envelope. The test feeds the canned raw result through the distiller +
`resultMiddleware` (no browser, no daemon) and asserts byte-equality. A behavior-changing envelope
edit must regenerate goldens intentionally; accidental drift fails CI.

**B4 raw-location pointer schema:** a redacted sensitive field becomes
`{ redacted: true, kind: "cookie"|"token"|"authorization"|"body"|"postData"|"wsPayload", raw: "<path under .pi/browser-artifacts>", jsonPath: "<dot-path within that artifact>", bytes?: number }`.
Emitted by `redactSensitiveValue` **only** when the masked field IS persisted to the artifact (so the
pointer always resolves); `browser_artifact jsonPath=<jsonPath>` on `<raw>` returns the value in one
step. The pointer carries names/paths only — **never the value** (I5 holds).

## Rejected alternatives (decided — do not re-litigate)

| Considered | Rejected because |
|---|---|
| `bounds` sub-object for websec mechanical knobs | hostile on a command line (`--bounds '{...}'`); hide via lean schema instead |
| typebox `hidden`/`x-internal` param annotation | the Pi harness surfaces `parameters` as-is (`ToolInfo`); `ToolDefinition` has no hidden field — the annotation would be ignored on Pi-native |
| remove mechanical params from schema with NO tolerance | strict `additionalProperties:false` hard-rejects habit-callers → re-breaks C2/H1/C4; use the `prepareArguments` strip |
| per-tool default-raw for security tools (first B4 idea) | leaks tokens into context on every security call; uniform-redact + self-locating pointer leaks nothing by default — kept only as an eval-gated fallback |
| retire `redact:false` → pure per-field targeted retrieval (original B4) | log shows raw is the working norm (199×), often from free-text bodies with no predictable path → would create groping |
| new public tool/param to drive adoption (mutations/observe) | widens the surface + adds a "which tool?" decision; use a result-driven `nextActions` hint instead |
| bundle the ABML PageModel/ChangeModel split into the agent line | highest-risk, agent-invisible; deferred to the maintainer track, gated on real maintenance pain |

## Relationship to the CLI docs

- `docs/agent-native-cli-spec.md` — the **external face contract**. This document supersedes/sharpens
  two of its points: principle 8 ("agent-visible defaults") is sharpened to **hide+tolerate** for
  mechanical params (defaults are not just visible — mechanical params leave the advertised surface);
  the Privacy section's `--no-redact`/`--redact false` agent toggle is **replaced** by redaction
  internalization + targeted retrieval (boundary point 3).
- `docs/agent-native-cli-execution-plan.md` — the **external-face task queue** (P0–P8). It runs under
  this mainline; its P-items interlock with the batches here (e.g. B1 simplifies P1 command metadata
  and `check:cli-parity`; B2 shrinks `commands`/`schema` discovery output; B3/B4 align with P2/P6).

## Connection reliability (B5 — durable offscreen transport)

**Problem (measured 2026-06-08):** the extension's WebSocket reconnect is driven by the MV3 service
worker, which idles out; reconnection then waits on the ~30s `chrome.alarms` probe + backoff. Measured
cold-SW reconnect latency **~50-97s and unstable**; warm-SW ~2s. Agent-native pain: an agent starts a
daemon after the browser's been idle → tens of seconds before the extension connects (no human to wake
it). Earlier `ERR_CONNECTION_REFUSED` console spam is just the benign no-daemon scan, not this defect.

**Interim fix — REPLACED:** the earlier `bridge_src/service_worker/transport.ts` 5s chrome API
`setInterval` keepalive improved a 50s-idle reconnect from ~50-97s to ~2s, but it still fought the
MV3 service worker lifetime model and could not survive Chrome's hard service-worker cap. That code is
not the durable B5 architecture.

**Durable fix — ACTIVE:** move the real WebSocket lifecycle into an **offscreen document**. The
offscreen context owns local daemon health probes, port-range fan-out, reconnect backoff, ping, socket
identity cleanup, and inbound/outbound WS frames. The service worker owns only extension capabilities:
offscreen creation/recovery, router dispatch, startup recovery, tab sync, CDP/CSP/state cleanup, and
socket adapters that forward bytes to the offscreen document.

**Why this split:** offscreen is the only MV3 context here that can hold a long-lived connection without
turning the service worker into a keepalive target. The service worker must still execute browser
capabilities because offscreen has limited extension API access. Therefore B5 is an internal transport
ownership change, not a protocol/tool-surface change.

**Contracts:** manifest includes `offscreen`; `offscreen.html` loads generated `dist/offscreen.js`;
build manifest records the offscreen entry; service-worker transport contains no `new WebSocket` and no
5s keepalive interval; offscreen transport contains `new WebSocket`, health probes, backoff, ping, and
message forwarding; tab sync fans out through service-worker socket adapters. Runtime smoke target:
"daemon restart after long idle → reconnect within bounded seconds" remains the live browser acceptance
gate after deterministic contracts pass.

## Boundaries / non-goals

- No new public `browser_*` tools; no MCP; no orchestration/target-resolver revival.
- Execution stays the agent's JS (`browser_execute {script}`) with `browser_command` CDP as the
  trusted-event escape. ABML stays observation-only; the action ladder is not revived.
- Safety gates (redaction, private-target, confirm, lease, launcher override) are **internalized, not
  removed** — they move out of the agent's choice but still operate and stay overridable at the
  operator/config layer where applicable; never silently dropped.
- Behavior-preserving small batches; each independently shippable and revertible (B2 action-arm revert
  is the precedent). No mega-PR.
