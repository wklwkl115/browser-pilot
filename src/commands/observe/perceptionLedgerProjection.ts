import type { Entity } from "../../kernels/abml/entity.js";
import type { CommandPerceptionLedgerFactState } from "../../ports/BrowserCommandRuntimePort.js";

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

export function factsFromObservedEntities(entities: Entity[]): Record<string, CommandPerceptionLedgerFactState> {
	const facts: Record<string, CommandPerceptionLedgerFactState> = {};
	for (const entity of entities) facts[entity.ref] = { versionStamp: entityVersionStamp(entity), stableStamp: entityStableStamp(entity) };
	return facts;
}
