# Browser task evaluation

`npm run eval:browser` executes scripted tasks in a real headless Chrome/Edge browser against **controlled local fixtures**. It exercises public browser tools through the daemon, not private DOM adapters. It is a task regression baseline, not evidence of arbitrary website success or an LLM's planning ability.

## Run

```sh
npm run eval:browser
npm run eval:browser -- --list
npm run eval:browser -- --suite core --rounds 3
npm run eval:browser -- --task frame-cross --task browser-reconnect --rounds 3
npm run eval:browser -- --suite all --rounds 10 --output .cache/browser-eval/baseline.json
```

Node.js 22+ and Chrome/Edge are required. Set `BROWSER_PILOT_SMOKE_BROWSER` to choose the executable, as for `npm run smoke:browser`. The default is all 14 tasks for three rounds; valid round counts are 1–50. Select `core` (4), `extended` (10), or `all` with `--suite`. Repeat `--task` to select named tasks within that suite. `--list` lists the selected scenarios without launching a browser. Unknown IDs, empty selections, and conflicting filters fail before execution. No external URL or authenticated-account input is accepted.

The shared harness creates a temporary browser profile and a private copy of the extension with an ephemeral pairing secret. It does not install into the user's extension directory or use their cookies. Initial browser startup/build time is outside task timing; an explicit restart inside a recovery task is included. Each attempt navigates to fresh fixture state; failed writes are never automatically retried.

## Scenarios (fixture version 5)

| Task                   | Kind     | Independent completion check                                                                                                                                                      |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `async-form`           | Workflow | Submit once; declared success requires the save response and a captured GET readback with the expected record ID and title. The fixture independently confirms one saved request. |
| `async-invoice-lookup` | Workflow | Filter an asynchronously loaded invoice list (950 ms), open the overdue record, and check the displayed record ID.                                                                |
| `rerender-ref`         | Workflow | Replace a button with an equivalent DOM node, use the original ref, and assert exactly one save.                                                                                  |
| `stale-target-guard`   | Safety   | Replace a safe action with a different action; require explicit stale-ref rejection and verify the replacement was not clicked.                                                   |

The four scenarios above form the `core` suite. The `extended` suite adds:

| Task                      | Kind     | Completion or safety oracle                                                                                                                                                    |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `failed-submit-no-replay` | Safety   | An optimistic Saved message is followed by a delayed 503. Continued observation verifies the failure UI and business failure under the same operation ID without resubmitting. |
| `spa-ref-continuity`      | Workflow | A history route change preserves document identity and an existing input ref.                                                                                                  |
| `multitab-ref-ownership`  | Safety   | A ref updates its owning tab while a second active tab with identical labels remains untouched.                                                                                |
| `frame-same`              | Workflow | Read/write a same-origin child frame without modifying its parent.                                                                                                             |
| `frame-cross`             | Workflow | Read/write a different-origin child frame while parent-page same-origin restrictions remain intact.                                                                            |
| `frame-nested`            | Workflow | Discover and operate on a nested child while retaining hierarchy and parent isolation.                                                                                         |
| `occluded-control-guard`  | Safety   | Covered controls reject input and execute no action.                                                                                                                           |
| `browser-reconnect`       | Recovery | Close the browser, wait for disconnect, reconnect a fresh isolated profile to the same daemon, reject old refs, and use a freshly observed control.                            |

Frame origins use two loopback ports: they are cross-origin but same-site. This does not test out-of-process cross-site frames (OOPIFs). The restart case intentionally uses a fresh profile; persisted login/session restoration is not claimed.

The extended suite also includes two single-Agent task-view scenarios:

| Task                  | Kind     | Completion or safety oracle                                                                                                                                                                              |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-view-record`    | Workflow | Find an invoice beyond unrelated controls, expand its snapshot resource, preserve an external field error and current values, edit/save only that record, and keep historical resource values unchanged. |
| `task-view-ambiguity` | Safety   | Preserve distinct records with identical Save buttons, bound zero-match claims to captured evidence, execute no writes during projection, and reject an explicit focus after navigation.                 |

Task-view coverage exercises the MCP text representation and resource adapter. It does not certify any particular host application's resource UX or an LLM's ability to choose the right candidate.

Fixtures retain a CSP that blocks page `eval`. Evaluation therefore also exercises safe CDP fallback without removing page security headers. Control selection requires one matching control, not a similarly named label.

## Report

The default report is `.cache/browser-eval/report.json`. It records Node/platform/browser metadata, extension build identity, fixture version, the selected task IDs, planned attempt count, per-attempt results, and per-task/per-kind/overall summaries:

- success rate, attempted/passed/failed counts;
- P50/P95/max task latency using nearest-rank percentiles;
- success-only latency separately, so early failures cannot make a broken run look faster;
- tool-call counts, serialized response JSON UTF-8 bytes, and inline text length in UTF-16 code units;
- completed resource-read counts and their response sizes; rendered MCP response bytes, including structured content, text and resource links;
- per-step timing, response sizes, verification status, and explicitly expected rejections;
- execution receipt and business outcome statuses, separately from assertion verification;
- failure category/code, including observation, tool, verification, assertion, transport, and recovery errors.

Output counts cover completed tool responses and resource reads; resource bodies not requested by the task are excluded. `responseJsonBytes` measures daemon tool responses plus resource responses, while `mcpResponseJsonBytes` measures rendered MCP results plus resource responses. These are separate totals, not additive costs. Bytes/characters are **not token counts**: model-specific tokenization is not performed. A harness failure produces a nonzero exit code and a report with `harnessFailure`; zero attempts never yields a 100% success rate. Any failed or missing task also returns nonzero.

For changes outside the documentation-only route, CI runs all scenarios for two rounds on Linux and Windows and retains only the summary JSON with OS-specific artifact names; the Windows release gate always runs all scenarios for three rounds. See [repository guidelines](../AGENTS.md#testing-guidelines) for validation triggers. Raw local captures remain under the report directory's `.browser-pilot/artifacts/` and are not uploaded.

## Interpret results

Compare the same fixture version, browser build, Node version, platform, and round count. Treat P95 from a few samples as a smoke indicator, not a production latency estimate. Inspect workflow and safety results separately; passing a rejection test is not a completed business transaction.

There are no performance thresholds yet. Record repeated baselines before setting budgets. Real authenticated sites, hour-scale sessions, persisted-profile recovery, OOPIFs, uploads/downloads, and model planning remain outside this suite. Add those as explicit scenarios rather than generalizing from the current success rate.

## Extending the suite

Keep fixtures deterministic and loopback-only. Each task must have a stable ID, suite, kind, and an independent completion oracle; asserting only a successful tool envelope is insufficient. Negative tests must name the expected rejection code and verify that no action occurred. Keep retries out of mutating tasks. Add fixture/contract tests under `tests/runtime/` or `tests/extension/`, update the catalog test when intentionally changing coverage, and increment `fixtureVersion` when changing existing scenario semantics. Keep raw responses, secrets, and user data out of the summary report.

Resource costs are also reported as cumulative `resourceResponseJsonBytes` and maximum `maxResourceResponseJsonBytes`; resource steps identify index/group/scope reads. Fixture version 5 nests the target invoice field in a fieldset to exercise owner-context recovery.
