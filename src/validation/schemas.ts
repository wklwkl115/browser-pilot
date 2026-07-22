import { createSchema, Type } from "./typeboxCompat.js";

/**
 * Validation schemas for runtime type checking.
 * These use TypeBox internally and expose the small safeParse surface consumed by
 * existing tool validators.
 */

export type ValidatedBridgeCommand = {
	cmd: string;
	method?: string;
	action?: string;
	params?: Record<string, unknown>;
	cdpMethod?: string;
	cdpParams?: Record<string, unknown>;
	[key: string]: unknown;
};

export const BridgeCommandSchema = createSchema<ValidatedBridgeCommand>(Type.Object({
	cmd: Type.String({ minLength: 1 }),
	method: Type.Optional(Type.String()),
	action: Type.Optional(Type.String()),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	cdpMethod: Type.Optional(Type.String()),
	cdpParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: true }));
