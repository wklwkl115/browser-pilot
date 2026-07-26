import assert from "node:assert/strict";
import test from "node:test";
import { axCacheKeyForPage, executeScanCapture } from "../../src/commands/observe/scanCapture.ts";
import { finalizedObserveTimings } from "../../src/commands/observe/timings.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserRuntimeCommand } from "../../src/ports/BrowserRuntimeTypes.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

test("AX cache identity requires page and observer epochs and includes every change discriminator", () => {
	assert.equal(axCacheKeyForPage({ changeSeq: 1, url: "https://example.test" }), undefined);
	assert.equal(axCacheKeyForPage({ changeSeq: 1, pageEpoch: "page-1", url: "https://example.test" }), undefined);
	const base = { changeSeq: 1, observerEpoch: "observer-1", pageEpoch: "page-1", documentId: "doc-1", url: "https://example.test", title: "Example", readyState: "complete", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, visibleCount: 4, interactiveCount: 2 };
	const key = axCacheKeyForPage(base);
	for (const changed of [
		{ ...base, observerEpoch: "observer-2" },
		{ ...base, pageEpoch: "page-2" },
		{ ...base, documentId: "doc-2" },
		{ ...base, changeSeq: 2 },
		{ ...base, url: "https://example.test/next" },
		{ ...base, title: "Next" },
		{ ...base, readyState: "interactive" },
		{ ...base, scrollX: 100 },
		{ ...base, scrollY: 100 },
		{ ...base, viewportWidth: 1024 },
		{ ...base, viewportHeight: 768 },
		{ ...base, devicePixelRatio: 2 },
		{ ...base, visibleCount: 5 },
		{ ...base, interactiveCount: 3 },
	]) assert.notEqual(key, axCacheKeyForPage(changed));
});

test("observe diagnostics retain measured visual phases without synthetic totals", () => {
	const data = pageWorldScanBundle();
	const timings = finalizedObserveTimings({ tabRefreshMs: 2, fingerprintMs: 3, pageScriptMs: 5, abmlMs: 7, visualMs: 11, screenshotTransportMs: 8, visualDecodeHashMs: 2, visualWriteMs: 1 }, data, undefined);
	assert.equal(timings.transportMs, undefined);
	assert.equal(timings.screenshotTransportMs, 8);
	assert.equal(timings.visualDecodeHashMs, 2);
	assert.equal(timings.visualWriteMs, 1);
});

type FingerprintStep = number | { changeSeq: number; observerEpoch?: string };

function scanCaptureRuntime(sequences: FingerprintStep[], pageEpoch = "page-1") {
	const calls: string[] = [];
	const runtime = {
		calls,
		snapshot() {
			return { browserSessionId: "session-1", defaultTabId: 7, selectionVersion: 1, tabs: [{ tabId: 7, targetGeneration: 1, pageEpoch, documentId: "doc-1", url: "https://example.test/" }] };
		},
		createObservationSnapshot(input: Record<string, unknown>) {
			return { snapshotId: `snapshot-${calls.length}`, sourceMode: "scan", capturedAt: Number(input.capturedAt), ttlMs: 300_000, ...input };
		},
		async sendCommand(command: BrowserRuntimeCommand) {
			const method = typeof command.cdpMethod === "string" ? command.cdpMethod : String(command.cmd);
			calls.push(method);
			if (command.cmd === "content.fingerprint") {
				const step = sequences.shift();
				const changeSeq = typeof step === "number" ? step : step?.changeSeq;
				const observerEpoch = typeof step === "object" ? step.observerEpoch : undefined;
				return { id: "fingerprint", acknowledged: true, data: { changeSeq, ...(observerEpoch ? { observerEpoch } : {}), pageEpoch, documentId: "doc-1", url: "https://example.test/", title: "Example", readyState: "complete", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, visibleCount: 0, interactiveCount: 0 } };
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

function liveFingerprint(changeSeq: number, observerEpoch?: string) {
	return { changeSeq, ...(observerEpoch ? { observerEpoch } : {}), pageEpoch: "page-cache", documentId: "doc-1", url: "https://example.test/", title: "Example", readyState: "complete", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, visibleCount: 0, interactiveCount: 0 };
}

test("scan capture reuses a stable raw scan while refreshing ABML snapshot ownership", async () => {
	const server = scanCaptureRuntime([{ changeSeq: 1, observerEpoch: "observer-1" }, { changeSeq: 1, observerEpoch: "observer-1" }], "page-cache-hit");
	const fingerprint = { ...liveFingerprint(1, "observer-1"), pageEpoch: "page-cache-hit", documentId: "doc-1", visibleCount: 0, interactiveCount: 0 };
	const first = await executeScanCapture({ ...captureOptions(server), pageFingerprint: fingerprint });
	const second = captureOptions(server);
	const reused = await executeScanCapture({ ...second, pageFingerprint: fingerprint });
	assert.equal(server.calls.filter((call) => call === "Runtime.evaluate").length, 1);
	assert.equal(server.calls.filter((call) => call === "Accessibility.getFullAXTree").length, 1);
	assert.equal(second.timings.scanCacheHit, true);
	assert.notEqual(first.observation.abmlRead.ok && first.observation.abmlRead.data.snapshotId, reused.observation.abmlRead.ok && reused.observation.abmlRead.data.snapshotId);
});

test("scan capture fully reanchors changed pages and observer replacements", async () => {
	const server = scanCaptureRuntime([
		{ changeSeq: 1, observerEpoch: "observer-1" },
		{ changeSeq: 2, observerEpoch: "observer-1" },
		{ changeSeq: 2, observerEpoch: "observer-2" },
	], "page-cache");
	await executeScanCapture({ ...captureOptions(server), pageFingerprint: liveFingerprint(1, "observer-1") });
	const changed = captureOptions(server);
	await executeScanCapture({ ...changed, pageFingerprint: liveFingerprint(2, "observer-1") });
	const replaced = captureOptions(server);
	await executeScanCapture({ ...replaced, pageFingerprint: liveFingerprint(2, "observer-2") });
	assert.equal(server.calls.filter((call) => call === "Runtime.evaluate").length, 3);
	assert.equal(server.calls.filter((call) => call === "Accessibility.getFullAXTree").length, 3);
	assert.equal(server.calls.filter((call) => call === "DOMSnapshot.captureSnapshot").length, 3);
	assert.equal(changed.timings.scanFullReanchor, true);
	assert.equal(replaced.timings.scanFullReanchor, true);
});

test("fresh scan capture bypasses both scan and AX caches", async () => {
	const server = scanCaptureRuntime([
		{ changeSeq: 1, observerEpoch: "observer-fresh" },
		{ changeSeq: 1, observerEpoch: "observer-fresh" },
	], "page-cache");
	const fingerprint = liveFingerprint(1, "observer-fresh");
	await executeScanCapture({ ...captureOptions(server), pageFingerprint: fingerprint });
	const fresh = captureOptions(server);
	await executeScanCapture({ ...fresh, params: { fresh: true }, pageFingerprint: fingerprint });
	assert.equal(server.calls.filter((call) => call === "Runtime.evaluate").length, 2);
	assert.equal(server.calls.filter((call) => call === "Accessibility.getFullAXTree").length, 2);
	assert.equal(server.calls.filter((call) => call === "DOMSnapshot.captureSnapshot").length, 2);
	assert.equal(fresh.timings.scanCacheHit, undefined);
	assert.equal(fresh.timings.scanFullReanchor, true);
});

test("stable scan reuse is bounded and refreshes the AX cache on reanchor", async () => {
	const steps = Array.from({ length: 18 }, () => ({ changeSeq: 1, observerEpoch: "observer-bounded" }));
	const server = scanCaptureRuntime(steps, "page-bounded");
	const fingerprint = { ...liveFingerprint(1, "observer-bounded"), pageEpoch: "page-bounded" };
	let finalTimings: Record<string, number | boolean | undefined> | undefined;
	for (let index = 0; index < 18; index += 1) {
		const options = captureOptions(server);
		await executeScanCapture({ ...options, pageFingerprint: fingerprint });
		finalTimings = options.timings;
	}
	assert.equal(server.calls.filter((call) => call === "Runtime.evaluate").length, 2);
	assert.equal(server.calls.filter((call) => call === "Accessibility.getFullAXTree").length, 2);
	assert.equal(server.calls.filter((call) => call === "DOMSnapshot.captureSnapshot").length, 2);
	assert.equal(finalTimings?.scanFullReanchor, true);
});

test("scan capture retries one torn DOM+AX observation and accepts the stable retry", async () => {
	const server = scanCaptureRuntime([2, 3, 3]);
	const options = { ...captureOptions(server), pageFingerprint: { changeSeq: 1, pageEpoch: "page-1", documentId: "doc-1", url: "https://example.test/", title: "Example", readyState: "complete", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, visibleCount: 0, interactiveCount: 0 } };
	const result = await executeScanCapture(options);
	assert.equal(result.observation.abmlRead.ok, true);
	assert.deepEqual(result.observation.abmlRead.ok ? result.observation.abmlRead.data.observationCoherence : undefined, { status: "stable", attempts: 2 });
	assert.equal(server.calls.filter((call) => call === "Runtime.evaluate").length, 2);
	assert.equal(options.timings.abmlCoherenceRetries, 1);
	assert.equal(options.timings.observationAttempts, 2);
	assert.equal(options.timings.axCdpCalls, 4);
	assert.deepEqual(server.calls, [
		"Runtime.evaluate", "Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot", "content.fingerprint",
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
	assert.equal(result.visualCapture?.mime, "image/png");
	assert.equal(Buffer.isBuffer(result.visualCapture?.buffer), true);
	assert.equal(options.timings.observationAttempts, 1);
	assert.equal(options.timings.screenshotBytes, result.visualCapture?.buffer.length);
	assert.equal(typeof options.timings.screenshotTransportMs, "number");
	assert.equal(typeof options.timings.visualDecodeHashMs, "number");
	assert.deepEqual(server.calls, ["content.fingerprint", "Runtime.evaluate", "Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot", "screenshot.capture", "content.fingerprint"]);
});

test("scan capture reads AX and visual evidence concurrently inside one fingerprint bracket", async () => {
	const base = scanCaptureRuntime([1, 1], "page-concurrent");
	const sendCommand = base.sendCommand.bind(base);
	let active = 0;
	let maxActive = 0;
	const server = {
		...base,
		async sendCommand(command: BrowserRuntimeCommand) {
			const method = typeof command.cdpMethod === "string" ? command.cdpMethod : String(command.cmd);
			if (!["Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot", "screenshot.capture"].includes(method)) return sendCommand(command);
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			try { return await sendCommand(command); }
			finally { active -= 1; }
		},
	} as unknown as BrowserCommandRuntimePort;
	await executeScanCapture({ ...captureOptions(server), params: { visual: "always" } });
	assert.equal(maxActive, 3);
});
