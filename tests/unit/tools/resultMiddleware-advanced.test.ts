import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { distilledJsonResult, distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { summarizeMemoryResult } from "../../../src/tools/summaries/memory.ts";

function textOf(result: { content: Array<{ text: string }> }) {
	return result.content.map((item) => item.text).join("\n");
}

test("distilledJsonResult summary mode emits compact envelope", async () => {
	const result = await distilledJsonResult({ ok: true, data: { values: Array.from({ length: 50 }, (_, i) => i) } }, {
		toolName: "browser_network",
		command: "network.list",
		maxChars: 4000,
		fallbackName: "unit.json",
		detailLevel: "summary",
	});
	const text = textOf(result);
	assert.ok(text.includes('"tool": "browser_network"'));
	assert.ok(text.includes('"detailLevel": "summary"'));
});

test("distilledJsonResult only emits saved-artifact offset actions when an artifact exists", async () => {
	const inline = await distilledJsonResult({ ok: true, items: [1, 2] }, {
		toolName: "browser_network",
		command: "network.list",
		maxChars: 4000,
		fallbackName: "network-list.json",
		detailLevel: "summary",
		distill: () => ({ nextOffset: 20 }),
	});
	const inlineEnvelope = JSON.parse(textOf(inline));
	assert.notEqual(inlineEnvelope.nextActions?.some((item: string) => item.includes("read_saved_artifact offset=20")), true);

	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-result-offset-"));
	try {
		const saved = await distilledJsonResult({ ok: true, items: [1, 2] }, {
			toolName: "browser_network",
			command: "network.list",
			maxChars: 4000,
			ctx: { cwd },
			outputPath: path.join(cwd, "network-list.json"),
			fallbackName: "network-list.json",
			detailLevel: "summary",
			distill: () => ({ nextOffset: 20 }),
		});
		const savedEnvelope = JSON.parse(textOf(saved));
		assert.equal(savedEnvelope.nextActions.some((item: string) => item.includes("read_saved_artifact offset=20")), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("distilledJsonResult full mode redacts sensitive evidence", async () => {
	const result = await distilledJsonResult({ headers: { Authorization: "Bearer secret" } }, {
		toolName: "browser_command",
		command: "cdp",
		maxChars: 200,
		fallbackName: "sensitive.json",
		detailLevel: "full",
	});
	const text = textOf(result);
	assert.equal(text.includes("secret"), false);
	assert.ok(text.includes("browser_command"));
});

test("distilledJsonResult redacts sensitive summary fields by default", async () => {
	const result = await distilledJsonResult({ token: "supersecretvalue" }, {
		toolName: "browser_execute",
		command: "javascript",
		maxChars: 4000,
		fallbackName: "exec.json",
		detailLevel: "summary",
		distill: (value) => ({ token: (value as { token?: unknown }).token }),
	});
	const text = textOf(result);
	assert.equal(text.includes("supersecretvalue"), false, "default must redact token-named fields");
	const envelope = JSON.parse(text);
	assert.equal(envelope.summary.token.redacted, true);
	assert.equal(envelope.summary.token.kind, "token");
	assert.equal(envelope.summary.token.jsonPath, "token");
});

test("distilledJsonResult ignores redact:false and emits a raw-location pointer", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-result-redaction-"));
	try {
		const result = await distilledJsonResult({ token: "supersecretvalue" }, {
			toolName: "browser_execute",
			command: "javascript",
			maxChars: 4000,
			fallbackName: "exec.json",
			detailLevel: "summary",
			distill: (value) => ({ token: (value as { token?: unknown }).token }),
			redact: false,
			ctx: { cwd },
		});
		const text = textOf(result);
		const envelope = JSON.parse(text);
		assert.equal(text.includes("supersecretvalue"), false, "model-facing output must not expose raw values inline");
		assert.equal(envelope.summary.token.redacted, true);
		assert.equal(envelope.summary.token.kind, "token");
		assert.equal(envelope.summary.token.raw, path.join(cwd, ".pi", "browser-artifacts", "exec.json"));
		assert.equal(envelope.summary.token.jsonPath, "token");
		assert.equal(typeof envelope.summary.token.bytes, "number");
		assert.equal(envelope.privacy.modelFacingRedaction, "default");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("distilledTextResult summary mode emits compact artifact-guided output", async () => {
	const result = await distilledTextResult("hello", {
		toolName: "browser_observe",
		command: "scan",
		maxChars: 4000,
		fallbackName: "observe.txt",
		detailLevel: "summary",
		summary: {
			artifact_hints: { preferredReads: [{ jsonPath: "focus.primary_actions" }] },
			truncated: true,
			focus: {
				primary_entities: [{ ref: "pi-ref://control/pay", kind: "control", role: "button", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" }],
			},
		},
		error: { code: "REF_STALE", category: "ref", message: "stale" },
	});
	const text = textOf(result);
	assert.ok(text.includes("browser_observe"));
	assert.ok(text.includes("read(pi-ref://control/pay)") || text.includes("click(pi-ref://control/pay)"));
	assert.ok(text.includes("\"entities\"") && text.includes("\"error\""));
	assert.equal(text.includes("browser_artifact path="), false);
});

test("distilled result envelope redacts explicit error and entity inputs", async () => {
	const result = await distilledJsonResult({ ok: false }, {
		toolName: "browser_execute",
		command: "execute",
		maxChars: 4000,
		fallbackName: "execute-error.json",
		detailLevel: "summary",
		error: {
			code: "EXEC_FAILED",
			message: "failed token=explicit-secret",
			details: { authorization: "Bearer explicit-secret" },
			recovery: { nextActions: ["retry token=explicit-secret"] },
		},
		entities: [{ ref: "pi-ref://control/secret", kind: "control", name: "token=entity-secret" }],
	});
	const text = textOf(result);
	assert.equal(text.includes("explicit-secret"), false);
	assert.equal(text.includes("entity-secret"), false);
	assert.equal(text.includes("token=[redacted]"), true);
});

test("distilled memory error summaries lift structured error recovery", async () => {
	const result = await distilledJsonResult({
		action: "error",
		ok: false,
		error_code: "MEMORY_ENTRY_NOT_FOUND",
		message: "missing memory",
		error: "missing memory",
		recovery: { nextActions: ["browser_memory action=recall"] },
	}, {
		toolName: "browser_memory",
		command: "memory.read",
		maxChars: 4000,
		fallbackName: "memory-error.json",
		detailLevel: "summary",
		distill: summarizeMemoryResult,
	});
	const envelope = JSON.parse(textOf(result));
	assert.equal(envelope.summary.error_code, "MEMORY_ENTRY_NOT_FOUND");
	assert.equal(envelope.error.error_code, "MEMORY_ENTRY_NOT_FOUND");
	assert.deepEqual(envelope.error.recovery, { nextActions: ["browser_memory action=recall"] });
});

test("distilled result fallback artifact nextActions are directly executable", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-result-artifact-actions-"));
	try {
		const result = await distilledJsonResult({ ok: true, data: { value: "saved" } }, {
			toolName: "browser_execute",
			command: "execute",
			maxChars: 4000,
			ctx: { cwd },
			outputPath: path.join(cwd, "execute.json"),
			fallbackName: "execute.json",
			detailLevel: "summary",
			distill: () => ({ ok: true }),
		});
		const envelope = JSON.parse(textOf(result));
		assert.ok(envelope.nextActions.includes("read_saved_artifact mode=json"));
		assert.ok(envelope.nextActions.includes("read_saved_artifact mode=text"));
		assert.equal(envelope.nextActions.includes("read_saved_artifact mode=json|text"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("distilledJsonResult summary mode promotes correlation metadata", async () => {
	const result = await distilledJsonResult({
		ok: true,
		data: { requestId: "req-1", listenerId: "listener-1", sourceMode: "scan" },
		target: { source: "explicit", implicit: false, browserSessionId: "default", selectionVersionAtDispatch: 3, selectionVersionAtResolve: 4 },
	}, {
		toolName: "browser_command",
		command: "cdp",
		maxChars: 4000,
		fallbackName: "correlation.json",
		detailLevel: "summary",
		operation: { operationId: "op-1", snapshotId: "snap-1", sourceMode: "scan" },
	});
	const text = textOf(result);
	assert.ok(text.includes('"correlation"'));
	assert.ok(text.includes('"operationId": "op-1"'));
	assert.ok(text.includes('"snapshotId": "snap-1"'));
	assert.ok(text.includes('"requestId": "req-1"'));
	assert.ok(text.includes('"selectionVersionAtDispatch": 3'));
	assert.ok(text.includes('"selectionVersionAtResolve": 4'));
});

test("session-delta nextActions cap distinct recovery targets", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-session-delta-actions-"));
	try {
		const result = await distilledJsonResult({ ok: true, data: { value: "saved" } }, {
			toolName: "browser_observe",
			command: "scan",
			maxChars: 4000,
			ctx: { cwd },
			outputPath: path.join(cwd, "observe.json"),
			fallbackName: "observe.json",
			detailLevel: "summary",
			entities: [
				{ ref: "pi-ref://control/a", kind: "control" },
				{ ref: "pi-ref://control/b", kind: "control" },
			],
			distill: () => ({
				delta: "session",
				nextActions: [
					"read_saved_artifact mode=json jsonPath=data.a",
					"read_saved_artifact mode=json jsonPath=data.b",
					"read_saved_artifact mode=json jsonPath=data.c",
					"read_saved_artifact mode=json jsonPath=data.d",
				],
			}),
		});
		const envelope = JSON.parse(textOf(result));
		const recoveryTargets = (envelope.nextActions as string[]).filter((item) => item.startsWith("read_saved_artifact") || item.includes("pi-ref://"));
		assert.equal(envelope.delta, "session");
		assert.equal(recoveryTargets.length <= 3, true);
		assert.equal(recoveryTargets.some((item) => item.includes("data.d")), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("salience renderer marker is opt-in only", async () => {
	const previous = process.env.PI_BROWSER_RENDERER;
	try {
		delete process.env.PI_BROWSER_RENDERER;
		const ladder = JSON.parse(textOf(await distilledJsonResult({ ok: true }, { toolName: "browser_execute", command: "execute", maxChars: 4000, fallbackName: "renderer.json", detailLevel: "summary" })));
		assert.equal(ladder.renderer, undefined);
		process.env.PI_BROWSER_RENDERER = "salience";
		const salience = JSON.parse(textOf(await distilledJsonResult({ ok: true }, { toolName: "browser_execute", command: "execute", maxChars: 4000, fallbackName: "renderer.json", detailLevel: "summary" })));
		assert.equal(salience.renderer, "salience-v1");
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_RENDERER;
		else process.env.PI_BROWSER_RENDERER = previous;
	}
});
