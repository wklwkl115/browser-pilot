import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runVerifiedWrite, verifiedWriteValue } from "../../src/commands/verifiedWrite.ts";
import { defineExecuteCommand } from "../../src/commands/executeCommand.ts";
import { defineOperationCommand } from "../../src/commands/operationCommand.ts";
import { CommandManifestIndex } from "../../src/commands/commandManifestIndex.ts";
import { OperationRegistry } from "../../src/operations/operationRegistry.ts";
import { operationRequest } from "../../src/operations/operationContext.ts";
import { evaluateCondition } from "../../src/operations/conditionRuntime.ts";
import { businessConditionsSchema, declarativeConditionSchema } from "../../src/operations/conditionSchema.ts";
import { validateCommandArgs } from "../../src/validation/commandArgs.ts";
import { BrowserCommandQueueRegistry } from "../../src/bridge/server/BrowserCommandQueueRegistry.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";
import { BrowserBridgeError } from "../../src/utils/errors.ts";
import { errorResult, jsonResult } from "../../src/utils/toolResult.ts";

function response(data: unknown): BrowserBridgeExecutionResult {
	return { id: "fixture-response", acknowledged: true, data };
}

async function fixture(t: TestContext, overrides: Partial<BrowserCommandRuntimePort> = {}) {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-operation-contract-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const server = {
		async sendCommand() {
			return response(undefined);
		},
		async executeJavaScript() {
			return response(true);
		},
		...overrides,
	} as BrowserCommandRuntimePort;
	const operations = new OperationRegistry();
	const commands = new CommandManifestIndex();
	defineOperationCommand({ commands, ensureStarted: async () => server, operations });
	const query = commands.getCommands()[0]!;
	const options = {
		server,
		operations,
		ctx: { cwd },
		verb: "save",
		target: { browserSessionId: "fixture", tabId: 7, rawTarget: 7 },
		timeoutMs: 2000,
		verificationWaitMs: 200,
	};
	return { ...options, options, query };
}

function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

for (const mode of ["allOf", "anyOf"] as const) {
	test(`${mode} preserves decisive evidence without reading a stalled later branch`, async (t) => {
		let reads = 0;
		const f = await fixture(t, {
			async executeJavaScript() {
				reads++;
				if (reads === 1) return response("https://example.test/done");
				return await new Promise<BrowserBridgeExecutionResult>(() => {});
			},
		});
		const children = [
			{ url: { equals: mode === "anyOf" ? "https://example.test/done" : "https://example.test/other" } },
			{ url: { contains: "stalled" } },
		];
		const outcome = await runVerifiedWrite({
			...f.options,
			verificationWaitMs: 100,
			expect: { kind: "declarative", condition: mode === "allOf" ? { allOf: children } : { anyOf: children } },
			dispatch: async () => response(null),
		});
		assert.equal(outcome.verification?.status, mode === "allOf" ? "unmet" : "verified");
		assert.equal(outcome.verification?.observed.skippedConditions, 1);
		assert.equal((outcome.verification?.observed.conditions as unknown[]).length, 1);
	});
	test(`${mode} continues past inconclusive evidence to a decisive branch`, async (t) => {
		let reads = 0;
		const f = await fixture(t, {
			async executeJavaScript() {
				return response(++reads === 1 ? null : "https://example.test/done");
			},
		});
		const children = [
			{ url: { contains: "unknown" } },
			{ url: { equals: mode === "anyOf" ? "https://example.test/done" : "https://example.test/other" } },
		];
		const result = await evaluateCondition(mode === "allOf" ? { allOf: children } : { anyOf: children }, {
			server: f.server,
			verb: "save",
			tabId: 7,
			timeoutMs: 100,
		});
		assert.equal(result.status, mode === "allOf" ? "unmet" : "verified");
		assert.equal(result.observed.skippedConditions, 0);
		assert.equal(reads, 2);
	});
}

test("an assertion of the failure UI can be verified without claiming business success", async (t) => {
	const f = await fixture(t);
	const outcome = await runVerifiedWrite({
		...f.options,
		expect: { kind: "javascript", expression: "failureShown" },
		verifyScript: "return failureShown;",
		dispatch: async () => response("clicked"),
	});
	assert.equal(outcome.verification?.status, "verified");
	assert.equal(outcome.operation?.business.status, "unknown");
	assert.equal(outcome.operation?.execution.status, "returned");
	const value = payload(jsonResult(verifiedWriteValue(outcome)));
	assert.equal(value.operationId, outcome.operation?.operationId);
	assert.equal((value.verification as Record<string, unknown>).scope, "assertion");
	assert.equal((value.verification as Record<string, unknown>).operationId, value.operationId);
	const artifact = JSON.parse(
		await readFile(
			path.join(f.ctx.cwd, ".browser-pilot", "artifacts", `operation-${String(value.operationId)}.json`),
			"utf8",
		),
	) as Record<string, unknown>;
	assert.equal(artifact.operationId, value.operationId);
	assert.equal(
		outcome.operation?.continuation?.available,
		false,
		"arbitrary legacy expressions are not retained for continued execution",
	);
	let resumedReads = 0;
	f.server.executeJavaScript = async () => {
		resumedReads++;
		return response(false);
	};
	const status = payload(
		await f.query.execute({ operationId: value.operationId, action: "wait", waitMs: 100 }, undefined, f.ctx),
	);
	assert.equal((status.verification as Record<string, unknown>).status, "verified");
	assert.equal(resumedReads, 0, "continued observation must not execute an arbitrary legacy expression");
});

test("arbitrary page results do not masquerade as execution or business receipts", async (t) => {
	const f = await fixture(t);
	const outcome = await runVerifiedWrite({
		...f.options,
		dispatch: async () => response({ ok: false, status: "failed" }),
	});
	assert.equal(outcome.operation?.execution.response, "success");
	assert.equal(outcome.operation?.business.status, "unknown");
	assert.deepEqual(verifiedWriteValue(outcome).result, { ok: false, status: "failed" });
});

test("explicit failure evidence and conflicting declarations are independent of assertion truth", async (t) => {
	const f = await fixture(t, {
		async executeJavaScript() {
			return response("https://example.test/failed");
		},
	});
	const failure = { url: { equals: "https://example.test/failed" } };
	const outcome = await runVerifiedWrite({
		...f.options,
		expect: { kind: "declarative", condition: failure },
		business: { failure },
		dispatch: async () => response(null),
	});
	assert.equal(outcome.verification?.status, "verified");
	assert.equal(outcome.operation?.business.status, "failed");
	const conflict = await runVerifiedWrite({
		...f.options,
		business: { success: failure, failure },
		dispatch: async () => response(null),
	});
	assert.equal(conflict.operation?.business.status, "unknown");
	assert.match(conflict.operation!.business.reason, /conflict/);
});

test("optimistic UI cannot satisfy success requiring the completed save response", async (t) => {
	let writeCount = 0;
	let requestReads = 0;
	const f = await fixture(t, {
		async executeJavaScript() {
			return response({ count: 1, value: "Saved", truncated: false });
		},
		async sendCommand(command) {
			if (command.cmd === "network.status")
				return response({
					active: true,
					recorderId: "recorder",
					createdAt: 1000,
					lastSeq: writeCount,
					overflowCount: 0,
				});
			if (command.cmd === "network.list") {
				requestReads++;
				const finished = requestReads > 2;
				return response({
					nextOffset: null,
					items: [
						{
							requestId: "save-1",
							seq: 1,
							request: { url: "https://example.test/save/unique-1", method: "POST" },
							phase: finished ? "finished" : "request",
							response: finished ? { status: 503 } : null,
						},
					],
				});
			}
			return response(undefined);
		},
	});
	const request = { url: "https://example.test/save/unique-1", method: "POST", status: 200 };
	const outcome = await runVerifiedWrite({
		...f.options,
		verificationWaitMs: 1000,
		business: {
			success: { allOf: [{ text: { selector: "#toast", match: { equals: "Saved" } } }, { request }] },
			failure: { request: { ...request, status: 503 } },
		},
		dispatch: async () => {
			writeCount++;
			return response(null);
		},
	});
	assert.equal(outcome.operation?.business.status, "failed");
	assert.notEqual(outcome.operation?.business.success?.status, "verified");
	assert.equal(writeCount, 1);
});

test("lost dispatched result is retained and later business observation never replays the write", async (t) => {
	let writes = 0;
	const f = await fixture(t, {
		async executeJavaScript() {
			return response("https://example.test/record/unique-1");
		},
	});
	let lost: unknown;
	try {
		await runVerifiedWrite({
			...f.options,
			business: { success: { url: { equals: "https://example.test/record/unique-1" } } },
			dispatch: async () => {
				writes++;
				const receipt = operationRequest("lost-request");
				receipt?.sent();
				receipt?.ack();
				throw new BrowserBridgeError("BRIDGE_CLIENT_DISCONNECTED", "response lost", { acked: true });
			},
		});
	} catch (error) {
		lost = error;
	}
	assert.ok(lost);
	const failed = payload(errorResult(lost));
	assert.equal((failed.execution as Record<string, unknown>).status, "dispatched_unknown");
	assert.equal((failed.recovery as Record<string, unknown>).automaticReplay, false);
	assert.equal(typeof failed.operationId, "string");
	const waited = payload(
		await f.query.execute({ operationId: failed.operationId, action: "wait", waitMs: 200 }, undefined, f.ctx),
	);
	assert.equal(waited.operationId, failed.operationId);
	assert.equal((waited.execution as Record<string, unknown>).status, "dispatched_unknown");
	assert.equal((waited.business as Record<string, unknown>).status, "succeeded");
	assert.equal(writes, 1);
});

test("cancellation in the target queue reports proven non-dispatch", async (t) => {
	const queue = new BrowserCommandQueueRegistry();
	let release!: () => void;
	let occupied!: () => void;
	const started = new Promise<void>((resolve) => {
		occupied = resolve;
	});
	const blocker = queue.withTransaction("fixture", 7, async () => {
		occupied();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	await started;
	t.after(() => {
		release();
	});
	const f = await fixture(t, {
		withTargetTransaction: (input, run) =>
			queue.withTransaction("fixture", input.tabId, run, { signal: input.signal }),
	});
	const abort = new AbortController();
	let writes = 0;
	const attempt = runVerifiedWrite({
		...f.options,
		signal: abort.signal,
		dispatch: async () => {
			writes++;
			return response(null);
		},
	});
	abort.abort();
	await assert.rejects(attempt, (error: unknown) => {
		const value = payload(errorResult(error));
		assert.equal((value.execution as Record<string, unknown>).status, "not_dispatched");
		assert.equal((value.recovery as Record<string, unknown>).action, "retry_after_review");
		return true;
	});
	release();
	await blocker;
	assert.equal(writes, 0);
});

test("incomplete, ambiguous and mismatched JSON request evidence cannot prove success", async () => {
	let items: Record<string, unknown>[] = [];
	let body: unknown = { body: '{"id":"unique-1","value":"expected"}', bodyTruncated: false };
	const server = {
		async sendCommand(command: { cmd: string }) {
			if (command.cmd === "network.status")
				return response({ active: true, recorderId: "r1", createdAt: 1000, lastSeq: 2, overflowCount: 0 });
			if (command.cmd === "network.body") return response(body);
			return response({ items, nextOffset: null });
		},
	} as BrowserCommandRuntimePort;
	const runtime = {
		server,
		verb: "save",
		tabId: 7,
		timeoutMs: 100,
		networkBaseline: { recorderId: "r1", createdAt: 1000, lastSeq: 0, overflowCount: 0 },
	};
	const condition = {
		request: {
			url: "https://example.test/record/unique-1",
			method: "GET",
			status: 200,
			json: [
				{ pointer: "/id", equals: "unique-1" },
				{ pointer: "/value", equals: "expected" },
			],
		},
	};
	assert.equal((await evaluateCondition(condition, runtime)).status, "inconclusive");
	const item = {
		requestId: "q1",
		seq: 1,
		request: { url: condition.request.url, method: "GET" },
		phase: "finished",
		response: { status: 200 },
	};
	items = [item];
	assert.equal((await evaluateCondition(condition, runtime)).status, "verified");
	items = [{ ...item, phase: "response", response: { status: 503 } }];
	const headersOnly = await evaluateCondition(
		{ request: { ...condition.request, status: 503, json: undefined } },
		runtime,
	);
	assert.equal(headersOnly.status, "verified", "an HTTP error status does not require consuming the response body");
	assert.equal(headersOnly.observed.responseComplete, false);
	items = [item, { ...item, requestId: "q2", seq: 2 }];
	assert.equal((await evaluateCondition(condition, runtime)).status, "inconclusive");
	items = [item];
	body = { body: '{"id":"other"}', bodyTruncated: false };
	assert.equal((await evaluateCondition(condition, runtime)).status, "unmet");
	body = { body: '{"id":"unique-1"}', bodyTruncated: true };
	assert.equal((await evaluateCondition(condition, runtime)).status, "inconclusive");
});

test("observation budget preserves the last completed unmet assertion and its elapsed time", async (t) => {
	const f = await fixture(t, {
		async executeJavaScript() {
			return response("https://example.test/pending");
		},
	});
	const outcome = await runVerifiedWrite({
		...f.options,
		verificationWaitMs: 100,
		expect: { kind: "declarative", condition: { url: { equals: "https://example.test/done" } } },
		dispatch: async () => response(null),
	});
	assert.equal(outcome.verification?.status, "unmet");
	assert.ok(outcome.verification!.elapsedMs >= 90);
	assert.equal(outcome.operation?.business.status, "unknown");
});

test("a stuck observer is bounded and cannot overwrite its receipt with a late result", async (t) => {
	let release!: (value: BrowserBridgeExecutionResult) => void;
	const f = await fixture(t, {
		executeJavaScript: async () =>
			await new Promise<BrowserBridgeExecutionResult>((resolve) => {
				release = resolve;
			}),
	});
	const outcome = await runVerifiedWrite({
		...f.options,
		verificationWaitMs: 100,
		business: { success: { url: { equals: "https://example.test/done" } } },
		dispatch: async () => response(null),
	});
	assert.equal(outcome.operation?.execution.status, "returned");
	assert.equal(outcome.operation?.business.status, "unknown");
	release(response("https://example.test/done"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(outcome.operation?.business.status, "unknown");
});

test("a completed assertion remains distinct from a stalled business observation", async (t) => {
	let release!: (value: BrowserBridgeExecutionResult) => void;
	let reads = 0;
	const f = await fixture(t, {
		executeJavaScript: async () => {
			reads++;
			if (reads === 1) return response("https://example.test/done");
			return await new Promise<BrowserBridgeExecutionResult>((resolve) => {
				release = resolve;
			});
		},
	});
	const condition = { url: { equals: "https://example.test/done" } };
	const outcome = await runVerifiedWrite({
		...f.options,
		verificationWaitMs: 100,
		expect: { kind: "declarative", condition },
		business: { success: condition },
		dispatch: async () => response(null),
	});
	assert.equal(outcome.verification?.status, "verified");
	assert.equal(outcome.operation?.business.status, "unknown");
	release(response("https://example.test/done"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(outcome.operation?.business.status, "unknown");
});

test("operation records are project-scoped and duplicate IDs cannot execute another write", async (t) => {
	const f = await fixture(t);
	const outcome = await runVerifiedWrite({ ...f.options, dispatch: async () => response(null) });
	const id = outcome.operation!.operationId;
	assert.throws(() => f.operations.get(id, path.join(f.ctx.cwd, "other")), /unavailable/);
	let writes = 0;
	await assert.rejects(
		runVerifiedWrite({
			...f.options,
			ctx: { ...f.ctx, operationId: id },
			dispatch: async () => {
				writes++;
				return response(null);
			},
		}),
		/already exists/,
	);
	assert.equal(writes, 0);
});

test("adding an uncertain-execution receipt preserves an adapter's original error code", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		runVerifiedWrite({
			...f.options,
			dispatch: async () => {
				throw Object.assign(new Error("adapter response lost"), {
					code: "ADAPTER_OUTCOME_UNKNOWN",
					details: { dispatchStarted: true },
				});
			},
		}),
		(error: unknown) => {
			const value = payload(errorResult(error));
			assert.equal(value.code, "ADAPTER_OUTCOME_UNKNOWN");
			assert.equal((value.execution as Record<string, unknown>).status, "dispatched_unknown");
			return true;
		},
	);
});

test("preflight errors preserve a non-dispatch receipt at the public tool boundary", async (t) => {
	const f = await fixture(t);
	const commands = new CommandManifestIndex();
	defineExecuteCommand({
		commands,
		ensureStarted: async () => {
			throw new Error("offline before dispatch");
		},
		operations: f.operations,
	});
	const result = payload(await commands.getCommands()[0]!.execute({ script: "return 1" }, undefined, f.ctx));
	assert.equal((result.execution as Record<string, unknown>).status, "not_dispatched");
	assert.equal(typeof result.operationId, "string");
});

test("declarative schemas reject executable or unbounded business declarations", () => {
	assert.equal(validateCommandArgs(businessConditionsSchema, { success: "fetch('/save')" }).ok, false);
	assert.equal(validateCommandArgs(declarativeConditionSchema, { allOf: [] }).ok, false);
	assert.equal(
		validateCommandArgs(declarativeConditionSchema, {
			anyOf: Array.from({ length: 9 }, () => ({ url: { contains: "done" } })),
		}).ok,
		false,
	);
	assert.equal(
		validateCommandArgs(declarativeConditionSchema, { value: { selector: "#id", equals: "unique-1" } }).ok,
		true,
	);
});

for (const scenario of [
	"write-then-no-dispatch",
	"write-then-timeout",
	"read-then-no-dispatch",
	"evicted-write",
] as const) {
	test(`operation aggregates ${scenario} across the enclosing dispatch`, async (t) => {
		const f = await fixture(t);
		await assert.rejects(
			runVerifiedWrite({
				...f.options,
				effects: false,
				dispatch: async () => {
					const first = operationRequest("first", scenario === "read-then-no-dispatch" ? "read" : "write")!;
					first.sent();
					first.ack();
					first.returned("success");
					if (scenario === "evicted-write")
						for (let i = 0; i < 130; i++) {
							const skipped = operationRequest(`skipped-${i}`)!;
							skipped.returned("error", false);
						}
					const next = operationRequest("next")!;
					if (scenario === "write-then-timeout") {
						next.sent();
						next.returned("error", true, false);
					} else next.returned("error", false);
					throw new BrowserBridgeError("BRIDGE_TIMEOUT", "second request failed", {
						dispatchStarted: scenario === "write-then-timeout",
					});
				},
			}),
			(error) => {
				const value = payload(errorResult(error));
				assert.equal(
					(value.execution as Record<string, unknown>).status,
					scenario === "read-then-no-dispatch"
						? "not_dispatched"
						: scenario === "write-then-timeout"
							? "dispatched_unknown"
							: "returned",
				);
				assert.equal(
					(value.recovery as Record<string, unknown>).action,
					scenario === "read-then-no-dispatch" ? "retry_after_review" : "observe_only",
				);
				return true;
			},
		);
	});
}

for (const allowDestination of [false, true]) {
	test(`continued DOM evidence ${allowDestination ? "accepts an explicit destination" : "rejects an unrelated document"}`, async (t) => {
		let documentOrigin = 1;
		let url = "https://example.test/a";
		let writes = 0;
		const f = await fixture(t, {
			async executeJavaScript(script) {
				if (script === "return performance.timeOrigin;") return response(documentOrigin);
				if (script === "return location.href;") return response(url);
				return response({ count: 1, value: "Saved", documentOrigin, url });
			},
		});
		const text = { text: { selector: "#status", match: { equals: "Saved" } } };
		const success = allowDestination ? { allOf: [{ url: { equals: "https://example.test/b" } }, text] } : text;
		let operationId = "";
		await assert.rejects(
			runVerifiedWrite({
				...f.options,
				business: { success },
				dispatch: async () => {
					writes++;
					throw new BrowserBridgeError("BRIDGE_TIMEOUT", "write result unknown", { dispatchStarted: true });
				},
			}),
			(error) => {
				operationId = String(payload(errorResult(error)).operationId);
				return true;
			},
		);
		documentOrigin = 2;
		url = "https://example.test/b";
		const waited = payload(await f.query.execute({ operationId, action: "wait", waitMs: 100 }, undefined, f.ctx));
		assert.equal((waited.business as Record<string, unknown>).status, allowDestination ? "succeeded" : "unknown");
		assert.equal(writes, 1);
	});
}

test("successful outer return cannot erase a child's unknown write outcome", async (t) => {
	const f = await fixture(t);
	const outcome = await runVerifiedWrite({
		...f.options,
		effects: false,
		dispatch: async () => {
			const first = operationRequest("success")!;
			first.sent();
			first.returned("success");
			const second = operationRequest("unknown")!;
			second.sent();
			second.returned("error", true, false);
			return response(null);
		},
	});
	assert.equal(outcome.operation?.execution.status, "dispatched_unknown");
	assert.equal(outcome.operation?.recovery.action, "observe_only");
});

test("prior success cannot explain an untracked outer dispatch failure", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		runVerifiedWrite({
			...f.options,
			effects: false,
			dispatch: async () => {
				const first = operationRequest("success")!;
				first.sent();
				first.returned("success");
				throw new Error("untracked adapter outcome");
			},
		}),
		(error) => {
			assert.equal(
				(payload(errorResult(error)).execution as Record<string, unknown>).status,
				"dispatched_unknown",
			);
			return true;
		},
	);
});
