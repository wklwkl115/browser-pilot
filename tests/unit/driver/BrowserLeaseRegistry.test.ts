import test from "node:test";
import assert from "node:assert/strict";
import { BrowserLeaseRegistry } from "../../../src/driver/BrowserLeaseRegistry.ts";
import type { BrowserTabSession } from "../../../src/driver/types.ts";

function fakeTab(id = "browserA:7"): BrowserTabSession {
	return {
		id,
		browserId: "browserA",
		tabId: 7,
		url: "https://example.test",
		title: "Example",
		type: "ext_ws",
		connectedAt: Date.now(),
		client: {} as BrowserTabSession["client"],
	};
}

test("BrowserLeaseRegistry rejects cross-session lease conflicts", () => {
	const leases = new BrowserLeaseRegistry();
	const tab = fakeTab();
	const first = leases.leaseTab("session-a", tab, true);
	assert.equal(first.browserSessionId, "session-a");
	assert.throws(() => leases.leaseTab("session-b", tab, false), (error: any) => error.code === "TAB_LEASE_CONFLICT");
});

test("BrowserLeaseRegistry enforces UI lock ownership", () => {
	const leases = new BrowserLeaseRegistry();
	const lock = leases.acquireUiLock("session-a", "browser_pick");
	assert.equal(lock.browserSessionId, "session-a");
	assert.throws(() => leases.acquireUiLock("session-b", "browser_pick"), (error: any) => error.code === "UI_LOCK_CONFLICT");
	leases.releaseUiLock("session-a");
	assert.equal(leases.uiLockInfo(), undefined);
});
