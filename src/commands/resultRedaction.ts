import { redactSensitiveValueWithPointers } from "../artifacts/artifactPrivacy.js";
import { isRecord, pickDefined } from "../utils/records.js";

export function redactForModel<T>(value: T, saved?: Record<string, unknown>, rawArtifactValue?: unknown): T {
	return redactSensitiveValueWithPointers(value, {
		rawArtifactPath: typeof saved?.path === "string" ? saved.path : undefined,
		rawArtifactBytes: typeof saved?.bytes === "number" ? saved.bytes : undefined,
		artifactValue: rawArtifactValue,
	}) as T;
}

export function normalizedPrivacy(saved?: Record<string, unknown>, sensitiveRaw = false): Record<string, unknown> | undefined {
	const savedPrivacy = isRecord(saved?.privacy) ? saved.privacy : undefined;
	if (!savedPrivacy && !sensitiveRaw) return undefined;
	return {
		...pickDefined(savedPrivacy || {}, ["classification", "localOnly", "redaction"]),
		...(sensitiveRaw ? { sensitiveEvidence: true, modelFacingRedaction: "default" } : {}),
	};
}
