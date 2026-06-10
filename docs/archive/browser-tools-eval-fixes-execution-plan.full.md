# Browser-tools skeptical-eval fixes — execution contract

> Status: **CLOSED (2026-06-05).** Driven by the first real-agent skeptical eval (2026-06-05,
> `browser-tools-skeptical-eval`, 5 real sites + two blind rounds). **Outcome split in two:** the
> **read/observe-side fixes landed and are kept** (S4 generic query redaction, S5 template text-leaf
> denoise, S6 observe-artifact envelope mirror, S7 `diff.summary` salience, baseline-expiry recovery,
> and the internal runtime.ts actionability/target-probe improvements as substrate). The
> **execution-side action arm (B2) was REVERTED** — the eval showed the public `action.click` didn't
> earn its keep (silent failures / timeouts / selector misses in the wild, agents reverted to JS;
> "verified" ≠ intent achieved; CDP-escalation double-action hazard). Per user decision (Option A),
> ABML is observation-only; execution = `browser_execute {script}` (JS) with `browser_command` CDP as
> the trusted-event escape. The `action` param, `smoke:abml-action-gap` smoke + fixture, and its
> package.json script were removed. The per-feature scores below are the eval's *raw* signal and are
> kept for the record; the action-row guidance is superseded by the revert (see `CURRENT.md` and
> `docs/abml-action-path-gap-plan.md`).

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
- **Redaction stays GENERIC** — PII-pattern + generic query-param class based, never per-site key allowlists/denylists.
- **Templating + diff stay ARIA/kind-grounded** — no DOM tag/class/selector heuristics.
- **Pure-core stays pure**; no `native_command_schema.json` change.
- **No behavior regression**: existing `action` click/type effect + verification still hold
  (`smoke:browser:abml-action-gap` gating assertions stay green).

## 4. Fixes (slices, execution order)

Feasibility-review refinements before execution:
- `timeoutMs` fixes require a **single shared deadline** (`remainingMs()` for every probe/CDP/read subcall), not reusing the full timeout per subcall.
- `causal` redaction must cover the eval's ordinary search-query leak, not only PII-looking values.
- `diff`/`treeDiff` salience is **additive**: preserve existing raw `EntityDiff` arrays/schema and add ranked summaries; do not break consumers.
- Observe artifact jsonPath should prefer saving/reading the same envelope shape agents saw live; documentation-only is acceptable only if a compatibility reason blocks that.

### S1 — Doc honesty + usage guidance (F0, G4-docs)  ·  cheap, zero-risk, first
Record the measured per-feature verdict in SKILL.md + `docs/abml-tool-coverage-map.md`:
`action.type`/`causal` preferred; `action.click` only when synthetic clicks are unreliable;
`action.scroll` recorded as the original 1/5 weak spot and, after S3, recommended only as a bounded
probe-default action with `collect:true` reserved for virtualized-list entity collection; `templates`
only on big lists/tables; `diff`/`treeDiff`
read `summary` salience first and raw arrays only when churn is acceptable. Add guidance: **`pi-ref://` and observe baselines are
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
false). Click/type honor `timeoutMs` through a shared action deadline: every probe, DOM action, CDP
fallback, verification, and optional diff uses `remainingMs()`; when the deadline is exhausted the
verb returns a bounded failure/recovery instead of starting another full-timeout subcall.
**Acceptance:** action-gap smoke green; latency assertion (default click/type ≪ current, and ≪ with
`diff:true`); hard-timeout test proves elapsed wall time stays within a small grace window;
`verification.observed.changed` carries the target state delta on the fast path.

### S3 — action.scroll: bound + denoise + fix summary (F2, G2-scroll)
**Root cause:** `executeBrowserAbmlScroll` calls `readStructure` (full scan) **every iteration**
(1 step → 7 iterations) and the loop is **not bounded by `timeoutMs`** (73–79 s under a 20 s budget);
the summary is internally inconsistent (`stepResult.beforeTop=afterTop`, `changed=false`, while overall
`before/after.scrollTop` differ).
**Fix:** default scroll = scroll + cheap `scrollProbe` verify, **no per-iteration `readStructure`**.
Virtualized-list collection becomes opt-in (`scroll:{…, collect:true}`), and only that path may read
structure after bounded scroll steps. The loop uses the same shared-deadline discipline as S2: stop
when `remainingMs()` cannot cover another step/probe, return a bounded partial result, and never spend
the full timeout per iteration. Report one coherent overall before/after + an explicit `alreadyAtEdge`
flag; `stepResult` must reflect the same before/after pair or be omitted from the default summary.
**Fallback if non-trivial:** temporarily drop `scroll` from the public `action` param (keep the
internal verb) — better than shipping a 1/5 net-negative.
**Acceptance:** scroll smoke step completes within `timeoutMs` plus grace, scrollY advances or
`alreadyAtEdge=true`, summary self-consistent, and default path performs zero structure reads.

### S4 — causal URL query-value redaction (F3)  ·  privacy
**Root cause / precise:** redaction is **key-based**, so a search query *value*
(`query=playwright browser test 2`) — no sensitive key — is emitted raw (a user email/order#/phone in
`q=`/`query=` would leak).
**Fix:** extend `src/utils/redaction.ts` with two generic URL query rules:
1. scrub **PII-looking values** (email, phone, long digit runs) in any query parameter;
2. scrub values for generic human-query/text parameters (`q`, `query`, `qry`, `search`, `keyword`,
   `term`, `text`, `prompt`, `message`) even when the value is not PII.
Do not use per-site key allowlists/denylists. Keep ordinary low-risk machine identifiers visible
(e.g. `id=123`, `page=2`, `lang=en`, short enum/status params). Shared util applies to causal,
network summaries, and evidence model-facing output.
**Acceptance:** redaction contract covers `q=user@example.test`, `query=playwright browser test 2`,
`qry=13800138000`, and non-overredaction (`id=123`, `page=2`, `lang=en` remain visible); existing
redaction tests unregressed.

### S5 — templates denoise (F4)
**Root cause:** `buildTemplateSummary` groups **all** kinds, so text-leaf entities surface as templates
(`row/InlineTextBox`, `row/StaticText`) — high count, low meaning.
**Fix:** rank `control`/`link`/structural `element` templates ahead of pure text leaves, and exclude
or cap pure-text-leaf templates only when a same-container actionable/structural template exists.
Do **not** blindly delete all `InlineTextBox`/`StaticText` groups, because some accessible tables expose
text/cell structure as the only repeated signal. Pure-core, ARIA/kind-grounded (no DOM guessing).
**Acceptance:** `check:abml-templating` extended (text-leaf deprioritized/suppressed when redundant;
text-only accessible table fixture still yields a useful template); templating smoke still folds the
link list.

### S7 — diff/treeDiff salience (G5)  ·  bounded, generic
**Root cause:** the diff enumerates `appeared`/`disappeared` churn (27/76 on a search-suggestion popup)
while the one meaningful change (`value:A→B`, the focused control) is buried; `treeDiff` helps but still
leads with order-change noise.
**Fix (bounded, NOT a perception redesign):** preserve the existing raw `EntityDiff` contract
(`appeared[]`, `disappeared[]`, `changed[]`) and add an **additive salience view** for summaries/
envelopes: high-signal changes first (value/name/state changes on `control`/`element`, focused entity
changes), then churn summarized as counts/sample refs (`appeared:N`, `disappeared:M`) without hiding
the raw arrays in artifacts/full output. Generic by entity-kind + change-type, **no per-site/per-type
branches**. S1's doc-downgrade stays as the safety net if this proves insufficient.
**Acceptance:** `check:abml-diff` extended (raw schema unchanged; high-signal summary ordered ahead of
churn; churn summarized in the summary view); on a synthetic suggestion-popup fixture the value-change
leads while raw `appeared[]`/`disappeared[]` remain available.

### S6 — artifact jsonPath on observe results (F5)  ·  investigate-first
The eval hit "live result shows it, but `browser_artifact jsonPath` says notFound" on observe results
(fell back to `text`/`search`). Source review indicates the saved scan artifact currently stores the
raw bridge result plus `abml`, while the live agent-facing envelope lifts `diff`/`treeDiff`/
`snapshotProjection`/`templates` to summary/top-level positions. **Investigate** and prefer fixing by
saving an envelope-compatible artifact shape (or adding an envelope mirror) so jsonPath reads match
what agents saw. If compatibility blocks that, document exact read paths (`abml.diff`,
`abml.snapshotProjection`, etc.) and expose them in nextActions.
**Acceptance:** a reader test: jsonPath into a saved observe artifact resolves a known live-envelope
field (`diff` or documented mirror path) and no longer requires text/search fallback for normal reads.

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
  click/type/scroll bounded by `timeoutMs` through a shared deadline.
- **Meta-acceptance:** re-run the skeptical-eval prompt with a fresh agent. Negatives should flip —
  `type`/`causal` stay strong; `click`/`scroll` materially faster + click verify carries target state;
  `causal` redacts both PII query values and ordinary human search-query values; `templates` surface
  fewer redundant text-leaf rows without losing text-only table structure; `diff` summary leads with
  the value change while raw diff arrays remain available. n=1 caveat noted.

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
| causal URL not redacting query value, including ordinary search text (期待#4) | **S4** |
| templates text-leaf noise / too-low-level naming (期待#5) | **S5** |
| diff/treeDiff churn-noise / semantic filtering (期待#3) | **S7** (additive salience summary; raw schema preserved) + S1 doc-downgrade |
| baseline snapshot TTL expiry → INVALID_RULE | **S1** (guidance) + **S8** (recovery hint) |
| raw async `browser_execute` → BRIDGE_TIMEOUT | **S8** (investigate) |
| artifact jsonPath on observe → notFound (期待#6) | **S6** |
| docs overstate effect | **S1** |
| stale `pi-ref` → HANDLE_NOT_FOUND | **out-of-scope** (ref-stability line) + S1 guidance |
| templates under-detect non-AX card groups | **out-of-scope** (needs DOM guessing) |
| templates over-generalization | **out-of-scope** (AX-grouping limit) + partial relief via S5 |
| tabId went unstable mid-run | not a defect — tabId is documented as unstable across nav |
| HN/Wikipedia unreachable | environment, not our tool |
