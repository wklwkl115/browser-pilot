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
