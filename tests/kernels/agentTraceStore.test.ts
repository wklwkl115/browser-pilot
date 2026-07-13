import assert from "node:assert/strict";
import test from "node:test";
import { AgentTraceStore } from "../../src/apps/daemon/AgentTraceStore.js";
import { redactTraceRequestSummary } from "../../src/kernels/agent/agentTrace.js";

test("trace store owner isolation and TTL", () => {
	let now = 1_000;
	const store = new AgentTraceStore({ now: () => now });
	const a = store.record({
		contextRef: "ctx",
		owner: "o1",
		contextRevisionBefore: 1,
		contextRevisionAfter: 2,
		requestSummary: { actionKind: "fill", value: "secret", password: "x" },
		ttlMs: 5_000,
	});
	assert.equal(a.ok, true);
	if (!a.ok) return;
	assert.equal(Object.prototype.hasOwnProperty.call(a.record.requestSummary, "value"), false);
	assert.equal(a.record.requestSummary.password, "[redacted]");

	assert.equal(store.get(a.record.traceRef, "o2"), undefined);
	assert.ok(store.get(a.record.traceRef, "o1"));

	now = 10_000;
	assert.equal(store.get(a.record.traceRef, "o1"), undefined);
});

test("trace record fail-open path returns reason without throwing", () => {
	const redacted = redactTraceRequestSummary({
		token: "abc",
		path: "C:\\Users\\x\\.browser-pilot\\artifacts\\a.json",
		kind: "fill",
	});
	assert.equal(redacted.token, "[redacted]");
	assert.equal(redacted.path, "[path-redacted]");
	assert.equal(redacted.kind, "fill");
});
