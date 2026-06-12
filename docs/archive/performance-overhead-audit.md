# Performance & Overhead Audit

> Summary archive for `docs/archive/performance-overhead-audit.full.md`.

Whole-project performance and overhead audit completed on 2026-06-08. Two-pass approach:
a four-dimension fan-out (token output / runtime latency / startup cost / memory) plus
a verification pass that confirmed load-bearing findings at source and swept for redundant
work. All landed items cite `file:line` evidence; corrected (non-reproducing) first-pass
suspicions are recorded in the full doc.

## Completed Outcome

- **Tier 0**: bridge service-worker/offscreen whitespace minify (identity-preserving, ~77 KB
  saved); AX `DOM.getBoxModel` concurrent batch; network/hook seq concurrent reads;
  `containsSensitiveEvidence` first-hit predicate; CLI JSON render parse-once; network
  diagnostics write cap + paused-request overflow continue.
- **Tier 1**: default scan ABML read reuses first `scan_extract` payload (eliminates second
  DOM scan eval); `browser_execute` removes unconditional 200ms post-eval sleep on
  non-tab-opening paths; CLI command registry memoized + bin top-level help via lightweight
  dynamic import; nested validation migrated from `zod` to TypeBox-compatible wrapper
  (`zod` removed from runtime); daemon compatibility keyed on `DAEMON_PROTOCOL_VERSION`
  only; offscreen port probe concurrent + 500ms cap; resource/ref stores 10k cap + amortized
  prune; `summarizeScanData` cross-rung precompute + per-rung loop collapse + CJK budget guard.
- **Tier 2**: `fitEnvelopeBudget`/`fitSummaryBudget` serialize-once subset; extension
  readiness event-driven + short negative cache; artifact text/search/sample single-pass
  reads; CLI success responses omit transport-only `details`; `browser_tabs list` compact
  per-tab + shared bridge block; CLI artifact enrichment deduped `readCommands`.
- **Tier 3** (blind-eval gated): scan `focus` entity projections use refs-v1 (blind-eval
  confirmed safe; full entities still in `envelope.entities` + artifacts).
- **Evidence-closed without code**: 0.3 skip/batch (no cheap recorder state source), 1.1
  non-default scan modes (non-reversible projections), 1.7 stream ref reuse (lifecycle
  contract conflict), 2.2 shortened extension wait (synthetic evidence shows boundary
  failures), 2.4 broad `structuredClone` removal (uncompressed contract risk).

## Decision rules (still active)

- `DAEMON_PROTOCOL_VERSION` remains the mandatory bump point for tool-contract changes;
  package version bumps no longer auto-restart the daemon.
- Tier 3 output-shape changes require blind-eval transcript evidence before landing;
  Tier 0/1 CPU/byte optimizations must not change public `browser_*` surface or default
  envelope semantics.
- Full identifier minify requires relaxing dist bundle string contracts — treat as a
  separate workstream, not a follow-on to this plan.

## Evidence

- Full audit record: `docs/archive/performance-overhead-audit.full.md`
- CLI startup baseline: `node dist/cli/bin.js --help` median ~56 ms (post-landing)
- Smoke artifact: `.pi/browser-artifacts/smoke-browser-scan-summary-results.json`
