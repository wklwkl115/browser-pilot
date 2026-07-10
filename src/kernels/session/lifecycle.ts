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
