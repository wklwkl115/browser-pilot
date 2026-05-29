# Eval 27: WebSocket session transcript

## Goal

Given an explicit WebSocket URL and explicit message/matcher inputs, produce bounded session/transcript evidence without claiming a new public WebSocket browser tool exists.

## Fixture

- Local target: explicit local websocket endpoint only
- Required files:
  - `fixtures/ws-session-fixture.md`
- Setup notes:
  - No browser page discovery is required.
  - Input must stay explicit: session id, websocket URL, outbound text, bounded matcher.

## Allowed starting tools

- `browser_artifact`

## Expected tool sequence

1. Start from an explicit websocket URL and explicit session id.
2. Open a bounded internal session primitive.
3. Send explicit outbound text or run an explicit bounded replay step sequence.
4. Wait for a bounded inbound matcher.
5. On replay failure, inspect `stepIndex` / `lastSeq` / `partialTranscript` and keep the partial transcript artifact-first.
6. Collect a compact transcript summary and keep the full transcript artifact-first when large.

## Success criteria

- The task result includes correct open/send/wait/collect/close session facts.
- The result stays bounded and artifact-first.
- The agent does not claim a new public callable websocket fuzz tool exists.

## Required evidence

- Summary evidence:
  - `ws-summary`
  - session state
  - transcript count
  - matched inbound preview
  - replay failure `stepIndex` / `lastSeq` when applicable
- Artifact evidence:
  - `artifact-path`
  - transcript artifact path when explicitly saved or large
  - partial transcript artifact path on replay failure
- Diagnostics evidence:
  - `matcher-diagnostics`
  - invalid/unsafe matcher rejection when regex is unsafe
  - replay failure partial-step diagnostics

## Recovery checks

- Expected failure mode:
  - invalid URL/session input
  - unsafe regex matcher
  - no matching inbound message before timeout
  - bounded replay failure on a specific step
- Required recovery path:
  - narrow the matcher or use `contains`
  - use `stepIndex` / `lastSeq` / `partialTranscript` to continue diagnosis from the failing step
  - keep explicit input instead of discovery/orchestration

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
