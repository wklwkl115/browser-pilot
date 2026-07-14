import assert from "node:assert/strict";
import test from "node:test";
import { renderResult, type RenderMode } from "../../src/apps/cli/render.ts";
import {
	BROWSER_OPERATION_OUTCOME_CONTRACT,
	BROWSER_OPERATION_SCHEMA,
	classifyBrowserOperationEnvelope,
	classifyBrowserOperationStatus,
	type BrowserOperationStatus,
} from "../../src/kernels/session/browserOperation.ts";

function captureWrites(stream: NodeJS.WriteStream, run: () => number): { output: string; exitCode: number } {
	const originalWrite = stream.write;
	const chunks: string[] = [];
	stream.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof stream.write;
	try {
		const exitCode = run();
		return { output: chunks.join(""), exitCode };
	} finally {
		stream.write = originalWrite;
	}
}

function operation(status: BrowserOperationStatus, continuation: unknown = { next: "observe", opaque: status }): Record<string, unknown> {
	return {
		schema: BROWSER_OPERATION_SCHEMA,
		operationId: `operation-${status}`,
		commandName: "browser_execute",
		status,
		...classifyBrowserOperationStatus(status),
		continuation,
		dispatch: { acknowledged: true, started: true, finished: true },
	};
}

function render(env: Record<string, unknown>, mode: RenderMode) {
	return renderResult({ content: [{ type: "text", text: JSON.stringify(env) }] }, mode);
}

test("browser-operation/v2 maps all terminal statuses identically in JSON and TTY renderers", () => {
	const statuses = Object.keys(BROWSER_OPERATION_OUTCOME_CONTRACT) as BrowserOperationStatus[];
	assert.deepEqual(statuses.sort(), ["ambiguous", "completed", "deadline", "effect_observed", "failed", "no_effect", "stalled", "target_lost"]);
	for (const status of statuses) {
		const continuation = { next: status === "completed" ? "inspect_artifact" : "observe", opaque: { status } };
		const env = operation(status, continuation);
		const expected = classifyBrowserOperationStatus(status);
		const classified = classifyBrowserOperationEnvelope(env);
		assert.equal(classified.kind, "operation", status);
		if (classified.kind !== "operation") continue;
		assert.deepEqual(classified.outcome, expected, status);

		const json = captureWrites(process.stdout, () => render(env, "json"));
		assert.equal(json.exitCode, status === "completed" ? 0 : 1, `${status} json exit`);
		const parsed = JSON.parse(json.output) as Record<string, unknown>;
		assert.equal(parsed.schema, BROWSER_OPERATION_SCHEMA, status);
		assert.equal(parsed.status, status, status);
		assert.equal(parsed.classification, expected.classification, status);
		assert.equal(parsed.completionVerified, expected.completionVerified, status);
		assert.equal(parsed.ok, expected.ok, status);
		assert.equal(parsed.code, expected.code, status);
		assert.deepEqual(parsed.continuation, continuation, `${status} continuation`);

		const human = captureWrites(process.stdout, () => render(env, "human"));
		assert.equal(human.exitCode, status === "completed" ? 0 : 1, `${status} human exit`);
		assert.match(human.output, new RegExp(`browser_execute · ${status}`), status);
		assert.match(human.output, new RegExp(`outcome: ${expected.classification}`), status);
		assert.match(human.output, new RegExp(expected.completionVerified ? "completion verified" : "completion unverified"), status);
		if (expected.code) assert.match(human.output, new RegExp(expected.code), status);
	}
});

test("effect_observed cannot be promoted to success by generic error-shape heuristics", () => {
	const env = { ...operation("effect_observed"), failed: false, summary: { ok: true }, error: null };
	const rendered = captureWrites(process.stdout, () => render(env, "json"));
	const parsed = JSON.parse(rendered.output) as Record<string, unknown>;
	assert.equal(rendered.exitCode, 1);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.code, "OPERATION_EFFECT_UNVERIFIED");
});

test("human browser-operation output exposes semantic settlement separately from business proof", () => {
	const env = {
		...operation("effect_observed"),
		dispatch: { acknowledged: true, started: true, finished: true, settledAt: 3 },
		business: { status: "inconclusive", source: "abml", reason: "semantic_effect_without_expectation" },
		semantic: { provider: "abml", stability: "stable", effect: { summary: { hasSemanticEffect: true } } },
	};
	const human = captureWrites(process.stdout, () => render(env, "human"));
	assert.match(human.output, /dispatch: acknowledged · settled/);
	assert.match(human.output, /business: inconclusive · abml · semantic_effect_without_expectation/);
	assert.match(human.output, /semantic: abml · stable · effect observed/);
});

test("unknown operation schemas are not treated as browser-operation/v2", () => {
	const env = { schema: "browser-operation/v999", status: "effect_observed", continuation: null };
	assert.deepEqual(classifyBrowserOperationEnvelope(env), { kind: "not_operation" });
	const rendered = captureWrites(process.stdout, () => render(env, "json"));
	const parsed = JSON.parse(rendered.output) as Record<string, unknown>;
	assert.equal(rendered.exitCode, 0);
	assert.equal(parsed.ok, true);
});

test("malformed browser-operation/v2 returns a stable protocol error", () => {
	const env = { ...operation("completed") };
	delete env.continuation;
	const classified = classifyBrowserOperationEnvelope(env);
	assert.equal(classified.kind, "malformed");
	const rendered = captureWrites(process.stdout, () => render(env, "json"));
	const parsed = JSON.parse(rendered.output) as Record<string, unknown>;
	assert.equal(rendered.exitCode, 1);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.code, "OPERATION_PROTOCOL_ERROR");
	assert.match(String(parsed.message), /missing continuation/);
});
