# Debt clearance — remaining debts & dangling items execution contract

> Status: **COMPLETE — activated and executed 2026-06-10.** Activation and execution were
> recorded in `CURRENT.md`.
> Product of the 2026-06-10 whole-project debt/dangling/lag audit (source-verified: src/ has
> zero TODO/FIXME, tests have zero skips, all doc references resolve, the dead MCP `sections`
> field was already removed). This contract disposes of EVERY remaining item — each one is
> either a completed work item here, an accepted contract boundary, or a formal close-out with a
> reopen-evidence bar. After the 2026-06-10 debt-zeroing follow-up, the project has no
> trigger-gated backlog ledger.

## 1. Audit result — full disposition table

| Item | Evidence/state | Disposition |
| --- | --- | --- |
| B1 real-site row extraction falls back to hand-written JS | **Resolved** — scan now emits bounded DOM-ordered `data.rows`; settlement proof captured on `https://linux.do/latest` via `browser_observe mode=scan` + `browser_artifact jsonPath=data.rows`, no custom JS | **DONE — D1** |
| ROADMAP lists rejected decisions as "routes" | `ROADMAP.md` now separates **已关闭决策** / **当前非激活路线** / **近期质量建议**; closed items carry explicit reopen bars | **DONE — D2** |
| Dictionary/wordlist hardcoding (~44 sites / 5 classes) | W1 externalized into committed default wordlists consumed through `readWordlist()`; default behavior contract-locked byte-identical | **DONE — D3** |
| Recovery template scatter (current grandfathered baseline) | grandfather list is annotated, shrink-only contract is live, and D4 removed stale exemptions already no longer matching the regex baseline | **DONE — D4** |
| kernel-opt `bench:abml-kernel` | written off in the kernel plan: byte-identity evidence + `bench:distill` supersede a timing harness | **DONE — D5a** |
| summaries truncation grandfather (31 files) | accepted boundary: per-tool distillers perform deterministic compacting while allocator remains shadow-only for envelope entry; `check-summary-boundary` locks the 31-file allowlist as shrink-only | **ACCEPTED BOUNDARY — no backlog** |
| salience V6 shadow + R3 arbitration | shadow guard machine-enforced; allocator still never feeds model-facing envelope | **CLOSED CONTRACT — guard-locked** |
| capture esbuild migration | capture-core generated bundle seam is stable; entry-set and escape-ledger checks protect the current model without an esbuild migration | **CLOSED DECISION** |
| ABML public verb surface | W1 (WAI table) actively refutes need; B2 public action arm was tried and reverted; north star remains perception-first | **CLOSED DECISION** |
| web-reversing phase 2 | phase-1 primitives unrefuted by eval; no current product value in speculative expansion | **CLOSED DECISION** |
| renderer `line` granularity beyond entity primitive | owner decision from renderer-default-flip: line granularity stays out; zero positive evidence and highest comprehension risk | **CLOSED DECISION** |
| G5 artifact regex on one-line payloads; G1/G6 CLI papercuts | runs=1 each | **CLOSED AS HYPOTHESES** — rolling eval notes only, not backlog |
| B9a media candidate list; B11 sidebar-dominant primary_actions | B9a now `data.media_candidates` + summary/artifact hints; B11 now edge utility controls are penalized for `primary_actions` while remaining in full `actionables` | **DONE — debt-zeroing follow-up** |

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

Rewrite `ROADMAP.md` so adjudicated rejections are not disguised as future routes. ABML public
verbs, web-reversing phase 2, renderer line granularity, and capture esbuild migration now live
only as closed decisions with reopen-evidence bars; dictionary W2/W3 and explicit hook target
expansion remain parked governance/RFC areas, not debt backlog.

### D3 — Dictionary W1: security payload/signature externalization (zero behavior change) ✅

Externalize the hardcoded security payload/signature lists (the W1 class from
`docs/archive/dictionary-and-wordlist-governance-plan.md`) into committed default wordlist files
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
  sentinel run id/path; the debt-zeroing follow-up then resolved B9a with bounded visible
  media candidates and B11 with edge-utility primary-action ranking.
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

After the debt-zeroing follow-up: every prior debt item is either **gone** (B1/B9a/B11/W1/D4/D5),
an **accepted contract boundary** (31-file summary truncation shrink-only ratchet; salience
allocator shadow guard), or a **closed decision with a reopen-evidence bar** (ABML public verbs,
web-reversing phase 2, renderer line granularity, capture esbuild migration, n=1 eval
hypotheses). No trigger-gated backlog remains, and no adjudicated rejection is disguised as a
future route.
