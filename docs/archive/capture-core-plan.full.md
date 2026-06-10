# capture-core — page-world sensing kernel execution contract

> Status: **COMPLETE — activated and executed 2026-06-10.** Execution was recorded in
> `CURRENT.md`; verification passed the focused capture/fact-renderer gates and final full gates.
>
> **AS-BUILT MECHANISM DEVIATION (acceptance-reviewed and ACCEPTED 2026-06-10).** The landed
> implementation uses **parameterized template strings + copy-with-hash sync** (capture-src
> entries are TS files exporting page logic as `${...}`-placeholder string constants;
> `scripts/sync-capture.mjs` copies them to `src/capture/generated/*Bundle.ts` with a sha256
> drift header — NO esbuild compile, NO `lib/` modules, NO IIFE-args bundles as §4 originally
> designed). Acceptance verdict: the plan's four §1 defects are all addressed by the simpler
> mechanism — #1 selector divergence fixed behaviorally (pick adopts scan-canonical semantics;
> `check-capture-core-boundary.mjs` pins identical canonical fingerprints in BOTH bundles and
> bans O(S²) sibling scans — an anti-drift lock replacing "one engine"), #3 B3 inherited, #4
> closed by behavioral vm execution of scan in `check-page-scripts.mjs`. #2 (escape-class) is
> **contained, not eliminated**: page logic remains strings, but concentrated in one directory,
> hash-drift-gated, and covered by behavioral tests that break on escape collapse. Known
> residual debts: no TS type-checking of page logic; selector algorithm is duplicated-but-locked.
> **esbuild migration trigger — NOW ENFORCED, not prose:**
> - *6th entry* → `check-capture-core-boundary.mjs` pins the capture-src entry set AND the
>   generated-bundle set at exactly 5; adding a 6th entry fails the gate with a message citing
>   this note, forcing the migration decision (the gate cannot be silently grown).
> - *≥2 escape-class regressions* → escape collapse is test-caught today (the `\\s+` string
>   marker in `check-scan-script.mjs` plus behavioral scan execution in `check-page-scripts.mjs`).
>   Tally caught escape regressions in the **Debt ledger** below; at 2, migrate. (A running count
>   cannot be auto-asserted; this is the honest tracked form.)
>
> **Debt ledger (capture-core mechanism debt — zero interest while empty):**
> - Escape-class regressions caught in capture-src since 2026-06-10: **0 / 2** → migrate at 2.
> - Residual: page logic is untyped strings (contained, not eliminated) — `capture-src/` is in no
>   tsconfig (`check:src:types` does not cover it) and is exempted from the two type-aware ESLint
>   rules (syntactic rules incl. `no-useless-escape` still apply); selector engine is
>   duplicated-but-fingerprint-locked across the two bundles. Neither accrues interest until a
>   trigger fires; the esbuild migration retires both (capture-src joins a typed project).
>
> §4/§5 below are retained as the ORIGINAL design record; where they conflict with this note, the
> as-built note governs.
> Third kernel of the project: the **page-world sensing layer**. capture-core turns the scattered
> string-built injected scripts into real TypeScript modules compiled to deterministic, committed
> bundles — completing the sensory chain **capture-core (sense) → abml-core (perceive) →
> distill-core (express)**. Feasibility was source-verified on 2026-06-10 (§2); every mechanism
> this plan relies on already exists in-repo in some form.

## 1. Problem — the sensor layer is string-built JS, scattered, divergent, and asymmetrically tested

The code that runs inside the page IS the project's sensor. Today it exists as **10+ string-built
script builders across 5 modules**, hand-assembled from template literals:

| Builder | Where | Size/role |
| --- | --- | --- |
| `buildScanScript` | `src/scan/buildScanScript.ts` | the main sensor (~600 lines of string JS): DOM walk, actionables, selectors, visibility, list hints, top-layer |
| `buildPickScript` / `buildPickCleanupScript` | `src/pick/buildPickScript.ts` | element picker overlay |
| `buildContentScript` | `src/content/buildContentScript.ts` | text/link extraction |
| 7 verb probe builders | `src/abml/verbs/runtime.ts:287-442` | `actionabilityProbeScript`, `scrollIntoViewScript`, `syntheticClickScript`, `focusAndMaybeClearScript`, `verificationProbeScript`, `scrollProbeScript`, `scrollStepScript` |
| `viewportScript` | `src/abml/verbs/visionRuntime.ts:32` | viewport probe |

Four concrete defects of this form, all source-verified:

1. **Engine divergence (correctness, not style):** `buildPickScript.ts:24-98` contains its OWN
   selector generator whose algorithm DIFFERS from scan's `selectorFor`
   (`buildScanScript.ts:257-274`) — pick embeds `#id` inside path segments; scan returns early on
   id and uses class segments. **The same element can get different selectors from pick vs scan**,
   silently breaking cross-tool correlation (pick → execute → observe chains).
2. **A recurring bug class:** template-literal escape collapse (`\s` → whitespace) has shipped at
   least once (caught by ESLint `no-useless-escape`; standing lesson recorded). The current guard
   is literally `assert(script.includes("\\s+"))` in `check-scan-script.mjs:35` — a string marker,
   not a behavior test.
3. **Quadratic hot spot with no safe landing zone:** `selectorFor`'s per-level
   `Array.from(parent.children).filter + indexOf` is O(S²) on wide containers (200-row table ≈
   ~480k sibling ops; kernel-opt plan B3). Fixing logic inside a giant template literal cannot be
   unit-tested.
4. **Test asymmetry:** `tests/contracts/runtime/check-page-scripts.mjs` already executes PICK
   scripts behaviorally in `node:vm` against a hand-rolled `MockDocument` (click dispatch,
   pagehide cancellation, cleanup handles — `:414-441`), and even executes the service-worker's
   `buildExecScript` via esbuild `transformSync` (`:467-473`). But SCAN — the most complex and
   hottest script — has only syntax (`new Function`) + ~25 string-marker asserts
   (`check-scan-script.mjs:29-57`). The mini-DOM harness exists; scan logic just isn't shaped to
   use it.

## 2. Verified feasibility (the four hard questions, with evidence)

**Q1 — Injection mechanism / parameterization.** All Node-side page scripts go through one seam:
`src/tools/pageScriptEvaluation.ts:13-21` → `cmd:"cdp"`, `Runtime.evaluate`,
`{expression, awaitPromise:true, returnByValue:true}` (and `visionRuntime.ts:46-58`, same shape).
A compiled bundle injects as `(<compiled IIFE taking one args object>)(<json>)` — the safe inline
JSON serializer already exists (`jsonForInlineScript`, `buildScanScript.ts:11`, with
`</script>`/U+2028/`&` escaping locked by `check-scan-script.mjs:10-14`). **Zero protocol change;
zero bridge change.**

**Q2 — Iframe handling.** Scan handles iframes IN-PAGE via same-origin `contentDocument`
recursion (`buildScanScript.ts:439-503`); cross-origin frames are only noted. One evaluation per
scan stays one evaluation per scan. **Bundle boundary = today's boundary.**

**Q3 — Build pipeline under Pi-native source loading.** Pi loads `index.ts` source directly
(`pi.extensions`), so bundles cannot be build-time-only artifacts. The repo already solves exactly
this twice:
- `sync:protocol` generates committed `.ts` files (`bridge_src/service_worker/protocol.ts`,
  `src/protocol/*.ts`) with a `--check` drift gate (`check:protocol`) and a lefthook auto-stage
  hook;
- `bridge_src/page_scripts/*.ts` → committed `bridge/pi_browser_bridge/dist/*.js` bundles, with
  source↔bundle pair assertions in `check-page-scripts.mjs:30-42`.
capture-core copies the first pattern: `capture-src/*.ts` —esbuild→ generated
`src/capture/generated/<entry>Bundle.ts` (`export const SCAN_BUNDLE = "..."`), committed,
drift-checked by `sync:capture --check`, auto-staged by lefthook. Works identically under tsx
(dev), tsc dist (npm/CLI), and `npm pack` (`files` already ships `src/`). esbuild `^0.28` is
already a devDependency.

**Q4 — Testability.** No new test dependency needed: the `MockDocument`/`createPageContext`/
`vm.runInNewContext` harness in `check-page-scripts.mjs` already runs picker behavior end-to-end
(`:416-441`, including a mocked `elementFromPoint` via `_pointElement`). Once capture logic is
real TS modules, unit tests import functions directly (no vm needed for pure helpers) AND the vm
harness runs the compiled bundles for integration parity. The current `stripBridgeSource` regex
hack (`:11-21`) that fakes module loading for vm becomes unnecessary for capture entries.

## 3. What already exists (reuse, do not rebuild)

- The vm + MockDocument behavioral harness (`check-page-scripts.mjs`) — extend, don't replace.
- `jsonForInlineScript` — the args-injection serializer, already contract-locked.
- The generated-TS + `--check` + lefthook pattern (`sync:protocol`) — copy verbatim as
  `sync:capture` / `check:capture`.
- The bridge page_scripts source↔bundle pair locks — the assertion shape for bundle freshness.
- `noiseRules.ts` / `actionableRules.ts` (`src/scan/`) — already extracted as plain TS data
  modules consumed by the builder; they become ordinary imports of capture-src.
- Kernel-opt plan **B3** (selectorFor O(S²) fix) — lands inside C-2 of this plan with real unit
  tests, instead of as a string-surgery point fix.

## 4. Design

```
capture-src/                      page-world TS (the kernel; MAIN-world JS semantics)
  lib/selector.ts                 THE selector engine (single source; scan semantics canonical)
  lib/visibility.ts               visibleInfo / hit-testing / viewport math
  lib/text.ts                     clean/cleanLineText/label extraction
  lib/noise.ts                    re-exports of noiseRules/actionableRules data
  entries/scan.ts                 (args) => scan result      — replaces buildScanScript body
  entries/content.ts              (args) => content result   — replaces buildContentScript body
  entries/pick.ts + pickCleanup.ts
  entries/probes.ts               actionability/scroll/click/focus/verification probes (small,
                                  one bundle shared by the 7 verb builders + viewport probe)
scripts/build-capture.mjs         esbuild: entries → IIFE-with-args bundles → generated TS consts
src/capture/generated/*.ts        committed bundle constants (drift-gated, lefthook auto-staged)
src/capture/inject.ts             tiny runtime: `injectable(BUNDLE, args)` → `(IIFE)(json)` string
```

- **Builders become one-liners:** `buildScanScript(options)` →
  `injectable(SCAN_BUNDLE, normalizeOptions(options))`. Public builder signatures unchanged;
  call sites unchanged.
- **Kernel boundary lock (`check:capture-core-boundary`):** capture-src must not import Node
  builtins, `src/` runtime modules, or reference `chrome.*` (MAIN world); bundles must be
  self-contained IIFEs (same assertions the hook dispatcher already has,
  `check-page-scripts.mjs:37-40`). Allowed imports: capture-src internal + plain-data modules
  (noiseRules/actionableRules).
- **Selector unification decision:** scan's `selectorFor` semantics are canonical — they are what
  gets minted into entity locators (`by:"css"`) and therefore into `pi-ref://` ids; pick adopts
  the shared engine. Pick's divergent output shape is treated as the defect (it predates refs-v1
  correlation). Migration note: pick selectors may CHANGE for elements with mid-path ids — this is
  the intended fix, covered by updated pick behavior tests, and called out in CHANGELOG.
- **Bundle hygiene:** esbuild `target` pinned conservatively (chrome120, matching the existing
  test transform), `minify:false` (Runtime.evaluate exceptionDetails line numbers stay readable;
  bundles are sent per call today as full source strings anyway, so size parity holds), banner
  comment with generator + hash.

## 5. Hard constraints

1. **Byte-level behavior parity for scan/content during migration** (selector strings, actionable
   ordering, text output) — proven by golden fixtures on the mock DOM BEFORE the live smoke.
   Pick is the sanctioned exception (§4 selector unification).
2. **One sensor engine:** after C-3, `nth-of-type`/`cssEscape`/selector-path logic may exist ONLY
   in `capture-src/lib/selector.ts` — enforced by a grep lock over `src/` (the anti-scatter
   pattern from distill-core).
3. **Escape-class elimination is total:** no page-logic template literals remain in `src/` once
   C-4 lands; the `assert(script.includes("\\s+"))`-style guards retire WITH the bug class and
   are replaced by behavioral tests.
4. Generated bundles are **deterministic** (same source → same bytes; esbuild version pinned via
   lockfile) — required for the `--check` drift gate.
5. Perception-not-execution is untouched: probes/click/type scripts remain internal substrate
   reached via the same internal verbs; no public surface change of any kind.

## 6. Rejected alternatives (recorded so they are not re-litigated)

- **`fn.toString()` injection (no build step).** Tempting, but the emitted text differs between
  loaders (tsx/esbuild-transform in dev vs tsc in dist), breaking determinism, the drift gate,
  and byte-parity guarantees. Generated bundles are loader-independent.
- **Runtime esbuild (build on first use).** Adds a heavyweight runtime dependency + cold-start
  cost to the Pi-native path the project deliberately keeps丝滑; violates the "no host-specific
  production assumptions" portability rule for the npm package.
- **Per-frame injection redesign.** Out of scope: in-page same-origin recursion is the verified
  current contract (§2 Q2); changing frame strategy is a different (perception) workstream.
- **jsdom/happy-dom test dependency.** Unnecessary — the in-repo MockDocument harness already
  covers behavioral testing and stays dependency-free; extend it where scan needs richer geometry
  (`getBoundingClientRect` returns, `elementFromPoint` tables) instead.
- **Folding capture-src into bridge_src/page_scripts.** Different lifecycle and transport:
  page_scripts are extension-injected (manifest/scripting API, chrome-extension URL fetch),
  capture entries are CDP-evaluated per call from Node. Shared *conventions*, separate kernels;
  a future shared lib between them is allowed but not required.

## 7. Execution queue

- [x] **C-1 — Behavioral golden harness for scan/content/pick/probes.** Existing runtime gates now
  execute the generated capture templates through the same builder API: `check:scan`,
  `check:content-pick`, `check:page-scripts`, and `check:abml-verb-runtime` cover syntax,
  behavior markers, picker behavior, cleanup behavior, content/scan artifact preservation, and
  ABML verb probe execution. Scan/content parity is maintained by extracting the original script
  bodies into deterministic generated templates before thin-wrapper migration.
- [x] **C-2 — capture-src entries + generated pipeline.** `capture-src/entries/*Template.ts`,
  `scripts/sync-capture.mjs`, committed `src/capture/generated/*Bundle.ts`, `src/capture/inject.ts`,
  `sync:capture`, `check:capture`, lefthook `sync-capture`, package coverage, and boundary lock
  are live. `buildScanScript` is now a thin parameter-normalization wrapper. B3 was already landed
  by `docs/abml-kernel-optimization-plan.md`; this plan inherits and locks it instead of repeating it.
- [x] **C-3 — content + pick adopt capture seam.** `buildContentScript` and `buildPickScript` now
  render generated capture templates. Pick adopts scan-canonical selector semantics (`#id` early
  return, cached sibling `nth-of-type`, max-depth guard), eliminating the scan/pick selector split.
- [x] **C-4 — probes migrate.** The 7 ABML runtime probe builders and `viewportScript` now render
  generated templates from `src/capture/generated/probesBundle.ts` and `visionBundle.ts`; runtime
  files retain only argument injection and orchestration.
- [x] **C-5 — retire/upgrade string-scatter contracts.** `check:capture` combines deterministic
  drift checking with `check-capture-core-boundary.mjs`, and existing runtime contracts verify the
  generated outputs. The boundary lock rejects re-owned page logic in `src/`, restored O(S²) sibling
  scans, and non-canonical pick/scan selector divergence.

## 8. Verification map

- **Focused gates passed:** `check:capture`, `check:src:types`, `check:scan`, `check:content-pick`,
  `check:page-scripts`, `check:abml-verb-runtime`, `check:summaries`, `check:package`,
  `check:distiller-coverage`, `check:task-conditioned-salience`, `bench:distill`, and focused
  result-middleware / allocate-render unit tests.
- **Final gates:** `npm run check`, `npm run smoke:browser:scan-summary`, and `git diff --check`.
- **B3 evidence:** B3 was completed once in the prior ABML kernel optimization plan. Capture-core
  now locks the no-`Array.from(parent.children).filter` invariant in generated scan/pick bundles
  and does not repeat the implementation.

## 9. Relationship to other tracks

- `docs/abml-kernel-optimization-plan.md` — B3 is absorbed by C-2 here **if this plan activates
  first**; otherwise B3 lands as a string-surgery point fix and C-2 inherits its test. Either
  order is safe; do not do both.
- `docs/perception-renderer-plan.md` — now linked by the closure work: capture-core changes how
  facts are SENSED, and this execution also connected the existing production renderer to
  `factify → allocateFacts → renderFacts` so the prior fact-allocator substrate is no longer only
  test/bench-facing. The model-facing envelope remains contract-stable.
- Three-kernel end state: **capture-core (sense) → abml-core (perceive) → distill-core
  (express)**, each pure, boundary-locked, independently benchmarked. Remaining candidates stay
  rejected per the kernelization research + the 2026-06-10 review (comms: never; ref/artifact:
  already clean; redaction: lock not kernel; websec analysis-core: watchlist, gated on usage).
