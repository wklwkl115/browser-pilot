import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AbmlStateExpectation } from "../kernels/abml/verification.js";
import { BrowserBridgeError } from "../utils/errors.js";

const ref = Type.String({ pattern: "^bp-ref://", maxLength: 512 });
const shortText = Type.String({ maxLength: 2048 });
const matchSchema = Type.Union([
	Type.Object({ equals: shortText }, { additionalProperties: false }),
	Type.Object({ contains: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
]);

export const stateExpectationSchema = Type.Object(
	{
		ref,
		state: Type.Object(
			{
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
			},
			{ additionalProperties: false, minProperties: 1 },
		),
	},
	{
		additionalProperties: false,
		description: "Assert the observed ref's state; verified means this assertion holds, not business success.",
	},
);

export type TextMatch = { equals: string } | { contains: string };
export type JsonFieldCondition = { pointer: string; equals: string | number | boolean | null };
export type RequestCondition = {
	url: string;
	method: string;
	requestId?: string;
	status: number;
	json?: JsonFieldCondition[];
};
export type DeclarativeCondition =
	| AbmlStateExpectation
	| { text: { selector: string; match: TextMatch } }
	| { value: { selector: string; equals: string } }
	| { url: TextMatch }
	| { request: RequestCondition }
	| { allOf: DeclarativeCondition[] }
	| { anyOf: DeclarativeCondition[] };
export type BusinessConditions = { success?: DeclarativeCondition; failure?: DeclarativeCondition };

const leafSchema = Type.Union([
	stateExpectationSchema,
	Type.Object(
		{ text: Type.Object({ selector: shortText, match: matchSchema }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ value: Type.Object({ selector: shortText, equals: shortText }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
	Type.Object({ url: matchSchema }, { additionalProperties: false }),
	Type.Object(
		{
			request: Type.Object(
				{
					url: Type.String({
						minLength: 1,
						maxLength: 2048,
						description:
							"Exact request URL, preferably containing a unique business identifier. Requires a recorder started before the write.",
					}),
					method: Type.String({ pattern: "^[A-Z]+$", maxLength: 16 }),
					requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
					status: Type.Integer({ minimum: 100, maximum: 599 }),
					json: Type.Optional(
						Type.Array(
							Type.Object(
								{
									pointer: Type.String({
										maxLength: 512,
										pattern: "^(?:/.*)?$",
										description:
											"JSON Pointer into a complete captured response body; e.g. /record/id.",
									}),
									equals: Type.Union([
										Type.String({ maxLength: 2048 }),
										Type.Number(),
										Type.Boolean(),
										Type.Null(),
									]),
								},
								{ additionalProperties: false },
							),
							{ minItems: 1, maxItems: 16 },
						),
					),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
]);

function conditionGroup(child: TSchema): TSchema {
	const children = Type.Array(child, { minItems: 1, maxItems: 8 });
	return Type.Union([
		Type.Ref("#/$defs/conditionLeaf"),
		Type.Object({ allOf: children }, { additionalProperties: false }),
		Type.Object({ anyOf: children }, { additionalProperties: false }),
	]);
}

// Root-local definitions keep bounded trees compact without duplicating the leaf catalog at every branch.
export const CONDITION_DEFINITIONS = {
	conditionLeaf: leafSchema,
	conditionLevel1: conditionGroup(Type.Ref("#/$defs/conditionLeaf")),
	conditionLevel2: conditionGroup(Type.Ref("#/$defs/conditionLevel1")),
};
export const declarativeConditionInputSchema = Type.Ref("#/$defs/conditionLevel2");
export const declarativeConditionSchema = Type.Ref("#/$defs/conditionLevel2", { $defs: CONDITION_DEFINITIONS });
export const businessConditionsInputSchema = Type.Object(
	{
		success: Type.Optional(declarativeConditionInputSchema),
		failure: Type.Optional(declarativeConditionInputSchema),
	},
	{
		additionalProperties: false,
		minProperties: 1,
		description:
			"Explicit business evidence conditions. Unmet assertions do not imply failure; absent conditions leave business outcome unknown.",
	},
);
export const businessConditionsSchema = { ...businessConditionsInputSchema, $defs: CONDITION_DEFINITIONS };

export const verificationWaitSchema = Type.Integer({
	minimum: 100,
	maximum: 45_000,
	description:
		"Bounded assertion/business observation budget in milliseconds (default 5000). Does not retry the write.",
});

export function isDeclarativeCondition(value: unknown): value is DeclarativeCondition {
	return Value.Check(declarativeConditionSchema, value);
}

export function prepareBusinessConditions(value: unknown): BusinessConditions | undefined {
	if (value === undefined) return undefined;
	if (!Value.Check(businessConditionsSchema, value))
		throw new BrowserBridgeError(
			"INVALID_RULE",
			"business requires a bounded declarative success or failure condition",
		);
	return value as BusinessConditions;
}

export function prepareVerificationWait(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 45_000)
		throw new BrowserBridgeError("INVALID_RULE", "verificationWaitMs must be an integer from 100 to 45000");
	return value;
}

export function conditionRefs(condition: DeclarativeCondition): string[] {
	if ("ref" in condition) return [condition.ref];
	if ("allOf" in condition) return condition.allOf.flatMap(conditionRefs);
	if ("anyOf" in condition) return condition.anyOf.flatMap(conditionRefs);
	return [];
}

export function hasRequestCondition(condition: DeclarativeCondition): boolean {
	if ("request" in condition) return true;
	if ("allOf" in condition) return condition.allOf.some(hasRequestCondition);
	if ("anyOf" in condition) return condition.anyOf.some(hasRequestCondition);
	return false;
}
