# Renderer default flip — staged execution contract (post perception-renderer)

> Status: **COMPLETE — P2 salience default and P3 session-delta default flipped 2026-06-10.** Activation = the P0 `CURRENT.md` entry.
> Successor contract to the **completed** `docs/perception-renderer-plan.md` (IMPLEMENTED,
> opt-in). This contract flips the salience renderer and session-delta defaults in stages,
> WITHOUT a pre-flip multi-site blind eval — an explicit owner decision recorded here:
> **the eval gate is degraded to a post-flip monitor.** The standing `pi-browser-blind-eval`
> cron loop becomes the sentinel; rollback is a one-line default revert. This trades
> unmeasured multi-site comprehension risk for delivery speed, with the risk made cheap to
> detect (envelope self-marking) and cheap to undo (env escape + default revert).

## 1. What the C4 evidence actually said (the input to this plan)

One real-site (linux.do) implementation-blind A/B of the opt-in surfaces found:

- **Positive:** salience/session rendering improved page understanding.
- **Negative:** increased token/artifact pressure and more truncation.

So the flip is currently held back by **fixable cost regressions**, not by a comprehension
failure. This plan fixes the regressions first (as general defects, per
`eval-fixes-true-defect-no-overfit` — no linux.do-shaped tuning), then flips with
deterministic gates.

## 2. Decisions (owner-delegated, recorded)

- **D1 — flip order:** salience first; session-delta second after a soak; `line`
  granularity beyond the landed entity primitive is NOT in this contract (zero positive
  evidence, highest comprehension risk — stays opt-in/eval-gated).
- **D2 — fix before flip:** the three generalized regressions in §3 land and pass the
  comparative bench BEFORE any default changes.
- **D3 — deterministic gate replaces blind gate:** comparative `bench:distill`, dual-path
  goldens, long-conversation fixture, fixture eval runner, live smoke (§5). Fixtures verify
  shape/cost/recovery — they cannot verify multi-site agent comprehension; that residual
  risk is explicitly accepted and covered by D4.
- **D4 — monitor + hard revert rule:** the standing blind-eval cron loop runs as sentinel.
  Any finding classified "salience hid a needed fact" or "P-frame incomprehension" ⇒
  **immediate default revert** (one line), then fix-forward behind the flag. No debating
  the finding before reverting.
- **D5 — flag polarity reverses, marker stays:** after the flip,
  `PI_BROWSER_RENDERER=ladder` is the escape hatch (forces the old path);
  `=salience` remains accepted (no-op). Salience envelopes keep
  `renderer:"salience-v1"` self-marking so transcripts stay diagnosable. Ladder remains the
  in-pipeline hard-cap safety net regardless of default.

## 3. Pre-flip regression fixes (generalized, not site-tuned)

- **F1 — marginal-utility stopping rule** (`distill-core/allocate.ts`): the budget is a
  CEILING, not a fill target. Stop allocating when salience/cost density falls below a
  floor instead of filling to budget — this is the general form of the "token pressure"
  finding (ladder under-fills via blunt plane drops; salience must not over-fill via
  greedy completion). Guard: §5 comparative bench.
- **F2 — truncation discipline** (`distill-core/render.ts`/`granularity.ts`): prefer
  demoting a fact one granularity rung over mid-string truncation; consolidate omitted/
  truncation markers instead of scattering them. Guard: fixture goldens assert marker
  counts do not exceed ladder's on any corpus fixture.
- **F3 — P-frame pressure controls** (session-delta path, inert until P2 flip): changed/
  interacted facts keep ≥compact granularity in P-frames; cap the number of DISTINCT
  artifact/ref recovery targets a single P-frame envelope points at (fan-out, the general
  form of "artifact pressure"). Guard: long-conversation fixture (§5).

## 4. Phases

- [x] **P0 — clean baseline + hygiene.**
  `CURRENT.md` activation entry (decision, boundary, gates, revert rule) is recorded.
  The landed perception-renderer implementation is committed as baseline `d5f4ff0`
  before flip work starts, so flip diffs do not mix with implementation diff. The
  environment-sensitive npm-banner test (`tests/unit/cli/local-commands.test.ts`) now
  makes the banner-contamination assertion conditional on the banner actually appearing;
  the load-bearing `--silent`-gives-one-clean-JSON assertion stays unconditional.
- [x] **P1 — regression fixes F1+F2 (+F3 code, inert) + comparative bench.**
  F1 landed as marginal-density stopping plus salience-vs-ladder acceptance fallback;
  F2 landed as unified truncation/omission marker accounting with salience rejection when
  markers exceed ladder; F3 landed as a session-delta-only recovery fan-out cap, inert
  until session-delta default flips. `bench:distill` now compares ladder-vs-salience per
  fixture and gates chars, fact coverage, and truncation markers.
- [x] **P2 — flip salience default.**
  Default is now `salience`; `PI_BROWSER_RENDERER=ladder` forces the old path, and
  `PI_BROWSER_RENDERER=salience` remains accepted as a no-op. Salience envelopes continue
  to self-mark with `renderer:"salience-v1"`. Dual-path coverage is locked in unit tests
  and `bench:distill`: default output must match explicit salience, while ladder remains
  measurable and bounded by the comparative gates. Final gates passed: `npm run check`,
  `eval:browser-workflows -- --fixture-server --eval 16-scan-high-entropy-summary`, and
  `smoke:browser:scan-summary`.
- [x] **P3 — flip session-delta default (separate, after soak).**
  Trigger satisfied by explicit owner goal. Session-delta is now default; `PI_BROWSER_SESSION_DELTA=0`
  forces I-frame behavior. The long-conversation fixture gate runs a 6-observe scripted sequence,
  checks default P-frame shape and baseline chaining, simulates context loss by removing the prior
  snapshot and verifies automatic I-frame refresh, verifies the escape hatch, and keeps the F3
  recovery fan-out cap locked. Gate: `check:session-delta-long-conversation` is wired into
  `npm run check`.
- **Explicitly NOT in this contract:** broader `line` granularity, salience weight tuning,
  any new agent-facing fields, un-gating `templates`/`inference` (stay engine-only).

## 5. Verification kit (the deterministic gate)

- **Comparative bench** (P1, then every phase): ladder-vs-salience per fixture —
  chars / fact coverage / truncation markers; regression in any column blocks landing.
- **Dual-path goldens:** both renderer paths golden-locked at all times; flips swap the
  default suite, never delete the other path's lock.
- **Long-conversation fixture** (P3 gate): the deterministic stand-in for the
  context-compaction risk flagged in the original plan §5.
- **Per phase:** `npm run check` (green is meaningful after P0), fixture eval runner,
  `smoke:browser:scan-summary`.
- **Honesty rule unchanged:** no efficiency/capability CLAIMS from bench numbers alone;
  post-flip claims cite sentinel transcripts. The flip itself is a recorded owner
  decision, not an evidence-backed claim.

## 6. Rollback

One line per surface: default revert (env escape works immediately without code change).
Envelopes self-mark (`renderer:"salience-v1"`, `delta:"session"`), so any misbehaving
transcript identifies its path. Ladder hard-cap remains in-pipeline as the safety net.
Revert first, diagnose second (D4).

## 7. Related

- `docs/perception-renderer-plan.md` — completed implementation contract this builds on.
- `docs/abml-kernel-optimization-plan.md` / `docs/capture-core-plan.md` — orthogonal
  compute/sensing tracks; no shared files with P1/P2 except `observeRunners.ts`
  (coordinate if both active).
- `skills/pi-browser-blind-eval` — the sentinel loop (D4).
