# ABML tool-coverage map — where the philosophy is (and isn't) realized

> Status: REFERENCE (fact map, 2026-06-05). Records which public tools actually traverse the ABML
> layer, so the design docs stop overstating coverage. Verified by reading the source — see the
> file:line citations. Pairs with `docs/unified-browser-modeling-language-plan.md` (the *aspirational*
> verb-face vision) and `docs/abml-kernel-manifest.md` (the pure-core inventory).

## 1. The one-line truth

ABML is the **page-interaction substrate**. The vision is "agent expresses intent, the JS↔CDP/AX
choice disappears inside." That vision is **fully realized for *reading* the page and for the
structured `browser_execute.action` click/type/scroll path**. Raw `browser_execute {script}` remains
verbatim JavaScript. Everything else (tabs, network, files, waiting, raw CDP, web-security) is
**orthogonal** to ABML and correctly does not go through it.

## 2. The map (verified)

| Tool | Touches ABML? | Reality |
|---|---|---|
| `browser_observe` | ✅ read | Runs through ABML: AX↔DOM merge, entities, `relations`/`inference`/`diff`/`templates`. `observeRunners.ts` → `abml.readStructure`. The "which read mode" complexity is genuinely hidden from the agent. |
| `browser_execute` | ✅ read + click/type/scroll | `{script}` runs the agent's JavaScript **verbatim** (`registerExecuteTool.ts`), ABML only via `monitor:true` for a before/after read. **`{action:{click\|type\|scroll}}` routes through the ABML ladder** (actionability + auto CDP trusted-event fallback / insertText + bounded probe verification). Click/type default verification is now a cheap target-state probe; full entity diff is opt-in with `diff:true`. Scroll default is probe-only; virtualized-list structure collection is opt-in with `scroll.collect:true`. |
| `browser_frame` | ⚠️ partial | Frame entities exist in ABML (observe surfaces frames through it); the standalone tool is mostly a frame-tree passthrough. |
| `browser_pick` | ➖ no | Returns a CSS selector from a user click; no ABML refs. |
| `browser_screenshot` | ➖ no | Raw pixels (ABML's vision floor is a separate internal path). |
| `browser_tabs` / `browser_wait` / `browser_command` / `browser_network` / `browser_hook` / `browser_evidence` / `browser_artifact` / `browser_download` / `browser_upload` / `browser_memory` / all web-security (`crawl`/`fuzz`/`sqli`/`template`/`oast`/`cookie`/`http_replay`) | ➖ no — **and correctly so** | These do not operate on page affordances. Routing them "through ABML" would be a category error (forcing a page model onto tab/network/file/transport concerns) — exactly the surface-widening the project's narrow-tool philosophy rejects. |

## 3. The action gap — CLOSED (B2): click + type + scroll reach the ladder

The ABML **action degradation ladder** — `executeBrowserAbmlClick` / `…Type` / `…Scroll` in
`src/abml/verbs/runtime.ts`: actionability gating (wait stable/visible/not-occluded) → synthetic
click → effect verification → **automatic fallback to CDP `Input.dispatchMouseEvent`** → re-verify —
was fully implemented but wired to nothing public (the gap this doc opened with). **B2 slice 1
(commit `f88762a`) wired it for click:** `browser_execute {action:{click:"<pi-ref|selector>"}}`
routes through the ladder, so the JS↔CDP decision disappears for the agent on a click. **B2 slice 2
wired `type`:** `browser_execute {action:{type:{target,text,clear?}}}` → focus + CDP `Input.insertText`
(trusted) + verify. Both verified live (`smoke:browser:abml-action-gap`): the trusted-only `#guarded`
button (raw `el.click()` silently fails) now fires via the public tool, and `#typed` (raw synthetic
input ignored, `raw_type_model_updated=false`) updates via `action:{type}` (`public_type_effect_fired=true`).

**B2 slice 5 wired `scroll`:** `browser_execute {action:{scroll:{target?,to,steps?}}}` → window or
container scroll via the ladder (live-verified: `public_scroll_effect_fired=true`). The skeptical eval
found the first shipped scroll path slow and buggy (1/5); the 2026-06-05 fix made the default path
bounded by one shared `timeoutMs` deadline, removed default per-step structure reads, and reserved
structure collection for `scroll.collect:true`.

So `action` covers click + type + scroll; raw `{script}` stays 100% verbatim (no magic re-routing) for
everything else. **The action gap is closed.** Plan: `docs/abml-action-path-gap-plan.md`.

## 4. First Real-Agent Eval Verdict (2026-06-05, n=1)

The first skeptical real-agent eval was mixed, not a blanket win:

| Capability | Verdict | Current guidance |
|---|---|---|
| `causal` | strong (4/5) | Prefer it when action/API provenance matters; URL query values are now generically redacted for PII-looking and human-query parameters. |
| `action.type` | strong (4/5) | Prefer for fields that ignore synthetic input; it saves manual focus/setter/CDP/wait/readback chains. |
| `templates` | situational (3/5) | Useful for big ARIA-grounded lists/tables; redundant pure text-leaf templates are suppressed only when structural/actionable templates exist in the same scope. |
| `action.click` | marginal before fix (3/5) | Use when the click must take effect or synthetic clicks are unreliable; default verification now reports target semantic-state changes, with full entity diff opt-in. |
| `diff`/`treeDiff` | noisy before fix (2/5) | Raw arrays remain available; the envelope now adds salience summary so value/name/state changes lead ahead of churn counts. |
| `action.scroll` | net negative before fix (1/5) | Default is now bounded/probe-only; use `collect:true` only for virtualized-list entity collection. |

`pi-ref://` handles and observe baselines are short-lived. On `HANDLE_NOT_FOUND`, stale resource, or
baseline-expired errors, re-run `browser_observe mode=scan` and use the fresh refs/baseline instead of
retrying old handles.

## 5. Why this isn't fixed by "add a click tool"

Public verb tools (`browser_click`, etc.) were **tried and proved worse** than the base tools: a
parallel tool *widens* the surface and adds a "which tool?" decision, the opposite of the philosophy.
And `browser_execute` is "run arbitrary JS" — arbitrary JS can't be auto-wrapped in the ladder because
the ladder needs an *expressed intent* (`click(ref)`) the raw JS doesn't carry. So closing the action
gap was a "deepen, don't widen" design problem: add a structured action arm to the existing
`browser_execute`, not a parallel public verb tool.

## 6. Consequence for the docs

- `docs/unified-browser-modeling-language-plan.md` describes the agent calling `click(ref)` as a tool
  and the old tools collapsing into verbs. That **public verb-face was not adopted** — it is an
  aspirational RFC, not shipped reality (a banner there now says so).
- The skill's ABML guidance now separates raw JS from the structured action arm: raw
  `browser_execute {script}` is unchanged; `browser_execute {action:{...}}` is the shipped laddered
  path for click/type/scroll.
