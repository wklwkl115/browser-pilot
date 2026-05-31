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

test("BrowserLeaseRegistry exposes peek/touch and sweeps expired state", () => {
	const leases = new BrowserLeaseRegistry({ tabLeaseTtlMs: 100, uiLockTtlMs: 100 });
	const tab = fakeTab();
	const leased = leases.leaseTab("session-a", tab, true);
	leases.acquireUiLock("session-a", "browser_pick");
	assert.equal(leases.peekTabLease(tab)?.id, leased.id);
	leases.touchTabLease("session-a", tab, leased.createdAt + 50);
	leases.touchUiLock("session-a", leased.createdAt + 50);
	const early = leases.sweepExpired(leased.createdAt + 120);
	assert.equal(early.releasedLeases.length, 0);
	assert.equal(early.releasedUiLocks.length, 0);
	const late = leases.sweepExpired(leased.createdAt + 151);
	assert.equal(late.releasedLeases.length, 1);
	assert.equal(late.releasedLeases[0].releaseReason, "ttl");
	assert.equal(late.releasedUiLocks.length, 1);
	assert.equal(late.releasedUiLocks[0].releaseReason, "ttl");
});

test("BrowserLeaseRegistry releases lease and ui lock state for disconnected sessions", () => {
	const leases = new BrowserLeaseRegistry();
	const tab = fakeTab();
	leases.leaseTab("session-a", tab, true);
	leases.acquireUiLock("session-a", "browser_pick");
	const releasedLeases = leases.releaseLeasesForTabSessions([tab.id], "disconnect");
	const releasedUiLocks = leases.releaseUiLocksForBrowserSessions(["session-a"], "disconnect");
	assert.equal(releasedLeases.length, 1);
	assert.equal(releasedLeases[0].releaseReason, "disconnect");
	assert.equal(releasedUiLocks.length, 1);
	assert.equal(releasedUiLocks[0].releaseReason, "disconnect");
	assert.equal(leases.peekTabLease(tab), undefined);
	assert.equal(leases.uiLockInfo(), undefined);
});
