import { randomUUID } from "node:crypto";
import { BrowserBridgeError } from "./errors";
import type { BrowserTabLeaseInfo, BrowserTabSession, BrowserUiLockInfo } from "./types";

export class BrowserLeaseRegistry {
	private readonly tabLeases = new Map<string, BrowserTabLeaseInfo>();
	private uiLock?: BrowserUiLockInfo;

	listTabLeases(): BrowserTabLeaseInfo[] {
		return Array.from(this.tabLeases.values()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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

	releaseUiLock(browserSessionId: string): BrowserUiLockInfo | undefined {
		if (!this.uiLock || this.uiLock.browserSessionId !== browserSessionId) return undefined;
		const released = this.uiLock;
		if (released.count <= 1) this.uiLock = undefined;
		else this.uiLock = { ...released, count: released.count - 1, lastSeenAt: Date.now() };
		return released;
	}

	uiLockInfo(): BrowserUiLockInfo | undefined {
		return this.uiLock ? { ...this.uiLock } : undefined;
	}

	clear(): void {
		this.tabLeases.clear();
		this.uiLock = undefined;
	}

	private tabKey(tab: BrowserTabSession): string {
		return tab.id;
	}
}
