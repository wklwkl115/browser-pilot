/**
 * Program Op Registry — discriminator-based dispatch for browser_execute program-frame elements.
 *
 * Each op has exactly one discriminator field. The dispatcher extracts universal
 * modifiers (delay), finds the single discriminator, then validates the element
 * against the op's strict TypeBox schema (additionalProperties: false).
 */
import { Type, type TSchema } from "typebox";

/** Closed set of discriminator fields. Exactly one must be present per element. */
export const PROGRAM_OP_DISCRIMINATORS = ["eval", "mouse", "key", "text", "wait"] as const;
export type ProgramOpDiscriminator = typeof PROGRAM_OP_DISCRIMINATORS[number];

/** Universal modifiers extracted before dispatch. Not discriminators. */
export const PROGRAM_MODIFIERS = ["delay"] as const;

// ── Element Schemas (additionalProperties: false) ──────────────────────────

const EvalSchema = Type.Object({
	eval: Type.String({ description: "JavaScript expression to evaluate." }),
	as: Type.Optional(Type.String({ description: "Name to bind the result to in program context for later refFrom." })),
	expand: Type.Optional(Type.Boolean({ description: "If true, result must be an array; elements are spliced into the program as new frames." })),
	verify: Type.Optional(Type.Boolean({ description: "Mark this final eval as the explicit transaction postcondition. It passes only when the result is true or an object with verified:true." })),
	frameId: Type.Optional(Type.String({ description: "Frame to evaluate in. Default: main frame." })),
}, { additionalProperties: false });

const MouseSchema = Type.Object({
	mouse: Type.Union([
		Type.Literal("move"), Type.Literal("press"),
		Type.Literal("release"), Type.Literal("wheel"), Type.Literal("drag"),
	], { description: "move | press | release | wheel | drag. drag emits a trusted press → interpolated moves → release from the start point to toRef/toX,toY." }),
	ref: Type.Optional(Type.String({ description: "bp-ref:// start point to resolve. Bridge resolves at dispatch time." })),
	refFrom: Type.Optional(Type.String({ description: "Context variable name from a prior eval 'as' binding (start point)." })),
	anchor: Type.Optional(Type.Union([
		Type.Literal("center"), Type.Literal("topLeft"), Type.Literal("bottomRight"),
	])),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	toRef: Type.Optional(Type.String({ description: "drag only: bp-ref:// end point. Bridge resolves at dispatch time." })),
	toX: Type.Optional(Type.Number({ description: "drag only: end X (used when toRef is omitted)." })),
	toY: Type.Optional(Type.Number({ description: "drag only: end Y (used when toRef is omitted)." })),
	button: Type.Optional(Type.Union([
		Type.Literal("left"), Type.Literal("right"), Type.Literal("middle"),
	])),
	dx: Type.Optional(Type.Number()),
	dy: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const KeySchema = Type.Object({
	key: Type.Union([Type.Literal("down"), Type.Literal("up")]),
	code: Type.String({ description: "KeyboardEvent.code, e.g. Enter, Tab, Escape, ArrowDown, KeyC, Digit5, ShiftLeft. For typing free text prefer the `text` op; use key for special keys and combos (hold ShiftLeft/ControlLeft down, press the letter, release)." }),
	modifiers: Type.Optional(Type.Array(Type.Union([
		Type.Literal("ctrl"), Type.Literal("shift"), Type.Literal("alt"), Type.Literal("meta"),
	]))),
}, { additionalProperties: false });

const TextSchema = Type.Object({
	text: Type.String({ description: "Text to insert as a batch via Input.insertText." }),
}, { additionalProperties: false });

const WaitSchema = Type.Object({
	wait: Type.Number({ description: "Milliseconds to wait for DOM to settle (MutationObserver-based)." }),
}, { additionalProperties: false });

// ── Op Spec ────────────────────────────────────────────────────────────────

export type ProgramOpSpec = {
	discriminator: ProgramOpDiscriminator;
	schema: TSchema;
	requiredAny?: string[][];
};

export const PROGRAM_OP_REGISTRY: Record<ProgramOpDiscriminator, ProgramOpSpec> = {
	eval: {
		discriminator: "eval",
		schema: EvalSchema,
	},
	mouse: {
		discriminator: "mouse",
		schema: MouseSchema,
		requiredAny: [
			["ref"],
			["refFrom"],
			["x", "y"],
		],
	},
	key: {
		discriminator: "key",
		schema: KeySchema,
	},
	text: {
		discriminator: "text",
		schema: TextSchema,
	},
	wait: {
		discriminator: "wait",
		schema: WaitSchema,
	},
};

// ── Startup self-check ─────────────────────────────────────────────────────

let registryValidated = false;

/**
 * Validates the op registry for ambiguity at module load time.
 * Ensures: discriminators unique, schemas reject unknown fields, no cross-contamination.
 */
export function validateOpRegistry(): void {
	if (registryValidated) return;
	const seen = new Set<string>();
	for (const [name, spec] of Object.entries(PROGRAM_OP_REGISTRY)) {
		if (spec.discriminator !== name) {
			throw new Error(`ProgramOpRegistry: op "${name}" discriminator mismatch (got "${spec.discriminator}")`);
		}
		if (seen.has(name)) {
			throw new Error(`ProgramOpRegistry: duplicate discriminator "${name}"`);
		}
		seen.add(name);
		// Schema must reject unknown fields
		const opts = (spec.schema as unknown as { additionalProperties?: unknown }).additionalProperties;
		if (opts !== false) {
			throw new Error(`ProgramOpRegistry: op "${name}" schema must have additionalProperties: false`);
		}
		// No op schema may include another op's discriminator as a property
		const props = (spec.schema as unknown as { properties?: Record<string, unknown> }).properties ?? {};
		for (const other of PROGRAM_OP_DISCRIMINATORS) {
			if (other !== name && props[other] !== undefined) {
				throw new Error(`ProgramOpRegistry: op "${name}" schema includes foreign discriminator "${other}"`);
			}
		}
		// No op schema may include a universal modifier
		for (const mod of PROGRAM_MODIFIERS) {
			if (props[mod] !== undefined) {
				throw new Error(`ProgramOpRegistry: op "${name}" schema includes modifier "${mod}" — modifiers are extracted before dispatch`);
			}
		}
	}
	registryValidated = true;
}

// Run validation eagerly on module load
validateOpRegistry();
