import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { summarizeCommandEffect, withCommandEffect } from "../../src/commands/commandEffect.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";
import {
	coherentPageFingerprint,
	readPageFingerprint,
	samePageFingerprint,
	type PageFingerprint,
} from "../../src/commands/pageSignals.ts";
import type { VerificationResult } from "../../src/kernels/abml/types.ts";

function fingerprint(overrides: Partial<PageFingerprint> = {}): PageFingerprint {
	return {
		changeSeq: 10,
		pageEpoch: "page-1",
		documentId: "document-1",
		url: "https://example.test/",
		title: "Example",
		readyState: "complete",
		visibleCount: 20,
		interactiveCount: 4,
		...overrides,
	};
}

const bridgeResult: BrowserBridgeExecutionResult = { id: "result-1", acknowledged: true, data: { ok: true } };

test("observation coherence tolerates bounded mutation drift but not structural or identity change", () => {
	const before = fingerprint({ changeSeq: 10 });
	assert.deepEqual(coherentPageFingerprint(before, fingerprint({ changeSeq: 10 })), {
		coherent: true,
		changeSeqDrift: 0,
	});
	assert.deepEqual(coherentPageFingerprint(before, fingerprint({ changeSeq: 18, title: "(2) Example" })), {
		coherent: true,
		changeSeqDrift: 8,
	});
	assert.equal(coherentPageFingerprint(before, fingerprint({ changeSeq: 40 })).coherent, false);
	assert.equal(coherentPageFingerprint(before, fingerprint({ changeSeq: 9 })).coherent, false);
	assert.equal(coherentPageFingerprint(before, fingerprint({ changeSeq: 12, visibleCount: 21 })).coherent, false);
	assert.equal(coherentPageFingerprint(before, fingerprint({ changeSeq: 12, scrollY: 300 })).coherent, false);
	assert.equal(coherentPageFingerprint(before, fingerprint({ changeSeq: 12, pageEpoch: "page-2" })).coherent, false);
	// The settle check used for write effects stays exact.
	assert.equal(samePageFingerprint(before, fingerprint({ changeSeq: 11 })), false);
});

test("command effect reports an observed settled no-op explicitly", () => {
	const effect = summarizeCommandEffect(fingerprint(), fingerprint(), bridgeResult, {
		settled: true,
		elapsedMs: 12.6,
	});
	assert.deepEqual(effect, {
		observed: true,
		changed: false,
		settled: true,
		elapsedMs: 13,
		page: { changeSeqDelta: 0, readyState: "complete", visibleCountDelta: 0, interactiveCountDelta: 0 },
	});
});

test("command effect distinguishes DOM change, navigation, and new tabs", () => {
	const changed = summarizeCommandEffect(
		fingerprint(),
		fingerprint({ changeSeq: 13, title: "Updated", visibleCount: 23, interactiveCount: 3 }),
		bridgeResult,
		{ settled: true, elapsedMs: 20 },
	);
	assert.equal(changed.changed, true);
	assert.equal(changed.page?.changeSeqDelta, 3);
	assert.equal(changed.page?.visibleCountDelta, 3);
	assert.equal(changed.page?.interactiveCountDelta, -1);

	const navigated = summarizeCommandEffect(
		fingerprint(),
		fingerprint({ changeSeq: 1, pageEpoch: "page-2", documentId: "document-2", url: "https://example.test/next" }),
		{ ...bridgeResult, newTabs: [{ id: 8 }, { id: 9 }] },
		{ settled: true, elapsedMs: 30 },
	);
	assert.deepEqual(navigated.page?.navigation, { from: "https://example.test/", to: "https://example.test/next" });
	assert.equal(navigated.page?.changeSeqDelta, undefined);
	assert.equal(navigated.newTabs, 2);
	assert.equal(navigated.changed, true);
});

test("command effect degrades without turning missing page signals into no change", () => {
	assert.deepEqual(summarizeCommandEffect(undefined, undefined, bridgeResult, { settled: true, elapsedMs: 4 }), {
		observed: false,
		changed: null,
		settled: false,
		elapsedMs: 4,
	});
	assert.equal(
		summarizeCommandEffect(
			undefined,
			undefined,
			{ ...bridgeResult, newTabs: [{}] },
			{ settled: false, elapsedMs: 4 },
		).changed,
		true,
	);
});

test("command effect samples and settles inside one caller-owned transaction", async () => {
	const samples = [
		fingerprint(),
		fingerprint({ changeSeq: 12, visibleCount: 21 }),
		fingerprint({ changeSeq: 12, visibleCount: 21 }),
	];
	const order: string[] = [];
	let fingerprintReads = 0;
	const server = {
		async sendCommand() {
			order.push(`fingerprint:${(fingerprintReads += 1)}`);
			return { id: "fingerprint", acknowledged: true, data: samples.shift() };
		},
	} as unknown as BrowserCommandRuntimePort;
	const outcome = await withCommandEffect(
		server,
		{
			browserSessionId: "session-1",
			tabId: 7,
			timeoutMs: 1_000,
			deadlineAt: Date.now() + 1_000,
			quietMs: 0,
			settleMs: 50,
		},
		async () => {
			order.push("dispatch");
			return bridgeResult;
		},
	);
	assert.deepEqual(order, ["fingerprint:1", "dispatch", "fingerprint:2", "fingerprint:3"]);
	assert.equal(outcome.effect.changed, true);
	assert.equal(outcome.effect.settled, true);
	assert.equal(outcome.effect.page?.changeSeqDelta, 2);
});

test("command effect owns postcondition polling", async () => {
	let attempts = 0;
	const server = {
		async sendCommand() {
			return { id: "fingerprint", acknowledged: true, data: undefined };
		},
	} as unknown as BrowserCommandRuntimePort;
	const result = (verified: boolean): VerificationResult => ({
		status: verified ? "verified" : "unmet",
		verb: "test",
		observed: { verified },
		evidence: [],
		elapsedMs: 0,
	});
	const outcome = await withCommandEffect(
		server,
		{
			timeoutMs: 1_000,
			deadlineAt: Date.now() + 1_000,
			quietMs: 0,
			settleMs: 0,
			verify: async () => result((attempts += 1) === 2),
		},
		async () => bridgeResult,
	);
	assert.equal(outcome.verification?.status, "verified");
	assert.equal(Object.hasOwn(outcome.effect, "verification"), false);
	assert.equal(attempts, 2);
});

test("command effect stops polling terminal postcondition failures", async () => {
	let attempts = 0;
	const server = {
		async sendCommand() {
			return { id: "fingerprint", acknowledged: true, data: undefined };
		},
	} as unknown as BrowserCommandRuntimePort;
	const startedAt = Date.now();
	const outcome = await withCommandEffect(
		server,
		{
			timeoutMs: 1_000,
			deadlineAt: Date.now() + 1_000,
			verify: async () => {
				attempts += 1;
				return {
					status: "inconclusive",
					verb: "test",
					retryable: false,
					observed: {},
					evidence: [],
					elapsedMs: 0,
				};
			},
		},
		async () => bridgeResult,
	);
	assert.equal(outcome.verification?.retryable, false);
	assert.equal(attempts, 1);
	assert.ok(Date.now() - startedAt < 500);
});

test("command effect declares a stable unmet postcondition early once the page has settled", async () => {
	let attempts = 0;
	const server = {
		async sendCommand() {
			return { id: "fingerprint", acknowledged: true, data: fingerprint() };
		},
	} as unknown as BrowserCommandRuntimePort;
	const startedAt = Date.now();
	const outcome = await withCommandEffect(
		server,
		{
			tabId: 7,
			timeoutMs: 15_000,
			deadlineAt: Date.now() + 15_000,
			quietMs: 0,
			settleMs: 50,
			verify: async () => {
				attempts += 1;
				return { status: "unmet", verb: "test", observed: { pressed: false }, evidence: [], elapsedMs: 0 };
			},
		},
		async () => bridgeResult,
	);
	assert.equal(outcome.effect.settled, true);
	assert.equal(outcome.verification?.status, "unmet");
	assert.equal(attempts, 3);
	assert.ok(Date.now() - startedAt < 2_000, "a stable unmet state must not consume the tool timeout");
	assert.match(outcome.verification?.evidence.at(-1)?.summary ?? "", /settled and target state stayed unchanged/);
});

test("command effect keeps polling with backoff while the postcondition keeps changing, within its own budget", async () => {
	let attempts = 0;
	const server = {
		async sendCommand() {
			return { id: "fingerprint", acknowledged: true, data: fingerprint() };
		},
	} as unknown as BrowserCommandRuntimePort;
	const startedAt = Date.now();
	const outcome = await withCommandEffect(
		server,
		{
			tabId: 7,
			timeoutMs: 15_000,
			deadlineAt: Date.now() + 15_000,
			quietMs: 0,
			settleMs: 0,
			verifyBudgetMs: 700,
			verify: async () => {
				attempts += 1;
				return { status: "unmet", verb: "test", observed: { count: attempts }, evidence: [], elapsedMs: 0 };
			},
		},
		async () => bridgeResult,
	);
	assert.equal(outcome.verification?.status, "unmet");
	const elapsed = Date.now() - startedAt;
	assert.ok(elapsed >= 600 && elapsed < 3_000, `polling should stop at its own budget, took ${elapsed}ms`);
	// 100 + 200 + 400 ms of backoff fits four reads inside a 700ms budget; fixed 100ms polling would need seven.
	assert.ok(attempts >= 3 && attempts <= 5, `expected geometric backoff, saw ${attempts} reads`);
});

test("command effect keeps an unreadable postcondition inconclusive", async () => {
	const server = {
		async sendCommand() {
			return { id: "fingerprint", acknowledged: true, data: undefined };
		},
	} as unknown as BrowserCommandRuntimePort;
	const outcome = await withCommandEffect(
		server,
		{
			timeoutMs: 1_000,
			deadlineAt: Date.now() + 1_000,
			initialVerification: {
				status: "inconclusive",
				verb: "test",
				expected: { state: "ready" },
				observed: {},
				evidence: [],
				elapsedMs: 0,
			},
			verify: async () => {
				throw new Error("page replaced");
			},
		},
		async () => bridgeResult,
	);
	assert.equal(outcome.verification?.status, "inconclusive");
	assert.deepEqual(outcome.verification?.expected, { state: "ready" });
});

test("page fingerprint fallback never swallows cancellation", async () => {
	const controller = new AbortController();
	const server = {
		async sendCommand(_command: unknown, options: { signal?: AbortSignal }) {
			assert.equal(options.signal, controller.signal);
			controller.abort();
			throw new Error("transport closed");
		},
	} as unknown as BrowserCommandRuntimePort;
	await assert.rejects(
		() => readPageFingerprint(server, { tabId: 7, timeoutMs: 1_000, signal: controller.signal }),
		(error) => error === controller.signal.reason,
	);
});

test("command effect summary stays bounded and stateless under 10k-result pressure", () => {
	const before = fingerprint();
	const after = fingerprint({ changeSeq: 11, visibleCount: 21 });
	const manyTabs = Array.from({ length: 10_000 }, (_, index) => ({
		id: index,
		url: `https://example.test/${index}`,
		title: "x".repeat(1_000),
	}));
	const startedAt = performance.now();
	let last = summarizeCommandEffect(
		before,
		after,
		{ ...bridgeResult, newTabs: manyTabs },
		{ settled: true, elapsedMs: 10 },
	);
	for (let index = 0; index < 10_000; index += 1) {
		last = summarizeCommandEffect(before, after, bridgeResult, { settled: true, elapsedMs: 10 });
	}
	const elapsedMs = performance.now() - startedAt;
	assert.deepEqual(last, summarizeCommandEffect(before, after, bridgeResult, { settled: true, elapsedMs: 10 }));
	assert.ok(Buffer.byteLength(JSON.stringify(last)) < 512);
	assert.ok(elapsedMs < 5_000, `10k summaries took ${Math.round(elapsedMs)}ms`);
	const boundedTabs = summarizeCommandEffect(
		before,
		after,
		{ ...bridgeResult, newTabs: manyTabs },
		{ settled: true, elapsedMs: 10 },
	);
	assert.equal(boundedTabs.newTabs, 10_000);
	assert.ok(Buffer.byteLength(JSON.stringify(boundedTabs)) < 512);
});
