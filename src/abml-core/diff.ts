import type { Entity, EntityState } from "./entity.js";

export type EntityChangeKind = "appeared" | "disappeared" | "state-changed" | "name-changed";

export type EntityNameChange = { name?: string };

export type EntityChange = {
	ref: string;
	kind: EntityChangeKind;
	before?: Partial<EntityState> | EntityNameChange;
	after?: Partial<EntityState> | EntityNameChange;
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
	}

	for (const entity of before) {
		if (!afterByRef.has(entity.ref)) disappeared.push(entity.ref);
	}

	const focusedRef = after.find((entity) => entity.state.focused === true)?.ref;
	return { appeared, disappeared, changed, ...(focusedRef ? { focusedRef } : {}) };
}
