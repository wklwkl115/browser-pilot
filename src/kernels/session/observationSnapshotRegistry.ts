import { randomUUID } from "node:crypto";
import { evaluateObservationSnapshot, pruneObservationSnapshotsByTtl } from "./lifecycle.js";

export type SessionObservationSnapshotInfo = {
	snapshotId: string;
	browserSessionId?: string;
	tabId?: number;
	url?: string;
	targetGeneration?: number;
	pageEpoch?: string;
	documentId?: string;
	frameScope?: string;
	selectionVersion?: number;
	sourceMode: string;
	capturedAt: number;
	ttlMs: number;
	networkSeq?: number;
	hookSeq?: number;
	invalidatedReason?: string;
	expired?: boolean;
	saved?: {
		path?: string;
	};
};

export type SessionBridgeSnapshotView = {
	browserSessionId?: string;
	tabs: Array<{ tabId?: number; disconnectedAt?: number }>;
};

const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 256;

export class SessionObservationSnapshotRegistry {
	private readonly snapshots = new Map<string, SessionObservationSnapshotInfo>();

	clear(): void {
		this.snapshots.clear();
	}

	create(snapshot: Omit<SessionObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): SessionObservationSnapshotInfo {
		this.pruneExpiredByTtl();
		const record: SessionObservationSnapshotInfo = {
			snapshotId: snapshot.snapshotId || randomUUID(),
			browserSessionId: snapshot.browserSessionId,
			tabId: snapshot.tabId,
			url: snapshot.url,
			targetGeneration: snapshot.targetGeneration,
			pageEpoch: snapshot.pageEpoch,
			documentId: snapshot.documentId,
			frameScope: snapshot.frameScope,
			selectionVersion: snapshot.selectionVersion,
			sourceMode: snapshot.sourceMode,
			capturedAt: snapshot.capturedAt,
			networkSeq: snapshot.networkSeq,
			hookSeq: snapshot.hookSeq,
			ttlMs: Math.max(1_000, Math.floor(snapshot.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS)),
			invalidatedReason: snapshot.invalidatedReason,
			saved: snapshot.saved,
		};
		this.snapshots.set(record.snapshotId, record);
		while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
		return { ...record, expired: false };
	}

	get(snapshotId: string, currentSnapshot?: SessionBridgeSnapshotView): SessionObservationSnapshotInfo | undefined {
		const record = this.snapshots.get(String(snapshotId || "").trim());
		return record ? evaluateObservationSnapshot(record, currentSnapshot, Date.now()) : undefined;
	}

	list(currentSnapshot?: SessionBridgeSnapshotView): SessionObservationSnapshotInfo[] {
		this.pruneExpiredByTtl();
		return Array.from(this.snapshots.values())
			.map((record) => evaluateObservationSnapshot(record, currentSnapshot, Date.now()))
			.sort((a, b) => b.capturedAt - a.capturedAt || a.snapshotId.localeCompare(b.snapshotId));
	}

	private pruneExpiredByTtl(now = Date.now()): void {
		const active = new Set(pruneObservationSnapshotsByTtl(this.snapshots.values(), now).map((record) => record.snapshotId));
		for (const snapshotId of this.snapshots.keys()) if (!active.has(snapshotId)) this.snapshots.delete(snapshotId);
	}
}
