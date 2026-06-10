import type { Entity } from "./entity.js";

export type PerceptionLedgerKey = {
	browserSessionId?: string;
	tabId?: number;
	navigationEpoch?: string;
};

export type PerceptionLedgerFactState = {
	versionStamp: string;
	lastShownGranularity: "full" | "compact" | "line" | "ref";
};

export type PerceptionLedgerFrame = {
	key: PerceptionLedgerKey;
	snapshotId: string;
	capturedAt: number;
	facts: Record<string, PerceptionLedgerFactState>;
};

function keyString(key: PerceptionLedgerKey): string {
	return [key.browserSessionId || "default", key.tabId ?? "tab", key.navigationEpoch || "unknown"].join("\u0000");
}

function entityVersionStamp(entity: Entity): string {
	return JSON.stringify({
		kind: entity.kind,
		role: entity.role,
		name: entity.name,
		value: entity.value,
		state: entity.state,
		structure: entity.structure,
		relations: entity.relations?.map((rel) => ({ type: rel.type, targetRef: rel.targetRef, source: rel.source, confidence: rel.confidence })),
	});
}

export function factsFromEntities(entities: Entity[], granularity: PerceptionLedgerFactState["lastShownGranularity"] = "compact"): Record<string, PerceptionLedgerFactState> {
	const facts: Record<string, PerceptionLedgerFactState> = {};
	for (const entity of entities) facts[entity.ref] = { versionStamp: entityVersionStamp(entity), lastShownGranularity: granularity };
	return facts;
}

export class PerceptionLedger {
	private readonly frames = new Map<string, PerceptionLedgerFrame>();

	get(key: PerceptionLedgerKey): PerceptionLedgerFrame | undefined {
		return this.frames.get(keyString(key));
	}

	record(frame: PerceptionLedgerFrame): PerceptionLedgerFrame {
		this.frames.set(keyString(frame.key), frame);
		return frame;
	}

	clear(): void {
		this.frames.clear();
	}
}
