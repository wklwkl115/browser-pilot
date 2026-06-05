# ABML tool-coverage map — where the philosophy is (and isn't) realized

> Status: REFERENCE (fact map, 2026-06-04). Records which public tools actually traverse the ABML
> layer, so the design docs stop overstating coverage. Verified by reading the source — see the
> file:line citations. Pairs with `docs/unified-browser-modeling-language-plan.md` (the *aspirational*
> verb-face vision) and `docs/abml-kernel-manifest.md` (the pure-core inventory).

## 1. The one-line truth

ABML is the **page-interaction substrate**. The vision is "agent expresses intent, the JS↔CDP/AX
choice disappears inside." That vision is **fully realized for *reading* the page, and not realized
for *acting* on the page.** Everything else (tabs, network, files, waiting, raw CDP, web-security) is
**orthogonal** to ABML and correctly does not go through it.

## 2. The map (verified)

| Tool | Touches ABML? | Reality |
|---|---|---|
| `browser_observe` | ✅ read | Runs through ABML: AX↔DOM merge, entities, `relations`/`inference`/`diff`/`templates`. `observeRunners.ts` → `abml.readStructure`. The "which read mode" complexity is genuinely hidden from the agent. |
| `browser_execute` | ⚠️ read + click/type | `{script}` runs the agent's JavaScript **verbatim** (`registerExecuteTool.ts`), ABML only via `monitor:true` for a before/after read. **`{action:{click}}` / `{action:{type}}` (B2) now route through the ABML ladder** (actionability + auto CDP trusted-event fallback/insertText + verify) — the action path reaches ABML for click + type. `action.scroll` pending. |
| `browser_frame` | ⚠️ partial | Frame entities exist in ABML (observe surfaces frames through it); the standalone tool is mostly a frame-tree passthrough. |
| `browser_pick` | ➖ no | Returns a CSS selector from a user click; no ABML refs. |
| `browser_screenshot` | ➖ no | Raw pixels (ABML's vision floor is a separate internal path). |
| `browser_tabs` / `browser_wait` / `browser_command` / `browser_network` / `browser_hook` / `browser_evidence` / `browser_artifact` / `browser_download` / `browser_upload` / `browser_memory` / all web-security (`crawl`/`fuzz`/`sqli`/`template`/`oast`/`cookie`/`http_replay`) | ➖ no — **and correctly so** | These do not operate on page affordances. Routing them "through ABML" would be a category error (forcing a page model onto tab/network/file/transport concerns) — exactly the surface-widening the project's narrow-tool philosophy rejects. |

## 3. The action gap — CLICK + TYPE now closed (B2), scroll pending

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

**Still open:** `action.scroll` is not wired — for scrolling the agent still hand-writes JS (`{script}`)
and owns its own fallback. `{script}` itself stays 100% verbatim (no magic re-routing). Plan +
remaining slices: `docs/abml-action-path-gap-plan.md`.

## 4. Why this isn't fixed by "add a click tool"

Public verb tools (`browser_click`, etc.) were **tried and proved worse** than the base tools: a
parallel tool *widens* the surface and adds a "which tool?" decision, the opposite of the philosophy.
And `browser_execute` is "run arbitrary JS" — arbitrary JS can't be auto-wrapped in the ladder because
the ladder needs an *expressed intent* (`click(ref)`) the raw JS doesn't carry. So closing the action
gap is a genuine "deepen, don't widen" design problem (e.g. detect a click-shaped `browser_execute`
call and transparently apply the ladder), not a tool to add. It is **not currently scheduled** — see
CURRENT.md (the mechanism arm is paused; new directions need explicit confirmation).

## 5. Consequence for the docs

- `docs/unified-browser-modeling-language-plan.md` describes the agent calling `click(ref)` as a tool
  and the old tools collapsing into verbs. That **public verb-face was not adopted** — it is an
  aspirational RFC, not shipped reality (a banner there now says so).
- The skill's "this ABML layer strengthens the public surface / no evidence anyone is blocked" was
  corrected: ABML strengthens the **read** surface; the **action** path is raw `browser_execute` JS
  where the agent owns method + fallback; the narrow surface is a *deliberate, evidence-backed* choice
  (verb tools were tried and worse), not a "wait for someone to be blocked" hold.
