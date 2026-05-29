import test from "node:test";
import assert from "node:assert/strict";
import { BrowserObservationSnapshotRegistry } from "../../../src/driver/BrowserObservationSnapshotRegistry.ts";

test("BrowserObservationSnapshotRegistry marks stale snapshots expired after selection drift", () => {
	const registry = new BrowserObservationSnapshotRegistry();
	const now = Date.now();
	const created = registry.create({
		browserSessionId: "default",
		tabId: 7,
		url: "https://example.test",
		selectionVersion: 1,
		sourceMode: "scan",
		capturedAt: now,
	});
	const live = registry.get(created.snapshotId, {
		browserSessionId: "default",
		host: "127.0.0.1",
		port: 18765,
		running: true,
		connectedClients: 1,
		extensionConnected: true,
		clients: [],
		defaultTabId: 7,
		latestTabId: 7,
		selectionVersion: 1,
		tabs: [{ id: "browserA:7", browserId: "browserA", tabId: 7, url: "https://example.test", title: "Example", type: "ext_ws", connectedAt: now }],
		pending: [],
	});
	assert.equal(live?.expired, false);
	const stale = registry.get(created.snapshotId, {
		browserSessionId: "default",
		host: "127.0.0.1",
		port: 18765,
		running: true,
		connectedClients: 1,
		extensionConnected: true,
		clients: [],
		defaultTabId: 8,
		latestTabId: 8,
		selectionVersion: 2,
		tabs: [{ id: "browserA:8", browserId: "browserA", tabId: 8, url: "https://example.test/other", title: "Other", type: "ext_ws", connectedAt: now }],
		pending: [],
	});
	assert.equal(stale?.expired, true);
});

test("BrowserObservationSnapshotRegistry prunes TTL-expired snapshots on new writes", () => {
	const registry = new BrowserObservationSnapshotRegistry();
	const now = Date.now();
	const expired = registry.create({
		tabId: 1,
		url: "https://old.example",
		sourceMode: "scan",
		capturedAt: now - 10_000,
		ttlMs: 1_000,
	});
	registry.create({
		tabId: 2,
		url: "https://new.example",
		sourceMode: "scan",
		capturedAt: now,
	});

	assert.equal(registry.get(expired.snapshotId), undefined);
	assert.equal(registry.list().length, 1);
});
