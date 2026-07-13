import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentView, l0ContainsRequiredActionables } from "../../src/kernels/agent/agentView.js";
import { AGENT_VIEW_SCHEMA } from "../../src/kernels/agent/agentTypes.js";
import type { PageObservationV3 } from "../../src/kernels/abml/pageObservation.js";
import { PAGE_OBSERVATION_SCHEMA_V3 } from "../../src/kernels/abml/pageObservation.js";

function fixtureObservation(actionables: Array<{ ref: string; kind: string; name?: string }>): PageObservationV3 {
	return {
		schema: PAGE_OBSERVATION_SCHEMA_V3,
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target: {
			browserSessionId: "s1",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e1",
			url: "https://fixture.test/form",
		},
		snapshot: {
			snapshotId: "snap-1",
			browserSessionId: "s1",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e1",
			url: "https://fixture.test/form",
			sourceMode: "scan",
			capturedAt: 1,
			ttlMs: 60_000,
		},
		actionables,
		providers: {},
		frontier: { items: [], truncated: false },
		limits: { budgetChars: 35_000, cost: { chars: 100, bytes: 100, estimatedTokens: 25 } },
		gist: { title: "Agent Fixture Form", text: "Sign in form" },
	} as PageObservationV3;
}

test("AgentView preserves canonical actionable order and aliases", () => {
	const observation = fixtureObservation([
		{ ref: "bp-ref://fixture/email", kind: "textbox", name: "Email" },
		{ ref: "bp-ref://fixture/password", kind: "textbox", name: "Password" },
		{ ref: "bp-ref://fixture/submit", kind: "button", name: "Continue" },
	]);
	const { view, candidateBindings } = projectAgentView({
		observation,
		context: {
			id: "ctx_test",
			revision: 1,
			state: "anchored",
			pageIdentity: {
				browserSessionId: "s1",
				tabId: 1,
				targetGeneration: 1,
				pageEpoch: "e1",
				url: "https://fixture.test/form",
			},
		},
	});
	assert.equal(view.schema, AGENT_VIEW_SCHEMA);
	assert.equal(view.candidates[0]?.ref, "a_01");
	assert.equal(candidateBindings[0]?.resourceRef, "bp-ref://fixture/email");
	assert.ok(view.candidates.some((c) => c.actions.includes("fill")));
	assert.ok(view.candidates.some((c) => c.actions.includes("activate")));
	const envelope = JSON.stringify(view);
	assert.doesNotMatch(envelope, /bp-ref:\/\//);
	assert.doesNotMatch(envelope, /pageEpoch/);
	assert.doesNotMatch(envelope, /"tabId":\s*1/);
});

test("L0 recall requires required actionables under budget", () => {
	const observation = fixtureObservation([
		{ ref: "bp-ref://fixture/email", kind: "textbox", name: "Email" },
		{ ref: "bp-ref://fixture/submit", kind: "button", name: "Continue" },
	]);
	const { view, candidateBindings } = projectAgentView({ observation, context: { id: "c", revision: 1, state: "anchored" } });
	const recall = l0ContainsRequiredActionables(view.candidates, candidateBindings, ["bp-ref://fixture/email"]);
	assert.equal(recall.ok, true);
});

test("budget trims candidates but keeps at least one", () => {
	const many = Array.from({ length: 40 }, (_, i) => ({
		ref: `bp-ref://item/${i}`,
		kind: "button",
		name: `Item ${i}`,
	}));
	const { view } = projectAgentView({
		observation: fixtureObservation(many),
		context: { id: "c", revision: 1, state: "anchored" },
		maxChars: 800,
	});
	assert.ok(view.candidates.length >= 1);
	assert.ok(view.candidates.length <= 12);
	assert.ok(view.limits.cost.chars <= 800 || view.limits.truncated);
});
