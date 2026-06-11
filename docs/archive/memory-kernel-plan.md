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

## Acceptance review (2026-06-11, independent re-verification)

Verdict: **ACCEPTED**. Code re-verified against the v4 contracts (M3a five filters + append-last cap
isolation; `livePlaneSignature()` shared by runtime ladder and contract test; P6 no-repair reads;
HMAC local-secret stamps; D9 serialized read-merge-write + shutdown drain; D7 strike suppression;
distill-core untouched). Gates independently re-run green with captured exit codes:
`check:memory-core-boundary`, `check:memory-plane`, 21 memory unit tests, `check:task-conditioned-salience`,
`check:session-delta-long-conversation`, full `npm run check` (exit 0), `npm run lint` (exit 0).

Two recorded deviations (accepted, with reopen triggers):

1. **Conversation-once key is process-instance only** (`observeRunners.ts` `PROCESS_MEMORY_CONVERSATION_ID`
   = `pid:Date.now()`, unconditional collapse). The plan required: ctx conversation id → process id →
   *no stable key (shared long-lived daemon) ⇒ no collapse*. In CLI-daemon mode tools run in the
   long-lived daemon process (confirmed by the M5 env-switch finding), so a SECOND conversation on a
   previously-shown origin gets handle-only cards without ever seeing the inline body — a P1-corollary
   breach. Accepted because: Pi-native (primary frontend, one process ≈ one conversation) is correct;
   the collapsed card still carries title/verification/handle and the body is one `browser_memory read`
   away. **Reopen trigger:** any blind-eval run where a daemon-mode agent needed a collapsed card's
   body and failed to read through the handle.
2. **D6 record-nudge removal clause is unadjudicated-vacuous**: `recordNudgeShown:false` in all M5
   runs — the nudge never fired (read-only tasks ran observe/execute; nudge requires a non-observational
   tool envelope carrying a page url), so zero `recordCalled` is vacuous evidence, and deleting the
   nudge on it would be evidence-free change. Nudge kept; "why the nudge did not fire on T1 execute
   results" filed as an n=1 hypothesis in `blind-findings.md`; re-adjudicate at the next blind round.

Acceptance also fixed one sync gap: `CLAUDE.md` still described a three-kernel structure; updated to
the four-kernel table (+ `check:memory-core-boundary` / `check:memory-plane` in the test list).

## Evidence

- Full execution record: `docs/archive/memory-kernel-plan.full.md`
- Runtime user-facing contract: `docs/browser-memory.md`
- Blind eval notes: `evals/browser-workflows/blind-findings.md`
- Negative controls: `npm run check:memory-plane`
- Final completion state: `CURRENT.md`
