# Performance & Overhead Audit (2026-06-08)

Whole-project read-only audit. Two passes: a four-dimension fan-out (token output /
runtime latency / startup cost / memory) plus a verification + completeness-critic pass
that confirmed the load-bearing findings at source and swept for redundant work the first
pass structurally missed.

Every finding is grounded at `file:line`. Items marked **[src-confirmed]** were read
directly during the verification pass; **[corrected]** marks a first-pass suspicion that
did NOT reproduce. Per the project's eval-driven / no-overfit rules, contract-changing
items (T3) require blind-eval evidence before landing.

## Current Execution State

Status: **active execution queue**. This document is both the audit record and the runnable TODO for
performance work.

Latest acceptance evidence (2026-06-08):
- Subagent acceptance pass ran read-only performance gates and live smoke. After rebuilding stale
  `dist/`, local re-measurement of the actual user entrypoint shows
  `node dist/cli/bin.js --help` succeeds with six-run median **~56 ms**
  (`56.4,54.9,53.9,129.9,52.3,57.4` ms after one warm-up) while the internal dispatcher entry
  `node dist/cli/index.js --help` still costs **~315 ms**. Dev/tsx measurements remain loader
  dominated but show the same direction: `tsx cli/bin.ts --help` median **~389 ms** vs
  `tsx cli/index.ts --help` median **~799 ms**.
- `npm run verify:bridge:dist`, `npm run check:summaries`, `npm run check:token-economy`, and
  `npm run smoke:browser:scan-summary` passed. Latest smoke result:
  `.pi/browser-artifacts/smoke-browser-scan-summary-results.json`; saved scan artifact:
  `.pi/browser-artifacts/scan-summary-smoke-scan-1780923497331.json`.

Completed in the current landing passes:
- [x] 0.1 option (a): service-worker/offscreen whitespace minify with identifier names preserved;
  dist contract now enforces a service-worker size budget (current service-worker: 399,864 bytes).
- [x] 0.2: AX per-node `DOM.getBoxModel` calls are issued concurrently.
- [x] 0.3 partial: network/hook seq reads are issued concurrently with `Promise.all`; skip/batch
  optimization remains deferred until a cheap armed-recorder state source exists.
- [x] 0.4: `containsSensitiveEvidence` now short-circuits with a first-hit predicate and has a
  redact-then-compare oracle regression.
- [x] 0.5: CLI JSON render parses the tool envelope once in `renderResult`.
- [x] 0.6 partial: network recorder diagnostics are write-capped; intercept paused requests are
  capped with oldest-request auto-continue on overflow.
- [x] 1.1 default path: `browser_observe mode=scan` reuses the first `scan_extract` payload for ABML
  structure reads when it is already the ABML-safe superset, eliminating the second DOM scan eval.
- [x] 1.2 partial: `browser_execute` no longer pays an unconditional 200ms post-eval sleep; only
  likely tab-opening scripts keep a bounded 50ms observation window.
- [x] 1.3: `buildCliCommands()` / tool definition collection are memoized, and the actual CLI bin
  entrypoint handles top-level `--help` through a lightweight dynamic import before loading the
  dispatcher / registry graph.
- [x] 1.4: nested validation moved from `zod` to the local TypeBox-compatible schema wrapper;
  `zod` is removed from runtime dependencies while preserving the `.safeParse()` contract.
- [x] 1.5: daemon compatibility now compares only `DAEMON_PROTOCOL_VERSION`, not package version.
- [x] 1.6 adjusted: offscreen bridge port probing is concurrent, primary-port-first, and capped at
  500ms per loopback probe while preserving existing multi-live-port fan-out semantics.
- [x] 1.7 partial: `resourceStore` / `refStore` now have 10k entry caps and amortized expiry prune;
  capacity eviction uses the existing not-found recovery path and is covered by ref/resource tests.
- [x] 1.8 partial: `summarizeScanData` now precomputes scan lines/actionables/list hints/entities
  once per summary and reuses ranked action data across budget rungs without changing output shape.
- [x] 1.8 follow-up: remaining per-rung scan summary loops were collapsed behind the high-entropy
  byte/shape golden: sorted action ranking, form summary, headings, text-signal candidates,
  interactive rows, list summaries, action entity lookup, and referenced entity slices are prepared once.
- [x] 1.9 partial: text/search artifact reads count chars in the same stream pass, and sample mode
  collects multi-section line ranges in one additional pass instead of one pass per section.
- [x] 2.2 partial: extension readiness waits are event-driven and back-to-back no-extension commands
  use a short negative cache instead of each paying the full grace window.
- [x] 2.3 safe subset: `fitEnvelopeBudget` now reuses a single marked-envelope object per budget
  check, hoists lifted-value length comparisons to one `stableJson` per side, reuses the 120/5/5
  compact summary in `fitSummaryBudget`, and keeps CJK `String.length` budget semantics locked.

Next executable queue:
1. [ ] 0.3 follow-up: add skip/batch optimization only after confirming a cheap armed-recorder
   state source; current win is the no-contract `Promise.all` concurrency.
2. [ ] 1.1 follow-up: evaluate superset-capture-and-clamp for text / iframe-disabled / maxNodes scans
   only after a byte/shape comparison proves output parity.
3. [ ] 1.7 follow-up: stream signal ref reuse is not a low-risk mechanical change because
   `check-abml-causal`, `verbs-stream.test`, and live causal smoke currently assert that drain
   refreshes the captureRef. Treat as contract/eval-first unless the ref lifecycle contract changes.
4. [ ] 2.2 follow-up: default extension wait shortening still needs slow-extension evidence; keep
   the event-driven wait / negative-cache improvement as the completed safe subset.
5. [ ] 2.4 follow-up: defensive clone reduction and CLI-only `details` skipping need targeted
   clone/render contracts before code changes.
6. [ ] Tier 3: run blind eval/transcript review first; do not trim output fields until evidence
   shows agents do not depend on them.

---

## Tier 0 — biggest wins, low risk, no agent-facing contract change (do first)

### 0.1 Minify the service-worker bundle — paid on EVERY MV3 wake  **[src-confirmed]**
- **Where:** `scripts/build-bridge.mjs:55-66` (esbuild `build()`), output
  `bridge/pi_browser_bridge/dist/service-worker.js` = **476,582 bytes, un-minified**
  (9,401 lines, full identifiers/comments). `minify` is never set.
- **Why it matters:** MV3 service workers are torn down after ~30s idle and the whole
  bundle is **re-parsed + re-compiled + top-level-executed on every cold wake**
  (`installPiBrowserServiceWorker()` runs at `service-worker.js:9401`).
- **Measured:** un-minified = **476,582 bytes**; a real esbuild `minify:true` dry-run =
  **282,682 bytes (~40.7% reduction)** — smaller than a raw estimate because the bundle is
  already ESM + tree-shaken (`treeShaking: entry.name === "service-worker"`, `:64`).
  `minifyWhitespace:true, minifyIdentifiers:false` currently produces **399,864 bytes** while keeping symbol names.
- **GOTCHA — a contract test hard-breaks:** `tests/contracts/protocol/check-bridge-build.mjs:120-132`
  greps the emitted bundle for literal **un-minified symbol names** (`function installPiBrowserServiceWorker`,
  `function probeAndConnectWS`, `function ensureOffscreenDocument`, `__piBridgeModule_<name>`, …).
  Full `minify:true` renames/strips these → ~10 assertions fail. (Banner `:113` and the
  `runtimeSwitched`/`mode:"production"` string markers `:114-115` survive; `check-bridge-files.mjs`
  reads source not dist, safe.)
- **Fix (two options):** (a) **recommended low-risk:** `minifyWhitespace:true, minifyIdentifiers:false`
  — keeps the asserted `function <name>` text, saves ~77 KB in the current bundle, no symbol-name
  test edit; add a size-budget test (`dist/service-worker.js` < ~405 KB). (b) full `minify:true`
  or `minifySyntax:true` for a smaller bundle
  **and** relax `check-bridge-build.mjs:120-132` to assert behavioral/string-literal markers +
  the import-and-run block (`:245-262`) instead of `function <name>` text. Also extend
  `treeShaking` to the `offscreen` entry. Keep `sourcemap:true`.
- **Risk:** Low with option (a); medium with (b) (must rewrite the build contract assertions).

### 0.2 Scan: parallelize per-node `DOM.getBoxModel`  **[src-confirmed]**
- **Where:** `src/abml/verbs/axRuntime.ts:258-275` — the geometry `await sendPersistentCdp`
  is the only async work in the entity-build loop; everything else is sync.
- **Now:** one serial CDP roundtrip per interesting AX node (N nodes ⇒ N serial roundtrips).
- **Fix:** collect interesting nodes + `backendNodeId`s, fire all `DOM.getBoxModel` with
  `Promise.all`, then build entities from the resolved geometry. Same calls, concurrent.
- **Risk:** Near-zero (identical results). Larger rewrite (single geometry pass) is 2.1.

### 0.3 Scan: parallelize the network+hook seq stamps  **[src-confirmed]**
- **Where:** `src/tools/observeRunners.ts:476-477` — `readNetworkRecorderSeq` then
  `readHookRecorderSeq`, serial, on every scan; +2 more serial on the baseline path (484-488).
- **Fix:** `Promise.all` the two independent status reads; skip both when no recorder/hook
  session is armed for the tab; fold status+delta into one `batch` when a baseline is given.
- **Risk:** Low (skip needs a cheap "is any recorder armed" check to keep the seq anchor).

### 0.4 `containsSensitiveEvidence`: short-circuit instead of redact-then-compare  **[src-confirmed]**
- **Where:** `src/utils/redaction.ts:245-249`, called from `resultMiddleware.ts:653,682`
  on **every** distilled result.
- **Now:** `stableJson(value) !== stableJson(redactSensitiveValue(value))` — a full redaction
  tree-walk + two full serializations of the (often largest) raw value, just to get a boolean.
  The model output is then redacted *again* by `redactSensitiveValueWithPointers` (`:589`).
- **Fix:** replace with a predicate walk that returns `true` on the first sensitive
  field/text hit — O(first-hit) vs O(whole-tree)×2. Keep the same field-name set / regexes.
- **Risk:** Low. Pure boolean refactor; covered by redaction unit tests.

### 0.5 CLI `--json` render: parse the envelope once, not 3×  **[src-confirmed]**
- **Where:** `cli/render.ts` — the envelope text is `JSON.parse`d in `looksLikeToolError`
  (`:226`), `JSON.parse`d again in `parseJsonObject`/`normalizeJsonEnvelope` (`:89,209`), then
  `JSON.stringify`d in `writeJsonEnvelope` (`:215`). 2 parses + 1 stringify of the whole
  envelope on every CLI call.
- **Fix:** parse once in `renderResult`, pass the parsed object to `looksLikeToolError` and
  `normalizeJsonEnvelope`. Trivial signature change; parse-failure paths become
  `parsed === undefined` branches.
- **Risk:** Low.

### 0.6 Cap two unbounded buffers  **[src-confirmed via first pass]**
- `bridge_src/service_worker/network.ts` recorder `diagnostics[]` — pushed per command, only
  read-sliced (`network_model.ts:246`), never write-trimmed. Trim in place to ~100 like its
  capped siblings. Risk: none.
- `bridge_src/service_worker/intercept.ts:53` `session.paused` Map — the one SW buffer with no
  cap (bounded by in-flight + evicted on tab-close). Ring ~500 + auto-continue oldest on
  overflow. Risk: low (`REQUEST_NOT_FOUND` already handled).

---

## Tier 1 — high value, small behavior change + a targeted test each

### 1.1 Scan runs the scan SCRIPT twice — run it once and thread the data down  **[src-confirmed]**
- **Where:** `src/tools/observeRunners.ts:464` (`evaluatePageScriptDirect(scanScript, name:"scan_extract")`)
  and **again** `src/abml/verbs/runtime.ts:820` (`buildScanScript(...)`, `name:"abml_read_scan"`).
  The first scan's `data` is **not** passed into `abml.readStructure` (`:466` passes only
  ids/timeout/maxChars/baseline) — the structure plane re-walks the DOM independently.
- **Important nuance:** the second scan forces `includeIframes:true` and `maxChars≥100_000`,
  while the first honors `params.includeIframes`/`textOnly`. To collapse to one eval, run the
  single scan with the **superset** params and feed that `data` into `readStructure({ scanData })`.
  The AX pass (`Accessibility.getFullAXTree` + per-node `DOM.getBoxModel`, `axRuntime.ts:222-298`)
  is **distinct, necessary** work used by `mergeAxIntoDomEntities` — NOT part of this redundancy.
- **Done default path:** added optional prefetched scan data to `readStructure` / ABML read. Default
  `browser_observe mode=scan` now passes the already-collected `scan_extract` data to ABML when it is
  an ABML-safe superset (`mode !== "text"`, `includeIframes !== false`, no `maxNodes`). In that path,
  ABML skips the separate `abml_read_scan` eval. Text scans, iframe-disabled scans, and maxNodes-
  limited scans keep the separate ABML capture.
- **Follow-up:** reconcile params to the superset for non-default scan modes only with byte/shape
  comparison coverage.
- **Risk:** Medium. Covered by abml-scan-envelope + token-economy contract tests; verify text
  summary and entity counts are unchanged.

### 1.2 `browser_execute`: drop/shrink the unconditional 200ms sleep  **[src-confirmed]**
- **Where:** `bridge_src/service_worker/exec.ts:239` — `if (newTabIds.size === 0) await sleep(200)`,
  after the eval already completed, on a very high-frequency tool.
- **Fix:** synchronous same-task `window.open` already registers via the `onCreated` listener;
  skip the wait unless the code looks tab-opening, or cap to ≤50ms and let the next `tabs.list`
  pick up stragglers (create path already eager-refreshes).
- **Risk:** Low-med (bounded by the small residual wait).

### 1.3 CLI: lazy-load the tool/driver graph off browser-free commands  **[src-confirmed]**
- **Where:** `cli/index.ts:23` + `cli/registry.ts:8` statically import `registerBrowserTools`,
  pulling every `register*Tool.ts` → abml integration (55ms) + `BrowserBridgeServer` (80ms) +
  summaries + **typebox (178ms)**. Measured: `pi-browser --help` ≈ 780ms; the registration
  graph is **341ms** of it. Paid on EVERY process, incl. `--help`/`commands`/`schema`/
  `validate`/`doctor` (documented browser-free). Also `buildCliCommands()` is called 1–6× per
  process with no memo.
- **Fix:** (a) memoize `buildCliCommands()`/`collectToolDefs()` (pure, placeholder server,
  noop `ensureStarted`); (b) `await import()` the registrar graph only inside the execution
  branch of `main()`, keeping help/schema on a light path; optionally a build-time command
  manifest for `--help`/`commands`.
- **Risk:** Medium — keep the CLI-parity contract (`docs/cli-parity-testing.md`) byte-identical.

### 1.4 Drop `zod` for `typebox` (already the schema substrate)  **[src-confirmed]**
- **Where:** `src/validation/schemas.ts:1`, `src/validation/middleware.ts:1` — the only 2 files
  using zod (vs 24 using typebox), reached eagerly via `registerCommandTool.ts`. +53ms eager
  per process + an extra dependency.
- **Fix:** port both to typebox, drop `zod` from `package.json`. Preserve
  `BridgeCommandSchema` error semantics (validation unit tests).
- **Risk:** Medium (error-message contract).

### 1.5 Daemon: reuse on compatible-protocol bumps, don't restart on marketing version  **[src-confirmed via first pass]**
- **Where:** `cli/daemonControl.ts:261-287` (version check `:264`); `daemonVersion()` embeds the
  full `package.json` version (`cli/packageInfo.ts:32-34`). Any release — even a docs/patch bump
  — fails `isDaemonVersionCurrent`, forcing graceful shutdown (≤3s + SIGTERM/SIGKILL) + respawn +
  cold-start, tearing down the live bridge+extension for no protocol reason.
- **Fix:** gate the restart on the parsed `DAEMON_PROTOCOL_VERSION` component only.
- **Risk:** Medium — requires discipline: any control/tool-contract change MUST bump the
  protocol counter.

### 1.6 Extension: parallelize the 20-port probe (primary-port-first)  **[from first pass]**
- **Where:** `bridge_src/offscreen/transport.ts:133-147` — 20 ports (18765–18784), each
  `isServerAlive` fetch with a 2000ms abort, awaited **serially**. Daemon-down ⇒ up to ~40s to
  conclude "no server". Compounds 1.5 (every gratuitous restart pays it on reconnect).
- **Fix:** probe concurrently (first-to-resolve), try 18765 first (bridge binds ascending), drop
  per-fetch timeout to ~200–500ms for loopback.
- **Risk:** Low.

### 1.7 `resourceStore`/`refStore`: size cap + amortized prune + reuse stream signal ref  **[from first pass]**
- **Where:** `src/resources/resourceStore.ts:92-93,372-380` (producers `scanEntityRefs.ts`,
  `abml/verbs/runtime.ts:661-666,750,773,844-872`). TTL-only, **no size cap**; `pruneExpired()`
  runs a full O(n) map scan on every register/resolve → quadratic under bursts; each stream
  drain mints a fresh signal capture-ref that's immediately dead but lingers its full TTL.
- **Fix:** LRU/size cap (evict oldest by `createdAt`, ~5–10k) on top of TTL; sweep every K
  inserts; refresh one stream signal ref in place instead of minting per drain.
- **Risk:** Medium — prefer evicting oldest; `HANDLE_NOT_FOUND`/`REF_STALE` is the documented
  stale path.

### 1.8 `summarizeScanData`: one entity-array pass instead of ~8  **[src-confirmed]**
- **Where:** `src/tools/observeRunners.ts:565,578-580,645,648` — the merged entity array is
  full-scanned ~8× per scan (salience sort + region filters for `focus`, then the same 4 filters
  again in the `details` block), plus `buildPageGist`/`buildEntityOutline` re-loop the full set.
- **Fix:** single pass computing all bucket counts + arrays, reused by `focus` and `details`.
  Same `.slice(...)` caps. O(n) → one O(n).
- **Risk:** Low (mechanical).

### 1.9 `browser_artifact`: count chars during the read pass, not a second stream  **[src-confirmed]**
- **Where:** `src/tools/artifactReader.ts:274-280,340-366,389-443` — `readTextRange`/`searchText`/
  `sampleText` each stream the file once to select, then `countTextChars` streams the whole file
  AGAIN (sampleText re-streams up to 3× more per section). A single read re-reads the file 2–4×.
- **Fix:** accumulate `chars` (`line.length + 1`) during the first `eachLine` pass; collect all
  needed line ranges in one pass for sampleText. `crlfDelay:Infinity` already normalizes newlines.
- **Risk:** Low-med (match the existing `+1` char convention). Agent-paced, so mid-rank.

---

## Tier 2 — bigger latency/CPU wins, more rework

### 2.1 Replace the per-node box-model loop with a single geometry pass
Fold rects from the in-page scan (already computed) instead of N `DOM.getBoxModel` CDP calls —
removes 0.2's roundtrips entirely. Medium risk: re-derive the AX↔box mapping; gate on AX-merge
tests/smokes. Natural follow-on once 1.1 threads scan data through.

### 2.2 Cold-start extension grace: event-driven + shorter default + negative cache  **[from first pass]**
- **Where:** `src/driver/BrowserBridgeCommandService.ts:34` (`DEFAULT_EXTENSION_WAIT_MS=5000`),
  `:124-133`; `BrowserBridgeServer.ts:208-215` (100ms `snapshot()` poll loop). A disconnected
  extension makes **each** `sendCommand` in a scan (6+) re-pay up to 5s.
- **Done partial:** readiness wait now resolves via a Promise fired by extension registration
  (`ext_ready` / `tabs_update`) instead of a 100ms polling loop, and `sendCommand` caches a
  short-lived "no extension as of T" result so back-to-back failing sub-calls do not each pay the
  full grace window.
- **Deferred:** do not lower the default 5s grace until a slow-extension smoke/eval shows the shorter
  window does not regress cold starts. `PI_BROWSER_EXTENSION_WAIT_MS=0` remains the explicit
  hermetic/strict mode.
- **Risk:** Low.

### 2.3 `fitEnvelopeBudget`/`fitSummaryBudget`: serialize-once accounting  **[src-confirmed]**
- **Where:** `src/tools/resultMiddleware.ts:157-190,419-479`. On a budget-overflowing (large)
  page the envelope is `stableJson`-ed **30–50×** over progressively-large objects in one observe
  call: the ladder re-serializes each rung, `check()` (`:424`) re-marks omissions AND
  re-stringifies just to measure, the lift loop stringifies both `compacted` and `value` per key.
- **Fix — SAFE SUBSET ONLY (byte-identical):** (B-1) fold the `check()` measure + the matching
  `markEnvelopeBudgetOmissions` return into one `tryFinish()` that builds the marked envelope once
  and returns that exact object; (B-2) hoist `stableJson(value).length` in the lift loop so it's
  computed once per key, not twice; (B-5) reuse the `{stringChars:120,arrayItems:5,tableRows:5}`
  compacted summary at `:168` instead of recomputing it. Drops whole-envelope `stableJson` passes
  from **~30–50 to ~6–10** per overflow call.
- **DO NOT (byte-unsafe — corrects an earlier draft):** (1) **keep `String.length` (UTF-16), NOT
  `Buffer.byteLength`** — this project targets CJK/mainland sites where N CJK chars = N in `.length`
  but 3N in bytes; switching the metric trips budgets earlier on Chinese pages → different omitted
  fields → not byte-identical. (2) **reject the "subtract removed-field bytes" delta model** —
  `stableJson` is 2-space pretty-printed, so a field's byte cost includes position-dependent
  comma/indent framing and `markEnvelopeBudgetOmissions` *adds* bytes each rung; delta accounting
  can't reproduce the exact truncation point without re-serializing.
- **Guard:** `check-token-contract.mjs` now includes a CJK-heavy fixture that is under the
  `String.length` budget but over the UTF-8 byte length budget, so byte-accounting regressions
  over-trim the preview/rows and fail. Existing coverage: `check-token-contract.mjs`,
  `check-token-economy.mjs` (±10% layer0), and `envelope-disclosure.test.ts` (which fields survive
  the squeeze). A larger multi-rung golden can still be added before the serialize-once rewrite if
  the implementation goes beyond the safe subset.
- **Risk:** Medium — intricate budget logic; the safe subset returns identical objects, but land it
  only behind the golden test. Biggest per-call CPU sink on large pages.
- **Done safe subset:** `fitSummaryBudget` now reuses the already-built `{stringChars:120,
  arrayItems:5, tableRows:5}` compacted summary for `dropLowPrioritySummaryFields`;
  `fitEnvelopeBudget` uses a `tryFinish()` helper that marks omissions once per check and returns
  that exact object, and the lifted-value compaction loop computes `stableJson(compacted)` /
  `stableJson(value)` once per side. Guarded by `check-token-contract` including the CJK
  `String.length` fixture, `check-token-economy`, `envelope-disclosure.test.ts`, and
  `resultMiddleware-advanced.test.ts`.

### 2.4 Reduce `responseEnvelope` defensive deep clones + skip CLI-only `details`  **[src-confirmed]**
- `resultMiddleware.ts:269-307,610-616` — 7 lifted fields each `structuredClone`d per observe
  (on top of the `redactForModel` copy at `:592`); the `[Circular]` avoidance is load-bearing
  (blind-eval F2), so only drop clones where `fittedSummary` no longer shares the refs (verify on
  both compressed/uncompressed paths). Plus `src/utils/toolResult.ts:49-66` builds + compacts a
  `details` object that `cli/render.ts` never reads — don't feed large payloads (e.g.
  `server.snapshot()` for `browser_tabs`) into `details` on the CLI host.
- **Risk:** Medium (clone removal needs a non-`[Circular]` render test).

---

## Tier 3 — token savings that change the agent-facing contract (blind-eval first)

Per `eval-fixes-true-defect-no-overfit`: confirm against blind-eval transcripts that agents don't
consume the trimmed fields before landing; fix + regression must be general.

### 3.1 `enrichForCli`: stop emitting the same artifact-read commands three times  **[src-confirmed]**
- **Where:** `cli/render.ts:153-206`. Appended **after** distillation (so `maxChars` never trims
  it) to nearly every saved-artifact result: `readCommands` (7 strings) + `readArgv` (7 argv
  arrays, fully redundant with readCommands) + `cliNextActions` re-deriving the **same** ~6
  artifact-read commands a third time — including `COMMON_ARTIFACT_JSON_PATHS` entries
  (`operation.operationId`, `snapshot.snapshotId`) that mostly don't exist for the tool. ~1.5–2.5 KB
  of templated JSON on the hot path, the single biggest token waste.
- **Fix:** emit `argv` **or** `command` (not both); drop `cliNextActions` (duplicate) or cap to
  paths present in this envelope's `saved`/`snapshot`; gate `COMMON_ARTIFACT_JSON_PATHS` on
  existing keys.
- **Risk:** Med — CLI presentation contract; update `cli/envelope.ts` consumers + parity tests.

### 3.2 `browser_tabs`: hoist the shared `bridge` block, project per-tab fields  **[from first pass]**
- **Where:** `src/tools/registerTabsTool.ts:65,70,97,99` — bypasses the distiller (raw
  `jsonResult`, 50KB budget). Each `BrowserTabInfo` repeats the full `bridge` block (id,
  extensionId, name, version, ~120-char UA, bootId, 4 timestamps), identical for all tabs. The
  "small, non-secret list" comment (`:63-65`) is stale on a many-tab browser.
- **Fix:** project per tab to `{tabId,url,title,active,windowId,incognito}` + one shared top-level
  `bridge`/`extension`; truncate url/title; cap `snapshot` internals by default.
- **Risk:** Med — changes the `browser_tabs` contract (callers reading `tabs[i].bridge.*`).

### 3.3 Scan `focus`: store entity `ref`s, not duplicated full entities  **[from first pass]**
- **Where:** `src/tools/summaries/scan.ts:404,414,417` — full `Entity` objects in
  `primary_actions[].entity`, `primary_entities` (≤16), and `referenced_entities.slice(0,40)`,
  while `envelope.entities` already de-dupes/caps to 12 and the artifact has the full list. Hints
  carry uncapped selector arrays (`entity.ts:250-252,364-366`).
- **Fix:** in `focus`, store entity `ref` strings; cut `referenced_entities` 40→~12; cap hint
  selector arrays (~8). Verify agents read from `envelope.entities`/artifact vs `focus` first.
- **Risk:** Med — documented ABML perception surface; no-overfit applies.

---

## Verified clean / corrected (do NOT touch — recorded so they aren't re-flagged)

- **[corrected]** No redundant `server.snapshot()` within a single observe call — `runScanObservation`
  calls it once (`:473`) and reuses `bridge.*`; `currentObserveSnapshotMeta`'s later call captures
  *post-action* state by design. First-pass suspicion did not reproduce.
- **[corrected]** No `new RegExp` compiled inside a hot loop in artifact/render redaction — all are
  module-level literals or compiled once per search.
- `typescript` (~300ms cold) is correctly lazy — only `webSecurity/shared/jsAst.ts` imports it, via
  execution-time `import()`. Never static-import jsAst from a registrar.
- `.map` files ship in the tarball but are NOT loaded at SW wake (devtools-only) — install-size only.
- Daemon usage-log extra `JSON.stringify` (`cli/daemon.ts:239`) is gated behind `PI_BROWSER_USAGE_LOG`
  (off by default) — not on the default hot path.
- Event-driven (not polling): `BrowserBridgePendingRequests` ACK/timeout, `wait.selector`
  (addBinding+MutationObserver), `wait.networkIdle` (CDP events), 15s heartbeat off the request path.
- Persistent CDP reuses attachments per (tab,name), lazily attached.
- Screenshots → `[saved to …]`; network bodies → counts + 20-row sample + `bodyRef`; sensitive blobs
  forced to artifact + redacted even at `detailLevel:full`. `monitor` opt-out by default.
- `envelope.templates`/`envelope.inference` already removed as agent-facing (2026-06-05).
- Bounded/self-cleaning: network recorder ring buffers, `state_store` (24h TTL + 50/kind), driver
  registries (delete on resolve/finish/disconnect/tab-close), observation snapshots (5min TTL),
  session router (5min TTL + 128 cap), disk-backed memory/artifact stores. Tab-close cleanup wired
  via `chrome.tabs.onRemoved → cleanupPiBrowserTab`.

---

## Recommended sequence

1. **Tier 0** — minify (0.1), the two `Promise.all` batches (0.2, 0.3), the sensitive-evidence
   short-circuit (0.4), CLI parse-once (0.5), buffer caps (0.6). All low-risk, no agent-facing
   contract change; land behind `npm run check:all:bridge` + contract tests. 0.1 is the standout
   (every MV3 wake).
2. **Tier 1** — 1.1 (single scan pass) is the biggest scan-latency win; pair with 1.2/1.3/1.8.
   1.4/1.5/1.6/1.7/1.9 each need a targeted test + a smoke.
3. **Tier 2** — 2.1 follows 1.1; 2.2 (cold-start grace); 2.3 (budget serialize-once) only with
   full budget-contract coverage.
4. **Tier 3** — only after a blind-eval run confirms agents don't read the trimmed fields. 3.1 is
   the biggest token win.

---

## Execution readiness — change specs & test map (verified against current source)

Concrete landing details for the items whose patches were designed. Files are absolute-relative to
the repo root. "Guard" = existing test that would catch a regression; "New" = test to add.

### Tier 0

**0.1 SW minify** — `scripts/build-bridge.mjs:55-66`. Done: added `minifyWhitespace:true,
minifyIdentifiers:false` (option a) to the `build()` opts; extended `treeShaking` to `offscreen`.
Guard: `tests/contracts/protocol/check-bridge-build.mjs:120-132` (keep symbol names readable under
option a; under full/syntax minify, option b, rewrite these to behavioral markers). New: size-budget
assert `dist/service-worker.js` < 405 KB. Current savings: ~77 KB re-parsed **every SW wake**.

**0.2 box-model `Promise.all`** — `src/abml/verbs/axRuntime.ts:258-275`. Change: split the loop —
collect interesting nodes + `backendNodeId`s, `await Promise.all` the `DOM.getBoxModel` calls, then
build entities from resolved geometry (only the geometry await is async; rest is sync). Guard:
`tests/unit/tools/observe-abml-integration.test.ts` (entity counts/geometry). Savings: N serial CDP
roundtrips → 1 concurrent batch per scan.

**0.3 network/hook seq `Promise.all`** — `src/tools/observeRunners.ts:476-478`. Done: read
`network.status` and `hook.status` concurrently before building the causal baseline. Deferred: skip
both reads when a cheap armed-recorder source proves neither recorder can be active; do not guess this
from current envelope state.

**0.4 sensitive-evidence short-circuit** — `src/utils/redaction.ts:245-249`. Change: extract shared
`isSensitiveFieldKey(k)` + `sensitiveTextHit(s)` helpers (after `shouldRedactPayloadText`, ~`:100`);
replace `containsSensitiveEvidence` with a first-hit `hasSensitiveEvidence(value, seen, parentPayload)`
walk that mirrors `redactSensitiveValue` branch-for-branch (same `seen` WeakSet, same payload
threading). Keep the public symbol name. Guard: `tests/unit/utils/redaction.test.ts:113-129` (4
predicate cases) + `check-token-contract.mjs:191` (symbol present). New: a **redact-then-compare
oracle** test over a fixture corpus incl. circular, payload-object, and CJK-query cases. Savings: per
result, drops a full redaction-clone + 2 full `stableJson` → an allocation-free first-hit walk.

**0.5 CLI parse-once** — `cli/render.ts` (`looksLikeToolError` `:224-235`, `parseJsonObject`
`:87-94`, `writeJsonEnvelope` `:214-216`). Change: parse once in `renderResult`, thread the object;
keep `normalizeJsonEnvelope` string-accepting (or update the 4 call sites). Guard:
`tests/unit/cli/flags-render.test.ts:317-404` (exit codes, `artifacts`/`cliNextActions`, REF_STALE
output must stay identical). Savings: 1–2 fewer envelope `JSON.parse` per CLI call.

**0.6 buffer caps** — `bridge_src/service_worker/network.ts` (`recorder.diagnostics.push` at
`:47,51,69,74,96,116,410`) + `bridge_src/service_worker/intercept.ts:53` (`session.paused`). Change:
**reuse the existing `appendBounded<T>(arr,item,max,overflowTarget)` helper** (already exported from
`network_events.ts:14`, imported into `network.ts:8`, used for `lifecycleEvents` max 100) for
diagnostics (cap ~100); cap `session.paused` ~500 + auto-`Fetch.continueRequest` the oldest on
overflow. Guard: smokes `smoke-intercept-response.mjs:114` assert `pausedCount===0` after fulfill
(small N, safe). New: push >cap, assert length capped + newest retained.

**1.2 execute post-eval wait** — `bridge_src/service_worker/exec.ts:239`. Done: removed the
unconditional 200ms sleep and kept a 50ms window only for likely tab-opening scripts. Guard:
`tests/contracts/protocol/check-pi-browser-bridge.mjs` asserts the 200ms sleep does not return.

**1.3 command registry memoize / lazy top-level help** — `cli/registry.ts`, `cli/index.ts`,
`cli/bin.ts`, `cli/help.ts`. Done: `collectToolDefs()` and `buildCliCommands()` memoize the
synchronous registry graph, and the actual user-facing bin entrypoint handles top-level
`pi-browser --help` by dynamically importing only `cli/help.ts`. Non-help commands dynamically load
the dispatcher. Guard: `tests/unit/cli/flags-render.test.ts` asserts repeated calls reuse the same
command graph; `tests/unit/cli/local-commands.test.ts` asserts top-level help stays aligned with the
22 real registry commands and statically rejects reintroducing a top-level dispatcher import in
`cli/bin.ts`. Measurement after `npm run build`: `node dist/cli/bin.js --help` median ~56 ms vs
`node dist/cli/index.js --help` median ~315 ms; dev `tsx` stays loader-dominated but improves from
~799 ms to ~389 ms on `cli/bin.ts --help`. No further 1.3 cold-start work is queued until profiling
shows a concrete cost on a real agent entrypoint.

**1.6 offscreen port probe** — `bridge_src/offscreen/transport.ts:133-147`. Done: probe all bridge
port candidates concurrently with primary port first and a 500ms loopback timeout. It intentionally
preserves existing port-range fan-out by connecting every live bridge server, so this is not a
first-live-only short-circuit. Guard: `tests/contracts/protocol/check-pi-browser-bridge.mjs` asserts
primary-first, concurrent fetches, 500ms timeout, and multi-live-port socket creation.

**1.9 artifact text pass count** — `src/tools/artifactReader.ts`. Done: text/search modes collect
`chars` from the same stream used by `readline`, and sample mode reads multi-section line ranges in a
single second pass instead of one pass per section. Guard:
`tests/unit/tools/artifactReader-advanced.test.ts` preserves CRLF char counts and non-overlapping
sample snippets.

### Tier 1

**1.1 single scan eval** — edit `src/abml-core/verbs/router.ts:17-24` (add `prefetchedScan?:
Record<string,unknown>` to `AbmlReadInput` — browserless type, respects the abml-core boundary;
`read.ts` ignores it, no change), `src/abml/verbs/integration.ts:9-11` (forward it),
`src/abml/verbs/runtime.ts:820-826` (guard: `data = (input.prefetchedScan && !descriptor) ?
input.prefetchedScan : (await eval…).data`), `src/tools/observeRunners.ts:464-466` (pass
`prefetchedScan: result.data`). Done for the default path: only attach when
`mode==="scan" && params.includeIframes !== false && params.maxNodes === undefined`** — the default
path. (`mode:"text"` builds `textOnly:true`, which ABML can't consume; the gate inherently excludes
it. Superset-capture-and-clamp is a follow-up if iframe/maxNodes scans prove hot.) `acknowledged`/
`target` (`:465,467`) still come from the first eval — no change. Guard:
`observe-abml-integration.test.ts` (entityCount/focus), `check-abml-scan-envelope.mjs`,
`check-token-economy.mjs`, `check-content-pick.mjs:71` + `check-abml-internal-integration.mjs:14`
(keep the literals `evaluatePageScriptDirect(server, scanScript`, `abml.readStructure`,
`abml: observation.abmlRead`). New guard landed: fake server counts `Runtime.evaluate` command names
and asserts exactly one (`scan_extract`, no `abml_read_scan`) on the default path, while
`includeIframes:false` still runs both. Savings: one full DOM-walk `Runtime.evaluate` (~50% of
post-AX extraction time) eliminated per default scan. Live guard passed via
`npm run smoke:browser:scan-summary` with latest result
`.pi/browser-artifacts/smoke-browser-scan-summary-results.json`.

**1.3 CLI lazy graph** — `cli/index.ts:15` + `cli/registry.ts:8`. Change: **keep
`buildCliCommands` synchronous** (parity check + 4 unit suites call it sync — making it async is
high blast radius) and memoize it; dynamic-`import()` `registerBrowserTools` only on the **execute**
path so `--version`/local commands skip the ~341 ms graph. Guard: `check-cli-parity.mjs` (22
subcommands), `check-param-surface.mjs`, `flags-render.test.ts`, `parity-differential.test.ts`,
`local-commands.test.ts`. New: assert repeated `buildCliCommands()` returns identical content
(memo) + a local command doesn't trigger registration.

**1.4 drop zod** — `src/validation/schemas.ts`, `src/validation/middleware.ts` (only 2 zod users).
Done: ported nested validation to `src/validation/typeboxCompat.ts`, dropped `zod` from
`package.json` / lockfile, and kept the exported `.safeParse()` schema contract. Guard:
`tests/unit/validation/schemas.test.ts`, `tests/unit/validation/middleware.test.ts`,
`npm run check:deps`, and `npm run check:src:types`. Savings: removes one eager runtime dependency
and one schema library from the install/runtime graph.

**1.5 protocol-only restart** — `cli/daemonControl.ts` `isDaemonVersionCurrent` (~`:79-81` / the
`info.version === daemonVersion()` compare). Change: compare only the `+daemon.<n>` suffix vs
`DAEMON_PROTOCOL_VERSION`; keep `expectedVersion: daemonVersion()` display unchanged. Guard:
`daemon-control.test.ts:73-76`, `local-commands.test.ts:545-553` (proto.0 cases still stale). New:
`{version:"9.9.9+daemon.4"}===true` (pkg differs, proto same) + `{…+daemon.5}===false`. Savings: one
2–10 s stop+respawn + bridge/extension teardown avoided per package-version bump.

**1.6 parallel port probe** — `bridge_src/offscreen/transport.ts:133-147`. Change: try 18765 first,
`Promise.all` the rest, per-probe timeout 2000→~500 ms, short-circuit on first live. Keep the
`probeAndConnectWS(resetDelay?)` name/signature (structural greps + tab_sync stub depend on it).
Guard: `check-bridge-build.mjs:131-132`, `check-pi-browser-bridge.mjs` stub. New: fake
`isServerAlive`/`WebSocket` — assert primary-first, concurrency, stop-after-hit. Savings: cold
no-daemon walk ~40 s → ~0.5 s ceiling; also kills the ~38 s of dead-port probing **after** a
successful connect.

**1.7 resourceStore cap** — `src/resources/resourceStore.ts:92-93` + `pruneExpired` `:372-380`.
Done partial: resource/ref stores have 10k caps, oldest-by-`createdAt` eviction on overflow, and
expiry prune is amortized to every 128 registrations while resolve paths still check expiry inline.
Guard: `tests/contracts/tools/check-abml-ref-registry.mjs` asserts oldest live ref eviction, newest
ref retention, and TTL→`REF_STALE`; `tests/unit/resources/resourceReader.test.ts` asserts evicted
browser-result/pi-ref reads fail without leaking artifact paths. Deferred: reuse one stream signal
ref per drain once the exact minting path is isolated.

**1.8 summarizeScanData pass reduction** — `src/tools/summaries/scan.ts`.
Done: scan content lines, actionables, list hints, ABML entities, ranked action scores, action
duplicate counts, sorted action ranking, form summary, headings, text-signal candidates, interactive
rows, list summaries, action entity lookup, and referenced entity slices are precomputed once per
`summarizeScanData` call and reused across budget rungs. Guard: `check:summaries` includes a
deterministic high-entropy scan fixture with fixed `entityContext`, output length/hash,
omitted-field set, and final-rung row/action counts; `npm run check:summaries`,
`npm run check:summary-boundary`, and `npm run check:src:types` passed.

**2.2 extension grace event wait / negative cache** — `src/driver/BrowserBridgeServer.ts`,
`src/driver/BrowserBridgeClientMessageService.ts`, `src/driver/BrowserBridgeCommandService.ts`.
Done partial: `waitForExtensionReady()` now sleeps on an in-process waiter that is resolved by
`ext_ready` / `tabs_update`, and no-extension `sendCommand` failures set a 500ms negative cache so
immediate follow-up subcalls skip the full grace. Guard:
`tests/unit/driver/BrowserBridgeServerConnection.test.ts` covers timeout, zero-bound, event wake, and
back-to-back no-extension commands. Deferred: default wait reduction needs slow-extension evidence.

**1.9 / 1.2 / 2.3 / 2.4 / 3.x** — see the tiered entries above; 1.9, 1.2, and the 2.3
safe subset are already landed, while 2.4/3.x stay behind contract/blind-eval gates.

> Net: Tier 0 is ~6 small PRs landing behind `check:all:bridge` + contracts; 0.1 option (a) and 1.1
> default-gate are the two highest-leverage, lowest-risk changes. All savings above are latency/CPU/
> bytes/allocations — the agent-facing token contract changes only in Tier 3, gated on blind-eval.
