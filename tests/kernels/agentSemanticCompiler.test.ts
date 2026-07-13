import assert from "node:assert/strict";
import test from "node:test";
import { compileSemanticAction, selectAllProgram } from "../../src/browser-command-runtime/semanticActionCompiler.js";
import { dispatchProgramElement, validateProgram } from "../../src/browser-command-runtime/programDispatcher.js";
import type { AgentCandidateBinding } from "../../src/kernels/agent/agentTypes.js";
import { SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY } from "../../src/commands/operationResolvers.js";
import { AGENT_PUBLISHED_WRITE_KINDS } from "../../src/kernels/agent/agentTypes.js";
import { SEMANTIC_COMPLETION_RESOLVER_IDS } from "../../src/kernels/agent/semanticAction.js";

function binding(ref = "a_01", actions: AgentCandidateBinding["allowedActions"] = ["fill", "press", "activate"]): AgentCandidateBinding {
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
		allowedActions: actions,
		createdAt: 1,
	};
}

function assertValidProgram(program: unknown[]) {
	const validation = validateProgram(program);
	assert.equal(validation.ok, true, validation.ok ? "" : validation.error);
	for (let i = 0; i < program.length; i++) {
		const dispatched = dispatchProgramElement(program[i], i);
		assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.error);
	}
}

test("compile activate emits programOps mouse press/release frames", () => {
	const bindings = new Map([["a_01", binding("a_01", ["activate"])]]);
	const activate = compileSemanticAction({ kind: "activate", ref: "a_01" }, bindings);
	assert.ok("execution" in activate);
	assert.equal(activate.execution.kind, "program");
	if (activate.execution.kind !== "program") throw new Error("expected program");
	assertValidProgram(activate.execution.program);
	assert.deepEqual(activate.execution.program[0], { mouse: "press", ref: "bp-ref://fixture/email", button: "left" });
	assert.deepEqual(activate.execution.program[1], { mouse: "release", ref: "bp-ref://fixture/email", button: "left" });
	assert.equal(activate.completionResolverId, "semantic.activate");
	// Broken legacy shape must not validate
	const legacy = validateProgram([{ kind: "mouse", action: "click", ref: "bp-ref://fixture/email" }]);
	assert.equal(legacy.ok, false);
});

test("compile fill emits focus click, select-all keys, and text op", () => {
	const bindings = new Map([["a_01", binding()]]);
	const fill = compileSemanticAction({ kind: "fill", ref: "a_01", value: "user@example.test" }, bindings);
	assert.ok("execution" in fill);
	if (fill.execution.kind !== "program") throw new Error("expected program");
	assertValidProgram(fill.execution.program);
	assert.ok(fill.execution.program.some((frame) => frame.mouse === "press"));
	assert.ok(fill.execution.program.some((frame) => frame.key === "down" && frame.code === "KeyA"));
	assert.ok(fill.execution.program.some((frame) => frame.text === "user@example.test"));
	assert.equal(fill.completionResolverId, "semantic.fill");
});

test("compile press/scroll emit valid key/wheel frames", () => {
	const bindings = new Map([["a_01", binding()]]);
	const press = compileSemanticAction({ kind: "press", key: "Enter" }, bindings);
	assert.ok("execution" in press && press.execution.kind === "program");
	if (press.execution.kind === "program") {
		assertValidProgram(press.execution.program);
		assert.ok(press.execution.program.some((frame) => frame.key === "down" && frame.code === "Enter"));
	}
	const scroll = compileSemanticAction({ kind: "scroll", direction: "down", amount: "page" }, bindings);
	assert.ok("execution" in scroll && scroll.execution.kind === "program");
	if (scroll.execution.kind === "program") {
		assertValidProgram(scroll.execution.program);
		assert.equal(scroll.execution.program[0]?.mouse, "wheel");
	}
});

test("select without allowedActions is rejected; with select action compiles", () => {
	const bindings = new Map([["a_01", binding("a_01", ["activate"])]]);
	const denied = compileSemanticAction({ kind: "select", ref: "a_01", value: "x" }, bindings);
	assert.ok("code" in denied);
	assert.equal(denied.code, "ACTION_NOT_ALLOWED");
	const allowed = new Map([["a_01", binding("a_01", ["select"])]]);
	const ok = compileSemanticAction({ kind: "select", ref: "a_01", value: "US" }, allowed);
	assert.ok("execution" in ok);
});

test("navigate without url and press without key fail at compile", () => {
	const bindings = new Map([["a_01", binding()]]);
	const nav = compileSemanticAction({ kind: "navigate", url: "" } as never, bindings);
	assert.ok("code" in nav);
	assert.equal(nav.code, "INVALID_AGENT_REQUEST");
	const press = compileSemanticAction({ kind: "press" } as never, bindings);
	assert.ok("code" in press);
	assert.equal(press.code, "INVALID_AGENT_REQUEST");
});

test("select-all chord is Meta on darwin and Control elsewhere", () => {
	const mac = selectAllProgram("darwin");
	assert.equal(mac[0]?.code, "MetaLeft");
	assert.deepEqual(mac[1]?.modifiers, ["meta"]);
	const win = selectAllProgram("win32");
	assert.equal(win[0]?.code, "ControlLeft");
	assert.deepEqual(win[1]?.modifiers, ["ctrl"]);
	assertValidProgram(mac);
	assertValidProgram(win);
});

test("scroll on ref without scroll action is rejected", () => {
	const bindings = new Map([["a_01", binding("a_01", ["activate"])]]);
	const result = compileSemanticAction({ kind: "scroll", ref: "a_01", direction: "down" }, bindings);
	assert.ok("code" in result);
	assert.equal(result.code, "ACTION_NOT_ALLOWED");
});

test("semantic resolver registry covers every published write kind", () => {
	for (const kind of AGENT_PUBLISHED_WRITE_KINDS) {
		const id = SEMANTIC_COMPLETION_RESOLVER_IDS[kind];
		assert.ok(id in SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY, `missing resolver ${id}`);
	}
});
