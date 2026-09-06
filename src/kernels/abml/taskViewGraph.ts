import { assessTaskContext, planOwnerContext } from "./taskContextCoverage.js";
import { addTaskGap, retainTaskEvidence } from "./taskEvidence.js";
import type { Entity, EntityRelation } from "./entity.js";
import { entityRelationKeys } from "./relations.js";
import { normalizeTaskText, type NormalizedTaskViewSpec, type TaskEvidence, type TaskGap } from "./taskView.js";

export const TASK_ENTITY_LIMIT = 20_000;
export const TASK_CONTEXT_LIMIT = 128;
const OBJECT_ROLES = new Set(["row", "listitem", "article", "form", "dialog", "alertdialog", "group", "region"]);

export type TaskEntityIndex = {
	entities: Entity[];
	byRef: Map<string, Entity>;
	parent: Map<string, string>;
	children: Map<string, string[]>;
	complete: boolean;
};

function flatten(roots: Entity[]): { entities: Entity[]; parents: Map<string, string>; complete: boolean } {
	const entities: Entity[] = [];
	const parents = new Map<string, string>();
	const seen = new Set<string>();
	const pending = roots.map((entity) => ({ entity, parent: undefined as string | undefined })).reverse();
	while (pending.length && entities.length < TASK_ENTITY_LIMIT) {
		const { entity, parent } = pending.pop()!;
		if (parent) parents.set(entity.ref, parent);
		if (seen.has(entity.ref)) continue;
		seen.add(entity.ref);
		entities.push(entity);
		if (Array.isArray(entity.children))
			for (const child of [...entity.children].reverse()) pending.push({ entity: child, parent: entity.ref });
	}
	return { entities, parents, complete: pending.length === 0 };
}

function scopedKey(entity: Entity, key: string): string {
	const backend = entity.locators?.find((locator) => locator.by === "backendNodeId");
	const target = entity.hints?.targetId ?? (backend?.by === "backendNodeId" ? backend.targetId : undefined);
	return key.startsWith("b:") && typeof target === "string" && target ? `t:${target}:${key}` : key;
}

function contextParent(entity: Entity, keys: Map<string, string | null>): string | undefined {
	if (typeof entity.hints?.contextParentRef === "string") return entity.hints.contextParentRef;
	const ancestry = entity.hints?.contextAncestorKeys;
	const candidates = Array.isArray(ancestry) ? ancestry : [entity.hints?.containerKey];
	for (const key of candidates) {
		if (typeof key !== "string") continue;
		const ref = keys.get(scopedKey(entity, key));
		if (ref && ref !== entity.ref) return ref;
	}
	return taskRelations(entity).find((relation) => relation.type === "rowOf")?.targetRef;
}

export function taskRelations(entity: Entity): EntityRelation[] {
	const context = Array.isArray(entity.hints?.contextRelations)
		? (entity.hints.contextRelations as EntityRelation[])
		: [];
	return [...(entity.relations ?? []), ...context];
}

export function taskEntityIndex(roots: Entity[]): TaskEntityIndex {
	const flat = flatten(roots);
	const byRef = new Map(flat.entities.map((entity) => [entity.ref, entity]));
	const keys = new Map<string, string | null>();
	for (const entity of flat.entities)
		for (const key of entityRelationKeys(entity))
			keys.set(key, keys.has(key) && keys.get(key) !== entity.ref ? null : entity.ref);
	const parent = flat.parents;
	for (const entity of flat.entities) {
		const owner = parent.get(entity.ref) ?? contextParent(entity, keys);
		if (owner && byRef.has(owner) && owner !== entity.ref) parent.set(entity.ref, owner);
	}
	const children = new Map<string, string[]>();
	for (const [child, owner] of parent) {
		const members = children.get(owner) ?? [];
		members.push(child);
		children.set(owner, members);
	}
	return { entities: flat.entities, byRef, parent, children, complete: flat.complete };
}

/** Only proven ancestry groups hits; names and display scope numbers never establish ownership. */
export function taskObjectRoot(index: TaskEntityIndex, entity: Entity): Entity {
	if (OBJECT_ROLES.has(entity.role.toLowerCase())) return entity;
	let current = entity.ref;
	const seen = new Set<string>();
	for (let depth = 0; depth < 24; depth++) {
		const parent = index.parent.get(current);
		if (!parent || seen.has(parent)) break;
		seen.add(parent);
		const owner = index.byRef.get(parent);
		if (!owner) break;
		if (OBJECT_ROLES.has(owner.role.toLowerCase())) return owner;
		current = parent;
	}
	return entity;
}

export function taskContext(
	index: TaskEntityIndex,
	anchor: Entity,
	preferences: { spec: NormalizedTaskViewSpec; matchedRefs: Set<string>; changedRefs: Set<string> },
): TaskEvidence & { entities: Entity[]; candidates: Entity[] } {
	const root = taskObjectRoot(index, anchor);
	const members = new Map<string, Entity>([
		[anchor.ref, anchor],
		[root.ref, root],
	]);
	const pending = [...(index.children.get(root.ref) ?? [])];
	const visited = new Set<string>([root.ref]);
	const issues: Array<Omit<TaskGap, "id" | "remedyIds">> = [];
	const missing = (code: string, relatedRefs: string[], reason: string, layer: TaskGap["layer"] = "capture") =>
		issues.push({ code, relatedRefs, reason, layer, requirement: "local" });
	if (!index.complete)
		missing(
			"entity-index-limit",
			[],
			"The bounded index did not inspect the entire canonical snapshot.",
			"selection",
		);
	for (let position = 0; position < pending.length; position++) {
		const ref = pending[position]!;
		if (visited.has(ref)) continue;
		visited.add(ref);
		const entity = index.byRef.get(ref);
		if (!entity) {
			missing("structural-member-unavailable", [ref], "A referenced structural member was not captured.");
			continue;
		}
		members.set(ref, entity);
		pending.push(...(index.children.get(ref) ?? []));
	}
	const localRefs = new Set(members.keys());
	const ownerPlan = planOwnerContext(index, root);
	for (const ref of ownerPlan.refs) members.set(ref, index.byRef.get(ref)!);
	// Resolve captured dependencies before selection so limits cannot hide missing relations.
	const dependencies = [...members.values()];
	for (let i = 0; i < dependencies.length; i++) {
		const source = dependencies[i]!;
		if (source.children && !Array.isArray(source.children))
			missing(
				"uncaptured-children",
				[source.ref],
				"This entity has children that are not present in the snapshot.",
			);
		if (source.hints?.contextTextIncomplete === true)
			missing("captured-context-text-incomplete", [source.ref], "Captured context text is incomplete.");
		for (const edge of taskRelations(dependencies[i]!)) {
			if (
				!["labelledBy", "describedBy", "columnOf", "coveredBy", "controls", "expandedTarget"].includes(
					edge.type,
				)
			)
				continue;
			if (members.has(edge.targetRef)) continue;
			const target = index.byRef.get(edge.targetRef);
			if (!target) {
				missing(
					"related-context-unavailable",
					[source.ref, edge.targetRef],
					index.complete
						? `Captured ${edge.type} relation points to an unavailable node.`
						: `Captured ${edge.type} target is outside the bounded index; capture absence is not established.`,
					index.complete ? "capture" : "selection",
				);
				continue;
			}
			members.set(target.ref, target);
			localRefs.add(target.ref);
			dependencies.push(target);
		}
	}
	const evidence = assessTaskContext({
		anchor,
		localRefs,
		candidates: members,
		ownerPlan,
		intent: preferences.spec.intent,
		focused:
			preferences.matchedRefs.has(anchor.ref) ||
			("refs" in preferences.spec.focus && preferences.spec.focus.refs.includes(anchor.ref)),
		issues,
	});
	if (
		root.ref === anchor.ref &&
		!index.children.has(root.ref) &&
		!index.parent.has(root.ref) &&
		evidence.requirements.owner.evidence === "unknown"
	)
		addTaskGap(evidence, {
			code: "object-context-unavailable",
			requirement: "owner",
			layer: "association",
			relatedRefs: [root.ref],
			reason: "This captured entity has no established object context.",
		});
	const rank = (entity: Entity) => contextRank(entity, anchor.ref, root.ref, preferences);
	const ranked = [...members.values()].sort((a, b) => rank(a) - rank(b));
	const chosen = ranked.slice(0, TASK_CONTEXT_LIMIT);
	retainTaskEvidence(evidence, new Set(chosen.map((entity) => entity.ref)));
	return { ...evidence, entities: chosen, candidates: [...members.values()] };
}

function contextRank(
	entity: Entity,
	anchor: string,
	root: string,
	preferences: Parameters<typeof taskContext>[2],
): number {
	if (entity.ref === anchor || entity.ref === root) return 0;
	const role = entity.role.toLowerCase();
	if (["alert", "status", "dialog", "alertdialog"].includes(role)) return 1;
	if (preferences.matchedRefs.has(entity.ref)) return 2;
	const { fields, intent } = preferences.spec;
	if (intent === "check" && preferences.changedRefs.has(entity.ref)) return 2;
	if (fields.some((field) => normalizeTaskText(entity.name ?? "").includes(normalizeTaskText(field)))) return 2;
	if (intent === "locate" && ["heading", "rowheader"].includes(role)) return 3;
	if (intent === "interact" && role === "button") return 3;
	if (intent === "read" && entity.state.editable) return 3;
	if (["heading", "rowheader", "columnheader", "button"].includes(role)) return 4;
	return 5;
}
