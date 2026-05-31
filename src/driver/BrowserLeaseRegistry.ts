import { randomUUID } from "node:crypto";
import { BrowserBridgeError } from "./errors.js";
import type { BrowserReleasedTabLeaseInfo, BrowserReleasedUiLockInfo, BrowserTabLeaseInfo, BrowserTabSession, BrowserUiLockInfo } from "./types.js";

const DEFAULT_TAB_LEASE_TTL_MS = 30 * 60_000;
const DEFAULT_UI_LOCK_TTL_MS = 5 * 60_000;

type SweepExpiredResult = {
	releasedLeases: BrowserReleasedTabLeaseInfo[];
	releasedUiLocks: BrowserReleasedUiLockInfo[];
};

export class BrowserLeaseRegistry {
	private readonly tabLeases = new Map<string, BrowserTabLeaseInfo>();
	private uiLock?: BrowserUiLockInfo;
	private readonly tabLeaseTtlMs: number;
	private readonly uiLockTtlMs: number;

	constructor(options: { tabLeaseTtlMs?: number; uiLockTtlMs?: number } = {}) {
		this.tabLeaseTtlMs = Math.max(1, Math.floor(options.tabLeaseTtlMs ?? DEFAULT_TAB_LEASE_TTL_MS));
		this.uiLockTtlMs = Math.max(1, Math.floor(options.uiLockTtlMs ?? DEFAULT_UI_LOCK_TTL_MS));
	}

	listTabLeases(): BrowserTabLeaseInfo[] {
		return Array.from(this.tabLeases.values()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	peekTabLease(tab: BrowserTabSession | { id: string }): BrowserTabLeaseInfo | undefined {
		const lease = this.tabLeases.get(this.tabKey(tab));
		return lease ? { ...lease } : undefined;
	}

	touchTabLease(browserSessionId: string, tab: BrowserTabSession, now = Date.now()): BrowserTabLeaseInfo | undefined {
		const key = this.tabKey(tab);
		const existing = this.tabLeases.get(key);
		if (!existing || existing.browserSessionId !== browserSessionId) return undefined;
		const touched = { ...existing, lastSeenAt: now };
		this.tabLeases.set(key, touched);
		return touched;
	}

	leaseTab(browserSessionId: string, tab: BrowserTabSession, explicit: boolean): BrowserTabLeaseInfo {
		const key = this.tabKey(tab);
		const existing = this.tabLeases.get(key);
		if (existing && existing.browserSessionId !== browserSessionId) {
			throw new BrowserBridgeError("TAB_LEASE_CONFLICT", "Target tab is leased by another browser session", { requestedBrowserSessionId: browserSessionId, lease: existing });
		}
		const now = Date.now();
		const lease: BrowserTabLeaseInfo = existing
			? { ...existing, explicit: existing.explicit || explicit, lastSeenAt: now }
			: { id: randomUUID(), browserSessionId, tabSessionId: tab.id, browserId: tab.browserId, tabId: tab.tabId, explicit, createdAt: now, lastSeenAt: now };
		this.tabLeases.set(key, lease);
		return lease;
	}

	releaseTab(browserSessionId: string, tab: BrowserTabSession): BrowserTabLeaseInfo | undefined {
		const key = this.tabKey(tab);
		const existing = this.tabLeases.get(key);
		if (!existing || existing.browserSessionId !== browserSessionId) return undefined;
		this.tabLeases.delete(key);
		return existing;
	}

	async withAutoTabLease<T>(browserSessionId: string, tab: BrowserTabSession, fn: () => Promise<T>): Promise<T> {
		const lease = this.leaseTab(browserSessionId, tab, false);
		try {
			return await fn();
		} finally {
			const current = this.tabLeases.get(this.tabKey(tab));
			if (current?.id === lease.id && !current.explicit) this.tabLeases.delete(this.tabKey(tab));
		}
	}

	releaseLeasesForTabSessions(tabSessionIds: string[], reason: "ttl" | "disconnect"): BrowserReleasedTabLeaseInfo[] {
		const targetIds = new Set(tabSessionIds);
		if (!targetIds.size) return [];
		const released: BrowserReleasedTabLeaseInfo[] = [];
		for (const [key, lease] of this.tabLeases.entries()) {
			if (!targetIds.has(lease.tabSessionId)) continue;
			this.tabLeases.delete(key);
			released.push({ ...lease, releaseReason: reason });
		}
		return released.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	sweepExpired(now: number): SweepExpiredResult {
		const releasedLeases: BrowserReleasedTabLeaseInfo[] = [];
		for (const [key, lease] of this.tabLeases.entries()) {
			if (now - lease.lastSeenAt <= this.tabLeaseTtlMs) continue;
			this.tabLeases.delete(key);
			releasedLeases.push({ ...lease, releaseReason: "ttl" });
		}
		const releasedUiLocks: BrowserReleasedUiLockInfo[] = [];
		if (this.uiLock && now - this.uiLock.lastSeenAt > this.uiLockTtlMs) {
			releasedUiLocks.push({ ...this.uiLock, releaseReason: "ttl" });
			this.uiLock = undefined;
		}
		return { releasedLeases, releasedUiLocks };
	}

	acquireUiLock(browserSessionId: string, toolName: string): BrowserUiLockInfo {
		const now = Date.now();
		if (this.uiLock && this.uiLock.browserSessionId !== browserSessionId) {
			throw new BrowserBridgeError("UI_LOCK_CONFLICT", "Browser UI is locked by another browser session", { requestedBrowserSessionId: browserSessionId, lock: this.uiLock });
		}
		this.uiLock = this.uiLock
			? { ...this.uiLock, toolName, lastSeenAt: now, count: this.uiLock.count + 1 }
			: { browserSessionId, toolName, createdAt: now, lastSeenAt: now, count: 1 };
		return this.uiLock;
	}

	touchUiLock(browserSessionId: string, now = Date.now()): BrowserUiLockInfo | undefined {
		if (!this.uiLock || this.uiLock.browserSessionId !== browserSessionId) return undefined;
		this.uiLock = { ...this.uiLock, lastSeenAt: now };
		return this.uiLock;
	}

	releaseUiLock(browserSessionId: string): BrowserUiLockInfo | undefined {
		if (!this.uiLock || this.uiLock.browserSessionId !== browserSessionId) return undefined;
		const released = this.uiLock;
		if (released.count <= 1) this.uiLock = undefined;
		else this.uiLock = { ...released, count: released.count - 1, lastSeenAt: Date.now() };
		return released;
	}

	releaseUiLocksForBrowserSessions(browserSessionIds: string[], reason: "ttl" | "disconnect"): BrowserReleasedUiLockInfo[] {
		if (!this.uiLock) return [];
		if (!browserSessionIds.includes(this.uiLock.browserSessionId)) return [];
		const released = { ...this.uiLock, releaseReason: reason };
		this.uiLock = undefined;
		return [released];
	}

	uiLockInfo(): BrowserUiLockInfo | undefined {
		return this.uiLock ? { ...this.uiLock } : undefined;
	}

	clear(): void {
		this.tabLeases.clear();
		this.uiLock = undefined;
	}

	private tabKey(tab: BrowserTabSession | { id: string }): string {
		return tab.id;
	}
}
