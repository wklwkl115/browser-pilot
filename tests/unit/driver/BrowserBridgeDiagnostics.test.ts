import test from "node:test";
import assert from "node:assert/strict";
import { buildBridgeTimeoutDiagnostics } from "../../../src/driver/BrowserBridgeDiagnostics.ts";

test("buildBridgeTimeoutDiagnostics returns compact timeout facts", () => {
	const diagnostics = buildBridgeTimeoutDiagnostics({
		browserSessionId: "default",
		host: "127.0.0.1",
		port: 18765,
		running: true,
		connectedClients: 1,
		extensionConnected: true,
		clients: [],
		defaultTabId: 7,
		latestTabId: 7,
		selectionVersion: 3,
		tabs: [],
		pending: [{ id: "p1", createdAt: Date.now(), acked: false }],
	}, 7, 1500, false, { browserSessionId: "default", tabId: 7, source: "explicit", implicit: false, selectionVersionAtDispatch: 3 });
	assert.equal(diagnostics.tabId, 7);
	assert.equal(diagnostics.pendingCount, 1);
	assert.equal(diagnostics.selectionVersion, 3);
});
