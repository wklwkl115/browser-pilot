import schema from "../bridge/protocol/native-command.schema.json" with { type: "json" };

export const nativeErrorCodes = schema.errorCodes;

export type NativeErrorCode = keyof typeof nativeErrorCodes;

export function isNativeErrorCode(value: string): value is NativeErrorCode {
	return Object.hasOwn(nativeErrorCodes, value);
}

export function normalizeNativeErrorCode(value: unknown, fallback: NativeErrorCode = "INTERNAL_ERROR"): NativeErrorCode {
	return typeof value === "string" && isNativeErrorCode(value) ? value : fallback;
}
