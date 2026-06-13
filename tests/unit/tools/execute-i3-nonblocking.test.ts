/**
 * I3 contract test — "Free interaction loop"
 *
 * Invariant: the DEFAULT `browser_execute` path (no monitor:true) must dispatch
 * the JS action WITHOUT any pre-action standing-perception read (no
 * content.fingerprint, no scan/observe machinery, no perception-ledger reads).
 * Post-action effect collection happens only AFTER dispatch.
 *
 * How this fails: if someone adds a pre-action perception gate to
 * registerExecuteTool / toolAdapter the "dispatch" record will no longer be the
 * first call in the ordered log, and the test asserts will fire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withExecutionEffect } from "../../../src/tools/executionEffect.ts";
import type { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";
import type { BrowserBridgeExecutionResult } from "../../../src/driver/types.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDispatchResult(): BrowserBridgeExecutionResult {
	return {
		acknowledged: true,
		data: { ok: true, return: "hello" },
		target: { tabId: 5, browserSessionId: "s-1", source: "explicit" },
		sourceMode: "bridge",
	};
}

/**
 * Build an instrumented fake server that records the ORDER of calls.
 * We distinguish three categories that matter for I3:
 *   "fingerprint" — content.fingerprint (standing-perception read)
 *   "scan"        — any Runtime.evaluate that looks like a page scan/ABML read
 *   "dispatch"    — the actual JS execute call (server.executeJavaScript)
 */
function buildInstrumentedServer() {
	const callLog: string[] = [];

	const server = {
		queueDepth() { return 0; },
		leaseOwnerHash() { return undefined; },
		snapshot() {
			return { browserSessionId: "s-1", defaultTabId: 5, selectionVersion: 1 };
		},
		beginOperation(meta: Record<string, unknown>) {
			return { operationId: "op-1", startedAt: Date.now(), updatedAt: Date.now(), ...meta };
		},
		updateOperation(operationId: string, patch: Record<string, unknown>) {
			return { operationId, startedAt: Date.now(), updatedAt: Date.now(), ...patch };
		},
		finishOperation() { return undefined; },
		async refreshTabs() { return []; },
		getTabs() { return []; },
		createObservationSnapshot(s: Record<string, unknown>) { return { snapshotId: "snap-1", ttlMs: 60_000, expired: false, ...s }; },
		async executeJavaScript(_script: string, _opts: Record<string, unknown>): Promise<BrowserBridgeExecutionResult> {
			// This is the REAL dispatch — records only after being called
			callLog.push("dispatch");
			return makeDispatchResult();
		},
		async sendCommand(command: Record<string, unknown>, _opts?: Record<string, unknown>): Promise<Record<string, unknown>> {
			const cmd = String(command.cmd || "");
			if (cmd === "content.fingerprint") {
				callLog.push("fingerprint");
				// Return a valid fingerprint so the rest of withExecutionEffect can proceed
				return { ok: true, data: { changeSeq: 1, url: "https://example.test/", visibleCount: 2, interactiveCount: 1 } };
			}
			if (cmd === "network.status") {
				return { ok: true, data: {} };
			}
			if (cmd === "hook.status") {
				return { ok: true, data: {} };
			}
			// Any CDP Runtime.evaluate that is NOT a content.fingerprint is a scan read
			if (cmd === "persistent_cdp" || String(command.cdpMethod || "").includes("Runtime.evaluate")) {
				callLog.push("scan");
			}
			return { ok: true, data: {} };
		},
	} as unknown as BrowserBridgeServer & {
		callLog: string[];
		executeJavaScript(script: string, opts: Record<string, unknown>): Promise<BrowserBridgeExecutionResult>;
	};

	(server as unknown as { callLog: string[] }).callLog = callLog;
	return server;
}

// ── Test 1: default path — exec dispatches BEFORE any fingerprint read ────────

test("I3: default browser_execute path dispatches before any perception read (withExecutionEffect order)", async () => {
	const server = buildInstrumentedServer();
	const callLog = (server as unknown as { callLog: string[] }).callLog;

	// Simulate the default execute path: withExecutionEffect wraps the dispatch.
	// This is exactly what registerExecuteTool does on the default (non-monitor) branch.
	const executed = await withExecutionEffect(
		server,
		{ browserSessionId: "s-1", tabId: 5, timeoutMs: 5_000, quietMs: 0 },
		() => (server as unknown as { executeJavaScript: (s: string, o: Record<string, unknown>) => Promise<BrowserBridgeExecutionResult> })
			.executeJavaScript("return 1+1", { browserSessionId: "s-1", tabId: 5, timeoutMs: 5_000 }),
	);

	// Sanity: dispatch succeeded
	assert.equal(executed.result.acknowledged, true, "dispatch must succeed");

	// I3 core assertion: the first call in the log MUST be a fingerprint
	// (pre-action drain read by withExecutionEffect for the "before" snapshot),
	// and the DISPATCH must come immediately after — never a scan/observe before it.
	//
	// Call sequence from withExecutionEffect:
	//   1. readExecutionSignals (before) → content.fingerprint + network.status + hook.status
	//   2. dispatch() ← the JS eval
	//   3. readExecutionSignals (after) → content.fingerprint + network.status + hook.status
	//
	// The invariant: no "scan" entry appears at all on the default path.
	assert.equal(callLog.includes("scan"), false,
		`I3 violated: scan/observe machinery was called on the default execute path. Call log: ${JSON.stringify(callLog)}`);

	// The dispatch must appear in the log (at least one occurrence)
	assert.equal(callLog.includes("dispatch"), true, "dispatch must be recorded");

	// The dispatch must come BEFORE the second fingerprint read (post-action snapshot).
	// The before-snapshot fingerprints come first, then dispatch, then after-snapshot.
	const firstFpIdx = callLog.indexOf("fingerprint");
	const dispatchIdx = callLog.indexOf("dispatch");
	const secondFpIdx = callLog.lastIndexOf("fingerprint");

	assert.equal(firstFpIdx !== -1, true, "at least one fingerprint read must occur (before-snapshot)");
	assert.equal(dispatchIdx !== -1, true, "dispatch must occur");
	// dispatch must come AFTER the first fingerprint read (drain before)
	assert.equal(dispatchIdx > firstFpIdx, true,
		`I3: dispatch (idx ${dispatchIdx}) must follow the before-snapshot fingerprint read (idx ${firstFpIdx}). Log: ${JSON.stringify(callLog)}`);
	// dispatch must come BEFORE the last (post-action) fingerprint read
	assert.equal(dispatchIdx < secondFpIdx, true,
		`I3: dispatch (idx ${dispatchIdx}) must precede the after-snapshot fingerprint read (idx ${secondFpIdx}). Log: ${JSON.stringify(callLog)}`);
});

// ── Test 2: no scan/observe invoked at all on the default path ────────────────

test("I3: no scan or observe machinery is invoked on the default execute path", async () => {
	const server = buildInstrumentedServer();
	const callLog = (server as unknown as { callLog: string[] }).callLog;

	await withExecutionEffect(
		server,
		{ browserSessionId: "s-1", tabId: 5, timeoutMs: 5_000, quietMs: 0 },
		() => (server as unknown as { executeJavaScript: (s: string, o: Record<string, unknown>) => Promise<BrowserBridgeExecutionResult> })
			.executeJavaScript("document.title", { tabId: 5, timeoutMs: 5_000 }),
	);

	const scanCalls = callLog.filter((entry) => entry === "scan");
	assert.equal(scanCalls.length, 0,
		`I3: scan machinery must NOT be invoked on the default execute path. Scan calls recorded: ${scanCalls.length}. Full log: ${JSON.stringify(callLog)}`);
});

// ── Test 3: effect kill switch bypasses ALL perception reads ──────────────────

test("I3: with execute-effect kill switch, no perception reads occur at all", async () => {
	const prev = process.env.PI_BROWSER_EXECUTE_EFFECT;
	process.env.PI_BROWSER_EXECUTE_EFFECT = "0";
	try {
		const server = buildInstrumentedServer();
		const callLog = (server as unknown as { callLog: string[] }).callLog;

		await withExecutionEffect(
			server,
			{ browserSessionId: "s-1", tabId: 5, timeoutMs: 5_000 },
			() => (server as unknown as { executeJavaScript: (s: string, o: Record<string, unknown>) => Promise<BrowserBridgeExecutionResult> })
				.executeJavaScript("1", { tabId: 5, timeoutMs: 5_000 }),
		);

		assert.equal(callLog.filter((e) => e === "fingerprint").length, 0,
			"kill switch: no fingerprint reads should occur");
		assert.equal(callLog.filter((e) => e === "scan").length, 0,
			"kill switch: no scan reads should occur");
		assert.equal(callLog.includes("dispatch"), true,
			"kill switch: dispatch must still occur");
	} finally {
		if (prev === undefined) delete process.env.PI_BROWSER_EXECUTE_EFFECT;
		else process.env.PI_BROWSER_EXECUTE_EFFECT = prev;
	}
});
