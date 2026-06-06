# Blind-agent eval findings (rolling, triaged)

Product of the `pi-browser-blind-eval` skill. Each finding is triaged `fixable | WAI | reliability`
per `eval-friction-triage-perception-vs-execution`. `runs` = how many independent blind runs (different
agent + task) surfaced it; treat `runs ≥ 2` as confirmed, `runs = 1` as a hypothesis to re-test before
acting. WAI items are recorded for transparency but are **not** work items.

**Before fixing anything**, a finding must be a TRUE, GENERAL project defect — confirmed root cause that
generalizes, no change-for-change, no overfit to the site/DOM/task/shape that surfaced it (fix +
regression stay general). If it can't clear that bar, leave it here as "needs more runs", don't patch.
See `eval-fixes-true-defect-no-overfit`.

> **Protocol (corrected 2026-06-06, see `blind-eval-protocol-realsite-skill-china`):** blind eval now
> runs on REAL, mainland-China-reachable sites (READ-ONLY) with the agent READING the
> `pi-browser-tools` skill. The first two runs below predate that and are **legacy** (no skill,
> `--help`-only, local/ad-hoc fixtures) — re-validate their findings under the corrected protocol; some
> (e.g. F3) are likely skill-mitigated. The execute-return-value finding (F1) recurs under BOTH.
>
> Runs: R1 = login→orders (ad-hoc fixture, legacy); R2 = spec 02 scan-execute-wait (interactive.html,
> legacy); **R3 = linux.do top-topics (REAL site, skill-guided)** — canonical corrected run.

## fixable (work items)

| # | finding | runs | evidence | candidate fix |
|---|---------|------|----------|---------------|
| F1 | **`browser_execute` does not return your script's value inline — even small values**: nested arrays/objects collapse to `{type,count/keyCount}` shape placeholders and strings truncate (~280 chars) under default `detailLevel`, forcing a second `browser_artifact` round-trip to read data the agent just computed. | **3 — CONFIRMED, survives the skill** (R1 nested-array collapse; R2 280-char truncation; R3 <2KB `{count,rows}` → `keyCount:4` placeholders) | R1: rows→cells = `{type:"array",count:3}`. R2: `originalLength:280, truncated:true`, buried in `summary.data.value`. R3: small return collapsed to `{type:"object",keyCount:4}`, needed `artifact --json-path data.rows`. R3 agent (skill-guided): "pure overhead for the most common extract-a-few-values use case — the only real inefficiency I hit." | **✅ RESOLVED 2026-06-06** — see "Resolved" below. |
| F2 | **Envelope verbosity drowns the answer**: `observe`/`execute` wrap a tiny result in a large envelope (privacy/operation/correlation/nextActions + `[Circular]`/`{type,keyCount}` placeholders). `observe mode:text` was ~34KB JSON for one fact; useful fields (`summary.data.value`, `textPreview`, `entities[]`) are buried. | 2 (R1 observe-scan noise; R2 34KB text envelope) | R1: 9-node page → 75KB scan artifact, `headings:"[Circular]"`. R2: 34KB for "Status: activated". | Tighten default non-TTY envelope: surface the high-signal field at/near top; demote operation/correlation blocks under a key; keep full evidence in artifact. |
| F3 | **`tabs --json` without `--action` errors with raw schema noise**: `Invalid parameters — /: must have required properties action`. Top-level `--help` lists `tabs` but doesn't signal `--action` is mandatory; the `/:` is raw validator output. | 1 (R2, legacy) — **likely skill-mitigated**: R3 (skill-guided) did NOT hit this. | R2 cmd #4. | Lower priority. Friendly message: `tabs requires --action (one of: list, switch, create, …)`; or list required flags in top-level `--help`. |
| F4 | **`wait --params` JSON shape is undocumented**: `--help` shows `--params <json>` with no schema; the agent guessed `{selector,timeoutMs}` / `{url,state}` and got lucky. | 2 (R1, R3) — survives the skill | R1 cmd #5-6; R3 "`wait --help` does NOT document the shape of `--params`… guessed correctly from convention." | Document the per-action `params` shape in `wait --help`, or accept top-level flags as aliases. See `tool-ergonomics-accept-natural-aliases`. |

## Resolved

- **F1 — `browser_execute` small return-value rendering (2026-06-06).** Root cause: `src/tools/summaries/generic.ts` `compactSample` is depth-2 + 5-sample + 240-char limited, so a value nested inside an object/array (R1 rows→cells, R3 `{count,rows}`) collapsed to `{type,count/keyCount}` even when the whole return was a few hundred bytes. Fix: `summarizePlainValue` now inlines the WHOLE return value VERBATIM (JSON-cloned) when it serializes within `INLINE_VALUE_CHARS` (4 KB); genuinely large payloads still collapse to a compact shape (samples stay small) with the full value in the saved artifact, and `fitSummaryBudget` (~8 KB) remains the hard guard. Redaction still applies (it runs after distill). Regression locked in `tests/contracts/tools/check-summaries.mjs` (`generic.inline.*`). Verified live through the rebuilt daemon on a real, China-reachable site (linux.do): a `{count,rows:[{title,replies}…]}` extraction now returns inline in ONE call — no second `browser_artifact` round-trip. NOT "fixed" by an execution helper (that would be WAI); this is pure output-ergonomics.

## reliability (work items)

| # | finding | runs | evidence | notes |
|---|---------|------|----------|-------|
| Rel1 | **`execute` BRIDGE_TIMEOUT after idle** (ACK received, no response in 15s) while `tabs list` still works — suspected MV3 service-worker eviction between calls. Observed during harness bring-up, not yet inside a blind run. | 0 (operator-observed) | `selectionVersion` jumped 101→134; 3 execs timed out, `tabs list` fine. | Characterize before concluding (could be eviction, page stall, or env). Reproduce deterministically. |

## WAI (transparency only — NOT work items)

| # | finding | rationale |
|---|---------|-----------|
| W1 | "No `click`/`type`/`fill` verb; had to hand-write the form-fill via native value setter + `input`/`change` dispatch." | By deliberate project decision: the project provides the ABML page MODEL; the agent writes execution code. JS-first via `browser_execute`, trusted-event escape via `browser_command` CDP. The B2 action arm was tried and reverted. See `eval-friction-triage-perception-vs-execution`, `public-tool-surface-no-action-verbs`. (R2 agent reported "no friction finding how to act" — the model is fine; only the *return-value rendering* F1 hurt.) |
