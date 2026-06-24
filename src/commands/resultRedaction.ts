import { redactSensitiveValueWithPointers } from "../artifacts/artifactPrivacy.js";
import { isRecord } from "./summaries/common.js";

export function redactForModel<T>(value: T, saved?: Record<string, unknown>, rawArtifactValue?: unknown): T {
	return redactSensitiveValueWithPointers(value, {
		rawArtifactPath: typeof saved?.path === "string" ? saved.path : undefined,
		rawArtifactBytes: typeof saved?.bytes === "number" ? saved.bytes : undefined,
		artifactValue: rawArtifactValue,
	}) as T;
}

function pickDefined(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null && value !== "") out[key] = value;
	}
	return out;
}

export function normalizedPrivacy(saved?: Record<string, unknown>, sensitiveRaw = false): Record<string, unknown> | undefined {
	const savedPrivacy = isRecord(saved?.privacy) ? saved.privacy : undefined;
	if (!savedPrivacy && !sensitiveRaw) return undefined;
	return {
		...pickDefined(savedPrivacy || {}, ["classification", "localOnly", "redaction"]),
		...(sensitiveRaw ? { sensitiveEvidence: true, modelFacingRedaction: "default" } : {}),
	};
}
