# Performance & Overhead Audit (2026-06-08)

Whole-project read-only audit. Two passes: a four-dimension fan-out (token output /
runtime latency / startup cost / memory) plus a verification + completeness-critic pass
that confirmed the load-bearing findings at source and swept for redundant work the first
pass structurally missed.

Every finding is grounded at `file:line`. Items marked **[src-confirmed]** were read
directly during the verification pass; **[corrected]** marks a first-pass suspicion that
did NOT reproduce. Per the project's eval-driven / no-overfit rules, contract-changing
items (T3) require blind-eval evidence before landing.

---

## Tier 0 — biggest wins, low risk, no agent-facing contract change (do first)

### 0.1 Minify the service-worker bundle — paid on EVERY MV3 wake  **[src-confirmed]**
- **Where:** `scripts/build-bridge.mjs:55-66` (esbuild `build()`), output
  `bridge/pi_browser_bridge/dist/service-worker.js` = **476,582 bytes, un-minified**
  (9,401 lines, full identifiers/comments). `minify` is never set.
- **Why it matters:** MV3 service workers are torn down after ~30s idle and the whole
  bundle is **re-parsed + re-compiled + top-level-executed on every cold wake**
  (`installPiBrowserServiceWorker()` runs at `service-worker.js:9401`). 476 KB parsed every
  wake vs ~150–200 KB minified.
- **Fix:** add `minify: true` (or `minifyWhitespace + minifyIdentifiers`) to the
  `service-worker`/`offscreen` esbuild entries. esbuild already a dep; tree-shaking already
  on. Committed sourcemap keeps stacks readable.
- **Risk:** Low. Only watch: tests asserting on un-minified function-name strings in stacks.

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
- **Fix:** add an optional `scanData` input to `readStructure`/`executeBrowserAbmlRead`; when
  present, skip the `:820` eval. Reconcile params to the superset so neither output regresses.
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
- **Fix:** resolve the wait via a Promise fired by `registerClient` (ends instantly on connect,
  costs nothing idle); lower default to ~1.5–2s (already `PI_BROWSER_EXTENSION_WAIT_MS`-overridable);
  cache "no extension as of T" for a few hundred ms so back-to-back failing sub-calls don't re-pay.
- **Risk:** Low.

### 2.3 `fitEnvelopeBudget`/`fitSummaryBudget`: serialize-once accounting  **[src-confirmed]**
- **Where:** `src/tools/resultMiddleware.ts:157-190,419-479`. On a budget-overflowing (large)
  page the envelope is `stableJson`-ed **30–50×** over progressively-large objects in one observe
  call: the ladder re-serializes each rung, `check()` (`:424`) re-marks omissions AND
  re-stringifies just to measure, the lift loop stringifies both `compacted` and `value` per key.
- **Fix:** measure `.length`/`Buffer.byteLength` on the already-produced marked string instead of
  re-marking+re-stringifying in `check()`; cache `stableJson(value).length` across the lift loop;
  move to a "serialize once, subtract removed-field bytes" accounting model.
- **Risk:** Medium-high — intricate budget logic with blind-eval regressions baked in; only with
  full budget-contract test coverage. Biggest per-call CPU sink on large pages.

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
