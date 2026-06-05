# ABML action-path gap - measure (C) then deepen (B)

> Status: **C (measurement) DONE; B2 was shipped, then REVERTED (2026-06-05).** The first skeptical
> real-agent eval showed the public `action` arm did not earn its keep (wild `action.click` silently
> failed / timed out / missed selectors, agents reverted to JS; "verified" ≠ intent achieved;
> "silent-fail → escalate CDP" has a double-action hazard). **Decision (user, Option A): full revert.**
> ABML is observation-only; execution is the JS the agent writes via `browser_execute {script}`, and the
> trusted-event escape JS can't do is **already** reachable via `browser_command` CDP — i.e. **B3-as-guidance**
> (detect silent failure → escalate to CDP) is the landed answer, B2 is removed, no new public tool/param.
> The B1/B2/B3 analysis below is kept as historical record of how the decision was reached.
> Follow-up to `docs/abml-tool-coverage-map.md`. Scope: the page-ACTION path only (the read path is
> already on ABML). Constraint: **never widen the surface** (public verb tools were tried and proved worse).

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

## Decision (2026-06-05): B2 — shipped, then REVERTED to B3-as-guidance

B2 was chosen first and shipped (click+type+scroll behind one optional `action` param). It was then
**reverted** after the first skeptical real-agent eval: on real sites `action.click` silently failed /
hit `ACTIONABILITY_TIMEOUT` / missed selectors and agents reverted to raw JS; "verified" did not mean
"intent achieved" (a locally-mutated click still didn't perform the intended search/sort); and the
"silent-fail → escalate to CDP" recovery cannot distinguish *swallowed* from *slow-but-working*, so it
risks double-execution (worst for click). The microbenchmark gap B2 closed (the `#guarded`
trusted-only button) is real but rare, and does not outweigh re-introducing a "which entry — JS or
action?" decision on the hot path.

**Landed answer = B3-as-guidance.** Page JS can't emit a trusted event, but the privileged escape it
needs is **already public**: `browser_command` CDP (`Input.dispatchMouseEvent` / `Input.insertText`).
So the skill teaches: write the action as JS via `browser_execute {script}`; if a synthetic
`el.click()`/input returns ok but the page didn't change (a trusted-event-gated control), escalate to
`browser_command` CDP at the element rect. This kills the *silent* part (B3's win) without a new tool,
without a structured action param, and without the double-action hazard. ABML stays observation-only.

### Historical record — B2 as it was shipped (now removed from code)

The slices below describe B2 as it existed before the revert. The `action` param, the
`smoke:abml-action-gap` smoke + fixture, and its package.json script have been removed;
`registerExecuteTool` was restored to its pre-action `{script}`-only shape. Kept here only as the
record of what was tried.

### Exact public shape (additive, optional, safe default)
`browser_execute` gains an optional `action` (mutually exclusive with `script`; absent => today's
behavior unchanged):

```
action?: {
  click?: string                                  // pi-ref:// (from observe) OR a css selector
  type?:  { target: string, text: string, clear?: boolean }
}
```

When present, the call routes through the internal ABML ladder (runtime.click/type: actionability ->
synthetic -> verify -> auto CDP trusted fallback -> re-verify) and returns its structured result
(actionability + verification + transport). A bare css selector is accepted by synthesising a minimal
`control` ref descriptor (defaultRefPolicyForKind("control") allows live actions); a `pi-ref://`
resolves the real entity. `script` stays exactly as-is.

### Slices
1. **Core wiring** ✓ (commit `f88762a`) - `action.click` on `browser_execute` → ladder; selector→descriptor
   synthesis; script/action mutual-exclusion. Live-verified (#guarded recovers via the public tool).
2. **`type` verb** ✓ - `action.type` {target,text,clear?} → ladder (focus + CDP insertText + verify);
   #typed fixture (trusted-input-only) live-verified (raw synthetic ignored, action:{type} fires it).
3. **Public-surface process** ✓ - tool docs regenerated; tool-parameter-contract / output-schema /
   cli-parity all auto-green (the `action` param derives to the CLI); full `npm run check` green.
4. **Skill + docs** ✓ - skill teaches `action.click`/`type` (robust) vs `script` (raw); coverage map
   updated (browser_execute reaches the ladder via `action` for click + type).
5. **`scroll`** ✓ - `action.scroll` {target?,to,steps?} → window/container scroll via the ladder;
   live-verified (`public_scroll_effect_fired=true`). **B2 complete: click + type + scroll all reach
   the ladder via the one optional `action` param; the action gap is closed.**
