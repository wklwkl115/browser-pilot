import type { Entity } from "./entity.js";
import { taskRelations, type TaskEntityIndex } from "./taskViewGraph.js";
import type { OwnerContextPlan } from "./taskContextCoverage.js";
import type { RelationEvidence } from "./taskView.js";

export function nativeFormOwner(index: TaskEntityIndex, entity: Entity): Entity | undefined {
	const edges = taskRelations(entity).filter(
		(edge) => edge.type === "formOwner" && edge.source === "dom" && edge.evidence?.basis === "native-association",
	);
	const refs = new Set(edges.map((edge) => edge.targetRef));
	if (refs.size !== 1) return undefined;
	const owner = index.byRef.get(edges[0]!.targetRef);
	return owner?.role.toLowerCase() === "form" ? owner : undefined;
}

function independentOwner(index: TaskEntityIndex, entity: Entity, formRef: string): boolean {
	let ref = entity.ref;
	const seen = new Set<string>();
	for (let depth = 0; depth < 24; depth++) {
		const parent = index.parent.get(ref);
		if (!parent || parent === formRef || seen.has(parent)) return false;
		seen.add(parent);
		const owner = index.byRef.get(parent);
		if (owner && ["row", "listitem", "article", "dialog", "alertdialog"].includes(owner.role.toLowerCase()))
			return true;
		ref = parent;
	}
	return true;
}

export function belongsToTaskOwner(index: TaskEntityIndex, entity: Entity, owner: Entity): boolean {
	if (entity.ref === owner.ref) return true;
	const native = nativeFormOwner(index, entity);
	if (owner.role.toLowerCase() === "form" && native)
		return native.ref === owner.ref && !independentOwner(index, entity, owner.ref);
	let current = entity.ref;
	const visited = new Set<string>();
	for (let depth = 0; depth < 24; depth++) {
		const parent = index.parent.get(current);
		if (!parent || visited.has(parent)) break;
		if (parent === owner.ref) return true;
		visited.add(parent);
		const container = index.byRef.get(parent);
		if (
			container &&
			["form", "row", "listitem", "article", "dialog", "alertdialog"].includes(container.role.toLowerCase())
		)
			return false;
		current = parent;
	}
	return true;
}

function provenControlBoundary(index: TaskEntityIndex, boundary: string): boolean {
	if (index.byRef.get(boundary)?.hints?.contextStructureIncomplete === true) return false;
	const pending = [...(index.children.get(boundary) ?? [])];
	const seen = new Set<string>();
	let controls = 0;
	for (let i = 0; i < pending.length; i++) {
		const ref = pending[i]!;
		if (seen.has(ref)) continue;
		seen.add(ref);
		const entity = index.byRef.get(ref);
		if (!entity) return false;
		if (entity.actionability?.actions.length) {
			if (!nativeFormOwner(index, entity)) return false;
			controls++;
			continue;
		}
		const children = index.children.get(ref) ?? [];
		if (!children.length && (entity.name || entity.hints?.contextText)) return false;
		pending.push(...children);
	}
	return controls > 0;
}

export function supplementNativeOwnership(index: TaskEntityIndex, plan: OwnerContextPlan): OwnerContextPlan {
	if (plan.owner?.role.toLowerCase() !== "form") return plan;
	if (plan.owner.hints?.contextStructureIncomplete === true) plan.unknownBoundaries.add(plan.owner.ref);
	const unprovenNativeRefs = new Set<string>();
	for (const entity of index.entities) {
		const native = nativeFormOwner(index, entity);
		if (native?.ref === plan.owner.ref && !independentOwner(index, entity, plan.owner.ref))
			plan.refs.add(entity.ref);
		else if (
			!native &&
			declaredOwnerMatches(entity, plan.owner) &&
			!independentOwner(index, entity, plan.owner.ref)
		)
			unprovenNativeRefs.add(entity.ref);
	}
	for (const boundary of plan.unknownBoundaries)
		if (provenControlBoundary(index, boundary)) plan.unknownBoundaries.delete(boundary);
	for (const ref of unprovenNativeRefs) plan.unknownBoundaries.add(ref);
	return plan;
}

function declaredOwnerMatches(entity: Entity, owner: Entity): boolean {
	const target = (item: Entity) => {
		const locator = item.locators?.find((entry) => entry.by === "backendNodeId");
		return item.hints?.targetId ?? (locator?.by === "backendNodeId" ? locator.targetId : undefined);
	};
	return (
		typeof owner.hints?.selector === "string" &&
		entity.hints?.formOwnerObserved === true &&
		entity.hints.formOwnerSelector === owner.hints.selector &&
		target(entity) === target(owner)
	);
}

export function taskRelationEvidence(
	index: TaskEntityIndex,
	refs: Set<string>,
	snapshotId: string,
): RelationEvidence[] {
	const result: RelationEvidence[] = [];
	const seen = new Set<string>();
	const add = (edge: RelationEvidence) => {
		const key = `${edge.fromRef}|${edge.relation}|${edge.toRef}|${edge.basis}`;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(edge);
		}
	};
	for (const ref of refs) {
		const entity = index.byRef.get(ref);
		if (!entity) continue;
		const parent = index.parent.get(ref);
		if (parent && refs.has(parent))
			add({
				fromRef: ref,
				toRef: parent,
				relation: "containedBy",
				basis: "captured-structure",
				snapshotId,
				source:
					entity.hints?.contextParentRef || entity.hints?.contextAncestorKeys
						? "ax"
						: entity.source === "dom"
							? "dom"
							: "ax",
			});
		for (const edge of taskRelations(entity)) {
			if (!refs.has(edge.targetRef) || !["dom", "ax"].includes(edge.source)) continue;
			add({
				fromRef: ref,
				toRef: edge.targetRef,
				relation: edge.type,
				basis:
					edge.evidence?.basis === "native-association"
						? "native-association"
						: ["rowOf", "cellOf", "columnOf", "headerFor"].includes(edge.type)
							? "captured-structure"
							: "explicit-relation",
				snapshotId,
				source: edge.source as "dom" | "ax",
			});
		}
	}
	return result;
}

export function taskIdentityFields(index: TaskEntityIndex, candidates: Entity[], owner?: Entity): Entity[] {
	const fieldContext = new Set(
		candidates.flatMap((entity) =>
			taskRelations(entity)
				.filter((edge) => edge.type === "labelledBy" || edge.type === "describedBy")
				.map((edge) => edge.targetRef),
		),
	);
	const pending = [...fieldContext];
	for (let i = 0; i < pending.length; i++)
		for (const ref of index.children.get(pending[i]!) ?? [])
			if (!fieldContext.has(ref)) {
				fieldContext.add(ref);
				pending.push(ref);
			}
	return candidates.filter(
		(entity) =>
			entity.ref === owner?.ref ||
			(!entity.state.editable &&
				!entity.actionability?.actions.length &&
				!fieldContext.has(entity.ref) &&
				!["alert", "status", "alertdialog"].includes(entity.role.toLowerCase()) &&
				!index.children.get(entity.ref)?.length &&
				!!(entity.name || entity.value || entity.hints?.contextText)),
	);
}
