# Eval NN: Title

## Goal

State the user-visible task the agent must complete.

## Fixture

- Local target:
- Required files:
- Setup notes:

## Allowed starting tools

- `browser_tabs`

## Expected tool sequence

1. Start from explicit tab/session state.
2. Observe before acting.
3. Act with the narrowest tool that can complete the step.
4. Verify state with independent evidence.
5. Cite artifact paths when raw evidence is needed.

## Success criteria

- The task result is correct.
- The result includes sufficient evidence.
- The agent does not use a broader follow-up tool before baseline observation.

## Required evidence

- Summary evidence:
- Artifact evidence:
- Diagnostics evidence:

## Recovery checks

- Expected failure mode:
- Required recovery path:

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
