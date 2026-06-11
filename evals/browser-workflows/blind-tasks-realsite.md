# Blind-eval real-site task bank (mainland-China reachable, READ-ONLY)

Targets for the `pi-browser-blind-eval` skill. Every task is **read-only** (no login / submit / post)
and chosen to be reachable from a **mainland-China** network (see
`blind-eval-protocol-realsite-skill-china`). Sites change — treat `goal` as the intent and grade on
"did it extract a plausible correct answer + via which tool path", not an exact string. Always
pre-flight (`observe` must not land on `chrome-error://`) before spawning the agent; swap a target that
stopped loading.

`reach`: `confirmed` = seen loading on the operator's network; `likely` = generally CN-reachable but
verify per run.

## Single-step extraction tasks (per-call ergonomics)

| id | url | reach | capability under test | goal (given to the blind agent) |
|----|-----|-------|-----------------------|---------------------------------|
| rs-linuxdo-topics | https://linux.do/ | confirmed | SPA list perception + per-item value extraction + wait-for-hydration | Report the titles of the top 5 topics shown in the topic list, with each topic's reply count if visible. The page is a dynamic SPA; wait for the topic list before reading. |
| rs-bilibili-home | https://www.bilibili.com/ | confirmed | heavy SPA cards, lazy/virtualized content, value extraction | Report the titles of 5 video cards currently visible on the home page, with the uploader name for each if shown. |
| rs-bilibili-active-tab | https://www.bilibili.com/ | confirmed | selected/pressed state perception probe | State which visible top navigation/channel tab is currently active or selected, and explain what observable state or structure proves it. Do not click or change tabs. |
| rs-github-repo | https://github.com/ | likely | static-ish structured page, file/list reading, table-ish rows | On a public repository page (navigate within github.com to one if needed), report the names of the top-level files/folders shown in the file list and the repository's star count. |
| rs-mdn-table | https://developer.mozilla.org/en-US/docs/Web/HTTP/Status | likely | long structured doc + relations/table reading boundary | Report 5 HTTP status codes and their short meanings from the page (use the page's structure to locate them, then extract the values). |
| rs-baike-fact | https://baike.baidu.com/ | likely | article + infobox fact extraction (Wikipedia substitute) | Navigate within baike.baidu.com to an entry of your choice and report its title plus two facts from the entry's info box / summary. |

## Journey tasks (multi-step, read-only — the mechanisms single-shot tasks cannot reach)

These exercise the JOURNEY mechanisms (session-delta, granularity ceilings, render cache, trace-driven
relevance, conversation-once memory, tabId churn across navigation, wait orchestration, mid-chain
recovery). Every journey goal must instruct the agent to append a **JOURNEY LOG** to its report:
steps planned vs taken, calls per step, wrong turns (and the first wrong tool choice), recovery
events (timeouts / stale handles / re-observes and what fixed them). Operator grades calls-per-step
against the loose reference length — never exact-match (anti-overfit). Searches must be URL-navigated
(GET), never form-submitted.

| id | url | reach | capability under test | goal (given to the blind agent) | ref length |
|----|-----|-------|-----------------------|---------------------------------|------------|
| rs-j-linuxdo-drill | https://linux.do/ | confirmed | list→compare→open→read; SPA nav; tabId churn; session-delta on repeated observes | Among the top 10 topics on the list, find the one with the most replies, open it, and report: its title, the author of the first post, and a one-sentence summary of the first post. Append a JOURNEY LOG (steps planned/taken, calls per step, wrong turns, recovery events). | ~4 steps |
| rs-j-github-trace | https://github.com/ | likely | multi-page navigation chain; structured drill-down; wait-after-navigate | Open any public repository, then: report its star count and default branch, open the file list, descend into one folder, and report the path and name of one file inside it. Append a JOURNEY LOG. | ~5 steps |
| rs-j-mdn-cross | https://developer.mozilla.org/en-US/docs/Web/HTTP/Status | likely | doc→link→doc cross-page reading; content extraction across navigations | From the status-code index, follow the link to one specific status code's page and report: the code's name, its category, and one concrete usage detail from that page. Append a JOURNEY LOG. | ~3 steps |

## Causal tasks (operate an in-page control, read the change products)

Read-only in the server-mutation sense: in-page tab/filter clicks that fire GET reads only.

| id | url | reach | capability under test | goal (given to the blind agent) |
|----|-----|-------|-----------------------|---------------------------------|
| rs-c-bilibili-tab | https://www.bilibili.com/ | confirmed | baseline→action→treeDiff/causal workflow; network recorder + scan baseline | Start the network recorder and take a baseline scan. Click ONE channel/category tab on the home page (an in-page control). Then report what changed using the second scan's `treeDiff`/`diff` summary and `causal.requests` — do not re-derive the change by hand-diffing the page. |
| rs-c-linuxdo-filter | https://linux.do/ | confirmed | same workflow on a lighter SPA; category filter | Take a baseline scan, click one category/filter control in the topic list page, and report what changed via `treeDiff` and `causal.requests`. |

## Memory pair tasks (T2 companions for cold/warm paired runs, per D6)

T1 = the site's extraction task above; T2 = a DIFFERENT task on the same origin (below). Warm runs
keep `.pi/browser-memory/` state from the T1 run; controls run a fresh daemon with
`PI_BROWSER_MEMORY=0` (env must be set on the DAEMON, not the CLI call). The blind report must include
the MEMORY ADOPTION block (six fields, see the `pi-browser-blind-eval` skill).

| id | url | pairs with | goal (given to the blind agent) |
|----|-----|-----------|---------------------------------|
| rs-m-bilibili-nav | https://www.bilibili.com/ | rs-bilibili-home | Report the primary navigation and search affordances visible on the home page: their names/labels and where they sit on the page. |
| rs-m-linuxdo-struct | https://linux.do/ | rs-linuxdo-topics | Describe the topic list's structure: the visible fields/columns each row carries, and the visible category names on the page. |

Notes:
- `linux.do` and `bilibili.com` are confirmed reachable (operator had them open 2026-06-06); `linux.do`
  is the validated canonical run.
- **Execution-side tasks live in local fixtures**, not here (real sites are READ-ONLY): the
  execution-feedback form/canvas fixtures run via `eval:blind:launch -- --fixtures` (adoption-gate
  precedent: `ef-form-pi-resolve`, `ef-canvas-input-pointer` in `blind-findings.md`).
- For the pending G12/D6 nudge adjudication: run any extraction task against an UNCOVERED origin
  (wipe the store or pick a new site) and check `recordNudgeShown` → `recordCalled` in the adoption block.
- Add new China-reachable targets here as they prove useful; prefer ones that stress a specific
  capability so findings map to a fix.
- Keep the set small per run (token cost) and rotate sites to avoid overfitting to one DOM. Journey
  tasks have higher variance — the n≥2 cross-run rule matters MORE for them, not less.
