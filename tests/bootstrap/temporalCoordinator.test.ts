import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTemporalCoordinator } from "../../src/bridge/server/BrowserTemporalCoordinator.ts";
import type { BrowserBridgeExecutionResult } from "../../src/ports/BrowserRuntimeTypes.ts";

function executionResult(value: Record<string, unknown>): BrowserBridgeExecutionResult {
	return value as BrowserBridgeExecutionResult;
}

test("temporal profile samples preserve operation diagnostics, bounded signals, and metric fallbacks", () => {
	const coordinator = new BrowserTemporalCoordinator();
	const sample = coordinator.buildProfileSample({
		operationId: "operation-1",
		tool: "browser_execute",
		elapsedMs: 125,
		deadlineMs: 500,
		result: executionResult({
			id: "result-1",
			acknowledged: true,
			target: { browserSessionId: "session-1", tabId: 7, source: "explicit", implicit: false, selectionVersionAtDispatch: 2 },
			data: {
				supervisor: {
					attempts: 3,
					workerRestarts: 2,
					historyLost: true,
					temporal: { verdict: { status: "stale", reasons: ["supervisor"] }, frontier: { next: "diagnose" } },
				},
			},
			diagnostics: {
				temporalProfile: {
					command: "execute.script",
					deadlineMs: 900,
					bridgeRoundTrips: 4,
					queueDepthAtEnqueue: 2,
					queueDepthAtStart: 1,
					queueDelayMs: 12,
					waitAttempts: 9,
					workerRestarts: 8,
					historyLost: false,
					rawSignals: ["one", 2, "two", "three", "four", "five", "six", "seven", "eight", "nine"],
				},
				temporal: { verdict: { status: "possibly_stale", reasons: ["diagnostics"] }, frontier: { next: "retry" } },
			},
		}),
	});

	assert.deepEqual(sample, {
		operationId: "operation-1",
		tool: "browser_execute",
		command: "execute.script",
		target: { browserSessionId: "session-1", tabId: 7 },
		deadlineMs: 500,
		elapsedMs: 125,
		bridgeRoundTrips: 4,
		queueDepthAtEnqueue: 2,
		queueDepthAtStart: 1,
		queueDelayMs: 12,
		waitAttempts: 3,
		workerRestarts: 2,
		historyLost: true,
		rawSignals: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
		verdict: "possibly_stale",
		reasons: ["diagnostics"],
		recovery: "retry",
	});
});

test("temporal profile samples prefer command diagnostics outside execute and omit invalid optional metrics", () => {
	const coordinator = new BrowserTemporalCoordinator();
	const sample = coordinator.buildProfileSample({
		operationId: "",
		tool: "browser_network",
		command: "network.wait",
		target: { browserSessionId: "session-input", tabId: 9, targetRef: "bp-ref://control/input" },
		elapsedMs: 40,
		diagnostics: {
			temporalProfile: { deadlineMs: 750, bridgeRoundTrips: Number.NaN, historyLost: "yes", rawSignals: "not-an-array" },
			temporal: { verdict: { status: "stale", reasons: [] }, frontier: { next: "refresh_observation" } },
		},
		result: executionResult({
			id: "result-2",
			acknowledged: true,
			target: { browserSessionId: "session-result", tabId: 10, targetRef: "bp-ref://control/result" },
			data: { wait: { supervisor: { temporal: { verdict: { status: "fresh" }, frontier: { next: "reuse_target" } } } } },
		}),
	});

	assert.deepEqual(sample, {
		tool: "browser_network",
		command: "network.wait",
		target: { browserSessionId: "session-input", tabId: 9, targetRef: "bp-ref://control/input" },
		deadlineMs: 750,
		elapsedMs: 40,
		verdict: "stale",
		reasons: [],
		recovery: "refresh_observation",
	});
});
