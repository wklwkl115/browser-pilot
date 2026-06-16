import type { Entity } from "../../kernels/abml/entity.js";
import type { CommandPerceptionLedgerFactState, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";

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

function entityStableStamp(entity: Entity): string {
	return JSON.stringify({
		kind: entity.kind,
		role: entity.role,
		name: entity.name,
		value: entity.value,
		state: entity.state,
		structure: entity.structure,
	});
}

export function factsFromObservedEntities(entities: Entity[], granularity: CommandPerceptionLedgerFactState["lastShownGranularity"] = "compact"): Record<string, CommandPerceptionLedgerFactState> {
	const facts: Record<string, CommandPerceptionLedgerFactState> = {};
	for (const entity of entities) facts[entity.ref] = { versionStamp: entityVersionStamp(entity), stableStamp: entityStableStamp(entity), lastShownGranularity: granularity };
	return facts;
}

export function stableRefsFromCommandFrames(current: CommandPerceptionLedgerFrame, prior: CommandPerceptionLedgerFrame | undefined): Set<string> {
	const out = new Set<string>();
	if (!prior) return out;
	for (const [ref, state] of Object.entries(current.facts)) {
		const previous = prior.facts[ref];
		if (!previous) continue;
		if ((state.stableStamp ?? state.versionStamp) === (previous.stableStamp ?? previous.versionStamp)) out.add(ref);
	}
	return out;
}
