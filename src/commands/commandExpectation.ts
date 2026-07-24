import { Type } from "typebox";
import { isAbmlStateExpectation, type AbmlStateExpectation } from "../kernels/abml/verification.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import { BrowserBridgeError } from "../utils/errors.js";

const stateProperties = {
	visible: Type.Optional(Type.Boolean()),
	occluded: Type.Optional(Type.Boolean()),
	disabled: Type.Optional(Type.Boolean()),
	focused: Type.Optional(Type.Boolean()),
	checked: Type.Optional(Type.Boolean()),
	selected: Type.Optional(Type.Boolean()),
	pressed: Type.Optional(Type.Boolean()),
	expanded: Type.Optional(Type.Boolean()),
	current: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
	editable: Type.Optional(Type.Boolean()),
	inViewport: Type.Optional(Type.Boolean()),
};

export const commandExpectationSchema = Type.Union([
	Type.String({ minLength: 1, description: "JavaScript truth expression returning truthy when the intended state is reached." }),
	Type.Object({
		ref: Type.String({ pattern: "^bp-ref://", description: "Observed entity whose state is the business postcondition." }),
		state: Type.Object(stateProperties, { additionalProperties: false, minProperties: 1 }),
	}, { additionalProperties: false, description: "Structured postcondition verified from the target's observed state." }),
]);

export type PreparedCommandExpectation =
	| { kind: "javascript"; expression: string }
	| { kind: "abml"; expectation: AbmlStateExpectation };

export function prepareCommandExpectation(value: unknown, commandName: string): PreparedCommandExpectation | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && value.trim()) return { kind: "javascript", expression: value.trim() };
	if (isAbmlStateExpectation(value)) return { kind: "abml", expectation: value };
	throw new BrowserBridgeError("INVALID_RULE", `${commandName} expect must be a non-empty JavaScript expression or structured ref/state postcondition`, { commandName });
}

export function javascriptVerificationResult(verb: string, observed?: boolean): VerificationResult {
	return {
		status: observed === undefined ? "inconclusive" : observed ? "verified" : "unmet",
		verb,
		expected: { javascript: true },
		observed: observed === undefined ? {} : { value: observed },
		evidence: [{ kind: "javascript-postcondition", summary: observed === undefined ? "JavaScript postcondition was not observed" : observed ? "JavaScript postcondition observed" : "JavaScript postcondition unmet" }],
		elapsedMs: 0,
	};
}
