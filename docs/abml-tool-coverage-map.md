# ABML tool-coverage map — where the philosophy is (and isn't) realized

> Status: REFERENCE (fact map, 2026-06-05). Records which public tools actually traverse the ABML
> layer, so the design docs stop overstating coverage. Verified by reading the source — see the
> file:line citations. Pairs with `docs/unified-browser-modeling-language-plan.md` (the *aspirational*
> verb-face vision) and `docs/abml-kernel-manifest.md` (the pure-core inventory).

## 1. The one-line truth

ABML is the **page-perception substrate** — it is observation-only. The vision is "agent reads the
page through one merged AX↔DOM model; the read-mode choice disappears inside." That vision is
**fully realized for *reading* the page** (`browser_observe`). **Execution is NOT in ABML:** page
actions are the JavaScript the agent writes via `browser_execute {script}` (run verbatim), with
`browser_command` CDP as the escape for the rare trusted-event-gated control JS can't drive.
Everything else (tabs, network, files, waiting, raw CDP, web-security) is **orthogonal** to ABML and
correctly does not go through it.

## 2. The map (verified)

| Tool | Touches ABML? | Reality |
|---|---|---|
| `browser_observe` | ✅ read | Runs through ABML: AX↔DOM merge, entities, `relations`/`inference`/`diff`/`templates`. `observeRunners.ts` → `abml.readStructure`. The "which read mode" complexity is genuinely hidden from the agent. |
| `browser_execute` | ⚠️ read-only | `{script}` runs the agent's JavaScript **verbatim** (`registerExecuteTool.ts`) — execution is the agent's JS, NOT ABML. ABML is borrowed only via `monitor:true` for a before/after **read** diff. There is no structured action arm: a click/type/scroll that needs a trusted event escalates to `browser_command` CDP. |
| `browser_frame` | ⚠️ partial | Frame entities exist in ABML (observe surfaces frames through it); the standalone tool is mostly a frame-tree passthrough. |
| `browser_pick` | ➖ no | Returns a CSS selector from a user click; no ABML refs. |
| `browser_screenshot` | ➖ no | Raw pixels (ABML's vision floor is a separate internal path). |
| `browser_tabs` / `browser_wait` / `browser_command` / `browser_network` / `browser_hook` / `browser_evidence` / `browser_artifact` / `browser_download` / `browser_upload` / `browser_memory` / all web-security (`crawl`/`fuzz`/`sqli`/`template`/`oast`/`cookie`/`http_replay`) | ➖ no — **and correctly so** | These do not operate on page affordances. Routing them "through ABML" would be a category error (forcing a page model onto tab/network/file/transport concerns) — exactly the surface-widening the project's narrow-tool philosophy rejects. |

## 3. The action arm — TRIED, then REVERTED (2026-06-05): execution stays JS + CDP escape

The ABML **action degradation ladder** — `executeBrowserAbmlClick` / `…Type` / `…Scroll` in
`src/abml/verbs/runtime.ts`: actionability gating → synthetic action → effect verification →
**automatic fallback to CDP `Input.dispatchMouseEvent`** → re-verify — exists and works, but it is
**internal substrate** (reached via `createBrowserAbmlIntegration().runtime`, used by tests / the
eval-runner / `monitor:true`'s read path). A structured `action:{click|type|scroll}` param on
`browser_execute` was built (B2) to wire it to a public path — and then **reverted**.

**Why reverted:** the first skeptical real-agent eval (2026-06-05) showed the public action arm did
not earn its keep for clicks — in the wild `action.click` had silent failures, `ACTIONABILITY_TIMEOUT`,
and selector misses, and agents simply reverted to writing raw JS. "Verified" did not mean "intent
achieved" (a click reported verified because *something* locally mutated, but the intended
search/sort didn't happen). type/scroll/read worked, but did not justify a standing public action
surface that re-introduces a "which entry — JS or action?" decision. The deeper hazard: an "action
silently failed → escalate to CDP" recovery cannot reliably distinguish *swallowed* from
*slow-but-working*, so it risks double-execution (worst for click).

**Where execution lives now:** the agent writes JS via `browser_execute {script}` (the action
language); for the rare trusted-event-gated control a synthetic `el.click()`/input can't drive, the
agent escalates to `browser_command` CDP (`Input.dispatchMouseEvent` / `Input.insertText` at the
element rect) — the trusted-event escape JS can't do is **already publicly reachable** there, so no
new tool is needed. ABML does not touch execution. Plan / history: `docs/abml-action-path-gap-plan.md`.

## 4. First Real-Agent Eval Verdict (2026-06-05)

The first skeptical real-agent eval was mixed, and is what drove the action-arm revert above:

| Capability | Verdict | Current guidance |
|---|---|---|
| `causal` | strong | Prefer it when action/API provenance matters; URL query values are now generically redacted for PII-looking and human-query parameters. |
| page reading (lists/tables, `templates`) | strong | The read side is where ABML pays off; prefer `browser_observe` for big ARIA-grounded lists/tables. |
| `templates` | situational | Useful for big ARIA-grounded lists/tables; redundant pure text-leaf templates are suppressed only when structural/actionable templates exist in the same scope. |
| structured `action` (click/type/scroll) | reverted | Did not earn a public surface (agents reverted to JS; click "verified" ≠ intent achieved; CDP-escalation double-action hazard). Execution = JS via `browser_execute`; trusted-event escape via `browser_command` CDP. |
| `diff`/`treeDiff` | noisy before fix | Raw arrays remain available; the envelope now adds salience summary so value/name/state changes lead ahead of churn counts. |

`pi-ref://` handles and observe baselines are short-lived. On `HANDLE_NOT_FOUND`, stale resource, or
baseline-expired errors, re-run `browser_observe mode=scan` and use the fresh refs/baseline instead of
retrying old handles.

## 5. Why there is no public action verb (and why the `action` arm was reverted too)

Public verb tools (`browser_click`, etc.) were **tried and proved worse** than the base tools: a
parallel tool *widens* the surface and adds a "which tool?" decision, the opposite of the philosophy.
The structured `action` arm on `browser_execute` avoided a new *tool*, but a real-agent eval showed it
re-introduced the same "which entry — JS or action?" decision without earning its keep (agents reverted
to JS; "verified" ≠ intent; CDP-escalation double-action hazard). So the action arm was reverted: the
single action language is the JavaScript the agent writes via `browser_execute {script}`, and the one
thing JS can't do — emit a trusted event — is **already** reachable via `browser_command` CDP
(`Input.dispatchMouseEvent` / `Input.insertText`). No parallel verb tool, no structured action param.
ABML stays the read substrate.

## 6. Consequence for the docs

- `docs/unified-browser-modeling-language-plan.md` describes the agent calling `click(ref)` as a tool
  and the old tools collapsing into verbs. That **public verb-face was not adopted** — it is an
  aspirational RFC, not shipped reality (a banner there now says so).
- The skill's ABML guidance is observe-only on the action question: `browser_execute {script}` runs
  the agent's JS verbatim; a trusted-event-gated control that silently ignores a synthetic
  click/input escalates to `browser_command` CDP. There is no `browser_execute {action:{...}}` arm.
