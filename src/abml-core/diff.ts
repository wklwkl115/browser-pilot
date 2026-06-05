import type { Entity, EntityState } from "./entity.js";

export type EntityChangeKind = "appeared" | "disappeared" | "state-changed" | "name-changed" | "value-changed";

export type EntityNameChange = { name?: string };
export type EntityValueChange = { value?: string };

export type EntityChange = {
	ref: string;
	kind: EntityChangeKind;
	before?: Partial<EntityState> | EntityNameChange | EntityValueChange;
	after?: Partial<EntityState> | EntityNameChange | EntityValueChange;
};

export type EntityDiffSalienceItem =
	| { kind: "changed"; ref: string; changeKind: EntityChangeKind; score: number; signal: string; entityKind?: string; role?: string; name?: string; fields: string[]; before?: unknown; after?: unknown }
	| { kind: "churn"; score: number; signal: string; appeared: number; disappeared: number; sampleAppeared: string[]; sampleDisappeared: string[] };

export type EntityDiffSalience = {
	changed: number;
	appeared: number;
	disappeared: number;
	focusedRef?: string;
	items: EntityDiffSalienceItem[];
};

export type EntityDiff = {
	appeared: string[];
	disappeared: string[];
	changed: EntityChange[];
	focusedRef?: string;
};

export type EntityDiffOptions = {
	// Partial baselines intentionally include only a subset of refs (for example, a few controls
	// the caller wants to track). In that mode unmatched after-entities are noise, not true
	// appearances, so suppress appeared refs while still reporting disappeared/changed/focus.
	partialBaseline?: boolean;
};

const STATE_KEYS: Array<keyof EntityState> = [
	"visible",
	"occluded",
	"disabled",
	"focused",
	"checked",
	"selected",
	"pressed",
	"expanded",
	"current",
	"editable",
	"inViewport",
];

function stateDelta(before: EntityState, after: EntityState): { before: Partial<EntityState>; after: Partial<EntityState> } | undefined {
	const beforeDelta: Partial<EntityState> = {};
	const afterDelta: Partial<EntityState> = {};
	for (const key of STATE_KEYS) {
		if (before[key] === after[key]) continue;
		beforeDelta[key] = before[key] as never;
		afterDelta[key] = after[key] as never;
	}
	return Object.keys(beforeDelta).length ? { before: beforeDelta, after: afterDelta } : undefined;
}

export function diffEntities(before: Entity[], after: Entity[], options: EntityDiffOptions = {}): EntityDiff {
	const beforeByRef = new Map(before.map((entity) => [entity.ref, entity]));
	const afterByRef = new Map(after.map((entity) => [entity.ref, entity]));
	const appeared: string[] = [];
	const disappeared: string[] = [];
	const changed: EntityChange[] = [];

	for (const entity of after) {
		const previous = beforeByRef.get(entity.ref);
		if (!previous) {
			if (!options.partialBaseline) appeared.push(entity.ref);
			continue;
		}
		const delta = stateDelta(previous.state, entity.state);
		if (delta) changed.push({ ref: entity.ref, kind: "state-changed", before: delta.before, after: delta.after });
		if ((previous.name ?? undefined) !== (entity.name ?? undefined)) {
			changed.push({
				ref: entity.ref,
				kind: "name-changed",
				before: previous.name === undefined ? {} : { name: previous.name },
				after: entity.name === undefined ? {} : { name: entity.name },
			});
		}
		if ((previous.value ?? undefined) !== (entity.value ?? undefined)) {
			changed.push({
				ref: entity.ref,
				kind: "value-changed",
				before: previous.value === undefined ? {} : { value: previous.value },
				after: entity.value === undefined ? {} : { value: entity.value },
			});
		}
	}

	for (const entity of before) {
		if (!afterByRef.has(entity.ref)) disappeared.push(entity.ref);
	}

	const focusedRef = after.find((entity) => entity.state.focused === true)?.ref;
	return { appeared, disappeared, changed, ...(focusedRef ? { focusedRef } : {}) };
}

function changedFields(change: EntityChange): string[] {
	if (change.kind === "name-changed") return ["name"];
	if (change.kind === "value-changed") return ["value"];
	const before = change.before && typeof change.before === "object" ? Object.keys(change.before) : [];
	const after = change.after && typeof change.after === "object" ? Object.keys(change.after) : [];
	return Array.from(new Set([...before, ...after]));
}

function entityLabel(entity: Entity | undefined): Pick<Extract<EntityDiffSalienceItem, { kind: "changed" }>, "entityKind" | "role" | "name"> {
	if (!entity) return {};
	return {
		entityKind: entity.kind,
		role: entity.role,
		...(entity.name ? { name: entity.name } : {}),
	};
}

function changeScore(change: EntityChange, entity: Entity | undefined, focusedRef?: string): number {
	let score = 0;
	if (entity?.kind === "control") score += 40;
	else if (entity?.kind === "element" || entity?.kind === "region") score += 24;
	else if (entity?.kind === "text") score += 4;
	if (change.kind === "value-changed") score += 40;
	else if (change.kind === "name-changed") score += 28;
	else if (change.kind === "state-changed") score += 24;
	if (change.ref === focusedRef) score += 30;
	const fields = changedFields(change);
	for (const field of fields) {
		if (["value", "checked", "selected", "pressed", "expanded", "current", "disabled", "focused"].includes(field)) score += 8;
	}
	return score;
}

function signalForChange(change: EntityChange, fields: string[]): string {
	return `${change.kind}:${change.ref}${fields.length ? `:${fields.join(",")}` : ""}`;
}

export function summarizeEntityDiff(diff: EntityDiff, before: Entity[] = [], after: Entity[] = []): EntityDiffSalience {
	const entityByRef = new Map([...before, ...after].map((entity) => [entity.ref, entity]));
	const changedItems: EntityDiffSalienceItem[] = diff.changed.map((change) => {
		const entity = entityByRef.get(change.ref);
		const fields = changedFields(change);
		return {
			kind: "changed",
			ref: change.ref,
			changeKind: change.kind,
			score: changeScore(change, entity, diff.focusedRef),
			signal: signalForChange(change, fields),
			...entityLabel(entity),
			fields,
			before: change.before,
			after: change.after,
		};
	});
	changedItems.sort((a, b) => b.score - a.score || a.signal.localeCompare(b.signal));
	const churn = diff.appeared.length || diff.disappeared.length
		? [{
			kind: "churn" as const,
			score: 0,
			signal: `appeared:${diff.appeared.length} disappeared:${diff.disappeared.length}`,
			appeared: diff.appeared.length,
			disappeared: diff.disappeared.length,
			sampleAppeared: diff.appeared.slice(0, 8),
			sampleDisappeared: diff.disappeared.slice(0, 8),
		}]
		: [];
	return {
		changed: diff.changed.length,
		appeared: diff.appeared.length,
		disappeared: diff.disappeared.length,
		...(diff.focusedRef ? { focusedRef: diff.focusedRef } : {}),
		items: [...changedItems.slice(0, 12), ...churn],
	};
}
