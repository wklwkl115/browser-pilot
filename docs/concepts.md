# Browser Pilot concepts

This page explains the vocabulary that shows up in tool results, MCP resources, and the source tree. Read it once and the rest of the project (and its output) should stop looking like jargon.

The public contract is always the MCP `tools/list` response and the JSON returned by the tools. This page describes what that JSON means; it does not add fields.

## The mental model in one paragraph

Browser Pilot turns a live tab into a **page model**: a set of named **entities** (buttons, fields, text blocks, regions, frames) with stable **refs**, plus facts about them (state, relations, grouping) and about what happened since the last look (diffs, network requests, page events). `browser_observe` builds that model. `browser_execute` and `browser_command` act on it by ref. `expect` verifies a write by re-reading the same ref. Everything that is too large for one tool result is exposed as an MCP resource instead of being cut off.

## Core terms

### ABML

The internal name of the page-model layer ("accessible browser model layer"). The **kernel** in `src/kernels/abml/` is pure TypeScript with no browser or Node access; `src/browser-runtime/abml/` does the actual reads. You will see "ABML" in code, diagnostics, and error codes. From the outside it just means "the structured page model behind `browser_observe`".

### Entity

One thing on the page worth talking about. Every entity has:

| Field    | Meaning                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref`    | Stable identifier, see below.                                                                                                                             |
| `kind`   | `control`, `element`, `text`, `region`, `media`, or `frame`.                                                                                              |
| `role`   | Accessibility role (`button`, `textbox`, `link`, `heading`, ...).                                                                                         |
| `name`   | Accessible name (label, text, `aria-label`).                                                                                                              |
| `state`  | `visible`, `occluded`, `disabled`, `focused`, `editable`, `inViewport`, plus `checked` / `selected` / `pressed` / `expanded` / `current` when applicable. |
| `source` | `dom`, `ax`, or `vision`: which reader produced it.                                                                                                       |

Entities are built by fusing two readers: the DOM scan (physical facts: geometry, visibility, occlusion, focus, editability) and the Chrome accessibility tree (semantic facts: role, name, value, `checked` and friends). The rules for who wins are the "fusion invariants" in [`src/kernels/abml/README.md`](../src/kernels/abml/README.md).

### Ref (`bp-ref://...`)

A ref is the handle you use to act on something. It looks like `bp-ref://control/9f3a...`. The path segment is the kind (`control`, `element`, `region`, `network`, `event`, ...) and the tail is a content hash.

What a ref promises:

- It points at one node in one tab. Passing it to `browser_execute` or `browser_command` routes the call to the owning tab automatically, so you rarely need `browser_tabs`.
- It is stable across an observation session as long as the page identity (URL, document, navigation epoch) is unchanged. After a navigation, refs are re-anchored and the observation says so.
- It resolves lazily. Browser Pilot stores several **locators** per ref (backend node id, accessibility id, attribute signature, CSS, text anchor) and tries them in order, so a ref usually survives re-renders that would break a raw CSS selector.

Refs expire with their observation (`ttlMs`). A stale ref produces an explicit error instead of acting on the wrong node.

### Observation

The result of one `browser_observe` call. Two shapes exist:

- The **canonical observation** (`browser-page-observation/v3`) is saved as an artifact under `.browser-pilot/artifacts/`. It contains everything, including the full entity list and diagnostics.
- The **observation view** is what the tool returns inline. It is the canonical observation minus internals and minus anything oversized. The MCP `outputSchema` of `browser_observe` describes this view.

The view is deliberately small. It is meant to be enough to decide the next action, not to be a dump of the page.

An optional declarative `view` selects evidence from the same captured model before generic compression. [Task views](task-views.md) return self-contained object bundles and explicit captured/matched/displayed scope. They do not maintain task ownership, navigate the page or infer business success.

### Snapshot, baseline, diff

Every observation gets a `snapshotId`. `browser_observe` with `mode: "diff"` picks the latest prior snapshot of the same tab and page as the **baseline** and reports what changed. `mode: "full"` forces a fresh, complete model. `mode: "auto"` (default) lets Browser Pilot decide based on whether a usable baseline exists.

### Page identity and re-anchoring

The tuple (browser session, tab, target generation, page epoch) is the **page identity**. Refs and baselines are only valid within one identity. When the page navigates or the document is replaced, the next observation carries a `reanchorReason` and starts a new identity. You do not need to manage this; it is why a ref from before a navigation refuses to act after it.

### Fingerprint bracket

A page can mutate between the DOM read and the accessibility read. Browser Pilot records a lightweight page **fingerprint** (URL, change counter, scroll, viewport, element counts) before and after the reads. The observation is "torn" when the document identity, layout, or visible/interactive element counts changed, or when the mutation counter drifted by more than a small tolerance (live regions such as carousels and timers mutate constantly without changing which controls exist). A torn observation retries once, then degrades to a scan-only model and says so in diagnostics. A screenshot attached by `visual: "always"` is captured inside the same bracket, which is what makes the pixel boxes in `visual.targets` trustworthy.

### Perception ledger

Per-page bookkeeping of which facts were last seen at which snapshot, and what the last action was. It exists so that a diff can attribute a changed row or a fired request to the action you just took (`causal`). You never read the ledger directly.

### Frontier

Anything Browser Pilot knows about but did not inline. Each frontier item has a `kind` and a `state`:

| `kind`              | What is behind it                                                           |
| ------------------- | --------------------------------------------------------------------------- |
| `content`           | A text section (by heading) that was truncated.                             |
| `action-space`      | The full list of actionable controls when it exceeded the inline budget.    |
| `collection-window` | The items of one long list/table.                                           |
| `details`           | A larger structure such as `relations`, `causal`, or the whole observation. |

| `state`           | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `folded`          | Present on the page, trimmed from the inline view. Read the resource. |
| `viewport-window` | The page only renders what is on screen; more exists below.           |
| `virtualized`     | A virtual list; items outside the window are not in the DOM.          |
| `paginated`       | More pages exist; `controlRef` points at the next-page control.       |
| `lazy`            | Content loads on scroll or interaction.                               |
| `unavailable`     | Browser Pilot could not expand it; `unavailableReason` says why.      |

When a frontier item has a `resourceUri`, read it with MCP `resources/read`. The URI is `browser-pilot://observation/<token>` and stays valid for the observation's lifetime.

### Collection

A repeated structure (list, table, grid, feed, menu, tree) recognised as one unit. Collections carry `observed` and, when derivable, `total`, plus a `completeness` verdict (`complete`, `viewport-window`, `virtualized`, `paginated`, `lazy`, `unknown`) and a `confidence`. This is how the agent learns "this table shows 25 of 312 rows and here is the Next button" without scrolling.

### Template and tree diff

Items of a collection usually share a structure. Browser Pilot extracts that shared **template** once and describes each item as an instance. `treeDiff` compares templates between baseline and current: `appeared`, `disappeared`, `changed`, `reordered`, with a few sample names so "which row changed" is answerable from the summary.

### Causal

Network requests and page events (console, DOM sinks, storage, errors) that fired since the baseline, attributed where possible to the last action. Network attribution requires a recorder; start one with `browser_command` `network.start`. Without a recorder `causal` reports `unavailable`.

### Relations

Accessibility relations between entities: `labelledBy`, `describedBy`, `controls`, `owns`, `expandedTarget`, `currentIn`, `cellOf`, `rowOf`, `columnOf`, `headerFor`, `occludes`, `coveredBy`. The inline view carries counts and a few highlights; the full list is a `details` frontier resource.

### Effect and verification

`verified` describes the supplied assertion, not business success. Writes additionally expose an `operationId`, an execution receipt, and an explicit business outcome that defaults to `unknown`. Declared business evidence and read-only continued observation are described in [operation outcomes](operation-outcomes.md).

Writes through `browser_execute` and `browser_command`, and `browser_tabs navigate`, return an `effect`: did the page observably change (`changed`), did it settle (`settled`), did navigation happen, did new tabs open, how many DOM changes were counted. When the page could not be fingerprinted around the write, `observed` is `false` and `unobservedReason` says why (`no-tab`, `deadline-exhausted`, or `fingerprint-unavailable`).

Add `expect` to a write to get a `verification`. `expect` is either a JavaScript truth expression or a structured postcondition such as `{ "ref": "bp-ref://control/...", "state": { "pressed": true } }`. Browser Pilot reads the ref before and after the write and returns `status` (`verified`, `unmet`, `inconclusive`), the observed state, the evidence used, and a target-scoped diff. Verification is scoped to the ref you named; it does not re-observe the whole page.

A quiet page is not proof that asynchronous work has finished. Retryable postconditions keep polling until the assertion holds, cancellation, or the observation budget (five seconds by default, configurable with bounded `verificationWaitMs`). `unmet` means the condition was not observed within that budget; it does not mean the write was rolled back. Do not blindly repeat a write after an unmet or inconclusive result. For longer workflows, use `browser_operation` to continue declared observation and inspect the resulting business state.

## What `browser_observe` returns

The inline result (the observation view) has these top-level keys. All except `target` are optional and appear only when they carry information.

| Key           | What it is for                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`      | `{ url }` of the observed tab.                                                                                                                                                                                                                                                                  |
| `content`     | Readable page text, `headings`, and `complete: false` when text was folded into a frontier resource.                                                                                                                                                                                            |
| `gist`        | `title` and landmark roles present (`main`, `navigation`, ...). A one-glance orientation.                                                                                                                                                                                                       |
| `outline`     | Containers with member counts and refs. The skeleton of the page.                                                                                                                                                                                                                               |
| `actionSpace` | `items`: compact actionables with `ref`, `role`, `name`, `actions` (`click` / `edit`), `state`, `scope`; fields also carry their current `value`, `placeholder`, and `inputKind`, links their `href`. Password fields never report a value. `coverage` says whether all controls were captured. |
| `collections` | Recognised lists/tables with completeness (see above).                                                                                                                                                                                                                                          |
| `relations`   | Relation counts plus highlights.                                                                                                                                                                                                                                                                |
| `causal`      | Requests and events since the baseline, or `unavailable`.                                                                                                                                                                                                                                       |
| `treeDiff`    | Summary of repeated-structure changes since the baseline.                                                                                                                                                                                                                                       |
| `visual`      | When a screenshot was attached: image `ref`, `resourceUri`, size, and normalized `targets` boxes per ref.                                                                                                                                                                                       |
| `frontier`    | Everything not inlined, with resource URIs or the reason it is unavailable.                                                                                                                                                                                                                     |
| `warnings`    | Human-readable notes about degraded providers or partial capture.                                                                                                                                                                                                                               |
| `nextActions` | Short hints about sensible follow-ups.                                                                                                                                                                                                                                                          |

Alongside the JSON, the MCP result includes `resource_link` entries for every frontier resource, the screenshot, and the saved canonical artifact.

## What the tools are for

| Tool                 | Use it when                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_observe`    | You need to understand the page or verify a change with a diff. Not needed before every action.                                                                                                                                                                                                                                                                     |
| `browser_execute`    | You want to run page JavaScript. `browserPilot.refs`, `resolve(ref)`, `box(ref)`, and `setValue(target, value)` are available. Combine same-page reads and writes in one call.                                                                                                                                                                                      |
| `browser_command`    | You need trusted input on an observed control (`input.ref` with `click`, `type`, `check`, `select`, `focus`, `hover`), a wait (`wait.loadState`, `wait.selector`, `wait.networkIdle`, `wait.navigation`), a native browser operation (downloads, uploads, network recorder), or a raw CDP method. Field definitions live at `browser-pilot://native-command/<cmd>`. |
| `browser_tabs`       | You need to navigate the selected tab to a URL, or disambiguate, create, switch, or close tabs. Omit it when the selected tab is already right.                                                                                                                                                                                                                     |
| `browser_screenshot` | You want an image for a human or a vision model, without building a page model.                                                                                                                                                                                                                                                                                     |
| `browser_operation`  | You need an execution receipt or continued declarative observation for an operationId, without replaying the write.                                                                                                                                                                                                                                                 |

## Where things live in the source

| Path                        | Owns                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/apps/mcp`              | The MCP server (official SDK, stdio) and the extension installer.                                          |
| `src/apps/daemon`           | The user-local daemon that owns the bridge and sessions.                                                   |
| `src/bridge/server`         | WebSocket bridge to the extension, pending requests, per-target write queues.                              |
| `src/bridge/extension`      | The Manifest V3 extension: service worker, CDP helpers, content script.                                    |
| `src/commands`              | Public tool schemas and orchestration; `observe/` assembles observations.                                  |
| `src/operations`            | Execution receipts, declared business conditions, correlated evidence, and bounded read-only continuation. |
| `src/kernels/abml`          | Pure page-model logic: entities, fusion, collections, diffs, verification.                                 |
| `src/kernels/refs`          | Ref minting, locators, and access policy.                                                                  |
| `src/kernels/session`       | Page identity, perception ledger, snapshot registry.                                                       |
| `src/scan`, `capture-src`   | The page-world scan script and its noise/actionability rules.                                              |
| `.browser-pilot/artifacts/` | Saved observations and screenshots for the current project root.                                           |
