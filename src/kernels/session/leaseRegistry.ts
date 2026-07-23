import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SessionKernelError } from "./errors.js";

export const DEFAULT_TAB_LEASE_TTL_MS = 30 * 60_000;
export const DEFAULT_UI_LOCK_TTL_MS = 5 * 60_000;

export type SessionTabLeaseInfo = {
	id: string;
	browserSessionId: string;
	tabSessionId: string;
	browserId: string;
	tabId: number;
	explicit: boolean;
	createdAt: number;
	lastSeenAt: number;
};

export type SessionReleasedTabLeaseInfo = SessionTabLeaseInfo & {
	releaseReason: "ttl" | "disconnect";
};

export type SessionUiLockInfo = {
	browserSessionId: string;
	commandName: string;
	createdAt: number;
	lastSeenAt: number;
	count: number;
};

export type SessionReleasedUiLockInfo = SessionUiLockInfo & {
	releaseReason: "ttl" | "disconnect";
};

export type LeaseIdRedactor = {
	hash(value: string): string;
	tabLease(lease: SessionTabLeaseInfo, ttlMs?: number, now?: number): Record<string, unknown>;
	uiLock(lock: SessionUiLockInfo, ttlMs?: number, now?: number): Record<string, unknown>;
};

function remainingMs(lastSeenAt: number, ttlMs: number, now: number): number {
	return Math.max(0, lastSeenAt + ttlMs - now);
}

export function createLeaseIdRedactor(salt = randomBytes(32).toString("hex")): LeaseIdRedactor {
	const hash = (value: string): string => createHash("sha256").update(salt).update("\0").update(value).digest("hex").slice(0, 12);
	return {
		hash,
		tabLease(lease, ttlMs = DEFAULT_TAB_LEASE_TTL_MS, now = Date.now()) {
			const expiresAt = lease.lastSeenAt + ttlMs;
			return {
				id: lease.id,
				browserSessionHash: hash(lease.browserSessionId),
				tabSessionHash: hash(lease.tabSessionId),
				browserId: lease.browserId,
				tabId: lease.tabId,
				explicit: lease.explicit,
				createdAt: lease.createdAt,
				lastSeenAt: lease.lastSeenAt,
				expiresAt,
				remainingMs: remainingMs(lease.lastSeenAt, ttlMs, now),
			};
		},
		uiLock(lock, ttlMs = DEFAULT_UI_LOCK_TTL_MS, now = Date.now()) {
			const expiresAt = lock.lastSeenAt + ttlMs;
			return {
				browserSessionHash: hash(lock.browserSessionId),
				commandName: lock.commandName,
				createdAt: lock.createdAt,
				lastSeenAt: lock.lastSeenAt,
				count: lock.count,
				expiresAt,
				remainingMs: remainingMs(lock.lastSeenAt, ttlMs, now),
			};
		},
	};
}

export const defaultLeaseIdRedactor = createLeaseIdRedactor();

export type SessionTabLeaseTarget = {
	id: string;
	browserId: string;
	tabId: number;
};

type SweepExpiredResult = {
	releasedLeases: SessionReleasedTabLeaseInfo[];
	releasedUiLocks: SessionReleasedUiLockInfo[];
};

export class SessionLeaseRegistry {
	private readonly tabLeases = new Map<string, SessionTabLeaseInfo>();
	private uiLock?: SessionUiLockInfo;
	private readonly tabLeaseTtlMs: number;
	private readonly uiLockTtlMs: number;

	constructor(options: { tabLeaseTtlMs?: number; uiLockTtlMs?: number } = {}) {
		this.tabLeaseTtlMs = Math.max(1, Math.floor(options.tabLeaseTtlMs ?? DEFAULT_TAB_LEASE_TTL_MS));
		this.uiLockTtlMs = Math.max(1, Math.floor(options.uiLockTtlMs ?? DEFAULT_UI_LOCK_TTL_MS));
	}

	listTabLeases(): SessionTabLeaseInfo[] {
		return Array.from(this.tabLeases.values()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	peekTabLease(tab: SessionTabLeaseTarget | { id: string }): SessionTabLeaseInfo | undefined {
		const lease = this.tabLeases.get(this.tabKey(tab));
		return lease ? { ...lease } : undefined;
	}

	describeTabLease(lease: SessionTabLeaseInfo, now = Date.now()): Record<string, unknown> {
		return defaultLeaseIdRedactor.tabLease(lease, this.tabLeaseTtlMs, now);
	}

	describeUiLock(lock: SessionUiLockInfo, now = Date.now()): Record<string, unknown> {
		return defaultLeaseIdRedactor.uiLock(lock, this.uiLockTtlMs, now);
	}

	touchTabLease(browserSessionId: string, tab: SessionTabLeaseTarget, now = Date.now()): SessionTabLeaseInfo | undefined {
		const key = this.tabKey(tab);
		const existing = this.tabLeases.get(key);
		if (!existing || existing.browserSessionId !== browserSessionId) return undefined;
		const touched = { ...existing, lastSeenAt: now };
		this.tabLeases.set(key, touched);
		return touched;
	}

	leaseTab(browserSessionId: string, tab: SessionTabLeaseTarget, explicit: boolean): SessionTabLeaseInfo {
		const key = this.tabKey(tab);
		const existing = this.tabLeases.get(key);
		if (existing && existing.browserSessionId !== browserSessionId) {
			throw new SessionKernelError("TAB_LEASE_CONFLICT", "Target tab is leased by another browser session", { requestedBrowserSessionId: browserSessionId, lease: this.describeTabLease(existing) });
		}
		const now = Date.now();
		const lease: SessionTabLeaseInfo = existing
			? { ...existing, explicit: existing.explicit || explicit, lastSeenAt: now }
			: { id: randomUUID(), browserSessionId, tabSessionId: tab.id, browserId: tab.browserId, tabId: tab.tabId, explicit, createdAt: now, lastSeenAt: now };
		this.tabLeases.set(key, lease);
		return lease;
	}

	releaseTab(browserSessionId: string, tab: SessionTabLeaseTarget): SessionTabLeaseInfo | undefined {
		const key = this.tabKey(tab);
		const existing = this.tabLeases.get(key);
		if (!existing || existing.browserSessionId !== browserSessionId) return undefined;
		this.tabLeases.delete(key);
		return existing;
	}

	migrateTabLeaseForReplacement(fromTabSessionId: string, toTab: SessionTabLeaseTarget, now = Date.now()): SessionTabLeaseInfo | undefined {
		const existing = this.tabLeases.get(fromTabSessionId);
		if (!existing) return undefined;
		this.tabLeases.delete(fromTabSessionId);
		const migrated: SessionTabLeaseInfo = {
			...existing,
			tabSessionId: toTab.id,
			browserId: toTab.browserId,
			tabId: toTab.tabId,
			lastSeenAt: now,
		};
		this.tabLeases.set(this.tabKey(toTab), migrated);
		return migrated;
	}

	async withAutoTabLease<T>(browserSessionId: string, tab: SessionTabLeaseTarget, fn: () => Promise<T>): Promise<T> {
		const lease = this.leaseTab(browserSessionId, tab, false);
		try {
			return await fn();
		} finally {
			const current = this.tabLeases.get(this.tabKey(tab));
			if (current?.id === lease.id && !current.explicit) this.tabLeases.delete(this.tabKey(tab));
		}
	}

	releaseLeasesForTabSessions(tabSessionIds: string[], reason: "ttl" | "disconnect"): SessionReleasedTabLeaseInfo[] {
		const targetIds = new Set(tabSessionIds);
		if (!targetIds.size) return [];
		const released: SessionReleasedTabLeaseInfo[] = [];
		for (const [key, lease] of this.tabLeases.entries()) {
			if (!targetIds.has(lease.tabSessionId)) continue;
			this.tabLeases.delete(key);
			released.push({ ...lease, releaseReason: reason });
		}
		return released.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	sweepExpired(now: number): SweepExpiredResult {
		const releasedLeases: SessionReleasedTabLeaseInfo[] = [];
		for (const [key, lease] of this.tabLeases.entries()) {
			if (now - lease.lastSeenAt <= this.tabLeaseTtlMs) continue;
			this.tabLeases.delete(key);
			releasedLeases.push({ ...lease, releaseReason: "ttl" });
		}
		const releasedUiLocks: SessionReleasedUiLockInfo[] = [];
		if (this.uiLock && now - this.uiLock.lastSeenAt > this.uiLockTtlMs) {
			releasedUiLocks.push({ ...this.uiLock, releaseReason: "ttl" });
			this.uiLock = undefined;
		}
		return { releasedLeases, releasedUiLocks };
	}

	acquireUiLock(browserSessionId: string, commandName: string): SessionUiLockInfo {
		const now = Date.now();
		if (this.uiLock && this.uiLock.browserSessionId !== browserSessionId) {
			const heldForMs = now - this.uiLock.createdAt;
			throw new SessionKernelError(
				"UI_LOCK_CONFLICT",
				`UI lock held by ${this.uiLock.commandName} for ${heldForMs}ms — try again shortly`,
				{ requestedBrowserSessionId: browserSessionId, lock: this.describeUiLock(this.uiLock, now), heldForMs },
			);
		}
		this.uiLock = this.uiLock
			? { ...this.uiLock, commandName, lastSeenAt: now, count: this.uiLock.count + 1 }
			: { browserSessionId, commandName, createdAt: now, lastSeenAt: now, count: 1 };
		return this.uiLock;
	}

	releaseUiLock(browserSessionId: string): SessionUiLockInfo | undefined {
		if (!this.uiLock || this.uiLock.browserSessionId !== browserSessionId) return undefined;
		const released = this.uiLock;
		if (released.count <= 1) this.uiLock = undefined;
		else this.uiLock = { ...released, count: released.count - 1, lastSeenAt: Date.now() };
		return released;
	}

	releaseUiLocksForBrowserSessions(browserSessionIds: string[], reason: "ttl" | "disconnect"): SessionReleasedUiLockInfo[] {
		if (!this.uiLock) return [];
		if (!browserSessionIds.includes(this.uiLock.browserSessionId)) return [];
		const released = { ...this.uiLock, releaseReason: reason };
		this.uiLock = undefined;
		return [released];
	}

	uiLockInfo(): SessionUiLockInfo | undefined {
		return this.uiLock ? { ...this.uiLock } : undefined;
	}

	clear(): void {
		this.tabLeases.clear();
		this.uiLock = undefined;
	}

	private tabKey(tab: SessionTabLeaseTarget | { id: string }): string {
		return tab.id;
	}
}
