# ABML tool-coverage map — where the philosophy is (and isn't) realized

> Status: REFERENCE (fact map, updated 2026-06-13). Records which public tools actually traverse the ABML
> layer, so the design docs stop overstating coverage. Verified by reading the source — see the
> file:line citations. Pairs with `docs/unified-browser-modeling-language-plan.md` (the *aspirational*
> verb-face vision) and `docs/abml-kernel-manifest.md` (the pure-core inventory).

## 1. The one-line truth

ABML is the **page-perception substrate** — it is observation-only. The vision is "agent reads the
page through one merged AX↔DOM model; the read-mode choice disappears inside." That vision is
**fully realized for *reading* the page** (`browser_observe`). **Execution is NOT in ABML:** page
actions are the JavaScript the agent writes via `browser_execute {script}` (run verbatim), with
`browser_command` `input.*` as the physical escape for trusted-event/canvas/WebGL cases JS can't drive.
Everything else (tabs, network, files, waiting, raw CDP, web-security) is **orthogonal** to ABML and
correctly does not go through it.

Agent-native perception means ABML should remove human viewport/gesture loops from the agent's
thinking path, not publish better names for them. Humans can repeatedly scroll, inspect, and react;
agents have higher one-shot input bandwidth but expensive interaction turns. So a scroll bar, lazy
list, pagination edge, or hidden row is first a **collection completeness / continuation /
data-source / state-transition** modeling problem. Physical scroll/click/key input remains runtime
mechanics or a `browser_command` escape; it is not a reason to add `browser_scroll`, revive
`browser_execute {action}`, or expose ABML verbs as public tools. Reopening that boundary requires
evidence that the perception-first model itself is wrong, not merely that one site needs another
viewport step today.

## 2. The map (verified)

| Tool | Touches ABML? | Reality |
|---|---|---|
| `browser_observe` | ✅ read | Runs through ABML: AX↔DOM merge, entities, and emits `relations`/`diff`/`treeDiff`/`snapshotProjection`/`collections`/`causal` envelope fields. `observeRunners.ts` → `abml.readStructure`. The `collections` block reports completeness and read-only continuation evidence for long/virtualized/lazy/paginated lists; it does not execute scrolling. The `inference`/`templates` engines still run internally (they drive `treeDiff`/`snapshotProjection`/`referenced_entities`) but were removed as agent-facing fields after a 2026-06-05 real-agent eval. The "which read mode" complexity is genuinely hidden from the agent. |
| `browser_execute` | ⚠️ read-only | `{script}` runs the agent's JavaScript **verbatim** (`registerExecuteTool.ts`) — execution is the agent's JS, NOT ABML. ABML is borrowed only via `monitor:true` for a before/after **read** diff, and observed `pi-ref://` handles can be dereferenced in-page via the minimal `pi.resolve` / `pi.box` / `pi.setValue` / `pi.settled` stdlib. There is no structured action arm: a click/type/scroll that needs a trusted event escalates to `browser_command input.*`. |
| `browser_frame` | ⚠️ partial | Frame entities exist in ABML (observe surfaces frames through it); the standalone tool is mostly a frame-tree passthrough. |
| `browser_pick` | ➖ no | Returns a CSS selector from a user click; no ABML refs. |
| `browser_screenshot` | ➖ no | Raw pixels (ABML's vision floor is a separate internal path). |
| `browser_tabs` / `browser_wait` / `browser_command` / `browser_network` / `browser_hook` / `browser_evidence` / `browser_artifact` / `browser_download` / `browser_upload` / `browser_memory` / all web-security (`crawl`/`fuzz`/`sqli`/`template`/`oast`/`cookie`/`http_replay`) | ➖ no — **and correctly so** | These do not operate on page affordances. Routing them "through ABML" would be a category error (forcing a page model onto tab/network/file/transport concerns) — exactly the surface-widening the project's narrow-tool philosophy rejects. |

## 3. The action arm — TRIED then REVERTED (2026-06-05), internal actuators then REMOVED (2026-06-13)

ABML once carried an internal **action degradation ladder** — `executeBrowserAbmlClick` / `…Type` /
`…Scroll` in `src/abml/verbs/runtime.ts`: actionability gating → synthetic action → effect
verification → physical-input (`input.pointer`/`input.keys`) fallback → re-verify. A structured
`action:{click|type|scroll}` param on `browser_execute` (B2) wired it to a public path — and was
**reverted** (2026-06-05).

**Why the public arm reverted:** the first skeptical real-agent eval showed it did not earn its keep
for clicks — silent failures, `ACTIONABILITY_TIMEOUT`, selector misses; agents reverted to raw JS.
"Verified" did not mean "intent achieved" (a click reported verified because *something* locally
mutated, but the intended search/sort didn't happen). The deeper hazard: an "action silently failed →
escalate to CDP" recovery cannot distinguish *swallowed* from *slow-but-working*, so it risks
double-execution (worst for click).

**Then the internal actuators were removed (2026-06-13).** After the B2 revert the click/type/scroll
executors survived as dormant internal substrate — but `createBrowserAbmlIntegration` only ever
exposed `read`, so **no production caller dispatched them** (tests + the reverted arm only). Two blind
evals (linux.do infinite feed, bilibili lazy grid) confirmed agents actuate via `browser_execute`
without ever needing an internal actuator. The orphaned click/type/scroll verbs, runtime executors,
and CDP input injection were deleted; `check:abml-verb-runtime` now LOCKS that ABML stays
perception-only (no `executeBrowserAbml{Click,Type,Scroll}`, no `input.pointer`/`input.keys`). read /
pierce / frame / visual-floor stay.

**Where execution lives now:** the agent writes JS via `browser_execute {script}` (the action
language); for the rare trusted-event-gated control, canvas/WebGL target, or cross-origin iframe
a synthetic `el.click()`/input can't drive, the agent escalates to `browser_command input.pointer` /
`input.keys` — the physical escape JS can't do is **already publicly reachable** there, so no
new tool is needed. ABML does not touch execution. Plan / history: `docs/abml-action-path-gap-plan.md`.

## 4. First Real-Agent Eval Verdict (2026-06-05)

The first skeptical real-agent eval was mixed, and is what drove the action-arm revert above:

| Capability | Verdict | Current guidance |
|---|---|---|
| `causal` | strong | Prefer it when action/API provenance matters; URL query values are now generically redacted for PII-looking and human-query parameters. |
| page reading (lists/tables) | strong | The read side is where ABML pays off; prefer `browser_observe` for big ARIA-grounded lists/tables. Completeness and continuation surface through `collections`; structure surfaces via `treeDiff`/`snapshotProjection`; per-item VALUES still come from `browser_execute`. |
| `templates` (internal engine) | engine-only | No longer an agent-facing envelope field (a real-agent eval showed it unread); the templating engine still powers `treeDiff`/`snapshotProjection`. Redundant pure text-leaf templates are suppressed only when structural/actionable templates exist in the same scope. |
| structured `action` (click/type/scroll) | reverted; internal actuators removed (2026-06-13) | Public arm never earned its keep (agents reverted to JS; click "verified" ≠ intent achieved; escalation double-action hazard). The dormant internal click/type/scroll executors were then deleted — zero production callers, blind evals confirmed JS actuation. Execution = JS via `browser_execute`; trusted-event/canvas escape via `browser_command input.*`. Locked by `check:abml-verb-runtime`. |
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
thing JS can't do — emit physical trusted input — is **already** reachable via `browser_command`
`input.pointer` / `input.keys`. No parallel verb tool, no structured action param.
ABML stays the read substrate.

For long or virtualized content, the preferred fix is now the shipped richer observation semantic:
top-level `collections` with honest completeness, continuation handles, source/evidence pointers,
and before/after state transitions. Adding a public scroll verb only moves the human UI loop into the
agent transcript.

## 6. Consequence for the docs

- `docs/unified-browser-modeling-language-plan.md` describes the agent calling `click(ref)` as a tool
  and the old tools collapsing into verbs. That **public verb-face was not adopted** — it is an
  aspirational RFC, not shipped reality (a banner there now says so).
- The skill's ABML guidance is observe-only on the action question: `browser_execute {script}` runs
  the agent's JS verbatim; `pi.*` only removes selector transcription for observed refs; a
  trusted-event-gated control that silently ignores a synthetic click/input escalates to
  `browser_command input.*`. There is no `browser_execute {action:{...}}` arm.
