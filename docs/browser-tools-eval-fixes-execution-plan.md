# Browser-tools skeptical-eval fixes — execution contract

> Status: **PLANNED (not started).** Driven by the first real-agent skeptical eval
> (2026-06-05, `browser-tools-skeptical-eval`). Turns its measured efficacy signal into fixes for
> the recently-shipped action path (B2), causal plane (R3.x), and templating (M1). New line → own
> contract; activate in `CURRENT.md` before executing slices. Each slice lands behind `npm run check`
> + the action-gap smoke, and the eval is **re-run as meta-acceptance**.

## 1. Goal

The eval (n=1 agent, 5 real sites, read-only) is our first real-agent efficacy evidence, and it is
**mixed** — correcting any impression that the ladder "uniformly strengthens the surface":

| Capability | Eval score | Verdict |
|---|---|---|
| `causal` | 4/5 | genuinely useful (located the action's APIs + `triggered` on a real site) |
| `action.type` | 4/5 | genuinely useful (CDP/verified; saved the manual focus+setter+wait+readback) |
| `templates` | 3/5 | situational — big tables yes; noisy (text-leaf templates) + under-detects non-AX groups |
| `action.click` | 3/5 | marginal — mostly packages verification; **slow** |
| `diff`/`treeDiff` | 2/5 | churn-noisy — core semantic change drowned by suggestion-popup churn |
| `action.scroll` | 1/5 | net negative — **very slow + buggy** |

This contract fixes the concrete defects and corrects the docs' "effect" wording to match measured
reality, **without widening the surface or overfitting**. It does not invent new capability.

## 2. Evidence basis

- Report: `browser-tools-skeptical-eval-2026-06-05` (relayed; not in repo). Scores above; raw
  evidence (latencies, transports, counts) in §"证据附录" of that report.
- Root causes below are confirmed against source (`executeBrowserAbmlClick`/`Type`/`Scroll` in
  `src/abml/verbs/runtime.ts`; `redactUrl`/`redactSensitiveText` in `src/abml-core/causal.ts` +
  `src/utils/redaction.ts`; `buildTemplateSummary` in `src/abml-core/templating.ts`).

## 3. Constraints (unchanged project invariants)

- **No new public tool**; `action`/observe changes are additive/optional with a safe default
  (absent ⇒ today's behavior).
- **Redaction stays GENERIC** — pattern-based, never per-site key allowlists (overfitting smell).
- **Templating stays ARIA-grounded** — do NOT add DOM tag/class/selector heuristics to fix
  under-detection (that is the rejected widening; the gap is documented, not overfit).
- **Pure-core stays pure**; no `native_command_schema.json` change.
- **No behavior regression**: existing `action` click/type effect + verification must still hold —
  the `smoke:browser:abml-action-gap` gating assertions stay green.

## 4. Fixes (slices, ROI order)

### Slice 1 — Doc honesty (F0)  ·  cheap, zero-risk, first
Record the measured per-feature verdict so agents get accurate guidance instead of "everything is
great": SKILL.md + `docs/abml-tool-coverage-map.md` — `action.type`/`causal` preferred; `action.click`
only when synthetic clicks are unreliable; **`action.scroll` not recommended until fixed**; `templates`
only on big lists/tables; `diff`/`treeDiff` only on large pages tolerating churn. Tag the source
("first real-agent eval, 2026-06-05, n=1"). No code.

### Slice 2 — action click/type performance (F1)  ·  highest ROI
**Root cause:** `executeBrowserAbmlClick`/`Type` run a full `executeBrowserAbmlRead({plane:"structure"})`
BEFORE *and* AFTER the action (to compute the entity `diff`) — two whole-page scan+AX+merge passes per
action. On big pages (GitHub 2676 entities) this is the 14–65 s the eval measured.
**Fix:** make the before/after **entity diff opt-in**. Default click/type = actionability +
synthetic → CDP fallback + the **lightweight `clickVerificationProbe`** (a small JS read, already
present) → no full scan. The structured entity `diff` is produced only when the caller asks
(`action:{click:…, diff:true}` / `type:{…, diff:true}` — additive optional bool, default false).
**Acceptance:** action-gap smoke green; a latency assertion (click/type without `diff` ≪ with `diff`);
`verification.status` still set on the fast path.

### Slice 3 — action.scroll: bound + denoise + fix summary (F2)
**Root cause:** `executeBrowserAbmlScroll` calls `executeBrowserAbmlRead` (full scan) **every
iteration** (1 step ran 7 iterations) and the loop is not bounded by `timeoutMs` (ran 73–79 s under a
20 s budget); `verifyScroll`/`stepResult` reporting is internally inconsistent (`stepResult.beforeTop
=afterTop`, `changed=false`, while overall `before/after.scrollTop` differ).
**Fix:** default scroll = scroll + cheap `scrollProbe` verify, **no per-iteration `readStructure`**
(the virtualized-list entity collection becomes opt-in `scroll:{…, collect:true}`); bound the loop by
elapsed vs `timeoutMs`; report a single coherent before/after + a clear "already at edge" signal.
**Fallback if the fix proves non-trivial:** temporarily drop `scroll` from the public `action` param
(keep the internal verb) until fixed — better than shipping a 1/5 net-negative.
**Acceptance:** a scroll smoke step: `action:{scroll:{to:"bottom"}}` completes within `timeoutMs`,
scrollY advances, summary is self-consistent.

### Slice 4 — causal URL PII redaction (F3)  ·  privacy
**Root cause / precise:** redaction is **key-based** (`token=`/`secret=`/…). A search query value
(`query=playwright browser test 2`) carries no sensitive *key*, so it is emitted raw — working as
designed, but a real gap (a user's email/order#/phone in a `q=`/`query=` would leak).
**Fix:** extend `src/utils/redaction.ts` to also scrub query-param **values matching PII patterns**
(email, phone, long digit runs) in any param — generic, pattern-based, **no per-site key allowlist**.
Reused by causal URL shaping + network/evidence (shared util) — so it must NOT over-redact ordinary
API params; gate behind a tight pattern + a contract test on both "scrubs the email in `q=`" and
"leaves an ordinary `id=123` / short value alone".
**Acceptance:** `check:abml-causal` (or a redaction contract) covers the new patterns; no regression
in existing redaction tests.

### Slice 5 — templates denoise (F4)
**Root cause:** `buildTemplateSummary` groups **all** kinds, so text-leaf entities surface as
templates (`row/InlineTextBox`, `row/StaticText`) — high count, low meaning; the eval's top templates
were noise.
**Fix:** exclude pure-text-leaf entities (kind `text` / role `InlineTextBox`/`StaticText`) from
templating, and/or rank `control`/`link`/`element` templates ahead of text and cap — so the surfaced
templates are the actionable/structural ones. Pure-core, ARIA-grounded (no DOM guessing).
**Acceptance:** `check:abml-templating` extended (text-leaf groups excluded / deprioritized); the
templating smoke still folds the link list.

### Slice 6 — artifact jsonPath on observe results (F5)  ·  investigate-first
The eval repeatedly hit "live result shows it, but `browser_artifact jsonPath` says notFound" on
observe results, falling back to `text`/`search`. **Investigate** how the observe envelope/artifact is
shaped vs the jsonPath the reader expects; fix the mismatch or document the correct read path.
Separate from ABML; lower priority. **Acceptance:** a reader test: jsonPath into a saved observe
artifact resolves a known field.

## 5. Acceptance (whole line)

- Per slice: targeted unit/contract green + `smoke:browser:abml-action-gap` green + full `npm run check`.
- Perf slices (2,3): measure action latency before/after; assert the fast path no longer does the
  full scan(s); scroll bounded by `timeoutMs`.
- **Meta-acceptance:** re-run the skeptical-eval prompt with a fresh agent. The negative findings
  should flip — `type`/`causal` stay strong; `click`/`scroll` materially faster; `causal` redacts a
  PII query value; `templates` surface fewer text-leaf rows. n=1 caveat noted each time.

## 6. Out of scope

- **templates under-detection** of non-AX-container card groups (e.g. ReClaude cards): closing it
  needs DOM-structural heuristics — **rejected** (overfitting). Documented as the ARIA-grounded
  boundary; not a bug to "fix".
- **ref stability** beyond M2b's named-container gate (the stale `pi-ref://control/...` →
  `HANDLE_NOT_FOUND` the eval hit on a menu button): re-observe to refresh refs; broadening anchors is
  a separate line, not this one.
- **`diff`/`treeDiff` semantic prioritization** (surface "value A→B" ahead of popup churn): real, but
  a perception-layer redesign, not a defect fix — track as a follow-up if the docs-honesty downgrade
  (Slice 1) proves insufficient.
- vision/OCR, iframe AX aggregation, incognito — unchanged backlog.
