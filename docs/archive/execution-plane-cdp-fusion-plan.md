# Execution-Plane CDP Fusion Plan

> Summary archive for `docs/archive/execution-plane-cdp-fusion-plan.full.md`.

Execution-plane CDP fusion completed on 2026-06-14. The workstream collapsed
the trusted-input escape path from agent-managed measurement plus
`browser_command input.pointer` into a single `browser_execute` script path:
`await pi.click(ref)`.

## Completed Outcome

- Added internal native command `input.ref` for dispatch-only CDP physical
  click, using backend-node resolution first and explicit point dispatch only
  when no backend identity is present.
- Added `pi.click(ref, options?)` to the execute stdlib only when referenced,
  serviced through an in-flight `Runtime.addBinding` rather than a nested Node
  write.
- Preserved the public tool surface: no new `browser_*` tool and no
  `browser_execute action:{...}` parameter.
- Kept ABML perception-only; the dispatch path lives in the bridge/runtime
  execution layer, not ABML runtime verbs.
- Added runtime/contract/eval coverage, including eval 31 where raw
  `el.click()` is ignored but CDP physical input succeeds and semantic success
  is verified afterward through wait/observe.
- Kept generated service-worker dist under the size budget by enabling
  syntax-level build minification without minifying identifiers.

## Evidence

- Full execution record:
  `docs/archive/execution-plane-cdp-fusion-plan.full.md`
- Eval evidence directory:
  `.pi/browser-artifacts/eval-browser-workflows/2026-06-13T16-36-16-306Z-d97b6642`
- Sample result:
  `evals/browser-workflows/results/31-execution-plane-cdp-fusion.result.json`
- Closing gate:
  `npm run check`
