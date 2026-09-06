import type { Entity, EntityRelation } from "./entity.js";
import { entityRelationKeys, type RelationAnchor } from "./relations.js";
import { normalizeTaskText } from "./taskView.js";

export type CapturedDomId = { id: string; backendNodeId: number; path?: Array<{ tag: string; index: number }> };

function pathKey(path: unknown[]): string {
	return JSON.stringify(
		path.map((segment) => {
			const item = segment as { tag: string; index: number };
			return [item.tag, item.index];
		}),
	);
}

/** Snapshot-only context association. Does not mint/upgrade locators, ref identity or actionability. */
export function attachCapturedTaskContext(
	entities: Entity[],
	axEntities: Omit<Entity, "ref">[],
	anchors: RelationAnchor[],
	domIds: CapturedDomId[],
): Entity[] {
	const uniqueIds = new Map<string, number | null>();
	const uniquePaths = new Map<string, number | null>();
	for (const entry of domIds) {
		if (entry.id) uniqueIds.set(entry.id, uniqueIds.has(entry.id) ? null : entry.backendNodeId);
		if (entry.path) {
			const key = pathKey(entry.path);
			uniquePaths.set(key, uniquePaths.has(key) ? null : entry.backendNodeId);
		}
	}
	const axByKey = new Map<string, Omit<Entity, "ref">>();
	for (const entity of axEntities) for (const key of entityRelationKeys(entity)) axByKey.set(key, entity);
	const refsByKey = new Map<string, string | null>();
	const keyByRef = new Map<string, string>();
	for (const entity of entities) {
		if (
			entity.hints?.targetId ||
			entity.locators?.some((locator) => locator.by === "backendNodeId" && locator.targetId)
		)
			continue;
		const keys = entityRelationKeys(entity).filter((key) => key.startsWith("b:") || key.startsWith("a:"));
		const selector = entity.locators?.find((locator) => locator.by === "css");
		const id = selector?.by === "css" ? /^#([A-Za-z0-9_-]+)$/.exec(selector.value)?.[1] : undefined;
		const backend = id
			? uniqueIds.get(id)
			: Array.isArray(entity.hints?.capturedDomPath)
				? uniquePaths.get(pathKey(entity.hints.capturedDomPath))
				: undefined;
		if (backend) {
			const key = `b:${backend}`;
			const ax = axByKey.get(key);
			if (ax && sameObservedObject(entity, ax)) keys.push(key);
		}
		for (const key of keys) {
			refsByKey.set(key, refsByKey.has(key) && refsByKey.get(key) !== entity.ref ? null : entity.ref);
			if (axByKey.has(key) && !keyByRef.has(entity.ref)) keyByRef.set(entity.ref, key);
		}
	}
	const bySource = new Map<string, RelationAnchor[]>();
	const incompleteContainers = new Set<string>();
	for (const entity of axEntities) {
		if (!entity.actionability?.actions.length || entityRelationKeys(entity).some((key) => refsByKey.get(key)))
			continue;
		if (Array.isArray(entity.hints?.contextAncestorKeys))
			for (const key of entity.hints.contextAncestorKeys)
				if (typeof key === "string") incompleteContainers.add(key);
	}
	for (const anchor of anchors) bySource.set(anchor.sourceKey, [...(bySource.get(anchor.sourceKey) ?? []), anchor]);
	return entities.map((entity) => {
		const key = keyByRef.get(entity.ref);
		const ax = key ? axByKey.get(key) : undefined;
		if (!key || !ax || refsByKey.get(key) !== entity.ref) return entity;
		const ancestorKeys = ax.hints?.contextAncestorKeys;
		const parent = Array.isArray(ancestorKeys)
			? ancestorKeys
					.map((entry) => (typeof entry === "string" ? refsByKey.get(entry) : undefined))
					.find((ref) => ref && ref !== entity.ref)
			: undefined;
		const relations: EntityRelation[] = (bySource.get(key) ?? []).flatMap((edge) => {
			const target = refsByKey.get(edge.targetKey);
			return target
				? [{ type: edge.type, targetRef: target, source: edge.source, confidence: edge.confidence }]
				: [];
		});
		return {
			...entity,
			hints: {
				...entity.hints,
				...(parent ? { contextParentRef: parent } : {}),
				...(incompleteContainers.has(key) ? { contextStructureIncomplete: true } : {}),
				...(ax.hints?.contextRelationsIncomplete === true ? { contextRelationsIncomplete: true } : {}),
				...(relations.length ? { contextRelations: relations } : {}),
				...(typeof ax.hints?.contextText === "string"
					? {
							contextText: ax.hints.contextText,
							contextTextSource: "ax",
							contextTextIncomplete: ax.hints.contextTextIncomplete === true,
						}
					: {}),
			},
		};
	});
}

function sameObservedObject(dom: Entity, ax: Omit<Entity, "ref">): boolean {
	const role =
		dom.role.toLowerCase() === ax.role.toLowerCase() ||
		(dom.role === "form" && dom.hints?.referencedTarget === true && ax.role === "generic");
	const name = !dom.name || !ax.name || normalizeTaskText(dom.name) === normalizeTaskText(ax.name);
	// The ID association is main-document-only, as is the DOMSnapshot consumed by this runtime.
	return (
		role &&
		name &&
		!dom.hints?.targetId &&
		!dom.locators?.some((locator) => locator.by === "backendNodeId" && locator.targetId)
	);
}
