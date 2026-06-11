import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHtmlObservation, runScanObservation } from "../../../src/tools/observeRunners.ts";

let opId = 0;
const fakeServer = {
	queueDepth() { return 0; },
	leaseOwnerHash() { return undefined; },
	beginOperation(meta) { opId += 1; return { operationId: `op-${opId}`, startedAt: Date.now(), updatedAt: Date.now(), ...meta }; },
	updateOperation(operationId, patch) { return { operationId, startedAt: Date.now(), updatedAt: Date.now(), ...patch }; },
	finishOperation() { return undefined; },
	async refreshTabs() { return [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }]; },
	getTabs() { return [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }]; },
	snapshot() { return { browserSessionId: "default", defaultTabId: 7, selectionVersion: 3, tabs: [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }] }; },
	createObservationSnapshot(snapshot) { return { snapshotId: "snap-1", ttlMs: 60_000, expired: false, ...snapshot }; },
	async sendCommand(command) {
		if (command.cmd === "wait.navigate") {
			return { id: "nav-1", acknowledged: true, tabId: 7, data: { url: command.url, state: "complete" } };
		}
		if (command.cmd === "wait.loadState") {
			return { id: "wait-1", acknowledged: true, tabId: 7, data: { state: command.state ?? "complete" } };
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "Runtime.evaluate") {
			const expression = String(command.params?.expression || "");
			if (expression.includes("collectActionables") && expression.includes("list_hints")) {
				return { id: "eval-1", acknowledged: true, tabId: 7, data: { result: { value: { url: "https://example.test/checkout", title: "Checkout", readyState: "complete", content: "<h1>Checkout</h1>\nStatus: payment required", node_count: 12, truncated: false, actionables: [{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 }], list_hints: [] } } } };
			}
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "Accessibility.getFullAXTree") {
			return { id: "ax-tree", acknowledged: true, tabId: 7, data: { result: { nodes: [{ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } }] } } };
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "DOM.getBoxModel") {
			return { id: "box-1", acknowledged: true, tabId: 7, data: { result: { border: [140, 240, 220, 240, 220, 272, 140, 272] } } };
		}
		throw new Error(`unexpected command ${JSON.stringify(command)}`);
	},
};

function countingServer() {
	const calls: string[] = [];
	return {
		...fakeServer,
		calls,
		async sendCommand(command: any, options: any) {
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Runtime.evaluate") {
				calls.push(calls.length === 0 ? "scan_extract" : "abml_read_scan");
			}
			return fakeServer.sendCommand(command, options);
		},
	};
}

test("browser_observe scan exposes ABML integration diagnostics internally", async () => {
	const result = await runScanObservation(fakeServer as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(result.details?.abml?.integrated, true);
	assert.equal(result.details?.abml?.entityCount >= 1, true);
	assert.equal(typeof result.details?.abml?.primaryEntityCount, "number");
	assert.equal(typeof result.details?.abml?.visualRegionCount, "number");
	assert.equal(typeof result.details?.abml?.frameEntityCount, "number");
	assert.equal(Array.isArray(envelope.summary?.focus?.primary_entities), true);
	assert.equal(envelope.summary?.focus?.primary_entities?.length >= 1, true);
	assert.equal(envelope.summary?.focus?.entityShape, "refs-v1");
	assert.equal(typeof envelope.summary?.focus?.primary_entities?.[0], "string");
	assert.equal(Array.isArray(envelope.entities), true);
	assert.equal(envelope.entities?.some((entity: any) => entity.kind === "control"), true);
});

test("browser_observe default scan reuses scan_extract data for ABML read", async () => {
	const server = countingServer();
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan");
	assert.equal(result.details?.abml?.integrated, true);
	assert.deepEqual(server.calls, ["scan_extract"], "default scan should not run a second abml_read_scan Runtime.evaluate");
});

test("browser_observe iframe-disabled scan keeps the separate ABML scan", async () => {
	const server = countingServer();
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, includeIframes: false }, { cwd: process.cwd() }, "scan");
	assert.equal(result.details?.abml?.integrated, true);
	assert.deepEqual(server.calls, ["scan_extract", "abml_read_scan"], "non-superset scans must keep the separate ABML capture");
});

test("browser_observe tabs mode returns a tracked scan.tabs envelope", async () => {
	const result = await runScanObservation(fakeServer as any, { mode: "tabs", maxChars: 12_000 }, { cwd: process.cwd() }, "tabs");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.tool, "browser_observe");
	assert.equal(envelope.command, "scan.tabs");
	assert.equal(envelope.summary?.mode, "tabs");
	assert.equal(envelope.summary?.tabs_count, 1);
	assert.equal(envelope.summary?.active_tab, 7);
	assert.equal(envelope.operation?.operationId?.startsWith("op-"), true);
	assert.equal(envelope.snapshot?.snapshotId, "snap-1");
	assert.ok(envelope.saved?.path, "tabs mode should save a read-back artifact");
});

// --- R3.x causal plane (network-delta) runtime wiring ---------------------------------------------
// A server variant that also answers the network recorder reads observe issues for the causal plane.
function causalServer(network: { status: unknown; list?: unknown }, hook?: { status?: unknown; collect?: unknown }) {
	return {
		...fakeServer,
		async sendCommand(command: any, options: any) {
			if (command.cmd === "network.status") return { acknowledged: true, data: network.status };
			if (command.cmd === "network.list") return { acknowledged: true, data: network.list ?? { items: [] } };
			if (command.cmd === "hook.status") {
				if (!hook?.status) throw new Error("no hook session");
				return { acknowledged: true, data: hook.status };
			}
			if (command.cmd === "hook.collect") return { acknowledged: true, data: hook?.collect ?? { events: [] } };
			return fakeServer.sendCommand(command, options);
		},
	};
}

const BASE_ENTITY = { ref: "pi-ref://base-1", state: {} };

test("browser_observe baseline lifts a redacted network-delta to envelope.causal", async () => {
	const server = causalServer({
		status: { active: true, lastSeq: 8 },
		list: { items: [{ seq: 6, requestId: "req-a", request: { url: "https://example.test/api/cart?token=SECRET123", method: "POST" }, response: { status: 200 }, type: "XHR", updatedAt: 111 }], total: 1 },
	});
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.causal?.sinceSeq, 5, "delta windowed at baseline seq");
	assert.equal(envelope.causal?.requests?.length, 1);
	assert.equal(envelope.causal.requests[0].ref, "pi-ref://network/req-a");
	assert.equal(envelope.causal.requests[0].method, "POST");
	assert.equal(envelope.causal.requests[0].status, 200);
	assert.ok(typeof envelope.causal.requests[0].url === "string" && !envelope.causal.requests[0].url.includes("SECRET123"), "sensitive query value scrubbed in lifted causal");
});

test("browser_observe baseline emits causal.unavailable when no recorder is active", async () => {
	const server = causalServer({ status: { active: false } });
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.ok(typeof envelope.causal?.unavailable === "string" && envelope.causal.unavailable.includes("not active"));
	assert.equal(envelope.causal?.requests, undefined);
});

test("browser_observe records the network seq high-water mark for a future baseline (no causal without baseline)", async () => {
	const server = causalServer({ status: { active: true, lastSeq: 8 } });
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.causal, undefined, "no baseline → no causal block");
	assert.equal(envelope.snapshot?.networkSeq, 8, "high-water mark stored on the snapshot so it can anchor a later baseline");
});

test("browser_observe P1: actionRef attributes the causal delta to the control as a triggered relation", async () => {
	const server = causalServer({
		status: { active: true, lastSeq: 8 },
		list: { items: [{ seq: 6, requestId: "pay-1", request: { url: "https://example.test/api/pay", method: "POST" }, response: { status: 200 }, type: "XHR", updatedAt: 1 }], total: 1 },
	});
	// Discover the control ref from a plain scan, then attribute a baseline delta to it via actionRef.
	const env1 = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	const candidates = env1.entities ?? [];
	const control = candidates.find((e: any) => e.kind === "control") ?? candidates[0];
	const actionRef = control?.ref;
	assert.ok(typeof actionRef === "string" && actionRef, "a control ref is available to attribute to");
	const env2 = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] }, actionRef }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env2.relations?.summary?.triggered, 1, "triggered edge counted in the lifted relations summary");
	assert.equal(env2.causal?.requests?.length, 1, "the causal delta still ships inline (passive behavior preserved)");
	const triggered = (env2.entities ?? []).find((e: any) => e.ref === actionRef)?.relations?.find((r: any) => r.type === "triggered");
	if (triggered) {
		assert.equal(triggered.targetRef, "pi-ref://network/pay-1", "triggered points at the network request ref");
		assert.equal(triggered.source, "timing");
	}
});

test("browser_observe P1: no actionRef and no focusable control → causal present, no triggered (passive)", async () => {
	const server = causalServer({
		status: { active: true, lastSeq: 8 },
		list: { items: [{ seq: 6, requestId: "x", request: { url: "https://example.test/api/x", method: "GET" }, response: { status: 200 }, type: "Fetch", updatedAt: 1 }], total: 1 },
	});
	// No actionRef; the fakeServer control is not focused, so diff.focusedRef yields no control.
	const env = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env.causal?.requests?.length, 1, "causal delta present");
	assert.equal(env.relations?.summary?.triggered, undefined, "no attribution without an action signal");
});

test("browser_observe P2: baseline attaches the hook event-delta to envelope.causal.events", async () => {
	const server = causalServer(
		{ status: { active: true, lastSeq: 8 }, list: { items: [], total: 0 } },
		{ status: { last_seq: 11 }, collect: { events: [{ seq: 10, type: "domSink", timestamp: 1, data: { prop: "innerHTML", value: "secret=ABCDEF12 x", elementRef: { selector: "#out" } } }], next_seq: 10, total_available: 1 } },
	);
	const env = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, hookSeq: 9, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env.causal?.events?.length, 1, "hook event-delta lifted to envelope.causal.events");
	assert.equal(env.causal.events[0].ref, "pi-ref://event/10");
	assert.equal(env.causal.events[0].type, "domSink");
	assert.equal(env.causal.events[0].selector, "#out", "DOM-sink event carries its target selector");
	assert.ok(env.causal.events[0].summary && !env.causal.events[0].summary.includes("ABCDEF12"), "event summary redacted");
});

test("browser_observe P2: records the hook seq high-water on the snapshot for a future baseline", async () => {
	const server = causalServer({ status: { active: true, lastSeq: 8 } }, { status: { last_seq: 11 } });
	const env = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env.snapshot?.hookSeq, 11, "hook high-water stored so a later baseline can window events");
	assert.equal(env.causal, undefined, "no baseline → no causal block");
});

test("browser_observe C3: session delta is default and env escape disables it", async () => {
	const snapshots = new Map<string, any>();
	const ledger = new Map<string, any>();
	const frames: any[] = [];
	let snapshotSeq = 0;
	const server = {
		...fakeServer,
		createObservationSnapshot(snapshot: any) {
			snapshotSeq += 1;
			const record = { snapshotId: `snap-${snapshotSeq}`, ttlMs: 60_000, expired: false, ...snapshot };
			snapshots.set(record.snapshotId, record);
			return record;
		},
		getObservationSnapshot(snapshotId: string) { return snapshots.get(snapshotId); },
		getPerceptionLedgerFrame(key: any) { return ledger.get(JSON.stringify(key)); },
		getRecentPerceptionLedgerFrames(_key: any, limit = 3) { return frames.slice(-limit).reverse(); },
		recordPerceptionLedgerFrame(frame: any) { ledger.set(JSON.stringify(frame.key), frame); frames.push(frame); return frame; },
	};
	const previous = process.env.PI_BROWSER_SESSION_DELTA;
	try {
		delete process.env.PI_BROWSER_SESSION_DELTA;
		const first = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(first.delta, undefined, "first observe remains an I-frame");
		assert.equal(typeof first.snapshot?.snapshotId, "string", "I-frame carries a snapshotId");
		assert.equal(typeof frames[0]?.allocation?.budgetUsedRatio, "number", "observe records allocation pressure in the ledger frame");
		const second = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(second.delta, "session", "second observe renders as a default session P-frame");
		assert.equal(second.baselineSnapshotId, first.snapshot.snapshotId, "P-frame names its I-frame baseline snapshot");
		process.env.PI_BROWSER_SESSION_DELTA = "0";
		const disabled = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(disabled.delta, undefined, "PI_BROWSER_SESSION_DELTA=0 forces I-frame behavior");
		const full = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "full" }, { cwd: process.cwd() }, "scan");
		assert.ok(full.content[0].text.includes("Checkout"), "detailLevel=full returns the full text payload as the refresh escape hatch");
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
		else process.env.PI_BROWSER_SESSION_DELTA = previous;
	}
});

function changeGateHarness(fingerprintProvider: () => Record<string, unknown> = () => ({ changeSeq: 1, url: "https://example.test/checkout", title: "Checkout", readyState: "complete", visibleCount: 5, interactiveCount: 1, capturedAt: 123 })) {
	const snapshots = new Map<string, any>();
	const ledger = new Map<string, any>();
	const frames: any[] = [];
	let snapshotSeq = 0;
	let scanEvals = 0;
	const server = {
		...fakeServer,
		createObservationSnapshot(snapshot: any) {
			snapshotSeq += 1;
			const record = { snapshotId: `snap-${snapshotSeq}`, ttlMs: 60_000, expired: false, ...snapshot };
			snapshots.set(record.snapshotId, record);
			return record;
		},
		getObservationSnapshot(snapshotId: string) { return snapshots.get(snapshotId); },
		getPerceptionLedgerFrame(key: any) { return ledger.get(JSON.stringify(key)); },
		getRecentPerceptionLedgerFrames(_key: any, limit = 3) { return frames.slice(-limit).reverse(); },
		recordPerceptionLedgerFrame(frame: any) { ledger.set(JSON.stringify(frame.key), frame); frames.push(frame); return frame; },
		async sendCommand(command: any, options: any) {
			if (command.cmd === "content.fingerprint") return { acknowledged: true, data: fingerprintProvider() };
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Runtime.evaluate") scanEvals += 1;
			return fakeServer.sendCommand(command, options);
		},
	};
	return { server, frames, get scanEvals() { return scanEvals; } };
}

test("browser_observe change gate reuses cached scan when content fingerprint is unchanged", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-change-gate-"));
	const harness = changeGateHarness();
	const previous = process.env.PI_BROWSER_SESSION_DELTA;
	try {
		delete process.env.PI_BROWSER_SESSION_DELTA;
		const first = JSON.parse((await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan")).content[0].text);
		const second = JSON.parse((await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan")).content[0].text);
		assert.equal(first.fromCache, undefined);
		assert.equal(second.summary?.fromCache, true);
		assert.equal(second.summary?.cache?.reason, "content-fingerprint-unchanged");
		assert.equal(harness.scanEvals, 1, "unchanged fingerprint should avoid a second Runtime.evaluate scan");
		assert.equal(harness.frames.length, 2, "cache hit still records a fresh ledger frame");
		assert.equal(harness.frames[1].renderCache.renderedAt, harness.frames[0].renderCache.renderedAt, "cache hits preserve the original render timestamp");
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
		else process.env.PI_BROWSER_SESSION_DELTA = previous;
	}
});

test("browser_observe change gate misses when output-affecting params change", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-change-gate-params-"));
	const envPrevious = process.env.PI_BROWSER_SESSION_DELTA;
	try {
		delete process.env.PI_BROWSER_SESSION_DELTA;
		const intentHarness = changeGateHarness();
		await runScanObservation(intentHarness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary", intent: "checkout" }, { cwd }, "scan");
		const changedIntent = JSON.parse((await runScanObservation(intentHarness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary", intent: "account" }, { cwd }, "scan")).content[0].text);
		assert.equal(changedIntent.summary?.fromCache, undefined, "changed intent must not reuse the cached render");
		assert.equal(intentHarness.scanEvals, 2, "changed intent triggers a fresh Runtime.evaluate scan");

		const outputHarness = changeGateHarness();
		await runScanObservation(outputHarness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan");
		const outputPath = path.join(cwd, "explicit-observe.json");
		const changedOutputPath = JSON.parse((await runScanObservation(outputHarness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary", outputPath }, { cwd }, "scan")).content[0].text);
		assert.equal(changedOutputPath.summary?.fromCache, undefined, "outputPath changes captureMaxChars and must miss");
		assert.equal(outputHarness.scanEvals, 2, "outputPath-driven capture breadth triggers a fresh Runtime.evaluate scan");
	} finally {
		if (envPrevious === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
		else process.env.PI_BROWSER_SESSION_DELTA = envPrevious;
	}
});

test("browser_observe change gate enforces TTL, kill switch, and fingerprint tuple", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-change-gate-ttl-"));
	let interactiveCount = 1;
	const harness = changeGateHarness(() => ({ changeSeq: 1, url: "https://example.test/checkout", title: "Checkout", readyState: "complete", visibleCount: 5, interactiveCount, capturedAt: 123 }));
	const previousDelta = process.env.PI_BROWSER_SESSION_DELTA;
	const previousTtl = process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS;
	try {
		delete process.env.PI_BROWSER_SESSION_DELTA;
		process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS = "5000";
		await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan");
		harness.frames[0].renderCache.renderedAt = Date.now() - 10_000;
		const expired = JSON.parse((await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan")).content[0].text);
		assert.equal(expired.summary?.fromCache, undefined, "expired renderCache must miss");
		assert.equal(harness.scanEvals, 2, "expired TTL triggers a fresh scan");

		process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS = "0";
		const disabled = JSON.parse((await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan")).content[0].text);
		assert.equal(disabled.summary?.fromCache, undefined, "TTL=0 disables observe cache hits");
		assert.equal(harness.scanEvals, 3, "disabled cache triggers a fresh scan");

		delete process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS;
		interactiveCount = 2;
		const changedTuple = JSON.parse((await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan")).content[0].text);
		assert.equal(changedTuple.summary?.fromCache, undefined, "same changeSeq with changed fingerprint tuple must miss");
		assert.equal(harness.scanEvals, 4, "changed fingerprint tuple triggers a fresh scan");
	} finally {
		if (previousDelta === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
		else process.env.PI_BROWSER_SESSION_DELTA = previousDelta;
		if (previousTtl === undefined) delete process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS;
		else process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS = previousTtl;
	}
});

function navigationObserveServer() {
	let currentUrl = "https://example.test/checkout";
	let snapshotSeq = 0;
	let scanEvals = 0;
	let fingerprintReads = 0;
	let navigations = 0;
	const snapshots = new Map<string, any>();
	const ledger = new Map<string, any>();
	const frames: any[] = [];
	const scanPayload = () => ({
		url: currentUrl,
		title: "Navigation",
		readyState: "complete",
		content: "<h1>Navigation</h1>\nStatus: payment required",
		node_count: 12,
		truncated: false,
		actionables: [{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 }],
		list_hints: [],
	});
	const server = {
		...fakeServer,
		async refreshTabs() { return [{ tabId: 7, url: currentUrl, title: "Navigation", active: true }]; },
		getTabs() { return [{ tabId: 7, url: currentUrl, title: "Navigation", active: true }]; },
		snapshot() { return { browserSessionId: "default", defaultTabId: 7, selectionVersion: 3, tabs: [{ tabId: 7, url: currentUrl, title: "Navigation", active: true }] }; },
		createObservationSnapshot(snapshot: any) {
			snapshotSeq += 1;
			const record = { snapshotId: `nav-snap-${snapshotSeq}`, ttlMs: 60_000, expired: false, ...snapshot };
			snapshots.set(record.snapshotId, record);
			return record;
		},
		getObservationSnapshot(snapshotId: string) { return snapshots.get(snapshotId); },
		getPerceptionLedgerFrame(key: any) { return ledger.get(JSON.stringify(key)); },
		getRecentPerceptionLedgerFrames(_key: any, limit = 3) { return frames.slice(-limit).reverse(); },
		recordPerceptionLedgerFrame(frame: any) { ledger.set(JSON.stringify(frame.key), frame); frames.push(frame); return frame; },
		async sendCommand(command: any, options: any) {
			if (command.cmd === "wait.navigate") {
				navigations += 1;
				currentUrl = String(command.url);
				return { id: "nav", acknowledged: true, tabId: 7, data: { url: currentUrl, state: "complete" } };
			}
			if (command.cmd === "wait.loadState") return { id: "wait", acknowledged: true, tabId: 7, data: { state: command.state ?? "complete" } };
			if (command.cmd === "content.fingerprint") {
				fingerprintReads += 1;
				return { acknowledged: true, data: { changeSeq: 1, url: currentUrl, title: "Navigation", readyState: "complete", visibleCount: 5, interactiveCount: 1, capturedAt: 123 } };
			}
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Runtime.evaluate") {
				scanEvals += 1;
				return { id: "eval-nav", acknowledged: true, tabId: 7, data: { result: { value: scanPayload() } } };
			}
			if (command.cmd === "html.get") return { id: "html", acknowledged: true, tabId: 7, data: { url: currentUrl, html: "<main>Navigation</main>" } };
			return fakeServer.sendCommand(command, options);
		},
	};
	return { server, frames, get scanEvals() { return scanEvals; }, get fingerprintReads() { return fingerprintReads; }, get navigations() { return navigations; } };
}

test("browser_observe scan url navigates first and skips old cache/baseline", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-observe-nav-scan-"));
	const harness = navigationObserveServer();
	const previous = process.env.PI_BROWSER_SESSION_DELTA;
	try {
		delete process.env.PI_BROWSER_SESSION_DELTA;
		const first = JSON.parse((await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan")).content[0].text);
		const fingerprintReadsAfterFirst = harness.fingerprintReads;
		const secondResult = await runScanObservation(harness.server as any, { mode: "scan", tabId: 7, url: "https://example.test/after", maxChars: 12_000, detailLevel: "summary" }, { cwd }, "scan");
		const second = JSON.parse(secondResult.content[0].text);
		assert.equal(first.snapshot?.url, "https://example.test/checkout");
		assert.equal(second.command, "navigate+scan");
		assert.equal(second.snapshot?.url, "https://example.test/after");
		assert.equal(second.delta, undefined, "navigation observe must not use the prior URL frame as implicit baseline");
		assert.equal(second.summary?.fromCache, undefined, "navigation observe must not serve the old render cache");
		assert.equal(harness.fingerprintReads, fingerprintReadsAfterFirst, "navigation observe skips the pre-navigation content fingerprint cache gate");
		assert.equal(harness.navigations, 1);
		assert.equal(harness.scanEvals, 2);
		assert.equal(harness.frames.at(-1)?.key?.navigationEpoch, "https://example.test/after", "ledger frame records the post-navigation URL");
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
		else process.env.PI_BROWSER_SESSION_DELTA = previous;
	}
});

test("browser_observe html url navigates before html.get", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-observe-nav-html-"));
	const harness = navigationObserveServer();
	const result = await runHtmlObservation(harness.server as any, { mode: "html", tabId: 7, url: "https://example.test/html", htmlMode: "outer", maxChars: 12_000 }, { cwd });
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.command, "navigate+html");
	assert.equal(envelope.snapshot?.url, "https://example.test/html");
	assert.equal(result.details?.mode, "html");
	assert.equal(result.details?.modeInferred, null);
	assert.equal(harness.navigations, 1);
});

function relevanceServer(options: { url?: string; traceTerms?: Array<{ term: string; kind: string; weight?: number }> } = {}) {
	const url = options.url ?? "https://example.test/neutral";
	return {
		...fakeServer,
		async refreshTabs() { return [{ tabId: 7, url, title: "Relevance", active: true }]; },
		getTabs() { return [{ tabId: 7, url, title: "Relevance", active: true }]; },
		snapshot() { return { browserSessionId: "default", defaultTabId: 7, selectionVersion: 3, tabs: [{ tabId: 7, url, title: "Relevance", active: true }] }; },
		perceptionTraceSnapshot() { return { terms: options.traceTerms ?? [], latestSeq: options.traceTerms?.length ?? 0 }; },
		async sendCommand(command: any, commandOptions: any) {
			if (command.cmd === "network.status") return { acknowledged: true, data: { active: false } };
			if (command.cmd === "hook.status") throw new Error("no hook session");
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Runtime.evaluate") {
				return { id: "eval-rel", acknowledged: true, tabId: 7, data: { result: { value: {
					url,
					title: "Relevance",
					readyState: "complete",
					content: "<h1>Actions</h1>\n<button>Account settings</button>\n<button>Checkout now</button>",
					node_count: 20,
					truncated: false,
					actionables: [
						{ index: 0, tag: "button", role: "button", action: "account", label: "Account settings", selector: "#account", point: { x: 80, y: 260 }, rect: { x: 40, y: 240, width: 120, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1000 },
						{ index: 1, tag: "button", role: "button", action: "checkout", label: "Checkout now", selector: "#checkout", point: { x: 240, y: 260 }, rect: { x: 190, y: 240, width: 120, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1000 },
					],
					list_hints: [],
				} } } };
			}
			return fakeServer.sendCommand(command, commandOptions);
		},
	};
}

function primaryActionNames(envelope: any): string[] {
	return (envelope.summary?.focus?.primary_actions ?? []).map((item: any) => String(item.name));
}

test("browser_observe relevance: no-signal is byte-identical to relevance-disabled (whole envelope)", async () => {
	const previous = process.env.PI_BROWSER_RELEVANCE;
	// Normalize the fields that differ between ANY two sequential observe runs regardless of
	// relevance — artifact filename (Date.now() in artifactFallbackName), the monotonic operation
	// counter, and epoch-ms timestamps — so the comparison isolates relevance's effect on the
	// model-facing envelope. Everything semantic (summary/focus/entities/ordering/refs/nextActions)
	// stays compared byte-for-byte; a real no-signal perturbation (reorder, added relevance field,
	// changed flags) is NOT normalized and would fail.
	const normalize = (env: unknown) => JSON.stringify(env)
		.replace(/observe-scan-\d+\.json/g, "observe-scan-N.json")
		.replace(/op-\d+/g, "op-N")
		.replace(/\b\d{13}\b/g, "T");
	try {
		process.env.PI_BROWSER_RELEVANCE = "0";
		const disabled = JSON.parse((await runScanObservation(relevanceServer() as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
		delete process.env.PI_BROWSER_RELEVANCE;
		const enabledNoSignal = JSON.parse((await runScanObservation(relevanceServer() as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(normalize(enabledNoSignal), normalize(disabled), "no-signal relevance must not perturb the model-facing envelope byte-for-byte");
		assert.equal(enabledNoSignal.summary?.relevance, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_RELEVANCE;
		else process.env.PI_BROWSER_RELEVANCE = previous;
	}
});

test("browser_observe relevance is boost-not-gate: a signal reorders but never narrows the action set", async () => {
	// The v3.1 "feedback-loop / repeated-observe-must-not-narrow" fixture, in its meaningful
	// reorder-mode form: turning relevance ON with a real trace signal may re-rank actions but must
	// never DROP one from the rendered set (boost-never-gate). Becomes a granularity-narrowing test
	// once the fact path drives the render (see the salience contract's promotion checklist).
	const neutral = JSON.parse((await runScanObservation(relevanceServer() as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	const boosted = JSON.parse((await runScanObservation(relevanceServer({ traceTerms: [{ term: "checkout", kind: "literal", weight: 1 }] }) as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	const neutralNames = primaryActionNames(neutral);
	const boostedNames = primaryActionNames(boosted);
	assert.ok((boosted.summary?.relevance?.boosted ?? 0) > 0, "the trace signal must actually activate relevance, else this fixture is vacuous");
	assert.deepEqual([...boostedNames].sort(), [...neutralNames].sort(), "relevance must preserve the rendered action set — boost reorders, never narrows");
	assert.equal(boostedNames.length, neutralNames.length, "relevance must not change the rendered action count");
});

test("browser_observe relevance URL cold-start boosts matching actions without trace terms in envelope", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-relevance-url-"));
	const envelope = JSON.parse((await runScanObservation(relevanceServer({ url: "https://example.test/checkout" }) as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd }, "scan")).content[0].text);
	assert.equal(primaryActionNames(envelope)[0], "checkout");
	assert.equal(envelope.summary?.relevance?.signals?.includes("D"), true);
	assert.equal(JSON.stringify(envelope).includes("debugTerms"), false);
	assert.equal(JSON.stringify(envelope).includes("checkout now"), false, "raw trace/debug terms are not serialized into the model-facing envelope");
	const saved = JSON.parse(readFileSync(envelope.saved.path, "utf8"));
	assert.equal(saved.relevance?.signals?.includes("D"), true, "artifact carries source tags for boosted refs");
	assert.equal(saved.relevance?.debugTerms, undefined, "artifact omits raw terms unless debug env is enabled");
});

test("browser_observe relevance behavioral trace and explicit intent use the same lookup surface", async () => {
	const traced = JSON.parse((await runScanObservation(relevanceServer({ traceTerms: [{ term: "#checkout", kind: "literal", weight: 1.4 }] }) as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(primaryActionNames(traced)[0], "checkout");
	assert.equal(traced.summary?.relevance?.signals?.includes("A"), true);
	const intent = JSON.parse((await runScanObservation(relevanceServer() as any, { mode: "scan", tabId: 7, maxChars: 12_000, intent: "checkout" }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(primaryActionNames(intent)[0], "checkout");
	assert.equal(intent.summary?.relevance?.signals?.includes("E"), true);
});

test("browser_observe relevance debug terms stay artifact-only", async () => {
	const previous = process.env.PI_BROWSER_RELEVANCE_DEBUG;
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-relevance-debug-"));
	try {
		process.env.PI_BROWSER_RELEVANCE_DEBUG = "1";
		const envelope = JSON.parse((await runScanObservation(relevanceServer({ traceTerms: [{ term: "#checkout", kind: "literal", weight: 1.4 }] }) as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd }, "scan")).content[0].text);
		assert.equal(JSON.stringify(envelope).includes("debugTerms"), false, "debug terms never enter the envelope");
		const saved = JSON.parse(readFileSync(envelope.saved.path, "utf8"));
		assert.equal(Array.isArray(saved.relevance?.debugTerms), true, "debug terms are available only in the saved artifact under opt-in env");
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_RELEVANCE_DEBUG;
		else process.env.PI_BROWSER_RELEVANCE_DEBUG = previous;
	}
});

test("browser_observe P2-B: a DOM-sink event naming its element → triggered edge on that control (source event)", async () => {
	// Discover a control with a selector from a plain scan, then have the hook delta name it.
	const probe = causalServer({ status: { active: true, lastSeq: 8 } });
	const env1 = JSON.parse((await runScanObservation(probe as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	const ctl = (env1.entities ?? []).find((e: any) => e.hints?.selector && (e.kind === "control" || e.kind === "element"));
	assert.ok(ctl?.hints?.selector, "a control with a selector is available to attribute to");
	const server = causalServer(
		{ status: { active: true, lastSeq: 8 }, list: { items: [], total: 0 } },
		{ status: { last_seq: 11 }, collect: { events: [{ seq: 10, type: "domSink", timestamp: 1, data: { value: "x" }, selector: ctl.hints.selector }] } },
	);
	const env2 = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, hookSeq: 9, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env2.causal?.events?.length, 1, "event present in causal.events");
	assert.equal(env2.relations?.summary?.triggered, 1, "event-sourced triggered counted in relations.summary");
	const edge = (env2.entities ?? []).find((e: any) => e.ref === ctl.ref)?.relations?.find((r: any) => r.type === "triggered");
	if (edge) {
		assert.equal(edge.source, "event", "element-sourced attribution (stronger than timing)");
		assert.equal(edge.targetRef, "pi-ref://event/10", "edge targets the event ref");
	}
});
