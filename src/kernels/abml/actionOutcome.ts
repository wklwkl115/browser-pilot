import type { Entity, EntityKind, EntityState } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { VerificationResult } from "./types.js";

// Pure semantic settlement over an already captured ABML before/after pair. The runtime owns
// fencing and stability; this kernel deliberately never turns page quiet or a mechanical ACK into
// success. A declared expectation may verify (or, on a stable explicit mismatch, fail). Undeclared,
// changing, and unavailable outcomes remain inconclusive while still exposing bounded page effects.

export const MAX_ACTION_OUTCOME_ENTITIES = 8;
export const MAX_ACTION_OUTCOME_FEEDBACK = 4;
export const MAX_ACTION_OUTCOME_TEXT_CHARS = 160;

export type ActionOutcomeStability = "stable" | "changing" | "unknown";

export type ActionOutcomeExpectation = {
	state?: Partial<EntityState>;
	name?: string;
	value?: string;
};

export type AbmlActionContext = {
	verb: string;
	targetRef?: string;
	expected?: ActionOutcomeExpectation;
};

export type ActionValueTransition = {
	before?: boolean | string;
	after?: boolean | string;
};

export type ActionTargetTransition = {
	ref: string;
	state?: Partial<Record<keyof EntityState, ActionValueTransition>>;
	name?: ActionValueTransition;
	value?: ActionValueTransition;
};

export type ActionEntitySummary = {
	ref: string;
	kind?: EntityKind;
	role?: string;
	name?: string;
	value?: string;
};

export type ActionFeedback = {
	ref: string;
	role: "alert" | "status";
	freshness: "appeared" | "updated";
	name?: string;
	value?: string;
	transition?: {
		state?: Partial<Record<"visible", ActionValueTransition>>;
		name?: ActionValueTransition;
		value?: ActionValueTransition;
	};
};

export type BoundedActionEntityBucket<T> = {
	count: number;
	items: T[];
	truncated?: true;
};

export type ActionSemanticEffect = {
	summary: {
		hasSemanticEffect: boolean;
		targetChanged: boolean;
		feedback: number;
		changed: number;
		appeared: number;
		disappeared: number;
	};
	target?: ActionTargetTransition;
	feedback: BoundedActionEntityBucket<ActionFeedback>;
	changed: BoundedActionEntityBucket<ActionEntitySummary>;
	appeared: BoundedActionEntityBucket<ActionEntitySummary>;
	disappeared: BoundedActionEntityBucket<ActionEntitySummary>;
};

export type BuildAbmlActionOutcomeInput = {
	action: AbmlActionContext;
	beforeEntities: readonly Entity[];
	afterEntities: readonly Entity[];
	diff: EntityDiff;
	stability: ActionOutcomeStability;
	elapsedMs?: number;
};

export type AbmlActionOutcome = {
	provider: "abml";
	effect: ActionSemanticEffect;
	verification: VerificationResult;
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

function boundedText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	if (!text) return undefined;
	if (text.length <= MAX_ACTION_OUTCOME_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_ACTION_OUTCOME_TEXT_CHARS - 1)}…`;
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function transitionValue(before: unknown, after: unknown): ActionValueTransition {
	return {
		...(typeof before === "boolean" || typeof before === "string" ? { before: typeof before === "string" ? boundedText(before) : before } : {}),
		...(typeof after === "boolean" || typeof after === "string" ? { after: typeof after === "string" ? boundedText(after) : after } : {}),
	};
}

function stateTransition(diff: EntityDiff, ref: string): ActionTargetTransition["state"] {
	const state: NonNullable<ActionTargetTransition["state"]> = {};
	for (const change of diff.changed) {
		if (change.ref !== ref || change.kind !== "state-changed") continue;
		const before = change.before ?? {};
		const after = change.after ?? {};
		for (const key of STATE_KEYS) {
			if (!hasOwn(before, key) && !hasOwn(after, key)) continue;
			state[key] = transitionValue((before as Partial<EntityState>)[key], (after as Partial<EntityState>)[key]);
		}
	}
	return Object.keys(state).length ? state : undefined;
}

function scalarTransition(diff: EntityDiff, ref: string, kind: "name-changed" | "value-changed", field: "name" | "value"): ActionValueTransition | undefined {
	const change = diff.changed.find((candidate) => candidate.ref === ref && candidate.kind === kind);
	if (!change) return undefined;
	const before = change.before ?? {};
	const after = change.after ?? {};
	return transitionValue((before as Record<string, unknown>)[field], (after as Record<string, unknown>)[field]);
}

function targetTransition(diff: EntityDiff, ref: string | undefined): ActionTargetTransition | undefined {
	if (!ref) return undefined;
	const state = stateTransition(diff, ref);
	const name = scalarTransition(diff, ref, "name-changed", "name");
	const value = scalarTransition(diff, ref, "value-changed", "value");
	if (!state && !name && !value) return undefined;
	return { ref, ...(state ? { state } : {}), ...(name ? { name } : {}), ...(value ? { value } : {}) };
}

function uniqueRefs(refs: readonly string[]): string[] {
	return Array.from(new Set(refs));
}

function entitySummary(ref: string, byRef: ReadonlyMap<string, Entity>): ActionEntitySummary {
	const entity = byRef.get(ref);
	if (!entity) return { ref };
	const role = boundedText(entity.role);
	const name = boundedText(entity.name);
	const value = boundedText(entity.value);
	return {
		ref,
		kind: entity.kind,
		...(role ? { role } : {}),
		...(name ? { name } : {}),
		...(value ? { value } : {}),
	};
}

function entityBucket(refs: readonly string[], entities: readonly Entity[]): BoundedActionEntityBucket<ActionEntitySummary> {
	const unique = uniqueRefs(refs);
	const byRef = new Map(entities.map((entity) => [entity.ref, entity]));
	return {
		count: unique.length,
		items: unique.slice(0, MAX_ACTION_OUTCOME_ENTITIES).map((ref) => entitySummary(ref, byRef)),
		...(unique.length > MAX_ACTION_OUTCOME_ENTITIES ? { truncated: true as const } : {}),
	};
}

function feedbackTransition(diff: EntityDiff, ref: string): ActionFeedback["transition"] | undefined {
	const name = scalarTransition(diff, ref, "name-changed", "name");
	const value = scalarTransition(diff, ref, "value-changed", "value");
	const targetState = stateTransition(diff, ref);
	const visible = targetState?.visible;
	if (!name && !value && !visible) return undefined;
	return {
		...(visible ? { state: { visible } } : {}),
		...(name ? { name } : {}),
		...(value ? { value } : {}),
	};
}

function feedbackItem(entity: Entity, diff: EntityDiff, appeared: ReadonlySet<string>): ActionFeedback | undefined {
	const role = entity.role.trim().toLowerCase();
	if ((role !== "alert" && role !== "status") || entity.state.visible !== true || entity.state.occluded === true) return undefined;
	const transition = feedbackTransition(diff, entity.ref);
	const freshness = appeared.has(entity.ref) ? "appeared" : transition ? "updated" : undefined;
	if (!freshness) return undefined;
	const name = boundedText(entity.name);
	const value = boundedText(entity.value);
	return {
		ref: entity.ref,
		role,
		freshness,
		...(name ? { name } : {}),
		...(value ? { value } : {}),
		...(freshness === "updated" && transition ? { transition } : {}),
	};
}

function feedbackBucket(diff: EntityDiff, afterEntities: readonly Entity[]): BoundedActionEntityBucket<ActionFeedback> {
	const appeared = new Set(diff.appeared);
	const seen = new Set<string>();
	const all: ActionFeedback[] = [];
	for (const entity of afterEntities) {
		if (seen.has(entity.ref)) continue;
		seen.add(entity.ref);
		const item = feedbackItem(entity, diff, appeared);
		if (item) all.push(item);
	}
	return {
		count: all.length,
		items: all.slice(0, MAX_ACTION_OUTCOME_FEEDBACK),
		...(all.length > MAX_ACTION_OUTCOME_FEEDBACK ? { truncated: true as const } : {}),
	};
}

export function deriveActionSemanticEffect(input: Pick<BuildAbmlActionOutcomeInput, "action" | "beforeEntities" | "afterEntities" | "diff">): ActionSemanticEffect {
	const target = targetTransition(input.diff, input.action.targetRef);
	const feedback = feedbackBucket(input.diff, input.afterEntities);
	const changed = entityBucket(input.diff.changed.map((change) => change.ref), input.afterEntities);
	const appeared = entityBucket(input.diff.appeared, input.afterEntities);
	const disappeared = entityBucket(input.diff.disappeared, input.beforeEntities);
	const hasSemanticEffect = Boolean(target) || feedback.count > 0 || changed.count > 0 || appeared.count > 0 || disappeared.count > 0;
	return {
		summary: {
			hasSemanticEffect,
			targetChanged: Boolean(target),
			feedback: feedback.count,
			changed: changed.count,
			appeared: appeared.count,
			disappeared: disappeared.count,
		},
		...(target ? { target } : {}),
		feedback,
		changed,
		appeared,
		disappeared,
	};
}

type ExpectedField = {
	path: string;
	expected: boolean | string;
	actual?: boolean | string;
};

function expectedFields(action: AbmlActionContext, target: Entity | undefined): ExpectedField[] {
	const fields: ExpectedField[] = [];
	const expected = action.expected;
	if (!expected) return fields;
	for (const key of STATE_KEYS) {
		const expectedValue = expected.state?.[key];
		if (typeof expectedValue !== "boolean" && typeof expectedValue !== "string") continue;
		const actualValue = target?.state[key];
		fields.push({
			path: `state.${key}`,
			expected: expectedValue,
			...(typeof actualValue === "boolean" || typeof actualValue === "string" ? { actual: actualValue } : {}),
		});
	}
	if (typeof expected.name === "string") fields.push({ path: "name", expected: expected.name, ...(typeof target?.name === "string" ? { actual: target.name } : {}) });
	if (typeof expected.value === "string") fields.push({ path: "value", expected: expected.value, ...(typeof target?.value === "string" ? { actual: target.value } : {}) });
	return fields;
}

function expectedRecord(action: AbmlActionContext, fields: readonly ExpectedField[]): Record<string, unknown> | undefined {
	if (!fields.length) return undefined;
	const state = Object.fromEntries(fields.filter((field) => field.path.startsWith("state.")).map((field) => [field.path.slice(6), field.expected]));
	const name = fields.find((field) => field.path === "name")?.expected;
	const value = fields.find((field) => field.path === "value")?.expected;
	return {
		...(action.targetRef ? { targetRef: action.targetRef } : {}),
		...(Object.keys(state).length ? { state } : {}),
		...(typeof name === "string" ? { name } : {}),
		...(typeof value === "string" ? { value } : {}),
	};
}

function verificationReason(input: BuildAbmlActionOutcomeInput, fields: readonly ExpectedField[], target: Entity | undefined, contradicted: readonly string[], unknown: readonly string[], hasEffect: boolean): string {
	if (!fields.length) return hasEffect ? "semantic_effect_without_expectation" : "no_semantic_effect";
	if (input.stability !== "stable") return "post_state_not_stable";
	if (!target) return "target_not_available";
	if (contradicted.length) return "expectation_contradicted";
	if (unknown.length) return "expectation_not_observable";
	return "expectation_matched";
}

function verificationStatus(reason: string): VerificationResult["status"] {
	if (reason === "expectation_matched") return "verified";
	if (reason === "expectation_contradicted") return "failed";
	return "inconclusive";
}

function effectEvidence(effect: ActionSemanticEffect): VerificationResult["evidence"] {
	const evidence: VerificationResult["evidence"] = [];
	if (effect.target) evidence.push({ kind: "target-transition", summary: "ABML observed a target semantic transition", ref: effect.target.ref, data: { ...effect.target } });
	for (const feedback of effect.feedback.items) {
		evidence.push({ kind: "live-region-feedback", summary: `ABML observed ${feedback.freshness} ${feedback.role} feedback`, ref: feedback.ref, data: { ...feedback } });
	}
	if (effect.changed.count) evidence.push({ kind: "entities-changed", summary: `ABML observed ${effect.changed.count} changed entities`, data: { count: effect.changed.count, refs: effect.changed.items.map((item) => item.ref), truncated: effect.changed.truncated === true } });
	if (effect.appeared.count) evidence.push({ kind: "entities-appeared", summary: `ABML observed ${effect.appeared.count} appeared entities`, data: { count: effect.appeared.count, refs: effect.appeared.items.map((item) => item.ref), truncated: effect.appeared.truncated === true } });
	if (effect.disappeared.count) evidence.push({ kind: "entities-disappeared", summary: `ABML observed ${effect.disappeared.count} disappeared entities`, data: { count: effect.disappeared.count, refs: effect.disappeared.items.map((item) => item.ref), truncated: effect.disappeared.truncated === true } });
	return evidence;
}

function elapsedMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.round(value);
}

export function buildAbmlActionOutcome(input: BuildAbmlActionOutcomeInput): AbmlActionOutcome {
	const effect = deriveActionSemanticEffect(input);
	const target = input.action.targetRef ? input.afterEntities.find((entity) => entity.ref === input.action.targetRef) : undefined;
	const fields = expectedFields(input.action, target);
	const matched = fields.filter((field) => field.actual !== undefined && field.actual === field.expected).map((field) => field.path);
	const contradicted = fields.filter((field) => field.actual !== undefined && field.actual !== field.expected).map((field) => field.path);
	const unknown = fields.filter((field) => field.actual === undefined).map((field) => field.path);
	const reason = verificationReason(input, fields, target, contradicted, unknown, effect.summary.hasSemanticEffect);
	const expected = expectedRecord(input.action, fields);
	const evidence = effectEvidence(effect);
	if (fields.length) {
		evidence.unshift({
			kind: "target-expectation",
			summary: `ABML target expectation is ${verificationStatus(reason)}`,
			...(input.action.targetRef ? { ref: input.action.targetRef } : {}),
			data: { stability: input.stability, matched, contradicted, unknown },
		});
	}
	return {
		provider: "abml",
		effect,
		verification: {
			status: verificationStatus(reason),
			verb: input.action.verb,
			...(expected ? { expected } : {}),
			observed: {
				stability: input.stability,
				reason,
				matched,
				contradicted,
				unknown,
				semanticEffect: effect.summary,
			},
			evidence,
			elapsedMs: elapsedMs(input.elapsedMs),
		},
	};
}
