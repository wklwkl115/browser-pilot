# Browser task evaluation

`npm run eval:browser` executes scripted tasks in a real headless Chrome/Edge browser against **controlled local fixtures**. It exercises public browser tools through the daemon, not private DOM adapters. It is a task regression baseline, not evidence of arbitrary website success or an LLM's planning ability.

## Run

```sh
npm run eval:browser
npm run eval:browser -- --rounds 10 --output .cache/browser-eval/baseline.json
```

Node.js 22+ and Chrome/Edge are required. Set `BROWSER_PILOT_SMOKE_BROWSER` to choose the executable, as for `npm run smoke:browser`. The default is three rounds; valid round counts are 1–50. No external URL or authenticated-account input is accepted.

The shared harness creates a temporary browser profile and a private copy of the extension with an ephemeral pairing secret. It does not install into the user's extension directory or use their cookies. Browser startup/build time is outside task timing. Each attempt navigates to fresh fixture state; failed writes are never automatically retried.

## Scenarios

| Task                   | Kind     | Independent completion check                                                                                                    |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `async-form`           | Workflow | Enter a title, submit once, await a 650 ms server response; the fixture server confirms exactly one matching saved request.     |
| `async-invoice-lookup` | Workflow | Filter an asynchronously loaded invoice list (950 ms), open the overdue record, and check the displayed record ID.              |
| `rerender-ref`         | Workflow | Replace a button with an equivalent DOM node, use the original ref, and assert exactly one save.                                |
| `stale-target-guard`   | Safety   | Replace a safe action with a different action; require explicit stale-ref rejection and verify the replacement was not clicked. |

Fixtures retain a CSP that blocks page `eval`. Evaluation therefore also exercises safe CDP fallback without removing page security headers. Control selection requires one matching control, not a similarly named label.

## Report

The default report is `.cache/browser-eval/report.json`. It records Node/platform/browser metadata, extension build identity, fixture version, per-attempt results, and per-task/overall summaries:

- success rate, attempted/passed/failed counts;
- P50/P95/max task latency using nearest-rank percentiles;
- success-only latency separately, so early failures cannot make a broken run look faster;
- tool-call counts, serialized response JSON UTF-8 bytes, and inline text length in UTF-16 code units;
- failure category/code, including observation, tool, verification, assertion, and transport errors.

Output counts cover completed tool responses only; resource bodies not requested by the task are excluded. Bytes/characters are **not token counts**: model-specific tokenization is not performed. A harness failure produces a nonzero exit code and a report with `harnessFailure`; zero attempts never yields a 100% success rate. Any failed or missing task also returns nonzero.

Ordinary CI runs two rounds and retains only the summary JSON; the Windows release gate runs three rounds. Raw local captures remain under the report directory's `.browser-pilot/artifacts/` and are not uploaded.

## Interpret results

Compare the same fixture version, browser build, Node version, platform, and round count. Treat P95 from a few samples as a smoke indicator, not a production latency estimate. Inspect workflow and safety results separately; passing a rejection test is not a completed business transaction.

There are no performance thresholds yet. Record repeated baselines before setting budgets. Real authenticated sites, long-running sessions, browser restarts, cross-origin frames, and model planning remain outside this suite. Add those as explicit scenarios rather than generalizing from the current success rate.
