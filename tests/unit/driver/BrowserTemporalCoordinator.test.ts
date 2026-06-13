import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserTemporalCoordinator, queueTemporalDiagnostics } from "../../../src/driver/BrowserTemporalCoordinator.ts";
import { summarizeTemporalProfileSamples, writeTemporalProfileArtifacts } from "../../../src/driver/temporalProfileArtifacts.ts";
import type { BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo } from "../../../src/driver/types.ts";

test("temporal profile artifacts write canonical summary, per-run samples, and eval copy", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-temporal-profile-"));
	const evalRunDir = path.join(cwd, "eval-run");
	const samples = [
		{ tool: "browser_wait", command: "wait.selector", elapsedMs: 120, waitAttempts: 2, historyLost: false, verdict: "possibly_stale" as const, reasons: ["selector_missing" as const], recovery: "reobserve" as const },
		{ tool: "browser_execute", command: "javascript", elapsedMs: 45, queueDelayMs: 5, queueDepthAtEnqueue: 1, queueDepthAtStart: 1, verdict: "fresh" as const, reasons: ["same_target" as const], recovery: "reuse_target" as const },
	];
	const paths = await writeTemporalProfileArtifacts({ cwd, runId: "run:one", samples, evalRunDir, runnerSummaryPath: path.join(evalRunDir, "browser-workflow-eval-summary.json") });

	assert(paths.canonicalSummaryPath.endsWith(path.join(".pi", "browser-artifacts", "temporal-profile-summary.json")));
	assert(paths.runSamplesPath.endsWith(path.join(".pi", "browser-artifacts", "temporal-profile", "run_one", "temporal-profile-samples.jsonl")));
	assert(paths.evalRunSummaryPath?.endsWith(path.join("eval-run", "temporal-profile-summary.json")));
	const canonical = JSON.parse(await readFile(paths.canonicalSummaryPath, "utf8"));
	const runSummary = JSON.parse(await readFile(paths.runSummaryPath, "utf8"));
	const samplesText = await readFile(paths.runSamplesPath, "utf8");
	assert.equal(canonical.sampleCount, 2);
	assert.equal(canonical.tools.browser_wait, 1);
	assert.equal(canonical.reasons.selector_missing, 1);
	assert.equal(canonical.queueDelayMs.samples, 1);
	assert.deepEqual(runSummary, canonical);
	assert.equal(samplesText.trim().split("\n").length, 2);
});

test("BrowserTemporalCoordinator synthesizes stamps from existing snapshot carriers", () => {
	const coordinator = new BrowserTemporalCoordinator();
	const observation: BrowserObservationSnapshotInfo = {
		snapshotId: "snap-1",
		browserSessionId: "session-1",
		tabId: 7,
		url: "https://example.test/app",
		selectionVersion: 5,
		sourceMode: "scan",
		capturedAt: 1234,
		ttlMs: 10_000,
		networkSeq: 11,
		hookSeq: 4,
	};
	const anchor = coordinator.anchorFromObservationSnapshot(observation);
	assert.equal(anchor.version, "temporal-anchor/v1");
	assert.equal(anchor.source, "observe");
	assert.equal(anchor.stamp.clockDomain, "driver_wall");
	assert.equal(anchor.stamp.networkSeq, 11);

	const snapshot: BrowserBridgeSnapshot = {
		browserSessionId: "session-1",
		host: "127.0.0.1",
		port: 1,
		running: true,
		connectedClients: 1,
		extensionConnected: true,
		extension: { id: "browser-1", workerBootId: "boot-1", connectedAt: 1, lastSeenAt: 2 },
		clients: [],
		defaultTabId: 7,
		defaultTabHandle: "tab-handle-7",
		selectionVersion: 5,
		tabs: [],
		pending: [],
	};
	const target: BrowserBridgeTargetInfo = { browserSessionId: "session-1", tabId: 7, tabHandle: "tab-handle-7", targetRef: "pi-tab://session-1/7", browserId: "browser-1", source: "explicit", implicit: false, selectionVersionAtDispatch: 5, url: "https://example.test/app" };
	const stamp = coordinator.stampFromTarget(target, snapshot, 1300);
	assert.equal(stamp.targetRef, "pi-tab://session-1/7");
	assert.equal(stamp.workerBootId, "boot-1");
	assert.equal(coordinator.estimateTargetContinuity(anchor, stamp).verdict.status, "fresh");
});

test("BrowserTemporalCoordinator builds samples from result diagnostics and supervisor payload", () => {
	const coordinator = new BrowserTemporalCoordinator();
	const sample = coordinator.buildProfileSample({
		operationId: "op-1",
		tool: "browser_wait",
		command: "wait.selector",
		deadlineMs: 500,
		elapsedMs: 125,
		result: {
			id: "req-1",
			acknowledged: true,
			data: {
				supervisor: {
					attempts: 2,
					workerRestarts: 1,
					historyLost: true,
				},
			},
			diagnostics: {
				temporal: {
					verdict: { status: "unknown", confidence: "lost", reasons: ["worker_restarted_history_lost", "unknown_due_to_history_loss"] },
					frontier: { next: "diagnose" },
				},
				temporalProfile: { queueDelayMs: 4, queueDepthAtEnqueue: 1, queueDepthAtStart: 1 },
			},
		},
	});
	assert.deepEqual(sample, {
		operationId: "op-1",
		tool: "browser_wait",
		command: "wait.selector",
		deadlineMs: 500,
		elapsedMs: 125,
		queueDepthAtEnqueue: 1,
		queueDepthAtStart: 1,
		queueDelayMs: 4,
		waitAttempts: 2,
		workerRestarts: 1,
		historyLost: true,
		verdict: "unknown",
		reasons: ["worker_restarted_history_lost", "unknown_due_to_history_loss"],
		recovery: "diagnose",
	});
	const summary = summarizeTemporalProfileSamples([sample], { runId: "runtime" });
	assert.equal(summary.historyLostCount, 1);
	assert.equal(summary.waitAttempts?.median, 2);
});

test("queueTemporalDiagnostics emits profile always and verdict only for pressure", () => {
	const calm = queueTemporalDiagnostics({ queueDelayMs: 1, queueDepthAtEnqueue: 0, queueDepthAtStart: 1, deadlineMs: 100 });
	assert.equal(calm.temporal, undefined);
	assert.equal(calm.temporalProfile.queueDelayMs, 1);
	const delayed = queueTemporalDiagnostics({ queueDelayMs: 120, queueDepthAtEnqueue: 1, queueDepthAtStart: 1, deadlineMs: 100 });
	assert.equal(delayed.temporal?.verdict.reasons[0], "queue_delay_budget_exceeded");
});
