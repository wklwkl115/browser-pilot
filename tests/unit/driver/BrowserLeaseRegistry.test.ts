import test from "node:test";
import assert from "node:assert/strict";
import { BrowserLeaseRegistry } from "../../../src/driver/BrowserLeaseRegistry.ts";
import { createLeaseIdRedactor } from "../../../src/driver/leaseDiagnostics.ts";
import type { BrowserTabSession } from "../../../src/driver/types.ts";

function fakeTab(id = "browserA:7"): BrowserTabSession {
	return {
		id,
		browserId: "browserA",
		tabId: 7,
		logicalTabId: "logical-a",
		tabHandle: "tabh_browserA_logicala_g1",
		generation: 1,
		url: "https://example.test",
		title: "Example",
		type: "ext_ws",
		connectedAt: Date.now(),
		client: {} as BrowserTabSession["client"],
	};
}

test("BrowserLeaseRegistry rejects cross-session lease conflicts", () => {
	const leases = new BrowserLeaseRegistry({ tabLeaseTtlMs: 500 });
	const tab = fakeTab();
	const first = leases.leaseTab("session-a", tab, true);
	assert.equal(first.browserSessionId, "session-a");
	assert.throws(() => leases.leaseTab("session-b", tab, false), (error: any) => {
		assert.equal(error.code, "TAB_LEASE_CONFLICT");
		assert.equal(JSON.stringify(error.details).includes("session-a"), false, "foreign browserSessionId must be redacted");
		assert.equal(JSON.stringify(error.details).includes(tab.id), false, "foreign tabSessionId must be redacted");
		assert.equal(typeof error.details.lease.browserSessionHash, "string");
		assert.equal(typeof error.details.lease.tabSessionHash, "string");
		assert.equal(error.details.lease.expiresAt, first.lastSeenAt + 500);
		assert.equal(typeof error.details.lease.remainingMs, "number");
		return true;
	});
});

test("BrowserLeaseRegistry enforces UI lock ownership", () => {
	const leases = new BrowserLeaseRegistry();
	const lock = leases.acquireUiLock("session-a", "browser_pick");
	assert.equal(lock.browserSessionId, "session-a");
	assert.throws(() => leases.acquireUiLock("session-b", "browser_pick"), (error: any) => {
		assert.equal(error.code, "UI_LOCK_CONFLICT");
		assert.equal(JSON.stringify(error.details).includes("session-a"), false, "foreign uiLock browserSessionId must be redacted");
		assert.equal(typeof error.details.lock.browserSessionHash, "string");
		assert.equal(typeof error.details.lock.expiresAt, "number");
		return true;
	});
	leases.releaseUiLock("session-a");
	assert.equal(leases.uiLockInfo(), undefined);
});

test("lease id redaction is stable per salt and unlinkable across salts", () => {
	const first = createLeaseIdRedactor("salt-a");
	const same = createLeaseIdRedactor("salt-a");
	const other = createLeaseIdRedactor("salt-b");
	assert.equal(first.hash("session-a"), first.hash("session-a"));
	assert.equal(first.hash("session-a"), same.hash("session-a"));
	assert.notEqual(first.hash("session-a"), other.hash("session-a"));
	assert.notEqual(first.hash("session-a"), "session-a");
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

test("BrowserLeaseRegistry migrates a tab lease across tab replacement", () => {
	const leases = new BrowserLeaseRegistry();
	const from = fakeTab("browserA:7");
	const to = { ...fakeTab("browserA:8"), tabId: 8 };
	const leased = leases.leaseTab("session-a", from, true);
	const migrated = leases.migrateTabLeaseForReplacement(from.id, to, leased.createdAt + 25);
	assert.equal(migrated?.id, leased.id);
	assert.equal(migrated?.tabSessionId, to.id);
	assert.equal(migrated?.tabId, 8);
	assert.equal(migrated?.explicit, true);
	assert.equal(leases.peekTabLease(from), undefined);
	assert.equal(leases.peekTabLease(to)?.id, leased.id);
});
