import assert from "node:assert/strict";
import test from "node:test";
import { mapBrowserOperationToAgentOutcome } from "../../src/kernels/agent/agentOutcome.js";
import { decideAfterAct } from "../../src/kernels/agent/agentDecision.js";
import { AGENT_TURN_SCHEMA, AGENT_VIEW_SCHEMA } from "../../src/kernels/agent/agentTypes.js";
import { buildRunnableCliCommands } from "../../src/apps/cli/registry.js";
import { validateBrowserCommandArguments } from "../../src/commands/commandValidation.js";
import { compileSemanticAction } from "../../src/browser-command-runtime/semanticActionCompiler.js";
import type { AgentCandidateBinding } from "../../src/kernels/agent/agentTypes.js";

test("browser_act validates published kinds and required fields", () => {
	const act = buildRunnableCliCommands().find((c) => c.name === "browser_act");
	assert.ok(act);
	const ok = validateBrowserCommandArguments(act.def, {
		contextRef: "ctx",
		action: { kind: "activate", ref: "a_01" },
	});
	assert.equal(ok.ok, true);
	const bad = validateBrowserCommandArguments(act.def, {
		contextRef: "ctx",
		action: { kind: "select", ref: "a_01", value: "x" },
	});
	assert.equal(bad.ok, false);
	const navigateNoUrl = validateBrowserCommandArguments(act.def, {
		contextRef: "ctx",
		action: { kind: "navigate" },
	});
	assert.equal(navigateNoUrl.ok, false);
	const pressNoKey = validateBrowserCommandArguments(act.def, {
		contextRef: "ctx",
		action: { kind: "press" },
	});
	assert.equal(pressNoKey.ok, false);
	const fillNoValue = validateBrowserCommandArguments(act.def, {
		contextRef: "ctx",
		action: { kind: "fill", ref: "a_01" },
	});
	assert.equal(fillNoValue.ok, false);
});

test("AgentTurn outcome-first: post-view absence cannot invent success", () => {
	const outcome = mapBrowserOperationToAgentOutcome("effect_observed");
	const decision = decideAfterAct({ outcome, candidates: [] });
	assert.equal(outcome.ok, false);
	assert.notEqual(decision.kind, "choose_action");
	const turn = {
		schema: AGENT_TURN_SCHEMA,
		outcome,
		viewStatus: "unavailable" as const,
		viewUnavailableReason: "VIEW_UNAVAILABLE",
		decision,
	};
	assert.equal(turn.outcome.classification, "inconclusive");
	assert.equal(turn.viewStatus, "unavailable");
});

test("default envelopes do not embed raw mechanical ids in agent view shape", () => {
	const view = {
		schema: AGENT_VIEW_SCHEMA,
		context: { contextRef: "ctx_abc", contextRevision: 2, state: "anchored", pageChanged: false },
		page: { url: "https://example.test/", changed: false },
		summary: "ok",
		notices: [],
		candidates: [{ ref: "a_01", role: "button", actions: ["activate"] as const }],
		decision: { kind: "choose_action" as const, candidateRefs: ["a_01"] },
		limits: { cost: { chars: 10, bytes: 10, estimatedTokens: 3 } },
		trace: { available: false, unavailableReason: "none" },
	};
	const text = JSON.stringify(view);
	assert.doesNotMatch(text, /browserSessionId|pageEpoch|backendNodeId|"tabId"/);
});

test("stale candidate ref fails compile before dispatch", () => {
	const bindings = new Map<string, AgentCandidateBinding>();
	const compiled = compileSemanticAction({ kind: "activate", ref: "a_99" }, bindings);
	assert.ok("code" in compiled);
	assert.equal(compiled.code, "REF_STALE");
});
