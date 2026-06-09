import { createHash, randomUUID } from "node:crypto";
import type { BrowserActiveOperationInfo } from "./types.js";

function ownerHash(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

export class BrowserOperationRegistry {
	private readonly operations = new Map<string, BrowserActiveOperationInfo>();

	begin(operation: Omit<BrowserActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }): BrowserActiveOperationInfo {
		const now = Date.now();
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
		return { ...record };
	}

	update(operationId: string, patch: Partial<Omit<BrowserActiveOperationInfo, "operationId" | "startedAt">>): BrowserActiveOperationInfo | undefined {
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		const nextLeaseOwnerHash = Object.prototype.hasOwnProperty.call(patch, "leaseOwnerHash")
			? ownerHash(typeof patch.leaseOwnerHash === "string" ? patch.leaseOwnerHash : undefined)
			: current.leaseOwnerHash;
		const next: BrowserActiveOperationInfo = {
			...current,
			...patch,
			leaseOwnerHash: nextLeaseOwnerHash,
			updatedAt: Date.now(),
		};
		this.operations.set(operationId, next);
		return { ...next };
	}

	get(operationId: string): BrowserActiveOperationInfo | undefined {
		const current = this.operations.get(operationId);
		return current ? { ...current } : undefined;
	}

	finish(operationId: string): BrowserActiveOperationInfo | undefined {
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		this.operations.delete(operationId);
		return { ...current, updatedAt: Date.now() };
	}

	snapshot(): BrowserActiveOperationInfo[] {
		return Array.from(this.operations.values())
			.map((item) => ({ ...item }))
			.sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
	}

	clear(): void {
		this.operations.clear();
	}
}
