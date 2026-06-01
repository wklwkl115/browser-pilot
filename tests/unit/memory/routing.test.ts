import test from "node:test";
import assert from "node:assert/strict";
import { memoryRoutingTokens, buildMemoryRoutingIndex, routeByTokens, situationTokens } from "../../../src/tools/memory/routing.ts";

test("routing tokens come from title + triggers, deduped, length >= 3", () => {
	const tokens = memoryRoutingTokens({ title: "login flow", triggers: ["login", "auth"] });
	assert.deepEqual(new Set(tokens), new Set(["login", "flow", "auth"]));
	// "login" appears in both title and triggers but is counted once.
	assert.equal(tokens.length, 3);
	// short tokens (<3 chars) are dropped.
	assert.deepEqual(memoryRoutingTokens({ title: "a to do", triggers: [] }), []);
});

test("the inverted index maps tokens to active entry ids only", () => {
	const routing = buildMemoryRoutingIndex([
		{ id: "a", status: "active", title: "login flow", triggers: ["login", "auth"] },
		{ id: "b", status: "active", title: "checkout pay", triggers: ["checkout"] },
		{ id: "c", status: "deprecated", title: "login legacy", triggers: ["login"] },
	]);
	assert.deepEqual(routing.login, ["a"], "deprecated entry c must not route");
	assert.deepEqual(routing.checkout, ["b"]);
	assert.equal(routing.legacy, undefined, "deprecated entry's tokens are absent");
});

test("routeByTokens scores by token overlap", () => {
	const routing = buildMemoryRoutingIndex([
		{ id: "a", status: "active", title: "recon endpoints sweep", triggers: ["recon", "endpoints"] },
		{ id: "b", status: "active", title: "login flow", triggers: ["login"] },
	]);
	const overlaps = routeByTokens(routing, situationTokens("recon endpoints please"));
	assert.equal(overlaps.get("a"), 2, "two query tokens overlap entry a");
	assert.equal(overlaps.get("b"), undefined, "entry b shares no tokens");
});

test("routeByTokens tolerates a missing routing index", () => {
	assert.equal(routeByTokens(undefined, ["x"]).size, 0);
});

test("situationTokens lowercases, splits on non-alphanumerics, dedups", () => {
	assert.deepEqual(situationTokens("Login Flow! login"), ["login", "flow"]);
});
