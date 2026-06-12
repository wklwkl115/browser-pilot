import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScanObservation } from "../../../src/tools/observeRunners.ts";
import { validateObserveParams } from "../../../src/tools/registerObserveTool.ts";
import { distilledJsonResult } from "../../../src/tools/resultMiddleware.ts";

let opId = 0;

function textOf(result) {
	return result.content.map((item) => item.text).join("\n");
}

function createLongConversationServer() {
	const snapshots = new Map();
	const ledger = new Map();
	let snapshotSeq = 0;
	let scanSeq = 0;
	const calls = [];
	const tab = { tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true };
	const server = {
		queueDepth() { return 0; },
		leaseOwnerHash() { return undefined; },
		beginOperation(meta) { opId += 1; return { operationId: `op-${opId}`, startedAt: Date.now(), updatedAt: Date.now(), ...meta }; },
		updateOperation(operationId, patch) { return { operationId, startedAt: Date.now(), updatedAt: Date.now(), ...patch }; },
		finishOperation() { return undefined; },
		async refreshTabs() { return [tab]; },
		getTabs() { return [tab]; },
		snapshot() { return { browserSessionId: "default", defaultTabId: 7, selectionVersion: 3, tabs: [tab] }; },
		createObservationSnapshot(snapshot) {
			snapshotSeq += 1;
			const record = { snapshotId: `snap-${snapshotSeq}`, ttlMs: 60_000, expired: false, ...snapshot };
			snapshots.set(record.snapshotId, record);
			return record;
		},
		getObservationSnapshot(snapshotId) { return snapshots.get(snapshotId); },
		getPerceptionLedgerFrame(key) { return ledger.get(JSON.stringify(key)); },
		recordPerceptionLedgerFrame(frame) { ledger.set(JSON.stringify(frame.key), frame); return frame; },
		deleteSnapshot(snapshotId) { snapshots.delete(snapshotId); },
		ledgerSize() { return ledger.size; },
		async sendCommand(command) {
			if (command.cmd === "network.status") return { acknowledged: true, data: { active: false } };
			if (command.cmd === "hook.status") throw new Error("no hook session");
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Runtime.evaluate") {
				const expression = String(command.params?.expression || "");
				calls.push(expression.includes("collectActionables") ? "scan_extract" : "abml_read_scan");
				if (expression.includes("collectActionables")) {
					scanSeq += 1;
					return { id: `eval-${scanSeq}`, acknowledged: true, tabId: 7, data: { result: { value: {
						url: tab.url,
						title: "Checkout",
						readyState: "complete",
						content: `<h1>Checkout</h1>\nStatus step ${scanSeq}`,
						node_count: 16 + scanSeq,
						truncated: false,
						actionables: [
							{ index: 0, tag: "button", role: "button", action: "pay", label: `Pay now ${scanSeq}`, selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 },
							{ index: 1, tag: "button", role: "button", action: "details", label: `Details ${scanSeq}`, selector: "#details", point: { x: 280, y: 260 }, rect: { x: 240, y: 240, width: 100, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1100 },
						],
						list_hints: [],
					} } } };
				}
			}
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Accessibility.getFullAXTree") {
				return { id: "ax-tree", acknowledged: true, tabId: 7, data: { result: { nodes: [
					{ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } },
					{ nodeId: "ax-2", backendDOMNodeId: 82, role: { value: "button" }, name: { value: "Details" } },
				] } } };
			}
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "DOM.getBoxModel") {
				return { id: "box-1", acknowledged: true, tabId: 7, data: { result: { border: [140, 240, 220, 240, 220, 272, 140, 272] } } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
	return server;
}

const previous = process.env.PI_BROWSER_SESSION_DELTA;
const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-session-delta-long-"));
try {
	delete process.env.PI_BROWSER_SESSION_DELTA;
	const server = createLongConversationServer();
	const envelopes = [];
	for (let i = 0; i < 6; i += 1) {
		const result = await runScanObservation(server, { mode: "scan", tabId: 7, maxChars: 6_000 }, { cwd }, "scan");
		envelopes.push(JSON.parse(textOf(result)));
	}
	assert.equal(envelopes.length, 6, "long-conversation fixture must run at least 5 observes");
	assert.equal(envelopes[0].delta, undefined, "first frame is an I-frame");
	for (const [index, envelope] of envelopes.slice(1).entries()) {
		assert.equal(envelope.delta, "session", `observe ${index + 2} is a default P-frame`);
		assert.equal(envelope.baselineSnapshotId, envelopes[index].snapshot.snapshotId, `observe ${index + 2} names the previous frame baseline`);
		assert.equal(typeof envelope.saved?.path, "string", "P-frame keeps a saved artifact for ref/detail recovery under tight budgets");
		assert.ok((envelope.nextActions || []).some((action) => action.startsWith("read_saved_artifact")), "P-frame exposes artifact recovery actions");
	}
	const fresh = JSON.parse(textOf(await runScanObservation(server, { mode: "scan", tabId: 7, fresh: true, maxChars: 12_000 }, { cwd }, "scan")));
	assert.equal(fresh.delta, undefined, "fresh:true forces a full I-frame re-anchor");
	assert.equal(typeof fresh.snapshot?.snapshotId, "string", "fresh:true creates a reusable fresh snapshot");
	assert.ok(Array.isArray(fresh.entities) && fresh.entities.some((entity) => typeof entity.ref === "string" && entity.kind === "control"), "fresh:true restores inline entities");
	const afterFresh = JSON.parse(textOf(await runScanObservation(server, { mode: "scan", tabId: 7, maxChars: 6_000 }, { cwd }, "scan")));
	assert.equal(afterFresh.delta, "session", "no-fresh follow-up resumes session delta after the fresh frame");
	assert.equal(afterFresh.baselineSnapshotId, fresh.snapshot.snapshotId, "no-fresh follow-up uses the fresh frame as baseline");
	assert.doesNotThrow(() => validateObserveParams("scan", { fresh: false, baseline: { snapshotId: "snap-ok" } }), "fresh:false keeps absent-fresh baseline behavior");
	assert.throws(() => validateObserveParams("scan", { fresh: true, baseline: { snapshotId: "snap-old" } }), (error) => error?.code === "INVALID_RULE" && /fresh:true cannot be combined/.test(String(error.details?.reason)), "fresh:true rejects explicit baseline");
	assert.throws(() => validateObserveParams("content", { fresh: true }), (error) => error?.code === "INVALID_RULE" && /fresh:true is only valid/.test(String(error.details?.reason)), "fresh:true rejects content mode");
	assert.throws(() => validateObserveParams("html", { fresh: true }), (error) => error?.code === "INVALID_RULE" && /fresh:true is only valid/.test(String(error.details?.reason)), "fresh:true rejects html mode");
	server.deleteSnapshot(afterFresh.snapshot.snapshotId);
	const escaped = JSON.parse(textOf(await runScanObservation(server, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd }, "scan")));
	assert.equal(escaped.delta, undefined, "missing previous snapshot degrades to an I-frame instead of failing");
	assert.equal(typeof escaped.snapshot?.snapshotId, "string", "context-loss I-frame refreshes the baseline");
	assert.ok(Array.isArray(escaped.entities) && escaped.entities.some((entity) => typeof entity.ref === "string" && entity.kind === "control"), "context-loss I-frame restores inline readable control refs");

	process.env.PI_BROWSER_SESSION_DELTA = "0";
	const disabled = JSON.parse(textOf(await runScanObservation(server, { mode: "scan", tabId: 7, maxChars: 6_000 }, { cwd }, "scan")));
	assert.equal(disabled.delta, undefined, "PI_BROWSER_SESSION_DELTA=0 is the P3 escape hatch");

	const fanout = JSON.parse(textOf(await distilledJsonResult({ ok: true, data: { value: "saved" } }, {
		toolName: "browser_observe",
		command: "scan",
		maxChars: 4_000,
		ctx: { cwd },
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
	})));
	const recoveryTargets = fanout.nextActions.filter((item) => item.startsWith("read_saved_artifact") || item.includes("pi-ref://"));
	assert.equal(recoveryTargets.length <= 3, true, "P-frame recovery fan-out cap stays active");
	assert.equal(recoveryTargets.some((item) => item.includes("data.d")), false, "P-frame recovery fan-out drops overflow targets");

	console.log(`session-delta long conversation ok — observes=${envelopes.length}, ledgerFrames=${server.ledgerSize()}`);
} finally {
	if (previous === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
	else process.env.PI_BROWSER_SESSION_DELTA = previous;
	await rm(cwd, { recursive: true, force: true });
}
