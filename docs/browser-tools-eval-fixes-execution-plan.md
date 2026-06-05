# Browser-tools skeptical-eval fixes — execution contract

> Status: **PLANNED (not started).** Driven by the first real-agent skeptical eval
> (2026-06-05, `browser-tools-skeptical-eval`, n=1, 5 real sites). Turns its measured efficacy signal
> into fixes for the recently-shipped action path (B2), causal plane (R3.x), and templating (M1).
> Activated in `CURRENT.md`. Every report finding maps to a slice or to a reasoned out-of-scope
> decision — see the **coverage matrix (§7)**. Each slice lands behind `npm run check` + the
> action-gap smoke; the eval is **re-run as meta-acceptance**.

## 1. Goal

The eval is our first real-agent efficacy evidence, and it is **mixed** — correcting any impression
that the ladder "uniformly strengthens the surface":

| Capability | Eval score | Verdict |
|---|---|---|
| `causal` | 4/5 | genuinely useful (located the action's APIs + `triggered` on a real site) |
| `action.type` | 4/5 | genuinely useful (CDP/verified; saved the manual focus+setter+wait+readback) |
| `templates` | 3/5 | situational — big tables yes; noisy (text-leaf templates) + under-detects non-AX groups |
| `action.click` | 3/5 | marginal — mostly packages verification; **slow**; default verify weak |
| `diff`/`treeDiff` | 2/5 | churn-noisy — core semantic change drowned by suggestion-popup churn |
| `action.scroll` | 1/5 | net negative — **very slow + buggy** |

Fix the concrete defects and correct the docs' "effect" wording to match measured reality —
**without widening the surface or overfitting**. No new capability is invented.

## 2. Evidence basis

- Report: `browser-tools-skeptical-eval-2026-06-05` (relayed; not in repo).
- Root causes below are confirmed against source (`executeBrowserAbmlClick`/`Type`/`Scroll` in
  `src/abml/verbs/runtime.ts`; `redactUrl`/`redactSensitiveText` in `src/abml-core/causal.ts` +
  `src/utils/redaction.ts`; `buildTemplateSummary` in `src/abml-core/templating.ts`;
  `resolveBaselineEntities` in `src/tools/observeRunners.ts`).

## 3. Constraints (unchanged project invariants)

- **No new public tool**; `action`/observe changes are additive/optional with a safe default
  (absent ⇒ today's behavior).
- **Redaction stays GENERIC** — pattern-based, never per-site key allowlists.
- **Templating + diff stay ARIA/kind-grounded** — no DOM tag/class/selector heuristics.
- **Pure-core stays pure**; no `native_command_schema.json` change.
- **No behavior regression**: existing `action` click/type effect + verification still hold
  (`smoke:browser:abml-action-gap` gating assertions stay green).

## 4. Fixes (slices, ROI order)

### S1 — Doc honesty + usage guidance (F0, G4-docs)  ·  cheap, zero-risk, first
Record the measured per-feature verdict in SKILL.md + `docs/abml-tool-coverage-map.md`:
`action.type`/`causal` preferred; `action.click` only when synthetic clicks are unreliable;
**`action.scroll` not recommended until fixed**; `templates` only on big lists/tables; `diff`/`treeDiff`
only on large pages tolerating churn. Add guidance: **`pi-ref://` and observe baselines are
short-lived — re-observe to refresh; don't reuse a stale baseline** (the eval's `HANDLE_NOT_FOUND` /
`baseline ... expired`). Tag "first real-agent eval, 2026-06-05, n=1". No code.

### S2 — action click/type: cheap strong verify + opt-in entity-diff (F1, G1, G2-click)  ·  highest ROI
**Root cause:** click/type run a full `executeBrowserAbmlRead({plane:"structure"})` **before *and*
after** (for the entity `diff`) — two whole-page scan+AX+merge passes (the 14–65 s). And the
*lightweight* default verify only checks `mutationTick`/value/url/focus (the eval's "verify too weak").
**Fix (one move, three wins):** replace the expensive before/after entity-diff in the **default** path
with a **cheap target-semantic-state probe** — read the target's own `aria-expanded/checked/selected/
pressed/current` + `value`/`text`/`url`/`focus` before/after and report the delta in
`verification.observed.changed` (e.g. `expanded:false→true`). This is **faster** (no full scan) AND
**more accurate** (the signal the eval actually wanted). The full `diffEntities` over `readStructure`
becomes **opt-in** (`action:{click:…, diff:true}` / `type:{…, diff:true}`, additive bool, default
false). Click/type also honor `timeoutMs` as a hard bound.
**Acceptance:** action-gap smoke green; latency assertion (default click/type ≪ current, and ≪ with
`diff:true`); `verification.observed.changed` carries the target state delta on the fast path.

### S3 — action.scroll: bound + denoise + fix summary (F2, G2-scroll)
**Root cause:** `executeBrowserAbmlScroll` calls `readStructure` (full scan) **every iteration**
(1 step → 7 iterations) and the loop is **not bounded by `timeoutMs`** (73–79 s under a 20 s budget);
the summary is internally inconsistent (`stepResult.beforeTop=afterTop`, `changed=false`, while overall
`before/after.scrollTop` differ).
**Fix:** default scroll = scroll + cheap `scrollProbe` verify, **no per-iteration `readStructure`**
(virtualized-list collection → opt-in `scroll:{…, collect:true}`); bound the loop by elapsed vs
`timeoutMs`; report one coherent overall before/after + an explicit "already at edge" flag.
**Fallback if non-trivial:** temporarily drop `scroll` from the public `action` param (keep the
internal verb) — better than shipping a 1/5 net-negative.
**Acceptance:** scroll smoke step completes within `timeoutMs`, scrollY advances, summary self-consistent.

### S4 — causal URL PII redaction (F3)  ·  privacy
**Root cause / precise:** redaction is **key-based**, so a search query *value*
(`query=playwright browser test 2`) — no sensitive key — is emitted raw (a user email/order#/phone in
`q=`/`query=` would leak).
**Fix:** extend `src/utils/redaction.ts` to scrub query-param **values matching PII patterns** (email,
phone, long digit runs) in **any** param — generic, pattern-based, **no per-site key allowlist**.
Shared util (causal + network + evidence) → must NOT over-redact ordinary API params; tight pattern +
a contract test on both "scrubs the email in `q=`" and "leaves `id=123` / short values alone".
**Acceptance:** redaction contract covers the new patterns; existing redaction tests unregressed.

### S5 — templates denoise (F4)
**Root cause:** `buildTemplateSummary` groups **all** kinds, so text-leaf entities surface as templates
(`row/InlineTextBox`, `row/StaticText`) — high count, low meaning.
**Fix:** exclude pure-text-leaf entities (kind `text` / role `InlineTextBox`/`StaticText`) and/or rank
`control`/`link`/`element` templates ahead of text and cap — surfaced templates are the actionable/
structural ones. Pure-core, ARIA/kind-grounded (no DOM guessing).
**Acceptance:** `check:abml-templating` extended (text-leaf excluded/deprioritized); templating smoke
still folds the link list.

### S7 — diff/treeDiff salience (G5)  ·  bounded, generic
**Root cause:** the diff enumerates `appeared`/`disappeared` churn (27/76 on a search-suggestion popup)
while the one meaningful change (`value:A→B`, the focused control) is buried; `treeDiff` helps but still
leads with order-change noise.
**Fix (bounded, NOT a perception redesign):** rank the diff output by signal — **high-signal first**
(state/value/name changes on `control`/`element` entities, and the focused entity's change), then
**summarize churn as counts** (`appeared:N`, `disappeared:M`) instead of enumerating it. Generic by
entity-kind + change-type, **no per-site/per-type branches**. S1's doc-downgrade stays as the safety
net if this proves insufficient.
**Acceptance:** `check:abml-diff` extended (high-signal changes ordered ahead of churn; churn
summarized); on a synthetic suggestion-popup fixture the value-change leads.

### S6 — artifact jsonPath on observe results (F5)  ·  investigate-first
The eval hit "live result shows it, but `browser_artifact jsonPath` says notFound" on observe results
(fell back to `text`/`search`). **Investigate** the saved observe-artifact shape vs the reader's
jsonPath; fix the mismatch or document the correct read path.
**Acceptance:** a reader test: jsonPath into a saved observe artifact resolves a known field.

### S8 — execute robustness (G3, G4-error)  ·  investigate-first, minor
- **G3:** a raw async `browser_execute` script (`await 800ms`) returned `BRIDGE_TIMEOUT` though the
  side effect landed. Investigate execute's promise/timeout handling; fix or document (size `timeoutMs`
  for async scripts; don't report failure when the effect succeeded).
- **G4:** `resolveBaselineEntities` throws `INVALID_RULE: baseline ... expired` with no recovery hint —
  add an actionable `recovery` ("re-capture the baseline via browser_observe(mode:scan)").
**Acceptance:** baseline-expired error carries a recovery hint; async-script finding resolved or documented.

## 5. Acceptance (whole line)

- Per slice: targeted unit/contract green + `smoke:browser:abml-action-gap` green + full `npm run check`.
- Perf slices (S2, S3): measure action latency before/after; assert no full scan on the default path;
  scroll bounded by `timeoutMs`.
- **Meta-acceptance:** re-run the skeptical-eval prompt with a fresh agent. Negatives should flip —
  `type`/`causal` stay strong; `click`/`scroll` materially faster + click verify carries target state;
  `causal` redacts a PII query value; `templates` surface fewer text-leaf rows; `diff` leads with the
  value change. n=1 caveat noted.

## 6. Out of scope (with reasons — each is a deliberate decision, not an omission)

- **templates under-detection** of non-AX-container card groups (ReClaude cards → `templateCount=0`)
  and **over-generalization** (merging unrelated unnamed groups): closing either needs DOM-structural
  heuristics — **rejected** (overfitting). Documented as the ARIA-grounded boundary.
- **ref stability** beyond M2b's named-container gate (stale `pi-ref://control/...` →
  `HANDLE_NOT_FOUND` on a menu button): re-observe to refresh (guidance in S1); broadening anchors is a
  separate line.
- vision/OCR, iframe AX aggregation, incognito — unchanged backlog.

## 7. Coverage matrix — every report finding → disposition

| Report finding | Disposition |
|---|---|
| action.click slow | **S2** (drop default full scans) |
| action.type slow | **S2** (same) |
| action.click default verify too weak (期待#2) | **S2** (cheap target-state probe) |
| action.click / action.scroll exceed `timeoutMs` (期待#1) | **S2** (click) + **S3** (scroll) |
| action.scroll slow + per-step scan | **S3** (collection opt-in) |
| action.scroll summary self-contradiction | **S3** (coherent summary) |
| causal URL not redacting query value (期待#4) | **S4** |
| templates text-leaf noise / too-low-level naming (期待#5) | **S5** |
| diff/treeDiff churn-noise / semantic filtering (期待#3) | **S7** (bounded salience) + S1 doc-downgrade |
| baseline snapshot TTL expiry → INVALID_RULE | **S1** (guidance) + **S8** (recovery hint) |
| raw async `browser_execute` → BRIDGE_TIMEOUT | **S8** (investigate) |
| artifact jsonPath on observe → notFound (期待#6) | **S6** |
| docs overstate effect | **S1** |
| stale `pi-ref` → HANDLE_NOT_FOUND | **out-of-scope** (ref-stability line) + S1 guidance |
| templates under-detect non-AX card groups | **out-of-scope** (needs DOM guessing) |
| templates over-generalization | **out-of-scope** (AX-grouping limit) + partial relief via S5 |
| tabId went unstable mid-run | not a defect — tabId is documented as unstable across nav |
| HN/Wikipedia unreachable | environment, not our tool |
