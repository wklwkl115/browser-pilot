import { type NativeErrorCode, normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { normalizeError } from "../utils/errors.js";

export class BrowserBridgeError extends Error {
	readonly code: NativeErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "BrowserBridgeError";
		this.code = normalizeNativeErrorCode(code);
		this.details = details;
	}

	toJSON() {
		return { code: this.code, message: this.message, details: this.details };
	}
}

export function errorToPlain(error: unknown): Record<string, unknown> {
	return normalizeError(error);
}
