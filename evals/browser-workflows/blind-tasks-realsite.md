# Blind-eval real-site task bank (mainland-China reachable, READ-ONLY)

Targets for the `pi-browser-blind-eval` skill. Every task is **read-only** (no login / submit / post)
and chosen to be reachable from a **mainland-China** network (see
`blind-eval-protocol-realsite-skill-china`). Sites change — treat `goal` as the intent and grade on
"did it extract a plausible correct answer + via which tool path", not an exact string. Always
pre-flight (`observe` must not land on `chrome-error://`) before spawning the agent; swap a target that
stopped loading.

`reach`: `confirmed` = seen loading on the operator's network; `likely` = generally CN-reachable but
verify per run.

| id | url | reach | capability under test | goal (given to the blind agent) |
|----|-----|-------|-----------------------|---------------------------------|
| rs-linuxdo-topics | https://linux.do/ | confirmed | SPA list perception + per-item value extraction + wait-for-hydration | Report the titles of the top 5 topics shown in the topic list, with each topic's reply count if visible. The page is a dynamic SPA; wait for the topic list before reading. |
| rs-bilibili-home | https://www.bilibili.com/ | confirmed | heavy SPA cards, lazy/virtualized content, value extraction | Report the titles of 5 video cards currently visible on the home page, with the uploader name for each if shown. |
| rs-github-repo | https://github.com/ | likely | static-ish structured page, file/list reading, table-ish rows | On a public repository page (navigate within github.com to one if needed), report the names of the top-level files/folders shown in the file list and the repository's star count. |
| rs-mdn-table | https://developer.mozilla.org/en-US/docs/Web/HTTP/Status | likely | long structured doc + relations/table reading boundary | Report 5 HTTP status codes and their short meanings from the page (use the page's structure to locate them, then extract the values). |
| rs-baike-fact | https://baike.baidu.com/ | likely | article + infobox fact extraction (Wikipedia substitute) | Navigate within baike.baidu.com to an entry of your choice and report its title plus two facts from the entry's info box / summary. |

Notes:
- `linux.do` and `bilibili.com` are confirmed reachable (operator had them open 2026-06-06); `linux.do`
  is the validated canonical run.
- Add new China-reachable targets here as they prove useful; prefer ones that stress a specific
  capability (lists/tables, SPA hydration, causal/network, long content) so findings map to a fix.
- Keep the set small per run (token cost) and rotate sites to avoid overfitting to one DOM.
