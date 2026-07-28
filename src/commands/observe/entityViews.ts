import { isAddressableEntity, type Entity } from "../../kernels/abml/entity.js";

export function entitySalienceRank(entity: Entity): number {
	const s = entity.state;
	if (s.checked === true || s.selected === true || s.pressed === true || (s.current !== undefined && s.current !== false)) return 0;
	if (s.checked !== undefined || s.selected !== undefined || s.pressed !== undefined) return 1;
	if (entity.kind === "control") return s.inViewport === true ? 2 : 3;
	if (s.inViewport === true) return 4;
	return 5;
}

export function sortEntitiesBySalience(entities: Entity[]): Entity[] {
	return entities
		.map((entity, index) => ({ entity, index }))
		.sort((a, b) => entitySalienceRank(a.entity) - entitySalienceRank(b.entity) || a.index - b.index)
		.map((item) => item.entity);
}

export function buildEntityOutline(entities: Entity[]): Array<Record<string, unknown>> {
	const groups = new Map<string, { container: string; name?: string; memberCount: number; controlRefs: string[]; otherRefs: string[] }>();
	for (const entity of entities) {
		const role = typeof entity.hints?.containerRole === "string" ? entity.hints.containerRole : undefined;
		if (!role) continue;
		const name = typeof entity.hints?.containerName === "string" ? entity.hints.containerName : undefined;
		const key = `${role}\u0000${name ?? ""}`;
		let group = groups.get(key);
		if (!group) {
			group = { container: role, name, memberCount: 0, controlRefs: [], otherRefs: [] };
			groups.set(key, group);
		}
		group.memberCount += 1;
		if (isAddressableEntity(entity)) (entity.kind === "control" ? group.controlRefs : group.otherRefs).push(entity.ref);
	}
	return Array.from(groups.values())
		.sort((a, b) => b.memberCount - a.memberCount)
		.map((group) => {
			const orderedRefs = [...group.controlRefs, ...group.otherRefs];
			return {
				container: group.container,
				...(group.name ? { name: group.name } : {}),
				memberCount: group.memberCount,
				...(group.controlRefs.length ? { controlCount: group.controlRefs.length } : {}),
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
