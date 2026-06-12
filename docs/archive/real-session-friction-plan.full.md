# Real-Session Friction Plan

> Status: complete execution record (2026-06-11). Source evidence is a real (non-blind) skill-guided agent
> session — Pi session `019eb646-84a4-7cf5-a648-dc70a8861ef2` (2026-06-11), driver
> `deepseek-v4-flash`, task: fill the Huawei SRC vulnerability-report form (Element Plus,
> 2 text inputs + 5 cascading selects). Outcome: success in 2m34s / 44 tool calls
> (35 `browser_execute`), with ~40% of calls burned on one perception gap.
> Local analysis timeline: `.pi/browser-artifacts/session-form-analysis-timeline.txt`.
>
> Governance: execution was registered in `CURRENT.md` before implementation, then closed back to
> no active execution line after E1-E7 landed.

## Goal

Close the friction that the session verified down to mechanism level, without touching
the perception-not-execution north star or the public tool surface. Every item below is
fully specified (files, functions, gates) and executable now.

## Non-goals / WAI confirmations (do not "fix" these)

- No click/type helpers, no action verbs, no execution sugar. The session re-validated
  JS-first: the agent hand-wrote all 35 interaction scripts without friction complaints
  about missing action tools.
- No overfit to Element Plus or the test site: every fix below is mechanism-general
  (ARIA spec, SVG DOM API, JSON rendering, signal honesty).
- The driving agent's "tabId is unstable, I had to re-list constantly" complaint is
  **dismissed for lack of evidence**: the transcript shows one `browser_tabs list` call
  total and a constant tabId/selectionVersion throughout. Recorded here so it does not
  resurface as a finding.
- Byte-budget binary-search trimming of inline JSON (`fitInlineJsonToBudgetMeasured`,
  `src/tools/toolAdapter.ts:246`) is correct behavior; only per-item dead weight is
  addressed (E2).

## E1 — SVG className guard in scan hit paths

**Defect (observed).** `hitTarget.class` rendered as `"[object SVGAnimatedString]"` for
SVG hit targets (rich-text toolbar icons). In `capture-src/entries/scanTemplate.ts`,
~9 `className` reads exist; the guarded sites use
`typeof el.className === 'object' ? el.className.baseVal : el.className`, but the two
`hit.className` reads and the one `topRoot.className` read pass the raw value into
`cleanClassValue(...)` unguarded. Affects every SVG hit target on every page.

**Fix.** Apply the identical baseVal guard at the 3 unguarded call sites (grep
`cleanClassValue(` in the template to enumerate). Regenerate the committed bundle with
`npm run sync:capture`.

**Files.** `capture-src/entries/scanTemplate.ts`; generated
`src/capture/generated/scanBundle.ts` (via sync, do not hand-edit).

**Regression.** Extend the vm-executed scan fixture in
`tests/contracts/runtime/check-page-scripts.mjs` (or `check-scan-script`) with an SVG
actionable; assert the emitted class is the literal class string.

**Gates.** `npm run check:capture`, `npm run check:scan`, `npm run check:page-scripts`,
`npm run lint` (template-literal escape rules bite here), then `npm run check:all:contracts`.

**Completion evidence.** `hitTargetInfo()` now guards SVG `className.baseVal`, and
`tests/contracts/runtime/check-page-scripts.mjs` asserts a mocked SVG hit target emits
`"toolbar-icon svg-action"` instead of `"[object SVGAnimatedString]"`.

## E2 — Render empty arrays as `[]` in artifact json compaction

**Defect (observed).** `compactJsonValue` (`src/tools/artifactReader.ts:506-514`) wraps
every array — including empty ones — in the full
`{type,count,offset,limit,nextOffset,items}` window envelope (~90 chars each). Each scan
actionable carries an empty `handlers` array, so the envelope is pure dead weight that
the byte-budget fitter then pays for: the session requested `limit:80` on
`data.actionables` and received 7 items/page; the agent abandoned enumeration after 3
pages.

**Fix.** In the `Array.isArray(value)` branch: `if (value.length === 0) return [];`.
No other shape changes — non-empty arrays keep the window envelope.

**Files.** `src/tools/artifactReader.ts`; update expectations in
`tests/contracts/tools/check-artifact-reader.mjs` and
`tests/unit/tools/artifactReader.test.ts`.

**Gates.** `npm run check:artifact`, `npm run test:unit`,
`npm run check:output-schema-conformance`, `npm run check:cli-json-envelopes`.

**Completion evidence.** Re-read a captured scan artifact's `data.actionables` under the
same budget and record items-per-page before/after (expect a measurable increase; the
session baseline is 7/page).

**Measured post-fix evidence.** A same-shape 80-actionable payload through
`fitInlineJsonToBudget` improves fitting from 6->9 items at 4000 chars and 13->19 items
at 8000 chars when empty `handlers` arrays render as `[]` instead of window envelopes.
`tests/contracts/tools/check-artifact-reader.mjs` also asserts nested empty arrays stay `[]`.

## E3 — jsonPath notFound returns nearest-parent keys

**Defect (observed).** A missing-path json read returns only
`{exists:false, notFound:true}` plus a generic nextAction. The agent guessed
`data.relations`, got notFound, and never discovered `data.controls_pairs` — which held
the exact aria-controls pairings it then spent ~80s reconstructing by hand via
`browser_execute`.

**Fix.** In the `readJson` notFound branch (`src/tools/artifactReader.ts:587-594`), walk
the requested path from the deepest segment toward the root via the existing
`getJsonPath`; include `nearestPath`, `nearestType`, and `nearestKeys` (cap 40, same as
`summarizeJsonValue`) in both summary and value. Extend the notFound nextAction in
`src/tools/resultMiddleware.ts:381` to suggest re-reading `nearestPath`.

**Boundary.** One extra in-memory walk over already-parsed JSON; no extra file IO; no new
params.

**Gates.** `npm run check:artifact`, `npm run test:unit`,
`npm run check:cli-json-envelopes`, `npm run check:output-schema-conformance`;
`npm run docs:generate` + `npm run check:tool-docs` if the generated contract documents
the notFound shape.

**Completion evidence.** Missing `items[999].requestId` now returns nearest parent
`items` with type `array` and capped keys; missing `data.relations` returns nearest parent
`data` with keys including `controls_pairs`. Result middleware adds
`read_saved_artifact mode=json jsonPath=<nearestPath>`.

## E4 — Skill gotcha: shared-popper component dropdowns

**Decision.** Encode the recipe the agent had to discover by trial as skill methodology
(strategy belongs in skills, not tools). Content to add, phrased generically:

- Component-library selects (Element Plus / Ant Design / MUI style) render their popup
  lazily — the listbox DOM may not exist until first open, and "the first visible
  popper" is frequently a stale popup from the previously opened control.
- The mechanical identification is on the trigger: `aria-controls` (idref of the popup)
  + `aria-expanded`. Close (body click), reopen the target control, then query the popup
  **by that id** — never by visual popper heuristics.
- `browser_observe mode:scan` already captures page-wide controls/owns/expanded pairings
  in artifact `data.controls_pairs` (sources kept even when off-screen); re-scan after
  opening if the pairing was unresolvable at first scan.

**Files.** `skills/pi-browser-tools/SKILL.md` and `skills/pi-browser-cli/SKILL.md`
(methodology is duplicated across the two frontend skills by design — update both).

**Gates.** Skill quick-validate per CLAUDE.md for both skills; the skill-pinning
contracts (`check-tool-doc-drift` / `check-tools-contract` / `check-token-contract`).

**Completion evidence.** Both frontend skills now include the `aria-controls` /
`aria-expanded` shared-popper recipe. `quick_validate.py` passed for
`skills/pi-browser-tools` and `skills/pi-browser-cli`.

## E5 — Execute effect honesty: unknown ≠ zero

**Defect (observed, n=35).** Every `browser_execute` in the session reported
`effect: {mutations: 0, settled: true}` — including calls that opened 28-item dropdowns.
The effect plane produced zero information for the entire session while looking
confident.

**Mechanism (traced).** `mutations = delta(after.changeSeq, before.changeSeq) ?? 0`
(`src/tools/executionEffect.ts:59`) and `settled = mutations === 0 || quietDelta === 0`
(`:76`); the quiet re-read only runs when `mutations > 0` (`:98`). When
`readPageFingerprint` fails or returns a non-finite changeSeq,
`normalizePageFingerprint` (`src/tools/pageSignals.ts:25-28`) yields `undefined`, every
delta is `undefined`, and `?? 0` renders the unknown as a confident zero. The
content-script MutationObserver is broad
(`bridge_src/page_scripts/content.ts:99` — documentElement, subtree, childList,
attributes, characterData) and SPA renders flush as microtasks, so a healthy responder
should have observed the popper mutations — fingerprint unavailability is the leading
hypothesis, but the rendered lie is mechanical either way.

**Step 1 — unconditional honesty fix.** In `buildEffect`, when the before or after
fingerprint is `undefined`, omit `mutations`/`settled`/`visibleDelta`/`interactiveDelta`
(or emit `signals:"partial"`) instead of zeros. Mirror in `executionJournal` if it
copies these fields.

**Step 2 — diagnosis with existing harness.** Run
`npm run eval:browser-workflows -- --fixture-server --eval 02-scan-execute-wait` (and
`npm run smoke:browser`) against a fixture with a dynamically rendered control; log
fingerprint presence before/after. This decides between (a) responder/command failure
and (b) genuine zeros with healthy fingerprints.

**Step 3 — conditional repair, same workstream.**
- If (a): fix `content.fingerprint` delivery in `bridge_src`, and add a runtime fixture
  asserting changeSeq monotonicity across an execute that mutates DOM
  (`check:runtime-fixtures`).
- If (b): add a bounded quiet re-read on the zero path mirroring `:98-101`
  (default `quietMs` 150, escape `PI_BROWSER_EXECUTE_EFFECT_QUIET_MS=0`), reusing the
  existing `delay`/`readExecutionSignals` helpers, and surface changes that landed only
  in the quiet window (e.g. `async:true`).

**Boundary.** `PI_BROWSER_EXECUTE_EFFECT=0` escape unchanged. No unconditional execute
latency is added — any new wait lives inside effect collection (which already costs two
bridge round trips) and only on the zero path; the perf-audit decision removing the
fixed 200ms execute wait stands.

**Gates.** New focused unit tests for `executionEffect`; `npm run check:tools`,
`npm run check:summaries`, `npm run check:token-economy`,
`npm run check:runtime-fixtures`; `npm run check:all:bridge` if `bridge_src` changes;
live `npm run smoke:browser`; final `npm run check`.

**Completion evidence.** On the fixture: an execute that opens a dynamic popup reports
nonzero (or async-flagged) mutations; a true no-op execute reports zeros **with
fingerprints present**; an execute with unavailable fingerprints reports no
mutations/settled claim.

**Completion evidence.** Eval 02 now lazily inserts `#activation-popup[role=listbox]` on
click and fails if the execute artifact does not carry a positive mutation count. Passing
artifact:
`.pi/browser-artifacts/eval-browser-workflows/2026-06-11T12-56-07-377Z-ccfc90d9/02-scan-execute-wait-execute.json`
contains `effect.mutations:1`, `visibleDelta:3`, `anchor.changeSeq:2`, and popup option
text in the monitor diff. Unit coverage asserts unavailable fingerprints compact to
`{signals:"partial"}` with no `mutations`/`settled` claim.

## E6 — Actionable label borrows from the hit target

**Defect (observed).** The vulnerability-name input's actionable was labeled
`"el-input"` (framework wrapper class fallback) although the inner `<input>` — already
captured as `hitTarget` — carries `placeholder="请输入漏洞名称"`. The label chain
(aria-label || title || alt || placeholder || data-testid…) runs on the wrapper element
only, which has none of these.

**Step 0 — blast-radius check (required first).** Confirm whether entity names
participate in ref-id minting (`nodeRefId` consumers in
`src/tools/summaries/scan.ts:432-447` and the abml-core refId derivation). The ABML
kernel-optimization acceptance pinned "ref ids stable" as a property: if names feed
identity, scope this change to the display label only so refs stay stable.

**Fix slice.** In the scanTemplate actionable labeler: when the computed label is the
class/tag fallback AND the hit target differs from the element AND the hit target is a
form control, borrow its `placeholder`/`name`/`aria-label`. Regenerate via
`npm run sync:capture`.

**Gates.** `npm run check:scan`, `npm run check:abml-scan-entities`,
`npm run check:abml-scan-envelope`, `npm run check:task-conditioned-salience`,
`npm run check:token-economy`, `npm run check:capture`.

**Completion evidence.** Fixture with a wrapper-pattern input yields a
placeholder-derived action label; ref-stability assertions stay green.

**Completion evidence.** The scan fixture now keeps wrapper identity `label:""` /
`action:"el-input"` while exposing `displayLabel:"请输入漏洞名称"` and
`hitTarget.inputLabel`. `check-abml-scan-entities` asserts displayLabel improves primary
action display only and does not change the minted entity name or ref.

## E7 — Ledger and closure bookkeeping

- Record the E5 (effect vacuity) and popup-ownership findings in
  `evals/browser-workflows/blind-findings.md` with provenance marked as a real user
  session (not a blind run), per the triage convention.
- Add a closed decision to `ROADMAP.md` ("Closed decisions + reopen evidence bar"):
  heavier popup-ownership perception surfacing (entity-level expanded/controls fields,
  post-open auto-pairing) stays closed; reopen bar = a second real-agent run on a
  **different** component library hitting popper-ownership confusion **after** E3 + E4
  have landed.
- `CHANGELOG.md` entries for E1–E6; `CURRENT.md` activation entry at execution start;
  `TODO.md` pointer while active.
- Gates: `npm run docs:sync-indexes` if index blocks are touched,
  `npm run check:doc-structure`, final `npm run check` and `npm run lint`
  (`check` does not run ESLint).

**Completion evidence.** The findings are recorded in
`evals/browser-workflows/blind-findings.md` as real-session, not blind-run, entries; the
heavier popup-ownership perception surface is closed in `ROADMAP.md` with a concrete
reopen bar; `CHANGELOG.md`, `CURRENT.md`, `TODO.md`, README, skills, and Eval 02 docs are
updated.

## Execution order

1. E1, E2, E3, E4 — independent, cheapest-first, all deterministic.
2. E5 — diagnosis is built into the item; step 3 branches on its result.
3. E6 — only after its step-0 blast-radius check.
4. E7 — closes the workstream.

## Acceptance

- Every item's focused gates green, then one final `npm run check` (66 scripts) plus
  `npm run lint`.
- E5 live evidence via `smoke:browser` on a dynamic fixture.
- The two recorded numbers to beat from the session baseline: items-per-page on
  `data.actionables` under default budget (was 7), and effect informativeness (was 0/35
  informative).

## Execution Evidence

- Focused gates passed: `check:capture`, `check:scan`, `check:artifact`,
  `check:page-scripts`, `test:unit`, `check:output-schema-conformance`,
  `check:cli-json-envelopes`, `check:runtime-fixtures`, `check:tools`,
  `check:summaries`, `check:token-economy`, `check:abml-scan-entities`,
  `check:abml-scan-envelope`, `check:task-conditioned-salience`.
- Group gates passed: `check:all:contracts`; `check:all:bridge` passed after a clean rerun
  (an earlier concurrent run showed one unit failure that did not reproduce when unit and
  the group were rerun).
- Runtime/eval evidence passed: `npm run eval:browser-workflows -- --fixture-server --eval
  02-scan-execute-wait` with dynamic popup evidence at
  `.pi/browser-artifacts/eval-browser-workflows/2026-06-11T12-56-07-377Z-ccfc90d9/`;
  `npm run smoke:browser` passed and wrote `.pi/browser-artifacts/smoke-browser-results.json`.
- Skill validation passed for both `skills/pi-browser-tools` and `skills/pi-browser-cli`.
- Final closure gates: `npm run docs:sync-indexes`, `npm run check:doc-structure`,
  `npm run check`, and `npm run lint`.
