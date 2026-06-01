# Eval 29: MCP middleware coverage

## Goal

Measure MCP protocol middleware coverage and decide whether unresolved `on_message` limits require a transport wrapper or only explicit handler hooks.

## Fixture

- Local target: `fixtures/mcp-middleware-coverage.json`
- Required files:
  - `fixtures/mcp-middleware-coverage.json`
- Setup notes: fixture is a deterministic expected-event matrix. It does not start an MCP server by itself and does not require a browser. Runtime verification may use the existing stdio MCP fixture only when explicitly run by a contract or smoke.

## Allowed starting tools

- `browser_artifact`
- MCP `tools/list`
- MCP `tools/call`
- MCP `resources/read`
- MCP `prompts/list`
- MCP `prompts/get`

## Expected tool sequence

1. Trigger or inspect the registered MCP request paths: `tools/list`, `tools/call`, `resources/read`, `prompts/list`, and `prompts/get`.
2. Trigger or inspect one unknown request method and one unknown notification method.
3. Map each path to the expected hook: `on_list_tools`, `on_call_tool`, `on_read_resource`, proposed `on_list_prompts`, proposed `on_get_prompt`, or fallback-only `on_message`.
4. Verify registered request handlers do not depend on fallback `on_message`.
5. Decide whether remaining coverage needs explicit prompt hooks or a broader transport wrapper.

## Success criteria

- Registered methods have explicit outer-ring hooks and timing/log diagnostics.
- Unknown methods continue through fallback `on_message` and still reject unknown requests with MethodNotFound.
- `on_message` is documented and tested as fallback-only, not as a universal interceptor.
- Passing state for prompt coverage requires `on_list_prompts` and `on_get_prompt` hook call sites; otherwise the eval records a small explicit-hook gap.
- The eval must not recommend a transport wrapper unless it proves a concrete handler path cannot be covered by explicit hooks.

## Required evidence

- Summary evidence: method-to-hook matrix and gap classification.
- Artifact evidence: `fixtures/mcp-middleware-coverage.json` and any optional hook event artifact from a runtime smoke.
- Diagnostics evidence: hook names observed or statically required, fallback `on_message` behavior, and whether any registered method lacks an explicit hook.

## Recovery checks

- Expected failure mode: assuming `on_message` sees `tools/list`, `tools/call`, `resources/read`, or `prompts/*` registered methods.
- Required recovery path: add explicit handler hooks for missing registered paths instead of wrapping transport or relying on fallback.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after failure
- artifact sufficiency
- scoped follow-up discipline
- registered method hook coverage ratio
- fallback-only method count
