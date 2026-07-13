import assert from "node:assert/strict";
import test from "node:test";
import { compileSemanticAction } from "../../src/browser-command-runtime/semanticActionCompiler.js";
import type { AgentCandidateBinding } from "../../src/kernels/agent/agentTypes.js";
import { SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY } from "../../src/commands/operationResolvers.js";
import { AGENT_PUBLISHED_WRITE_KINDS } from "../../src/kernels/agent/agentTypes.js";
import { SEMANTIC_COMPLETION_RESOLVER_IDS } from "../../src/kernels/agent/semanticAction.js";

function binding(ref = "a_01"): AgentCandidateBinding {
	return {
		ref,
		contextRevision: 1,
		pageIdentity: {
			browserSessionId: "s",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e",
			url: "https://x.test/",
		},
		resourceRef: "bp-ref://fixture/email",
		role: "textbox",
		allowedActions: ["fill", "press", "activate"],
		createdAt: 1,
	};
}

test("compile activate/fill into trusted program frames", () => {
	const bindings = new Map([["a_01", binding()]]);
	const activate = compileSemanticAction({ kind: "activate", ref: "a_01" }, bindings);
	assert.ok("execution" in activate);
	assert.equal(activate.execution.kind, "program");
	if (activate.execution.kind === "program") {
		assert.equal(activate.execution.program[0]?.kind, "mouse");
	}

	const fill = compileSemanticAction({ kind: "fill", ref: "a_01", value: "user@example.test" }, bindings);
	assert.ok("execution" in fill);
	if (fill.execution.kind === "program") {
		assert.ok(fill.execution.program.some((frame) => frame.kind === "text"));
	}
});

test("rejects unpublished select on agent-preview", () => {
	const bindings = new Map([["a_01", binding()]]);
	const result = compileSemanticAction({ kind: "select", ref: "a_01", value: "x" }, bindings);
	assert.ok("code" in result);
	assert.equal(result.code, "ACTION_UNSUPPORTED_SURFACE");
});

test("semantic resolver registry covers every published write kind", () => {
	for (const kind of AGENT_PUBLISHED_WRITE_KINDS) {
		const id = SEMANTIC_COMPLETION_RESOLVER_IDS[kind];
		assert.ok(id in SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY, `missing resolver ${id}`);
	}
});
