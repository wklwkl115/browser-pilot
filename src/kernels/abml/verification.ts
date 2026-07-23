import type { Entity, EntityState } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import { diffEntities } from "./diff.js";
import type { VerificationResult, VerificationStatus } from "./types.js";

const BOOLEAN_STATE_KEYS = ["visible", "occluded", "disabled", "focused", "checked", "selected", "pressed", "expanded", "editable", "inViewport"] as const;
const EXPECTATION_KEYS = new Set(["ref", "state"]);
const STATE_KEYS = new Set<string>([...BOOLEAN_STATE_KEYS, "current"]);

export type AbmlStateExpectation = {
	ref: string;
	state: Partial<EntityState>;
};

export type AbmlVerificationObservation = {
	entity?: Entity;
	sources?: string[];
	reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAbmlStateExpectation(value: unknown): value is AbmlStateExpectation {
	if (!isRecord(value) || Object.keys(value).some((key) => !EXPECTATION_KEYS.has(key))) return false;
	if (typeof value.ref !== "string" || !value.ref.startsWith("bp-ref://")) return false;
	if (!isRecord(value.state) || Object.keys(value.state).length === 0) return false;
	for (const [key, item] of Object.entries(value.state)) {
		if (!STATE_KEYS.has(key)) return false;
		if (key === "current" ? typeof item !== "boolean" && typeof item !== "string" : typeof item !== "boolean") return false;
	}
	return true;
}

function expectedRecord(expectation: AbmlStateExpectation): Record<string, unknown> {
	return {
		ref: expectation.ref,
		state: expectation.state,
	};
}

function observedRecord(entity: Entity | undefined): Record<string, unknown> {
	if (!entity) return {};
	return {
		ref: entity.ref,
		state: entity.state,
	};
}

function expectationComparison(expectation: AbmlStateExpectation, entity: Entity): { missing: string[]; mismatched: string[] } {
	const missing: string[] = [];
	const mismatched: string[] = [];
	for (const [key, expected] of Object.entries(expectation.state)) {
		const observed = (entity.state as Record<string, unknown>)[key];
		if (observed === undefined) missing.push(`state.${key}`);
		else if (observed !== expected) mismatched.push(`state.${key}`);
	}
	return { missing, mismatched };
}

export function verifyAbmlState(
	verb: string,
	expectation: AbmlStateExpectation,
	observation: AbmlVerificationObservation,
	elapsedMs: number,
): VerificationResult {
	const entity = observation.entity;
	const comparison = entity ? expectationComparison(expectation, entity) : { missing: [], mismatched: [] };
	const status: VerificationStatus = comparison.mismatched.length
		? "unmet"
		: !entity || comparison.missing.length
			? "inconclusive"
			: "verified";
	const summary = status === "verified"
		? "ABML postcondition observed"
		: status === "unmet"
			? `ABML postcondition unmet: ${comparison.mismatched.join(", ")}`
			: observation.reason || `ABML state unavailable${comparison.missing.length ? `: ${comparison.missing.join(", ")}` : ""}`;
	return {
		status,
		verb,
		expected: expectedRecord(expectation),
		observed: observedRecord(entity),
		evidence: [{
			kind: "abml-state",
			summary,
			ref: expectation.ref,
			data: {
				...(observation.sources?.length ? { sources: observation.sources } : {}),
				...(comparison.missing.length ? { missing: comparison.missing } : {}),
				...(comparison.mismatched.length ? { mismatched: comparison.mismatched } : {}),
			},
		}],
		elapsedMs: Math.max(0, Math.round(elapsedMs)),
	};
}

export function verificationDiff(before: Entity | undefined, after: Entity | undefined): EntityDiff | undefined {
	return before && after ? diffEntities([before], [after], { partialBaseline: true }) : undefined;
}
