import type { Entity } from "./entity.js";
import { normalizeEntityText } from "./grouping.js";
import { deriveSemanticRefAnchors } from "./semanticRefAnchor.js";

export type IdentityReconciliationDiagnostics = {
	exact: number;
	template: number;
	semantic: number;
	geometry: number;
	created: number;
	ambiguous: number;
};

export type IdentityReconciliationResult = {
	entities: Entity[];
	refMap: Map<string, string>;
	diagnostics: IdentityReconciliationDiagnostics;
};

type MatchMethod = "exact" | "template" | "semantic" | "geometry";

const TRACKED_KINDS = new Set(["control", "element", "region", "frame", "media"]);

function text(value: unknown): string {
	return normalizeEntityText(value) ?? "";
}

function hint(entity: Entity, key: string): string {
	return text(entity.hints?.[key]);
}

function scopeKey(entity: Entity): string {
	return JSON.stringify([
		text(entity.structure?.landmark),
		hint(entity, "containerRole"),
		hint(entity, "containerName"),
		text(entity.scope?.name),
	]);
}

function scopedSemanticKey(entity: Entity): string | undefined {
	const role = text(entity.role);
	const name = text(entity.name);
	if (!TRACKED_KINDS.has(entity.kind) || !role || !name) return undefined;
	return JSON.stringify([scopeKey(entity), entity.kind, role, name]);
}

function globalSemanticKey(entity: Entity): string | undefined {
	const role = text(entity.role);
	const name = text(entity.name);
	return TRACKED_KINDS.has(entity.kind) && role && name ? JSON.stringify([entity.kind, role, name]) : undefined;
}

function geometryGroupKey(entity: Entity): string | undefined {
	const role = text(entity.role);
	if (!TRACKED_KINDS.has(entity.kind) || !role) return undefined;
	return JSON.stringify([scopeKey(entity), entity.kind, role]);
}

function templateKeys(entities: Entity[]): Map<string, string> {
	const keys = new Map<string, string>();
	for (const { ref, anchor } of deriveSemanticRefAnchors(entities).anchors) {
		if (!anchor.mintingEligible || anchor.confidence !== "high" || !anchor.normalizedName) continue;
		keys.set(ref, JSON.stringify([anchor.containerRole ?? "", anchor.containerName ?? "", anchor.role, anchor.kind, anchor.normalizedName]));
	}
	return keys;
}

function indexByKey(entities: Entity[], indexes: Iterable<number>, keyFor: (entity: Entity) => string | undefined): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const index of indexes) {
		const key = keyFor(entities[index]!);
		if (!key) continue;
		const bucket = out.get(key);
		if (bucket) bucket.push(index);
		else out.set(key, [index]);
	}
	return out;
}

function center(entity: Entity): { x: number; y: number; span: number } | undefined {
	const box = entity.geometry?.box;
	if (box && [box.x, box.y, box.w, box.h].every(Number.isFinite)) {
		return { x: box.x + box.w / 2, y: box.y + box.h / 2, span: Math.max(32, Math.hypot(box.w, box.h)) };
	}
	const point = entity.geometry?.point;
	return point && [point.x, point.y].every(Number.isFinite) ? { x: point.x, y: point.y, span: 32 } : undefined;
}

function geometricallyContinuous(previous: Entity, current: Entity): boolean {
	const before = center(previous);
	const after = center(current);
	if (!before || !after) return false;
	const distance = Math.hypot(before.x - after.x, before.y - after.y);
	return distance <= Math.min(240, Math.max(before.span, after.span) * 2);
}

export function reconcileEntityIdentities(previous: Entity[], current: Entity[]): IdentityReconciliationResult {
	const refMap = new Map<string, string>();
	const matchedPrevious = new Set<number>();
	const matchedCurrent = new Set<number>();
	const ambiguousCurrent = new Set<number>();
	const diagnostics: IdentityReconciliationDiagnostics = { exact: 0, template: 0, semantic: 0, geometry: 0, created: 0, ambiguous: 0 };
	const previousByRef = new Map(previous.map((entity, index) => [entity.ref, index]));

	const match = (previousIndex: number, currentIndex: number, method: MatchMethod) => {
		if (matchedPrevious.has(previousIndex) || matchedCurrent.has(currentIndex)) return;
		matchedPrevious.add(previousIndex);
		matchedCurrent.add(currentIndex);
		const from = current[currentIndex]!.ref;
		const to = previous[previousIndex]!.ref;
		if (from !== to) refMap.set(from, to);
		diagnostics[method] += 1;
	};

	for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
		const previousIndex = previousByRef.get(current[currentIndex]!.ref);
		if (previousIndex !== undefined) match(previousIndex, currentIndex, "exact");
	}

	const unmatchedPrevious = () => Array.from(previous.keys()).filter((index) => !matchedPrevious.has(index));
	const unmatchedCurrent = () => Array.from(current.keys()).filter((index) => !matchedCurrent.has(index));
	const matchUnique = (method: "template" | "semantic", previousKey: (entity: Entity) => string | undefined, currentKey = previousKey) => {
		const before = indexByKey(previous, unmatchedPrevious(), previousKey);
		const after = indexByKey(current, unmatchedCurrent(), currentKey);
		for (const [key, currentIndexes] of after) {
			const previousIndexes = before.get(key);
			if (!previousIndexes) continue;
			if (previousIndexes.length === 1 && currentIndexes.length === 1) match(previousIndexes[0]!, currentIndexes[0]!, method);
			else for (const index of currentIndexes) ambiguousCurrent.add(index);
		}
	};

	const previousTemplates = templateKeys(previous);
	const currentTemplates = templateKeys(current);
	matchUnique("template", (entity) => previousTemplates.get(entity.ref), (entity) => currentTemplates.get(entity.ref));
	matchUnique("semantic", scopedSemanticKey);
	matchUnique("semantic", globalSemanticKey);

	const geometryBefore = indexByKey(previous, unmatchedPrevious(), geometryGroupKey);
	const geometryAfter = indexByKey(current, unmatchedCurrent(), geometryGroupKey);
	for (const [key, currentIndexes] of geometryAfter) {
		const previousIndexes = geometryBefore.get(key);
		if (!previousIndexes) continue;
		if (previousIndexes.length !== 1 || currentIndexes.length !== 1) {
			for (const index of currentIndexes) ambiguousCurrent.add(index);
			continue;
		}
		const previousIndex = previousIndexes[0]!;
		const currentIndex = currentIndexes[0]!;
		const previousName = text(previous[previousIndex]!.name);
		const currentName = text(current[currentIndex]!.name);
		if (previousName && currentName && previousName !== currentName) continue;
		if (geometricallyContinuous(previous[previousIndex]!, current[currentIndex]!)) match(previousIndex, currentIndex, "geometry");
	}

	diagnostics.created = current.length - matchedCurrent.size;
	diagnostics.ambiguous = [...ambiguousCurrent].filter((index) => !matchedCurrent.has(index)).length;
	const entities = current.map((entity) => ({
		...entity,
		ref: refMap.get(entity.ref) ?? entity.ref,
	}));
	return { entities, refMap, diagnostics };
}
