# Memory Kernel Plan

> Summary archive for `docs/archive/memory-kernel-plan.full.md`.

Memory kernel v1 completed on 2026-06-11. The work promoted browser memory
from an explicit side tool into the fourth kernel on the default observe path:
sense -> perceive -> express -> retain.

## Completed Outcome

- Added pure `src/memory-core/` and runtime `src/memory/` layers for profile
  distillation, recall, verification, HMAC stamps, and serialized profile
  persistence.
- Added memory relevance source `F` with recurrence filtering, agreement
  gating, and cap isolation so memory cannot displace live relevance terms.
- Added runner-built `MemoryAugmentationPlan` for `browser_observe` scan/text.
  Accepted memory planes must pass the `livePlaneSignature()` inline -> handle
  -> omit ladder, so live page perception is unchanged.
- Added structural-anchor verification and strike feedback; stale cards lose
  inline bodies at strike 3.
- Kept strategic writes explicit through `browser_memory record`; automatic
  paths use no-repair reads and do not write outside profile persistence.
- Added privacy hardening: persistable term whitelist, path-only canonical
  URLs, local-secret HMAC fact stamps, no raw page text/query/title in
  automatic profiles.
- M5 blind eval proved relevant warm memory adoption on Bilibili T1 and no
  success harm on T2. The run exposed an over-broad same-origin collapsed card,
  so automatic `envelope.memory` injection was tightened to require current
  observe URL/intent token overlap.

## Evidence

- Full execution record: `docs/archive/memory-kernel-plan.full.md`
- Runtime user-facing contract: `docs/browser-memory.md`
- Blind eval notes: `evals/browser-workflows/blind-findings.md`
- Negative controls: `npm run check:memory-plane`
- Final completion state: `CURRENT.md`
