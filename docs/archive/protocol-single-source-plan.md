# Protocol Single Source Plan

> Summary archive for `docs/archive/protocol-single-source-plan.full.md`.

The protocol single-source migration decision is complete. The native browser
protocol continues to use `bridge/native_command_schema.json` as the maintained
source of truth, with generated runtime, Node, metadata, error-code, and
documentation artifacts checked by protocol contracts.

## Completed Outcome

- No external IDL was introduced.
- Native command names, callable tool names, parameters, summaries, saved
  envelopes, and error codes remained stable.
- `npm run sync:protocol` owns generated protocol outputs.
- `npm run check:protocol` and grouped bridge/contracts gates enforce drift.

## Evidence

- Full design/compatibility record:
  `docs/archive/protocol-single-source-plan.full.md`
- Runtime/generated protocol docs:
  `docs/generated/native-protocol.generated.md`
- Current verification entry points: `npm run check:protocol`,
  `npm run check:all:bridge`, and `npm run check`.
