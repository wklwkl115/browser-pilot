// Frontend middleware (relocated from mcp/middleware in the CLI migration). The
// daemon uses the on_log path (emitLog + timingLogHook + usage logging); the
// runHooks gating pipeline is exercised here. Replaces the reusable coverage that
// the MCP-protocol middleware contract used to provide.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHook, runHooks, emitLog, clearHooks, type MiddlewareContext } from "../../../src/frontend/middleware.ts";

function ctx(): MiddlewareContext {
	return { method: "invoke", toolName: "browser_execute", startedAt: 0 };
}

test("runHooks passes when all hooks pass, in registration order", async () => {
	clearHooks();
	const order: number[] = [];
	registerHook("on_call_tool", () => { order.push(1); return { pass: true }; });
	registerHook("on_call_tool", async () => { order.push(2); return { pass: true }; });
	const result = await runHooks("on_call_tool", ctx(), {});
	assert.deepEqual(result, { pass: true });
	assert.deepEqual(order, [1, 2], "hooks run in registration order");
	clearHooks();
});

test("runHooks short-circuits on the first failing hook", async () => {
	clearHooks();
	let secondRan = false;
	registerHook("on_call_tool", () => ({ pass: false, code: "BLOCKED", error: "denied" }));
	registerHook("on_call_tool", () => { secondRan = true; return { pass: true }; });
	const result = await runHooks("on_call_tool", ctx(), {});
	assert.deepEqual(result, { pass: false, code: "BLOCKED", error: "denied" });
	assert.equal(secondRan, false, "a failing hook blocks later hooks");
	clearHooks();
});

test("emitLog delivers timing/result to every on_log hook", () => {
	clearHooks();
	const seen: Array<{ result: string; ms: number; code?: unknown }> = [];
	registerHook("on_log", (_c, ms, result, details) => { seen.push({ result, ms, code: details?.code }); });
	registerHook("on_log", (_c, ms, result) => { seen.push({ result, ms }); });
	emitLog(ctx(), 42, "error", { code: "X" });
	assert.equal(seen.length, 2, "both on_log hooks fire");
	assert.equal(seen[0].result, "error");
	assert.equal(seen[0].ms, 42);
	assert.equal(seen[0].code, "X");
	clearHooks();
});

test("clearHooks removes all registered hooks", async () => {
	clearHooks();
	registerHook("on_call_tool", () => ({ pass: false, code: "X", error: "x" }));
	clearHooks();
	assert.deepEqual(await runHooks("on_call_tool", ctx(), {}), { pass: true }, "no hooks remain after clear");
});
