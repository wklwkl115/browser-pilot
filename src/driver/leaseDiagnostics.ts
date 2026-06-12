import { createHash, randomBytes } from "node:crypto";
import type { BrowserTabLeaseInfo, BrowserUiLockInfo } from "./types.js";

export const DEFAULT_TAB_LEASE_TTL_MS = 30 * 60_000;
export const DEFAULT_UI_LOCK_TTL_MS = 5 * 60_000;

export type LeaseIdRedactor = {
	hash(value: string): string;
	tabLease(lease: BrowserTabLeaseInfo, ttlMs?: number, now?: number): Record<string, unknown>;
	uiLock(lock: BrowserUiLockInfo, ttlMs?: number, now?: number): Record<string, unknown>;
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
				toolName: lock.toolName,
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

