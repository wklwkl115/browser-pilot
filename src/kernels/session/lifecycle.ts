export type SessionTabSnapshot = {
	tabId?: number;
	disconnectedAt?: number;
};

export type SessionBridgeSnapshot = {
	browserSessionId?: string;
	tabs: SessionTabSnapshot[];
};

export type SessionObservationSnapshot = {
	snapshotId: string;
	browserSessionId?: string;
	tabId?: number;
	capturedAt: number;
	ttlMs: number;
	invalidatedReason?: string;
	expired?: boolean;
};

export type SessionLease = {
	id: string;
	browserSessionId: string;
	tabSessionId: string;
	createdAt: number;
	lastSeenAt: number;
};

export type SessionUiLock = {
	browserSessionId: string;
	createdAt: number;
	lastSeenAt: number;
	count: number;
};

export type ReleasedSessionLease<TLease extends SessionLease> = TLease & { releaseReason: "ttl" | "disconnect" };
export type ReleasedSessionUiLock<TLock extends SessionUiLock> = TLock & { releaseReason: "ttl" | "disconnect" };

export type SessionOperation = {
	operationId: string;
	startedAt: number;
	updatedAt: number;
};

export function evaluateObservationSnapshot<TSnapshot extends SessionObservationSnapshot>(
	record: TSnapshot,
	snapshot: SessionBridgeSnapshot | undefined,
	now: number,
): TSnapshot & { expired: boolean } {
	let invalidatedReason = record.invalidatedReason;
	if (!invalidatedReason && now - record.capturedAt > record.ttlMs) invalidatedReason = "ttl_expired";
	if (!invalidatedReason && record.browserSessionId && snapshot?.browserSessionId === record.browserSessionId) {
		if (record.tabId !== undefined && !snapshot.tabs.some((tab) => tab.tabId === record.tabId && !tab.disconnectedAt)) invalidatedReason = "tab_disconnected";
	}
	return { ...record, invalidatedReason, expired: Boolean(invalidatedReason) };
}

export function pruneObservationSnapshotsByTtl<TSnapshot extends SessionObservationSnapshot>(
	records: Iterable<TSnapshot>,
	now: number,
): TSnapshot[] {
	return Array.from(records).filter((record) => now - record.capturedAt <= record.ttlMs);
}

export function sweepExpiredSessionLeases<TLease extends SessionLease, TLock extends SessionUiLock>(
	leases: Iterable<TLease>,
	uiLock: TLock | undefined,
	now: number,
	tabLeaseTtlMs: number,
	uiLockTtlMs: number,
): { activeLeases: TLease[]; releasedLeases: Array<ReleasedSessionLease<TLease>>; activeUiLock?: TLock; releasedUiLocks: Array<ReleasedSessionUiLock<TLock>> } {
	const activeLeases: TLease[] = [];
	const releasedLeases: Array<ReleasedSessionLease<TLease>> = [];
	for (const lease of leases) {
		if (now - lease.lastSeenAt > tabLeaseTtlMs) releasedLeases.push({ ...lease, releaseReason: "ttl" });
		else activeLeases.push(lease);
	}
	const releasedUiLocks: Array<ReleasedSessionUiLock<TLock>> = [];
	let activeUiLock = uiLock;
	if (uiLock && now - uiLock.lastSeenAt > uiLockTtlMs) {
		releasedUiLocks.push({ ...uiLock, releaseReason: "ttl" });
		activeUiLock = undefined;
	}
	return { activeLeases, releasedLeases, activeUiLock, releasedUiLocks };
}

export function pruneSessionOperations<TOperation extends SessionOperation>(
	operations: Iterable<TOperation>,
	now: number,
	ttlMs: number,
	maxOperations: number,
): TOperation[] {
	const fresh = Array.from(operations).filter((operation) => now - operation.updatedAt <= ttlMs);
	if (fresh.length <= maxOperations) return fresh;
	return fresh
		.sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || b.operationId.localeCompare(a.operationId))
		.slice(0, maxOperations);
}

export function sortSessionOperations<TOperation extends SessionOperation>(operations: Iterable<TOperation>): TOperation[] {
	return Array.from(operations).sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
}
