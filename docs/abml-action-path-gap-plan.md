# ABML action-path gap - measure (C) then deepen (B)

> Status: **C (measurement) DONE - gap quantified on a real browser; B (the fix) AWAITS a pick.**
> Follow-up to `docs/abml-tool-coverage-map.md`. Scope: the page-ACTION path only (the read path is
> already on ABML). Constraint: **deepen the one narrow tool, never widen the surface** (public verb
> tools were tried and proved worse). No new public tool unless the user explicitly accepts it.

## The gap, measured (C - done)

`tests/smoke/smoke-abml-action-gap.mjs` + fixture `evals/.../abml-action-gap.html`. The fixture's
`#guarded` button honors only a **trusted** click (`e.isTrusted`). Live Edge result:

| Path | reported ok? | effect fired? |
|---|---|---|
| raw skill snippet on `#plain` (accepts any click) | - | true - raw JS is not broken in general |
| raw skill snippet on `#guarded` | **true** | **false** -> **silent failure** (agent believes it clicked) |
| ABML ladder (`runtime.click`) on `#guarded` | - | true, `transport:"cdp"`, `verification:"verified"` |

**Conclusion:** the public action path silently loses a legitimate click; the internal ladder
recovers it by auto-falling-back to a CDP trusted event and verifying the effect. "No one is blocked"
is true and irrelevant - the cost is silent, not a block. This is the exact case the ladder exists
for, and the ladder is not wired to the public path.

> The measurement is a reproducible PASS gate (run: `tsx tests/smoke/smoke-abml-action-gap.mjs`). Not
> registered as an `npm` script yet - register when convenient.

## The fix (B) - three "deepen not widen" approaches

All keep the `browser_*` count unchanged; the question is *how* the agent's click intent reaches the ladder.

### B1 - execute auto-ladder (script classification)
`browser_execute` inspects the script; if it is exactly a recognized click/type shape, it transparently
routes through the ladder instead of running raw.
- **Pro:** zero surface/param change; agents already writing the snippet get the ladder for free; the
  JS<->CDP choice truly disappears for the common case.
- **Con:** **breaks the "script runs verbatim" contract** (extra scroll/CDP/time, return value
  replaced) -> surprising; classification is heuristic and must be ultra-conservative + always fall
  through to raw on any doubt. "Magic."

### B2 - optional structured intent on execute  (recommended floor to deliver the philosophy)
`browser_execute` gains an optional `action` param, e.g. `{action:{click:"<ref|selector>"}}` /
`{action:{type:{ref,text}}}`. Present -> run the ladder; absent -> `script` runs verbatim as today.
- **Pro:** explicit + reliable; `script` stays verbatim (contract intact); **one tool, no "which tool"
  decision** - the agent expresses intent on the same tool when it wants the robust path; the ladder
  finally has a public entry.
- **Con:** it is "a verb in disguise" - the closest thing to the rejected public verb tools. BUT the
  rejection was of **parallel tools** (`browser_click` as its own tool); B2 is **one optional param on
  one tool**, the least-widening way to give the ladder the *expressed intent* it requires. The user
  must judge whether that distinction is acceptable.

### B3 - upgrade the skill snippet to detect + instruct (no code change)
Replace the skill's click snippet with one that verifies the effect and, on failure, **returns a
structured "needs trusted event - escalate to `browser_command` CDP" signal**.
- **Pro:** cheapest; zero code/contract change; **kills the *silent* part** (the agent learns the click
  didn't take).
- **Con:** page JS **cannot** produce a trusted event (CDP needs the bridge), so B3 can only
  detect + instruct, not auto-recover - **the choice is surfaced, not removed.** Partial.

## Recommendation
- **B3 is the floor** (stop silent failure now, ~free) and is compatible with later doing B1/B2.
- **B2 is the philosophy-true minimum** (removes the choice, keeps `script` verbatim, one tool) - but
  it brushes the "no public verb" line, so it needs the user's explicit yes.
- **B1** delivers the philosophy with no param but at the cost of the verbatim contract + magic - riskiest.

Pick one (or "B3 now, revisit B2 later"). Then it gets its own slices + contract + live smoke. The
measurement smoke (C) already exists to gate whichever fix lands.
