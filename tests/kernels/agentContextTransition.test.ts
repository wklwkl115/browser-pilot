import assert from "node:assert/strict";
import test from "node:test";
import {
	applyAgentContextIdentityTransition,
	assertAnchoredIdentityInvariant,
} from "../../src/kernels/agent/contextTransition.js";
import type { PageIdentity } from "../../src/kernels/session/pageIdentity.js";
import { pageReanchorReason } from "../../src/kernels/session/pageIdentity.js";
import { AgentContextRegistry } from "../../src/kernels/session/agentContextRegistry.js";

const identity = (over: Partial<PageIdentity> = {}): PageIdentity => ({
	browserSessionId: "s1",
	tabId: 1,
	targetGeneration: 1,
	pageEpoch: "e1",
	url: "https://example.test/",
	...over,
});

test("context transition consumes pageReanchorReason decision", () => {
	const previous = identity();
	const current = identity({ pageEpoch: "e2" });
	const reason = pageReanchorReason(previous, current);
	assert.equal(reason, "document_changed");
	const transition = applyAgentContextIdentityTransition(
		{ state: "anchored", pageIdentity: previous, revision: 1 },
		current,
		reason,
	);
	assert.equal(transition.clearPageBindings, true);
	assert.equal(transition.state, "needs_reanchor");
	assert.equal(transition.reanchorReason, "document_changed");
});

test("ghost-state invariant rejects anchored with identity drift", () => {
	assert.throws(() => assertAnchoredIdentityInvariant(
		"anchored",
		identity(),
		identity({ pageEpoch: "other" }),
	));
});

test("registry owner isolation and expiry", () => {
	const registry = new AgentContextRegistry({
		now: () => 1_000,
		newId: () => "ctx_fixed",
	});
	const a = registry.create("owner-a");
	const denied = registry.get(a.id, "owner-b");
	assert.deepEqual(denied, { error: "CONTEXT_OWNER_MISMATCH" });
	const ok = registry.get(a.id, "owner-a");
	assert.equal("error" in ok, false);

	const busy = registry.beginMutation(a, "op1");
	assert.equal("ok" in busy, true);
	const second = registry.beginMutation(a, "op2");
	assert.deepEqual(second, { error: "CONTEXT_BUSY" });
	registry.endMutation(a, "anchored");

	registry.expireAll();
	assert.deepEqual(registry.get(a.id, "owner-a"), { error: "CONTEXT_EXPIRED" });
});

test("identity transition clears candidate bindings", () => {
	const registry = new AgentContextRegistry({ newId: () => "ctx_1" });
	const ctx = registry.create("o");
	ctx.pageIdentity = identity();
	registry.replaceCandidateBindings(ctx, [{
		resourceRef: "bp-ref://x",
		role: "button",
		actions: ["activate"],
	}]);
	assert.equal(ctx.candidateBindings.size, 1);
	const result = registry.applyIdentity(ctx, identity({ pageEpoch: "e9" }), "document_changed");
	assert.equal(result.cleared, true);
	assert.equal(ctx.candidateBindings.size, 0);
});
