import type { PageIdentity } from "./pageIdentity.js";

export type PerceptionLedgerKey = Pick<PageIdentity, "browserSessionId" | "tabId" | "targetGeneration" | "pageEpoch">;

export type PerceptionLedgerFactState = {
	versionStamp: string;
	stableStamp?: string;
};

export type PerceptionLedgerFrame = {
	key: PerceptionLedgerKey;
	snapshotId: string;
	capturedAt: number;
	facts: Record<string, PerceptionLedgerFactState>;
	lastAction?: {
		ref: string;
		verb: string;
		at: number;
	};
};

const MAX_LEDGER_FRAMES = 128;

function keyString(key: PerceptionLedgerKey): string {
	return [key.browserSessionId, key.tabId, key.targetGeneration, key.pageEpoch].join("\u0000");
}

export class PerceptionLedger {
	private readonly frames = new Map<string, PerceptionLedgerFrame>();

	get(key: PerceptionLedgerKey): PerceptionLedgerFrame | undefined {
		return this.frames.get(keyString(key));
	}

	record(frame: PerceptionLedgerFrame): PerceptionLedgerFrame {
		const key = keyString(frame.key);
		for (const [existingKey, existing] of this.frames) {
			if (existingKey !== key && existing.key.browserSessionId === frame.key.browserSessionId && existing.key.tabId === frame.key.tabId) this.frames.delete(existingKey);
		}
		this.frames.delete(key);
		this.frames.set(key, frame);
		while (this.frames.size > MAX_LEDGER_FRAMES) this.frames.delete(this.frames.keys().next().value!);
		return frame;
	}

	migrateTabId(fromTabId: number, toTabId: number, options: { browserSessionIds?: Iterable<string | undefined> } = {}): number {
		if (!Number.isInteger(fromTabId) || !Number.isInteger(toTabId) || fromTabId === toTabId) return 0;
		const scopedSessionIds = options.browserSessionIds ? new Set(Array.from(options.browserSessionIds).map((id) => id || "default")) : undefined;
		const frames = Array.from(this.frames.entries())
			.filter(([, frame]) => frame.key.tabId === fromTabId && (!scopedSessionIds || scopedSessionIds.has(frame.key.browserSessionId || "default")))
			.map(([key, frame]) => ({ key, frame }));
		for (const { key } of frames) this.frames.delete(key);
		for (const { frame } of frames.sort((a, b) => a.frame.capturedAt - b.frame.capturedAt)) {
			this.record({ ...frame, key: { ...frame.key, tabId: toTabId } });
		}
		return frames.length;
	}

	clear(): void {
		this.frames.clear();
	}
}
