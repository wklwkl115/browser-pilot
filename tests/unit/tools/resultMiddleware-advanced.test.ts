import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { distilledJsonResult, distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

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
