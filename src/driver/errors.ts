import { normalizeError } from "../utils/errors";

export class BrowserBridgeError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(code: string, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "BrowserBridgeError";
		this.code = code;
		this.details = details;
	}

	toJSON() {
		return { code: this.code, message: this.message, details: this.details };
	}
}

export function errorToPlain(error: unknown): Record<string, unknown> {
	return normalizeError(error);
}
