# Blind-agent execution feedback adoption tasks

These archived tasks covered the `docs/archive/execution-feedback-layer-plan.full.md` Track F
adoption gate. They run against the isolated local fixture stage, not a real website, because they
intentionally mutate page state. Launch:

```bash
npm run eval:blind:launch -- --confirm --fixtures --url <fixture-url>
```

Use `evals/browser-workflows/pb-blind.mjs` from the spawned blind agent, as in the normal blind
protocol. Grade adoption from the command log, not from fixture success alone.

| id | fixture url path | allowed state changes | goal (given to blind agent) | adoption signal |
|---|---|---|---|---|
| ef-form-pi-resolve | `/fixtures/execution-feedback-form.html` | Fill the local fixture input only. | Set the Full name field to `Pi Agent`, then verify the page status reports `Status: filled:Pi Agent`. | Agent uses `browser_observe` to get the input ref, then `browser_execute` with `pi.resolve` or `pi.setValue`; selector transcription errors should be zero. |
| ef-canvas-input-pointer | `/fixtures/execution-feedback-canvas.html` | Press the local fixture canvas target only. | Hit the blue rectangle on the canvas, then verify the page status reports `Status: target hit`. | Agent uses `input.pointer` for the trusted physical press rather than expanding three raw CDP `Input.dispatchMouseEvent` calls. |

Metrics to record in `blind-findings.md` or a run artifact:

- whether `pi.resolve`, `pi.setValue`, or `pi.box` was adopted without being named in the task prompt
- whether `input.pointer` was adopted for the canvas task without raw CDP fallback
- selector transcription mistakes
- total command count from first observe to verified status
- any mismatch between `skills/pi-browser-tools/SKILL.md`, `--help`, and actual JSON output

Honest revert clause: if blind agents ignore `pi.*` the way they ignored the reverted action arm, keep
Track C internal/undocumented or revert it. Track A/D can still ship independently; Track B can ship
if the canvas task demonstrates `input.pointer` adoption.
