import type { Entity, EntityRelation } from "./entity.js";

function scope(entity: Entity): string {
	const locator = entity.locators?.find((item) => item.by === "backendNodeId");
	return String(entity.hints?.targetId ?? (locator?.by === "backendNodeId" ? locator.targetId : "") ?? "");
}

/** Materialize native/explicit relations captured in the normal scan, never by name or distance. */
export function attachNativeTaskRelations(entities: Entity[]): Entity[] {
	const selectors = new Map<string, string | null>();
	for (const entity of entities) {
		const css = entity.locators?.find((locator) => locator.by === "css");
		const selector = entity.hints?.selector ?? (css?.by === "css" ? css.value : undefined);
		if (typeof selector !== "string") continue;
		const key = `${scope(entity)}|${selector}`;
		selectors.set(key, selectors.has(key) && selectors.get(key) !== entity.ref ? null : entity.ref);
	}
	return entities.map((entity) => {
		const edges: EntityRelation[] = [];
		let incomplete = false;
		for (const [hint, type, basis] of [
			["formOwnerSelector", "formOwner", "native-association"],
			["labelledBySelectors", "labelledBy", "explicit-relation"],
			["describedBySelectors", "describedBy", "explicit-relation"],
		] as const) {
			const value = entity.hints?.[hint];
			const targets = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
			for (const selector of targets) {
				const ref = typeof selector === "string" ? selectors.get(`${scope(entity)}|${selector}`) : undefined;
				if (!ref) {
					incomplete = true;
					continue;
				}
				edges.push({ type, targetRef: ref, source: "dom", confidence: "high", evidence: { basis } });
			}
		}
		if (!edges.length && !incomplete) return entity;
		const prior = Array.isArray(entity.hints?.contextRelations)
			? (entity.hints.contextRelations as EntityRelation[])
			: [];
		return {
			...entity,
			hints: {
				...entity.hints,
				contextRelations: [...prior, ...edges],
				...(incomplete ? { contextRelationsIncomplete: true } : {}),
			},
		};
	});
}
