# Debt clearance — remaining debts & dangling items execution contract

> Status: **DESIGN — not yet activated.** Activation requires a `CURRENT.md` entry.
> Product of the 2026-06-10 whole-project debt/dangling/lag audit (source-verified: src/ has
> zero TODO/FIXME, tests have zero skips, all doc references resolve, the dead MCP `sections`
> field was already removed). This contract disposes of EVERY remaining item — each one is
> either a work item here, a formal close-out, or a kept-deferral with a machine or evidence
> trigger. After this plan lands, the project's debt ledger contains only trigger-gated
> entries; nothing is parked without a reopen condition.

## 1. Audit result — full disposition table

| Item | Evidence/state | Disposition |
| --- | --- | --- |
| B1 real-site row extraction falls back to hand-written JS | **10 blind runs, survives the skill** — strongest item in the ledger; list_hints groups/samples (not DOM-ordered), B6 added href but no row projection | **WORK ITEM D1** (bounded perception version) |
| ROADMAP lists rejected decisions as "routes" | sources/debugger/intercept/storage/canvas + debugger lifecycle + incognito + orchestration regression are **adjudicated rejections**, not future work | **WORK ITEM D2** (honesty restructure) |
| Dictionary/wordlist hardcoding (~44 sites / 5 classes) | real parked debt, own plan; W1 pipeline (`readWordlist`) already in place | **WORK ITEM D3** (W1 only; W2/W3 stay parked) |
| Recovery template scatter (19 grandfathered files) | K4 burn-down remainder; mechanism centralized, content scattered | **WORK ITEM D4** (bounded ratchet) |
| kernel-opt `bench:abml-kernel` | recommended-only; byte-identity evidence (token-economy 0.0607 invariant) already covers regression | **WRITE-OFF D5a** |
| summaries truncation grandfather (31 files) | other face of the V6 shadow debt — burns when the fact path drives output | KEPT — trigger = V6 promotion (machine-locked) |
| salience V6 shadow + R3 arbitration | shadow guard machine-enforced; promotion checklist 2 paid / 1 gated | KEPT — trigger = promotion edits the guard |
| capture esbuild migration | entry-set gate + escape ledger 0/2 | KEPT — machine/ledger triggers |
| ABML public verb surface | W1 (WAI table) actively REFUTES need: agents report no acting friction | KEPT closed-leaning — trigger = transcript showing an agent BLOCKED by the missing verb |
| web-reversing phase 2 | phase-1 primitives unrefuted by any eval | KEPT — trigger = eval task phase 1 cannot close |
| renderer `line` granularity beyond entity primitive | zero positive evidence, highest comprehension risk | KEPT — trigger = per-plane blind evidence |
| G5 artifact regex on one-line payloads; G1/G6 CLI papercuts | runs=1 each | KEPT in ledger per triage rules (needs recurrence) — NOT plan items |
| B9a media candidate list; B11 sidebar-dominant primary_actions | n=2 boundary-adjacent / n=1 | KEPT in ledger; D1 infrastructure makes a future bounded B9a cheap |

## 2. Work items

### D1 — Bounded visible-row projection (settles B1, the 10-run debt)

**What:** scan collects a DOM-ordered, capped table of viewport-visible text/link rows:
`{ text, href?, sameOrigin?, rect, containerHint, selector }` — the mechanical facts an agent
needs to read "what rows are on screen" without writing extraction JS.

**Hard boundary (the original deferral's terms, verbatim contract):** DOM order preserved;
text/href/geometry/visibility/container-section hints ONLY. **No** site-specific selectors, no
source/time/uploader/author inference, no ranking semantics, no headline/card classification.
Perception, not strategy — same constitution test the B6 href fix passed.

**Where it lives (no new surface):** inside the EXISTING scan entry (extends the same
collection pass that already builds `list_hints` — no 6th capture entry, the D-gate stays at 5);
exposed as `data.rows` in the saved artifact + a compact capped summary table (list_hints
pattern: columns + rows + count) + an artifact hint. No new `browser_*` tool, no new mode, no
new params. Capped (≤40 rows, text ≤120 chars) and budget-tested.

**Gates:** capture goldens (C-1 harness fixture with a wide list page asserting DOM-order),
`check:token-economy` (±10%), `check:summaries` golden, `bench:distill` no-regression,
`smoke:browser:scan-summary`. **Settlement proof:** one post-landing sentinel/blind run on a
real list-heavy site must show row extraction WITHOUT custom execute JS; the B1 ledger entry
is then moved to Resolved with that run id. If the blind run still falls back to JS, the
feature is re-examined — not patched site-specifically (`eval-fixes-true-defect-no-overfit`).

### D2 — ROADMAP honesty restructure (dangling-decision cleanup)

Rewrite `ROADMAP.md` into two sections: **(a) Future routes** — items with a real reopen
trigger (web-reversing phase 2, ABML public surface with its *currently-refuting* evidence
noted, dictionary W2/W3, new eval specs); **(b) Closed decisions** — adjudicated rejections
stated as such with their reopen evidence bar (browser_sources/debugger/intercept/storage/
canvas; debugger lifecycle; incognito; orchestration regression). The standing RULES that are
not routes (#3 hook-target growth rule, quality re-run advice) move under a "standing rules"
note. Stays ≤80 lines (`check:doc-structure`).

### D3 — Dictionary W1: security payload/signature externalization (zero behavior change)

Externalize the hardcoded security payload/signature lists (the W1 class from
`docs/dictionary-and-wordlist-governance-plan.md`) into committed default wordlist files
consumed via the existing `readWordlist` pipeline. **Byte-identity rule:** the committed files
are generated FROM the current constants; with no user override, tool outputs are
byte-identical (contract-locked). User override arrives free through the existing wordlist
params. Scope: W1 only — W2 (ARIA codegen; pure-core runtime constraint) and W3 (SecLists
calibration; external dependency) stay parked in the governance plan with their reasons.

**Gates:** new contract test (default = embedded constants byte-identical), `check:web-security`,
`check:summaries`, full check.

### D4 — Recovery grandfather ratchet (bounded K4 burn-down slice)

For the 19 grandfathered template files: migrate ONLY the sites whose remediation text
duplicates vocabulary already present in `distill-core/recovery.ts` (pure dedupe, output
byte-identical), and annotate each REMAINING grandfathered file with a one-line comment naming
why its text is domain-specific. The grandfather list shrinks; no new entries (already
enforced); full burn-down stays tied to tool-edit opportunism. Honest cap: this is a ratchet
slice, not a completion — completion is not worth forcing while the text is correct and locked.

**Gates:** `check:recovery-boundary` (list shrinks, never grows), `check:errors`, affected
tool summaries goldens.

### D5 — Formal write-offs (close the dangling bookkeeping)

- **D5a:** `docs/abml-kernel-optimization-plan.md` §6 bench note gets a close-out line:
  superseded by byte-identity evidence + `bench:distill`; no timing harness will be added.
- **D5b:** `evals/browser-workflows/blind-findings.md` B1 entry updated when D1 lands
  (Resolved + run id); B9a note points at D1 infrastructure for its future bounded form.
- **D5c:** memory + `TODO.md` pointer sync after each item lands.

## 3. Execution order & rationale

1. **D2 + D5a** — zero-risk documentation honesty; instantly shrinks the dangling list.
2. **D4** — mechanical, byte-identical, independent.
3. **D3** — refactor with a byte-identity lock; independent of everything else.
4. **D1** — the only item with design risk; last, with its own gate set + sentinel settlement
   proof. (Touches scan template + summaries — coordinate with nothing: no other track is
   active in those files.)

Each lands separately with `npm run check` green (+ `npm run lint` — lesson: check does not
run eslint) before the next starts.

## 4. End state ("clean ledger" definition)

After this plan: every debt in the project is one of —
(a) **machine-trigger-gated** (capture esbuild, V6 promotion + its checklist, summaries
grandfather), (b) **evidence-trigger-gated with the trigger written down** (ABML surface,
phase 2, line granularity, ledger n=1 items), or (c) **gone** (B1 settled, ROADMAP honest,
W1 externalized, recovery list ratcheted, bench item written off). Nothing parked without a
reopen condition; no dangling references; no decision disguised as a future route.
