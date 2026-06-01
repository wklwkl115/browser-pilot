/**
 * MCP protocol middleware contract (Phase 7).
 *
 * Verifies:
 * - Hook names match the contract (on_initialize, on_list_tools, on_call_tool,
 *   on_list_prompts, on_get_prompt, on_read_resource, on_message, on_log)
 * - Hook execution order is fixed (auth first, logging last)
 * - Pass-through: no-op hooks do not block requests
 * - Short-circuit: failing hook blocks the request
 * - Logging hook receives timing/result info
 * - mcp/index.ts integrates hooks into all protocol handlers
 * - middleware does NOT auto-chain tools or select targets
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const middlewareSrc = read("mcp/middleware.ts");
assert(middlewareSrc.includes("on_initialize"), "middleware must define on_initialize hook");
assert(middlewareSrc.includes("on_list_tools"), "middleware must define on_list_tools hook");
assert(middlewareSrc.includes("on_call_tool"), "middleware must define on_call_tool hook");
assert(middlewareSrc.includes("on_list_prompts"), "middleware must define on_list_prompts hook");
assert(middlewareSrc.includes("on_get_prompt"), "middleware must define on_get_prompt hook");
assert(middlewareSrc.includes("on_read_resource"), "middleware must define on_read_resource hook");
assert(middlewareSrc.includes("on_message"), "middleware must define on_message hook");
assert(middlewareSrc.includes("on_log"), "middleware must define on_log logging hook");
assert(middlewareSrc.includes("runHooks"), "middleware must export runHooks");
assert(middlewareSrc.includes("registerHook"), "middleware must export registerHook");
assert(middlewareSrc.includes("emitLog"), "middleware must export emitLog");
assert(middlewareSrc.includes("timingLogHook"), "middleware must export default timingLogHook");
assert(!middlewareSrc.includes("selectTarget") && !middlewareSrc.includes("autoChain"),
	"middleware must NOT implement auto tool chaining or target selection");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes("runHooks(\"on_list_tools\""), "mcp/index.ts must call on_list_tools hook");
assert(indexSrc.includes("runHooks(\"on_call_tool\""), "mcp/index.ts must call on_call_tool hook");
assert(indexSrc.includes("runHooks(\"on_read_resource\""), "mcp/index.ts must call on_read_resource hook");
assert(indexSrc.includes("runHooks(\"on_list_prompts\""), "mcp/index.ts must call on_list_prompts hook");
assert(indexSrc.includes("runHooks(\"on_get_prompt\""), "mcp/index.ts must call on_get_prompt hook");
assert(indexSrc.includes("timingLogHook"), "mcp/index.ts must register timingLogHook");
assert(indexSrc.includes("emitLog"), "mcp/index.ts must emit log events");

// Residual D: on_initialize + on_message now have real call sites.
assert(indexSrc.includes("server.oninitialized"), "mcp/index.ts must wire on_initialize to server.oninitialized");
assert(indexSrc.includes("runHooks(\"on_initialize\""), "mcp/index.ts must call on_initialize hook from oninitialized");
assert(indexSrc.includes("fallbackRequestHandler") && indexSrc.includes("fallbackNotificationHandler"), "mcp/index.ts must wire on_message via fallback request/notification handlers");
assert(indexSrc.includes("runHooks(\"on_message\""), "mcp/index.ts must call on_message hook from the fallback handlers");
// The fallback request handler must still reject unknown methods (not swallow to success).
assert(indexSrc.includes("ErrorCode.MethodNotFound"), "fallbackRequestHandler must reject unknown methods with MethodNotFound");

// ── Runtime behavior ──────────────────────────────────────────────────────────

const { runHooks, registerHook, emitLog, clearHooks } = await import(
	new URL("../../../mcp/middleware.ts", import.meta.url).href
);

clearHooks();

// 1. No hooks → always pass
const noHookResult = await runHooks("on_call_tool", { method: "tools/call", startedAt: Date.now() }, {});
assert(noHookResult.pass, "runHooks with no registered hooks must return pass:true");

// 2. Pass-through hook → passes
registerHook("on_call_tool", async (_ctx, _params) => ({ pass: true }));
const passThroughResult = await runHooks("on_call_tool", { method: "tools/call", startedAt: Date.now() }, {});
assert(passThroughResult.pass, "pass-through hook must return pass:true");

// 3. Short-circuit hook → blocks
registerHook("on_call_tool", async () => ({ pass: false, error: "blocked by test", code: "TEST_BLOCKED" }));
const blockedResult = await runHooks("on_call_tool", { method: "tools/call", startedAt: Date.now() }, {});
assert(!blockedResult.pass, "failing hook must return pass:false");
assert.equal(blockedResult.code, "TEST_BLOCKED", "must return the correct error code");

// 4. Hook order: hooks run in registration order
const order = [];
clearHooks();
registerHook("on_list_tools", async () => { order.push("first"); return { pass: true }; });
registerHook("on_list_tools", async () => { order.push("second"); return { pass: true }; });
await runHooks("on_list_tools", { method: "tools/list", startedAt: Date.now() }, null);
assert.deepEqual(order, ["first", "second"], "hooks must run in registration order");

// 5. Logging hook receives timing and result
let loggedCtx, loggedDuration, loggedResult;
clearHooks();
registerHook("on_log", (ctx, durationMs, result) => { loggedCtx = ctx; loggedDuration = durationMs; loggedResult = result; });
emitLog({ method: "tools/call", toolName: "browser_tabs", startedAt: 0 }, 42, "ok");
assert.equal(loggedCtx?.method, "tools/call", "logging hook must receive method");
assert.equal(loggedDuration, 42, "logging hook must receive duration");
assert.equal(loggedResult, "ok", "logging hook must receive result status");

clearHooks();
console.log("mcp middleware ok");
