import { isRecord } from "./records.js";

export type KernelNormalizedError = {
	code: string;
	message: string;
	details: Record<string, unknown>;
	taxonomy: {
		source: "kernel";
	};
};

export function normalizeError(error: unknown, fallbackCode = "INTERNAL_ERROR"): KernelNormalizedError {
	if (error instanceof Error) {
		const extra = error as Error & { code?: unknown; details?: unknown };
		return {
			code: typeof extra.code === "string" && extra.code ? extra.code : fallbackCode,
			message: error.message || fallbackCode,
			details: isRecord(extra.details) ? extra.details : {},
			taxonomy: { source: "kernel" },
		};
	}
	if (isRecord(error)) {
		const nested = isRecord(error.error) ? error.error : {};
		const code = typeof error.code === "string" ? error.code
			: typeof error.error_code === "string" ? error.error_code
				: typeof nested.code === "string" ? nested.code
					: typeof nested.error_code === "string" ? nested.error_code
						: fallbackCode;
		const message = typeof error.message === "string" ? error.message
			: typeof error.error === "string" ? error.error
				: typeof nested.message === "string" ? nested.message
					: typeof nested.error === "string" ? nested.error
						: code;
		return {
			code,
			message,
			details: isRecord(error.details) ? error.details : isRecord(nested.details) ? nested.details : {},
			taxonomy: { source: "kernel" },
		};
	}
	return { code: fallbackCode, message: String(error), details: {}, taxonomy: { source: "kernel" } };
}
