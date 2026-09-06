import type { EntityAction, EntityState } from "./entity.js";

export type TaskViewSpec = {
	focus: { refs: string[] } | { query: string };
	intent?: "locate" | "read" | "interact" | "check";
	fields?: string[];
};
export type NormalizedTaskViewSpec = TaskViewSpec & { intent: NonNullable<TaskViewSpec["intent"]>; fields: string[] };
export type ObserveView = "page" | TaskViewSpec;

export type TaskFact = {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	text?: string;
	textSource?: "ax";
	state: EntityState;
	actions?: EntityAction[];
	source: "dom" | "ax" | "vision";
};
export type TaskMatch = {
	ref?: string;
	field: "name" | "value" | "label" | "content";
	text: string;
	kind: "exact" | "contains";
};
export type DecisionBundle = {
	id: string;
	kind: "record" | "field" | "dialog" | "feedback" | "context" | "content";
	anchor: { ref?: string; role?: string; name?: string };
	candidate: boolean;
	mandatory: boolean;
	reasons: string[];
	facts: TaskFact[];
	matches: TaskMatch[];
	gaps: string[];
	text?: string;
	changes: Array<{ ref: string; kind: string; fields: string[] }>;
};
export type TaskViewMetadata = {
	intent: NormalizedTaskViewSpec["intent"];
	focus: NormalizedTaskViewSpec["focus"];
	fields: string[];
	status: "resolved" | "ambiguous" | "no-match-in-observed" | "unresolved";
	unresolvedRefs: string[];
	observationScope: {
		entitiesObserved: number;
		contentComplete: boolean;
		actionsComplete: boolean;
		selectionComplete: boolean;
		collectionCount: number;
		partialCollectionCount: number;
		collections: Array<{ ref: string; name?: string; observed: number; total?: number; completeness: string }>;
	};
	matchScope: {
		method: "explicit-refs" | "literal-case-insensitive";
		unit: "structural-object-or-entity";
		candidateCount: number;
		contentMatchCount: number;
		searched: string[];
		complete: boolean;
	};
	outputScope: {
		groupsTotal: number;
		groupsInline: number;
		groupsFolded: number;
		mandatoryGroups: number;
		mandatoryGroupsFolded: number;
		contextComplete: boolean;
	};
	limitations: string[];
};
export type TaskProjectionPlan = { task: TaskViewMetadata; bundles: DecisionBundle[] };

export const TASK_PROJECTION_SCHEMA = "browser-task-projection/v1" as const;
export const TASK_PROJECTION_POLICY = "literal-context-v1" as const;
export type TaskProjectionArtifact = TaskProjectionPlan & {
	schema: typeof TASK_PROJECTION_SCHEMA;
	policy: typeof TASK_PROJECTION_POLICY;
	snapshotId: string;
	canonicalSha256: string;
	capturedAt: number;
	expiresAt: number;
	spec: NormalizedTaskViewSpec;
};

/** Literal retrieval only: no synonyms, language detection, dates or business rules. */
export function normalizeTaskText(value: string): string {
	return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
