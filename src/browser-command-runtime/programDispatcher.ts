/**
 * Program Dispatcher — three-layer deterministic dispatch for program elements.
 *
 * Layer 1: Registry self-check (run at module load in programOps.ts)
 * Layer 2: Discriminator counting — exactly one discriminator per element
 * Layer 3: Strict schema validation — additionalProperties: false catches typos
 *
 * Reuses the same requiredAnySatisfied helper from nativeProtocol.ts to avoid
 * duplicating the conditional-field validation logic.
 */
import { validateCommandArgs } from "../validation/commandArgs.js";
import { requiredAnySatisfied } from "../types/nativeProtocol.js";
import {
	PROGRAM_OP_DISCRIMINATORS,
	PROGRAM_MODIFIERS,
	PROGRAM_OP_REGISTRY,
	type ProgramOpSpec,
	type ProgramOpDiscriminator,
} from "./programOps.js";
import { isRecord } from "../utils/records.js";

export type DispatchResult =
	| { ok: true; op: ProgramOpSpec; discriminator: ProgramOpDiscriminator; element: Record<string, unknown>; modifiers: Record<string, unknown> }
	| { ok: false; error: string; step: number };

/**
 * Dispatch a single program element through the three-layer validation pipeline.
 *
 * @param element - The raw program element (unknown from JSON)
 * @param step - Step index for error reporting
 * @returns DispatchResult with op spec + validated element, or error
 */
export function dispatchProgramElement(element: unknown, step: number): DispatchResult {
	if (!isRecord(element)) {
		return { ok: false, error: `Step ${step}: element must be an object, got ${typeof element}`, step };
	}

	// Extract universal modifiers (delay) — these are not discriminators
	const modifiers: Record<string, unknown> = {};
	const remaining: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(element)) {
		if ((PROGRAM_MODIFIERS as readonly string[]).includes(k)) {
			modifiers[k] = v;
		} else {
			remaining[k] = v;
		}
	}

	// Layer 2: Count discriminators — exactly one required
	const presentOps = PROGRAM_OP_DISCRIMINATORS.filter((d) => remaining[d] !== undefined);
	if (presentOps.length === 0) {
		const keys = Object.keys(remaining);
		return {
			ok: false,
			error: `Step ${step}: no discriminator found. Expected one of [${PROGRAM_OP_DISCRIMINATORS.join(", ")}], got fields: [${keys.join(", ")}]`,
			step,
		};
	}
	if (presentOps.length > 1) {
		return {
			ok: false,
			error: `Step ${step}: multiple discriminators [${presentOps.join(", ")}] — exactly one required`,
			step,
		};
	}

	const discriminator = presentOps[0];
	const op = PROGRAM_OP_REGISTRY[discriminator];

	// Layer 3: Strict schema validation (additionalProperties: false catches typos)
	const validation = validateCommandArgs(op.schema, remaining);
	if (!validation.ok) {
		return { ok: false, error: `Step ${step} (${discriminator}): ${validation.error}`, step };
	}

	// Conditional required (requiredAny) check — reuses existing shared helper
	if (op.requiredAny && !requiredAnySatisfied(validation.args, op.requiredAny)) {
		return {
			ok: false,
			error: `Step ${step} (${discriminator}): requires one of field groups ${JSON.stringify(op.requiredAny)}`,
			step,
		};
	}

	return { ok: true, op, discriminator, element: validation.args, modifiers };
}

/**
 * Pre-dispatch validation: validate all elements in a program without executing.
 * Returns the first error encountered, or null if all elements are valid.
 */
export function validateProgram(program: unknown[]): { ok: true } | { ok: false; error: string; step: number } {
	for (let i = 0; i < program.length; i++) {
		const result = dispatchProgramElement(program[i], i);
		if (!result.ok) return result;
	}
	return { ok: true };
}
