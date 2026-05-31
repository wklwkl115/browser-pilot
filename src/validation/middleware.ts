import { z } from 'zod';
import { BrowserBridgeError } from '../driver/errors.js';

/**
 * Validation middleware for runtime type checking.
 * Provides type-safe parameter validation with detailed error messages.
 */

/**
 * Validates parameters against a Zod schema.
 * Throws BrowserBridgeError with INVALID_PARAMS code on validation failure.
 *
 * @param schema - Zod schema to validate against
 * @param params - Parameters to validate
 * @returns Validated and typed parameters
 * @throws {BrowserBridgeError} When validation fails
 *
 * @example
 * ```typescript
 * const validated = validateParams(BridgeCommandSchema, params.command);
 * // validated is now type-safe and guaranteed to match the schema
 * ```
 */
export function validateParams<T>(
	schema: z.ZodSchema<T>,
	params: unknown
): T {
	const result = schema.safeParse(params);

	if (!result.success) {
		// Format validation errors into a readable message
		const errors = result.error.issues.map(e => {
			const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
			return `${path}${e.message}`;
		}).join('; ');

		throw new BrowserBridgeError(
			'INVALID_BROWSER_COMMAND',
			`Parameter validation failed: ${errors}`,
			{
				validationErrors: result.error.issues,
				received: params,
			}
		);
	}

	return result.data;
}

/**
 * Type-safe alternative to the unsafe recordValue<T>() utility.
 * Validates that a value matches the expected schema before casting.
 *
 * @param value - Value to validate and cast
 * @param schema - Zod schema defining the expected type
 * @returns Validated and typed value
 * @throws {BrowserBridgeError} When validation fails
 *
 * @example
 * ```typescript
 * // Instead of: const cmd = recordValue<BridgeCommand>(obj);
 * // Use: const cmd = safeRecordValue(obj, BridgeCommandSchema);
 * ```
 */
export function safeRecordValue<T>(
	value: unknown,
	schema: z.ZodSchema<T>
): T {
	return validateParams(schema, value);
}

/**
 * Validates an optional parameter.
 * Returns undefined if the parameter is null, undefined, or empty string.
 * Otherwise validates against the schema.
 *
 * @param schema - Zod schema to validate against
 * @param params - Optional parameters to validate
 * @returns Validated parameters or undefined
 * @throws {BrowserBridgeError} When validation fails
 */
export function validateOptionalParams<T>(
	schema: z.ZodSchema<T>,
	params: unknown
): T | undefined {
	if (params === null || params === undefined || params === '') {
		return undefined;
	}
	return validateParams(schema, params);
}

/**
 * Validates an array of items against a schema.
 * Collects all validation errors and throws a single error with all failures.
 *
 * @param schema - Zod schema for individual items
 * @param items - Array of items to validate
 * @returns Array of validated items
 * @throws {BrowserBridgeError} When any validation fails
 */
export function validateArray<T>(
	schema: z.ZodSchema<T>,
	items: unknown[]
): T[] {
	const errors: Array<{ index: number; error: string }> = [];
	const validated: T[] = [];

	for (let i = 0; i < items.length; i++) {
		const result = schema.safeParse(items[i]);
		if (result.success) {
			validated.push(result.data);
		} else {
			const errorMsg = result.error.issues.map(e => e.message).join('; ');
			errors.push({ index: i, error: errorMsg });
		}
	}

	if (errors.length > 0) {
		const errorMsg = errors.map(e => `[${e.index}]: ${e.error}`).join('; ');
		throw new BrowserBridgeError(
			'INVALID_BROWSER_COMMAND',
			`Array validation failed: ${errorMsg}`,
			{
				validationErrors: errors,
				received: items,
			}
		);
	}

	return validated;
}

/**
 * Creates a validation function with a pre-bound schema.
 * Useful for creating reusable validators.
 *
 * @param schema - Zod schema to bind
 * @returns Validation function
 *
 * @example
 * ```typescript
 * const validateCommand = createValidator(BridgeCommandSchema);
 * const cmd = validateCommand(params.command);
 * ```
 */
export function createValidator<T>(
	schema: z.ZodSchema<T>
): (params: unknown) => T {
	return (params: unknown) => validateParams(schema, params);
}

/**
 * Validates parameters with a custom error message.
 *
 * @param schema - Zod schema to validate against
 * @param params - Parameters to validate
 * @param errorMessage - Custom error message prefix
 * @returns Validated parameters
 * @throws {BrowserBridgeError} When validation fails
 */
export function validateParamsWithMessage<T>(
	schema: z.ZodSchema<T>,
	params: unknown,
	errorMessage: string
): T {
	const result = schema.safeParse(params);

	if (!result.success) {
		const errors = result.error.issues.map(e => {
			const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
			return `${path}${e.message}`;
		}).join('; ');

		throw new BrowserBridgeError(
			'INVALID_BROWSER_COMMAND',
			`${errorMessage}: ${errors}`,
			{
				validationErrors: result.error.issues,
				received: params,
			}
		);
	}

	return result.data;
}

/**
 * Type guard that checks if a value matches a schema without throwing.
 *
 * @param schema - Zod schema to check against
 * @param value - Value to check
 * @returns True if value matches schema
 */
export function isValidParams<T>(
	schema: z.ZodSchema<T>,
	value: unknown
): value is T {
	return schema.safeParse(value).success;
}

/**
 * Attempts to validate parameters, returning a result object instead of throwing.
 *
 * @param schema - Zod schema to validate against
 * @param params - Parameters to validate
 * @returns Result object with success flag and data or error
 */
export function tryValidateParams<T>(
	schema: z.ZodSchema<T>,
	params: unknown
): { success: true; data: T } | { success: false; error: string; details: unknown } {
	const result = schema.safeParse(params);

	if (result.success) {
		return { success: true, data: result.data };
	}

	const errors = result.error.issues.map(e => {
		const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
		return `${path}${e.message}`;
	}).join('; ');

	return {
		success: false,
		error: errors,
		details: result.error.issues,
	};
}
