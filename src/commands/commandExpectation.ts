import { Type } from "typebox";
import { isAbmlStateExpectation, type AbmlStateExpectation } from "../kernels/abml/verification.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import { BrowserBridgeError } from "../utils/errors.js";
import {
	declarativeConditionInputSchema,
	isDeclarativeCondition,
	conditionRefs,
	type DeclarativeCondition,
	type BusinessConditions,
} from "../operations/conditionSchema.js";

export const commandExpectationSchema = Type.Union([
	Type.String({
		minLength: 1,
		description: "Read-only JavaScript truth expression. verified means the assertion holds, not business success.",
	}),
	declarativeConditionInputSchema,
]);

export type PreparedCommandExpectation =
	| { kind: "javascript"; expression: string }
	| { kind: "abml"; expectation: AbmlStateExpectation }
	| { kind: "declarative"; condition: DeclarativeCondition };

export function verificationRefs(expect?: PreparedCommandExpectation, business?: BusinessConditions): string[] {
	const condition =
		expect?.kind === "abml" ? expect.expectation : expect?.kind === "declarative" ? expect.condition : undefined;
	return [
		...new Set(
			[condition, business?.success, business?.failure].flatMap((item) => (item ? conditionRefs(item) : [])),
		),
	];
}

export function prepareCommandExpectation(value: unknown, commandName: string): PreparedCommandExpectation | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.trim()) return { kind: "javascript", expression: value.trim() };
	if (isAbmlStateExpectation(value)) return { kind: "abml", expectation: value };
	if (isDeclarativeCondition(value)) return { kind: "declarative", condition: value };
	throw new BrowserBridgeError(
		"INVALID_RULE",
		`${commandName} expect must be a non-empty read-only JavaScript expression or declarative condition`,
		{ commandName },
	);
}

export function javascriptVerificationResult(verb: string, observed?: boolean): VerificationResult {
	return {
		status: observed === undefined ? "inconclusive" : observed ? "verified" : "unmet",
		verb,
		expected: { javascript: true },
		observed: observed === undefined ? {} : { value: observed },
		evidence: [
			{
				kind: "javascript-postcondition",
				summary:
					observed === undefined
						? "JavaScript postcondition was not observed"
						: observed
							? "JavaScript postcondition observed"
							: "JavaScript postcondition unmet",
			},
		],
		elapsedMs: 0,
	};
}
