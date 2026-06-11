import { createHash, randomUUID } from "node:crypto";
import type { BrowserActiveOperationInfo } from "./types.js";

const DEFAULT_OPERATION_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_OPERATIONS = 256;

function ownerHash(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

export class BrowserOperationRegistry {
	private readonly operations = new Map<string, BrowserActiveOperationInfo>();
	private readonly ttlMs: number;
	private readonly maxOperations: number;
	private readonly now: () => number;

	constructor(options: { ttlMs?: number; maxOperations?: number; now?: () => number } = {}) {
		this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_OPERATION_TTL_MS));
		this.maxOperations = Math.max(1, Math.floor(options.maxOperations ?? DEFAULT_MAX_OPERATIONS));
		this.now = options.now ?? Date.now;
	}

	begin(operation: Omit<BrowserActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }): BrowserActiveOperationInfo {
		this.pruneStale();
		const now = this.now();
		const record: BrowserActiveOperationInfo = {
			operationId: operation.operationId || randomUUID(),
			toolName: operation.toolName,
			command: operation.command,
			browserSessionId: operation.browserSessionId,
			tabId: operation.tabId,
			phase: operation.phase,
			progress: operation.progress,
			queueDepth: operation.queueDepth,
			leaseOwnerHash: ownerHash(operation.leaseOwnerHash || operation.browserSessionId),
			conflictReason: operation.conflictReason,
			snapshotId: operation.snapshotId,
			sourceMode: operation.sourceMode,
			details: operation.details,
			startedAt: now,
			updatedAt: now,
		};
		this.operations.set(record.operationId, record);
		this.pruneToMaxSize();
		return { ...record };
	}

	update(operationId: string, patch: Partial<Omit<BrowserActiveOperationInfo, "operationId" | "startedAt">>): BrowserActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		const nextLeaseOwnerHash = Object.prototype.hasOwnProperty.call(patch, "leaseOwnerHash")
			? ownerHash(typeof patch.leaseOwnerHash === "string" ? patch.leaseOwnerHash : undefined)
			: current.leaseOwnerHash;
		const next: BrowserActiveOperationInfo = {
			...current,
			...patch,
			leaseOwnerHash: nextLeaseOwnerHash,
			updatedAt: this.now(),
		};
		this.operations.set(operationId, next);
		return { ...next };
	}

	get(operationId: string): BrowserActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		return current ? { ...current } : undefined;
	}

	finish(operationId: string): BrowserActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		this.operations.delete(operationId);
		return { ...current, updatedAt: this.now() };
	}

	snapshot(): BrowserActiveOperationInfo[] {
		this.pruneStale();
		return Array.from(this.operations.values())
			.map((item) => ({ ...item }))
			.sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
	}

	clear(): void {
		this.operations.clear();
	}

	private pruneStale(now = this.now()): void {
		for (const [operationId, operation] of this.operations.entries()) {
			if (now - operation.updatedAt > this.ttlMs) this.operations.delete(operationId);
		}
	}

	private pruneToMaxSize(): void {
		if (this.operations.size <= this.maxOperations) return;
		const overflow = this.operations.size - this.maxOperations;
		const oldest = Array.from(this.operations.values())
			.sort((a, b) => a.updatedAt - b.updatedAt || a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId))
			.slice(0, overflow);
		for (const operation of oldest) this.operations.delete(operation.operationId);
	}
}
