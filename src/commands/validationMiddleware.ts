import { BrowserBridgeError } from "../utils/errors.js";
import type { ValidationSchema } from "../validation/typeboxCompat.js";

type ValidationFailureDetails = {
	validationErrors: unknown;
	received: unknown;
};

function formatIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
	return issues.map((issue) => {
		const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
		return `${path}${issue.message}`;
	}).join("; ");
}

function validationError(message: string, details: ValidationFailureDetails): BrowserBridgeError {
	return new BrowserBridgeError("INVALID_BROWSER_COMMAND", message, details);
}

export function validateParams<T>(
	schema: ValidationSchema<T>,
	params: unknown,
): T {
	const result = schema.safeParse(params);
	if (!result.success) {
		throw validationError(`Parameter validation failed: ${formatIssues(result.error.issues)}`, {
			validationErrors: result.error.issues,
			received: params,
		});
	}
	return result.data;
}

export function safeRecordValue<T>(
	value: unknown,
	schema: ValidationSchema<T>,
): T {
	return validateParams(schema, value);
}

export function validateOptionalParams<T>(
	schema: ValidationSchema<T>,
	params: unknown,
): T | undefined {
	if (params === null || params === undefined || params === "") return undefined;
	return validateParams(schema, params);
}

export function validateArray<T>(
	schema: ValidationSchema<T>,
	items: unknown[],
): T[] {
	const errors: Array<{ index: number; error: string }> = [];
	const validated: T[] = [];

	for (let i = 0; i < items.length; i++) {
		const result = schema.safeParse(items[i]);
		if (result.success) {
			validated.push(result.data);
		} else {
			errors.push({ index: i, error: result.error.issues.map((issue) => issue.message).join("; ") });
		}
	}

	if (errors.length > 0) {
		throw validationError(`Array validation failed: ${errors.map((error) => `[${error.index}]: ${error.error}`).join("; ")}`, {
			validationErrors: errors,
			received: items,
		});
	}

	return validated;
}

export function createValidator<T>(
	schema: ValidationSchema<T>,
): (params: unknown) => T {
	return (params: unknown) => validateParams(schema, params);
}

export function validateParamsWithMessage<T>(
	schema: ValidationSchema<T>,
	params: unknown,
	errorMessage: string,
): T {
	const result = schema.safeParse(params);
	if (!result.success) {
		throw validationError(`${errorMessage}: ${formatIssues(result.error.issues)}`, {
			validationErrors: result.error.issues,
			received: params,
		});
	}
	return result.data;
}

export function isValidParams<T>(
	schema: ValidationSchema<T>,
	value: unknown,
): value is T {
	return schema.safeParse(value).success;
}

export function tryValidateParams<T>(
	schema: ValidationSchema<T>,
	params: unknown,
): { success: true; data: T } | { success: false; error: string; details: unknown } {
	const result = schema.safeParse(params);
	if (result.success) return { success: true, data: result.data };
	return {
		success: false,
		error: formatIssues(result.error.issues),
		details: result.error.issues,
	};
}
