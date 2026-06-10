# Debt clearance — remaining debts & dangling items execution contract

> Status: **COMPLETE — activated and executed 2026-06-10.** Activation and execution were
> recorded in `CURRENT.md`.
> Product of the 2026-06-10 whole-project debt/dangling/lag audit (source-verified: src/ has
> zero TODO/FIXME, tests have zero skips, all doc references resolve, the dead MCP `sections`
> field was already removed). This contract disposes of EVERY remaining item — each one is
> either a completed work item here, a formal close-out, or a kept-deferral with a machine or
> evidence trigger. After this plan landed, the project's debt ledger contains only
> trigger-gated entries; nothing is parked without a reopen condition.

## 1. Audit result — full disposition table

| Item | Evidence/state | Disposition |
| --- | --- | --- |
| B1 real-site row extraction falls back to hand-written JS | **Resolved** — scan now emits bounded DOM-ordered `data.rows`; settlement proof captured on `https://linux.do/latest` via `browser_observe mode=scan` + `browser_artifact jsonPath=data.rows`, no custom JS | **DONE — D1** |
| ROADMAP lists rejected decisions as "routes" | `ROADMAP.md` now separates **已关闭决策** / **当前非激活路线** / **近期质量建议**; closed items carry explicit reopen bars | **DONE — D2** |
| Dictionary/wordlist hardcoding (~44 sites / 5 classes) | W1 externalized into committed default wordlists consumed through `readWordlist()`; default behavior contract-locked byte-identical | **DONE — D3** |
| Recovery template scatter (current grandfathered baseline) | grandfather list is annotated, shrink-only contract is live, and D4 removed stale exemptions already no longer matching the regex baseline | **DONE — D4** |
| kernel-opt `bench:abml-kernel` | written off in the kernel plan: byte-identity evidence + `bench:distill` supersede a timing harness | **DONE — D5a** |
| summaries truncation grandfather (31 files) | other face of the V6 shadow debt — burns when the fact path drives output | KEPT — trigger = V6 promotion (machine-locked) |
| salience V6 shadow + R3 arbitration | shadow guard machine-enforced; promotion checklist 2 paid / 1 gated | KEPT — trigger = promotion edits the guard |
| capture esbuild migration | entry-set gate + escape ledger 0/2 | KEPT — machine/ledger triggers |
| ABML public verb surface | W1 (WAI table) actively REFUTES need: agents report no acting friction | KEPT closed-leaning — trigger = transcript showing an agent BLOCKED by the missing verb |
| web-reversing phase 2 | phase-1 primitives unrefuted by any eval | KEPT — trigger = eval task phase 1 cannot close |
| renderer `line` granularity beyond entity primitive | zero positive evidence, highest comprehension risk | KEPT — trigger = per-plane blind evidence |
| G5 artifact regex on one-line payloads; G1/G6 CLI papercuts | runs=1 each | KEPT in ledger per triage rules (needs recurrence) — NOT plan items |
| B9a media candidate list; B11 sidebar-dominant primary_actions | n=2 boundary-adjacent / n=1 | KEPT in ledger; D1 infrastructure makes a future bounded B9a cheap |

## 2. Work items

### D1 — Bounded visible-row projection (settled B1, the 10-run debt) ✅

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

**Landed:** scan page-world capture now emits bounded `rows` alongside `list_hints`, artifact
hints surface `data.rows`, and the scan summary exposes a compact `rows` table when budget
permits. Static/runtime contracts now lock the seam so `rows` remain DOM-ordered, bounded, and
perception-only.

**Verified:** `check:scan`, `check:summaries`, `check:token-economy`, `bench:distill`,
`smoke:browser:scan-summary`, `npm run check`, `npm run lint`.

**Settlement proof:** real list-heavy sentinel run on `https://linux.do/latest` succeeded with
`browser_observe mode=scan` followed by `browser_artifact mode=json jsonPath=data.rows` on
artifact `C:\\Users\\HUAWEI\\.pi\\browser-artifacts\\observe-scan-1781098809184.json`;
14 viewport-visible rows were recovered in DOM order with `text/href/sameOrigin/rect/
containerHint/selector`, without any custom `browser_execute` JS.

### D2 — ROADMAP honesty restructure (dangling-decision cleanup) ✅

Rewrite `ROADMAP.md` into two sections: **(a) Future routes** — items with a real reopen
trigger (web-reversing phase 2, ABML public surface with its *currently-refuting* evidence
noted, dictionary W2/W3, new eval specs); **(b) Closed decisions** — adjudicated rejections
stated as such with their reopen evidence bar (the rejected tools are enumerated in ROADMAP
and `docs/jshookmcp-native-absorption.md`; this plan does not re-list them). The standing
RULES that are not routes move under a "standing rules" note. Stays ≤80 lines
(`check:doc-structure`).

### D3 — Dictionary W1: security payload/signature externalization (zero behavior change) ✅

Externalize the hardcoded security payload/signature lists (the W1 class from
`docs/dictionary-and-wordlist-governance-plan.md`) into committed default wordlist files
consumed via the existing `readWordlist` pipeline. **Byte-identity rule:** the committed files
are generated FROM the current constants; with no user override, tool outputs are
byte-identical (contract-locked). User override arrives free through the existing wordlist
params. Scope: W1 only — W2 (ARIA codegen; pure-core runtime constraint) and W3 (SecLists
calibration; external dependency) stay parked in the governance plan with their reasons.

**Gates:** new contract test (default = embedded constants byte-identical), `check:web-security`,
`check:summaries`, full check.

### D4 — Recovery grandfather ratchet (bounded K4 burn-down slice) ✅

The grandfather list is now explicitly annotated in `check-recovery-boundary.mjs`, including
file-by-file rationale for each remaining exception and a recorded D4 ratchet note for entries
already removed from the baseline. The shrink-only contract remains authoritative; no new
entries are allowed, and future burn-down stays opportunistic.

**Verified:** `check:recovery-boundary`, `check:errors`, `npm run check`, `npm run lint`.

### D5 — Formal write-offs (close the dangling bookkeeping) ✅

- **D5a:** done — `docs/abml-kernel-optimization-plan.md` §6 now records the optional bench
  harness as written off in favor of byte-identity evidence + `bench:distill`.
- **D5b:** done — `evals/browser-workflows/blind-findings.md` B1 is now resolved with the
  sentinel run id/path, and B9a explicitly points at D1 row-projection infrastructure as the
  future bounded substrate.
- **D5c:** done — `CURRENT.md` / `TODO.md` / `CHANGELOG.md` now reflect plan completion and the
  absence of an active execution line.

## 3. Execution order & rationale

1. **D2 + D5a** — zero-risk documentation honesty; instantly shrinks the dangling list.
2. **D4** — mechanical, byte-identical, independent.
3. **D3** — refactor with a byte-identity lock; independent of everything else.
4. **D1** — the only item with design risk; last, with its own gate set + sentinel settlement
   proof. (Touches scan template + summaries — coordinate with nothing: no other track is
   active in those files.)

Execution landed in the documented order, with `npm run check` and `npm run lint` green at
completion.

## 4. End state ("clean ledger" definition)

After this plan: every remaining debt in the project is one of —
(a) **machine-trigger-gated** (capture esbuild, summaries grandfather),
(b) **evidence-trigger-gated with the trigger written down** (ABML surface, web-reversing
phase 2, renderer `line` granularity, ledger n=1 items, W2/W3 governance), or
(c) **gone** (B1 settled, ROADMAP honest, W1 externalized, recovery list ratcheted, kernel
bench item written off). Nothing is parked without a reopen condition; no dangling references;
no adjudicated rejection is disguised as a future route.
