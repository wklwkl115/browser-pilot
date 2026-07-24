import assert from "node:assert/strict";
import test from "node:test";
import { axCacheKeyForPage, executeScanCapture } from "../../src/commands/observe/scanCapture.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserRuntimeCommand } from "../../src/ports/BrowserRuntimeTypes.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

test("AX cache identity requires page epoch and includes every change discriminator", () => {
	assert.equal(axCacheKeyForPage({ changeSeq: 1, url: "https://example.test" }), undefined);
	const base = { changeSeq: 1, pageEpoch: "page-1", documentId: "doc-1", url: "https://example.test", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720 };
	const key = axCacheKeyForPage(base);
	for (const changed of [
		{ ...base, pageEpoch: "page-2" },
		{ ...base, documentId: "doc-2" },
		{ ...base, changeSeq: 2 },
		{ ...base, url: "https://example.test/next" },
		{ ...base, scrollY: 100 },
		{ ...base, viewportWidth: 1024 },
	]) assert.notEqual(key, axCacheKeyForPage(changed));
});

function scanCaptureRuntime(sequences: number[]) {
	const calls: string[] = [];
	const runtime = {
		calls,
		snapshot() {
			return { browserSessionId: "session-1", defaultTabId: 7, selectionVersion: 1, tabs: [{ tabId: 7, targetGeneration: 1, pageEpoch: "page-1", documentId: "doc-1", url: "https://example.test/" }] };
		},
		createObservationSnapshot(input: Record<string, unknown>) {
			return { snapshotId: `snapshot-${calls.length}`, sourceMode: "scan", capturedAt: Number(input.capturedAt), ttlMs: 300_000, ...input };
		},
		async sendCommand(command: BrowserRuntimeCommand) {
			const method = typeof command.cdpMethod === "string" ? command.cdpMethod : String(command.cmd);
			calls.push(method);
			if (command.cmd === "content.fingerprint") {
				const changeSeq = sequences.shift();
				return { id: "fingerprint", acknowledged: true, data: { changeSeq, pageEpoch: "page-1", documentId: "doc-1", url: "https://example.test/", title: "Example", readyState: "complete", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, visibleCount: 0, interactiveCount: 0 } };
			}
			if (command.cmd === "screenshot.capture") return { id: "screenshot", acknowledged: true, data: { screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s6Nwl8AAAAASUVORK5CYII=", method: "persistent_cdp" } };
			if (method === "Runtime.evaluate") {
				const bundle = pageWorldScanBundle({ signals: { fingerprint: { changeSeq: 0, capturedAt: 10, scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720 } } });
				return { id: "scan", acknowledged: true, data: { result: { value: bundle } } };
			}
			if (method === "Accessibility.getFullAXTree") return { id: "ax", acknowledged: true, data: { nodes: [] } };
			if (method === "DOMSnapshot.captureSnapshot") return { id: "snapshot", acknowledged: true, data: { documents: [], strings: [] } };
			throw new Error(`unexpected command: ${method}`);
		},
	} as unknown as BrowserCommandRuntimePort & { calls: string[] };
	return runtime;
}

function captureOptions(server: BrowserCommandRuntimePort) {
	const timings: Record<string, number | boolean | undefined> = {};
	return { server, params: {}, rawTargetRef: 7, browserSessionId: "session-1", tabId: 7, timeoutMs: 2_000, captureMaxChars: 10_000, scanScript: "scan", baseline: undefined, pageFingerprint: undefined, pageIdentity: undefined, reanchorReason: undefined, timings };
}

test("scan capture retries one torn DOM+AX observation and accepts the stable retry", async () => {
	const server = scanCaptureRuntime([1, 2, 3, 3]);
	const options = captureOptions(server);
	const result = await executeScanCapture(options);
	assert.equal(result.observation.abmlRead.ok, true);
	assert.deepEqual(result.observation.abmlRead.ok ? result.observation.abmlRead.data.observationCoherence : undefined, { status: "stable", attempts: 2 });
	assert.equal(server.calls.filter((call) => call === "Runtime.evaluate").length, 2);
	assert.equal(options.timings.abmlCoherenceRetries, 1);
	assert.deepEqual(server.calls, [
		"content.fingerprint", "Runtime.evaluate", "Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot", "content.fingerprint",
		"content.fingerprint", "Runtime.evaluate", "Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot", "content.fingerprint",
	]);
});

test("scan capture rejects repeatedly torn fusion and falls back to scan entities", async () => {
	const server = scanCaptureRuntime([1, 2, 3, 4]);
	const result = await executeScanCapture(captureOptions(server));
	assert.equal(result.observation.abmlRead.ok, false);
	assert.equal(result.observation.abmlRead.ok ? undefined : result.observation.abmlRead.error.code, "ABML_OBSERVATION_UNSTABLE");
	assert.equal(result.baseline, undefined);
	assert.equal(result.reanchorReason, "identity_unproven");
	assert.equal(result.fusedPageFingerprint, undefined);
	assert.equal(result.observation.result.data.signals.fingerprint.changeSeq, 0);
});

test("scan capture rejects unverified fingerprints instead of publishing AX fusion", async () => {
	const options = captureOptions(scanCaptureRuntime([Number.NaN, Number.NaN, Number.NaN, Number.NaN]));
	const result = await executeScanCapture(options);
	assert.equal(result.observation.abmlRead.ok, false);
	assert.equal(result.observation.abmlRead.ok ? undefined : result.observation.abmlRead.error.code, "ABML_OBSERVATION_UNSTABLE");
	assert.equal(options.timings.abmlCoherenceRetries, 1);
});

test("scan capture brackets an explicitly requested visual observation with the same fingerprint", async () => {
	const server = scanCaptureRuntime([1, 1]);
	const options = { ...captureOptions(server), params: { visual: "always" as const } };
	const result = await executeScanCapture(options);
	assert.equal(result.visualRequested, true);
	assert.equal(result.visualCapture?.actionableGrounding, true);
	assert.equal(result.visualCapture?.width, 1);
	assert.deepEqual(server.calls, ["content.fingerprint", "Runtime.evaluate", "Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot", "screenshot.capture", "content.fingerprint"]);
});
