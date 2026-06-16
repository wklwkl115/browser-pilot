import type { Entity } from "../../kernels/abml/entity.js";
import type { ObserveRelevanceResult } from "./relevanceTypes.js";

export function entitySalienceRank(entity: Entity): number {
	const s = entity.state;
	if (s.checked === true || s.selected === true || s.pressed === true || (s.current !== undefined && s.current !== false)) return 0;
	if (s.checked !== undefined || s.selected !== undefined || s.pressed !== undefined) return 1;
	if (entity.kind === "control") return 2;
	if (s.inViewport === true) return 3;
	return 4;
}

export function sortEntitiesBySalience(entities: Entity[], relevance?: ObserveRelevanceResult): Entity[] {
	return entities
		.map((entity, index) => ({ entity, index, relevance: relevance?.byRef.get(entity.ref)?.score ?? 0 }))
		.sort((a, b) => entitySalienceRank(a.entity) - entitySalienceRank(b.entity) || b.relevance - a.relevance || a.index - b.index)
		.map((item) => item.entity);
}

export function buildEntityOutline(entities: Entity[]): Array<Record<string, unknown>> {
	const groups = new Map<string, { container: string; name?: string; members: Array<{ ref: string; control: boolean }> }>();
	for (const entity of entities) {
		const role = typeof entity.hints?.containerRole === "string" ? entity.hints.containerRole : undefined;
		if (!role) continue;
		const name = typeof entity.hints?.containerName === "string" ? entity.hints.containerName : undefined;
		const key = `${role}\u0000${name ?? ""}`;
		let group = groups.get(key);
		if (!group) {
			group = { container: role, name, members: [] };
			groups.set(key, group);
		}
		group.members.push({ ref: entity.ref, control: entity.kind === "control" });
	}
	return Array.from(groups.values())
		.sort((a, b) => b.members.length - a.members.length)
		.slice(0, 12)
		.map((group) => {
			const controlCount = group.members.filter((member) => member.control).length;
			const orderedRefs = [...group.members.filter((m) => m.control), ...group.members.filter((m) => !m.control)].map((m) => m.ref);
			return {
				container: group.container,
				...(group.name ? { name: group.name } : {}),
				memberCount: group.members.length,
				...(controlCount ? { controlCount } : {}),
				memberRefs: orderedRefs.slice(0, 12),
			};
		});
}

export function buildPageGist(entities: Entity[]): Record<string, unknown> {
	const landmarks = new Set<string>();
	const containers = new Set<string>();
	let controlCount = 0;
	let statefulControlCount = 0;
	let activeControlCount = 0;
	for (const entity of entities) {
		const landmark = entity.structure?.landmark;
		if (typeof landmark === "string") landmarks.add(landmark);
		const containerRole = entity.hints?.containerRole;
		if (typeof containerRole === "string") containers.add(`${containerRole} ${typeof entity.hints?.containerName === "string" ? entity.hints.containerName : ""}`);
		if (entity.kind === "control") {
			controlCount += 1;
			const s = entity.state;
			if (s.checked !== undefined || s.selected !== undefined || s.pressed !== undefined) statefulControlCount += 1;
			if (s.checked === true || s.selected === true || s.pressed === true) activeControlCount += 1;
		}
	}
	return {
		landmarks: Array.from(landmarks),
		controlCount,
		...(statefulControlCount ? { statefulControlCount } : {}),
		...(activeControlCount ? { activeControlCount } : {}),
		containerCount: containers.size,
	};
}
