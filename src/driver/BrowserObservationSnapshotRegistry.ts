import { randomUUID } from "node:crypto";
import type { BrowserBridgeSnapshot, BrowserObservationSnapshotInfo } from "./types";

const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60_000;

function evaluateSnapshot(record: BrowserObservationSnapshotInfo, snapshot: BrowserBridgeSnapshot | undefined): BrowserObservationSnapshotInfo {
	const now = Date.now();
	let invalidatedReason = record.invalidatedReason;
	if (!invalidatedReason && now - record.capturedAt > record.ttlMs) invalidatedReason = "ttl_expired";
	if (!invalidatedReason && record.browserSessionId && snapshot?.browserSessionId === record.browserSessionId) {
		if (record.selectionVersion !== undefined && snapshot.selectionVersion !== record.selectionVersion) invalidatedReason = "selection_changed";
		if (record.tabId !== undefined && !snapshot.tabs.some((tab) => tab.tabId === record.tabId && !tab.disconnectedAt)) invalidatedReason = "tab_disconnected";
	}
	return { ...record, invalidatedReason, expired: !!invalidatedReason };
}

export class BrowserObservationSnapshotRegistry {
	private readonly snapshots = new Map<string, BrowserObservationSnapshotInfo>();

	clear(): void {
		this.snapshots.clear();
	}

	create(snapshot: Omit<BrowserObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): BrowserObservationSnapshotInfo {
		const record: BrowserObservationSnapshotInfo = {
			snapshotId: snapshot.snapshotId || randomUUID(),
			browserSessionId: snapshot.browserSessionId,
			tabId: snapshot.tabId,
			url: snapshot.url,
			frameScope: snapshot.frameScope,
			selectionVersion: snapshot.selectionVersion,
			sourceMode: snapshot.sourceMode,
			capturedAt: snapshot.capturedAt,
			ttlMs: Math.max(1_000, Math.floor(snapshot.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS)),
			invalidatedReason: snapshot.invalidatedReason,
			saved: snapshot.saved,
		};
		this.snapshots.set(record.snapshotId, record);
		return { ...record, expired: false };
	}

	get(snapshotId: string, currentSnapshot?: BrowserBridgeSnapshot): BrowserObservationSnapshotInfo | undefined {
		const record = this.snapshots.get(String(snapshotId || "").trim());
		return record ? evaluateSnapshot(record, currentSnapshot) : undefined;
	}

	list(currentSnapshot?: BrowserBridgeSnapshot): BrowserObservationSnapshotInfo[] {
		return Array.from(this.snapshots.values())
			.map((record) => evaluateSnapshot(record, currentSnapshot))
			.sort((a, b) => b.capturedAt - a.capturedAt || a.snapshotId.localeCompare(b.snapshotId));
	}
}
