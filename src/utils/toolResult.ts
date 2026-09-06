import { compactError } from "./errors.js";
import { stableJson } from "./json.js";
import { isRecord } from "./records.js";
import { safeJsonClone } from "./safeClone.js";

export type BrowserTextCommandResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

const RUNTIME_RESULT_KEYS = new Set([
	"browserSessionId",
	"tabSessionId",
	"sessionId",
	"session_id",
	"networkSessionId",
	"tabId",
	"targetId",
	"target_id",
	"tabHandle",
	"defaultTabHandle",
	"latestTabHandle",
	"targetGeneration",
	"pageEpoch",
	"documentId",
	"selectionVersion",
	"operationId",
	"waitId",
	"host",
	"port",
]);

function isExecutionEnvelope(value: Record<string, unknown>): boolean {
	return (
		typeof value.id === "string" &&
		typeof value.acknowledged === "boolean" &&
		("data" in value || "target" in value || "diagnostics" in value)
	);
}

function isRuntimeResultKey(key: string): boolean {
	return (
		RUNTIME_RESULT_KEYS.has(key) ||
		/(?:TabId|TargetId|SessionId|SessionKey|SessionName|TabHandle)$/.test(key) ||
		/(?:tab|target|session)_(?:id|key|name)$/.test(key)
	);
}

type PublicToolValueOptions = { preserveExecutionData?: boolean };

function projectRecord(value: Record<string, unknown>, options: PublicToolValueOptions): Record<string, unknown> {
	if (isExecutionEnvelope(value)) {
		const data = options.preserveExecutionData ? value.data : publicToolValue(value.data, options);
		const rest = Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !["id", "acknowledged", "data", "tabId", "target", "diagnostics"].includes(key))
				.map(([key, item]) => [key, publicToolValue(item, options)]),
		);
		return {
			...(isRecord(data) ? data : data === undefined ? {} : { result: data }),
			...rest,
		};
	}

	const errorEnvelope = typeof value.code === "string" && typeof value.message === "string";
	const publicOperation =
		typeof value.operationId === "string" &&
		/^[0-9a-f-]{36}$/i.test(value.operationId) &&
		(value.scope === "assertion" || isRecord(value.execution));
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					(!isRuntimeResultKey(key) || (key === "operationId" && publicOperation)) &&
					!(errorEnvelope && key === "diagnostics"),
			)
			.map(([key, item]) => [
				key,
				options.preserveExecutionData && key === "result" ? item : publicToolValue(item, options),
			]),
	);
}

/** Keep private routing/lifecycle state out of every agent-facing JSON value. */
export function publicToolValue(value: unknown, options: PublicToolValueOptions = {}): unknown {
	if (Array.isArray(value)) return value.map((item) => publicToolValue(item, options));
	return isRecord(value) ? projectRecord(value, options) : value;
}

/** Details travel over the daemon's JSON control channel; stableJson breaks cycles and drops undefined. */
function normalizeDetails(details: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(stableJson(details)) as Record<string, unknown>;
}

export function jsonResult(
	value: unknown,
	details: Record<string, unknown> = {},
	options: PublicToolValueOptions = {},
): BrowserTextCommandResult {
	return {
		content: [{ type: "text", text: stableJson(publicToolValue(safeJsonClone(value), options)) }],
		details: normalizeDetails(details),
	};
}

export function errorResult(error: unknown): BrowserTextCommandResult {
	const normalized = publicToolValue(compactError(error)) as Record<string, unknown>;
	const rawDetails = isRecord(normalized.details) ? normalized.details : {};
	const {
		operation,
		recovery: _nestedRecovery,
		commandName: _commandName,
		snapshotId: _snapshotId,
		observationId: _observationId,
		refObservationId: _refObservationId,
		...details
	} = rawDetails;
	const rawRecovery = isRecord(normalized.recovery) ? normalized.recovery : {};
	const { summary: _summary, ...recovery } = rawRecovery;
	const publicError = {
		code: normalized.code,
		message: normalized.message,
		...(isRecord(operation)
			? {
					operationId: operation.operationId,
					execution: operation.execution,
					business: operation.business,
					...(operation.verification ? { verification: operation.verification } : {}),
					...(operation.evidence ? { evidence: operation.evidence } : {}),
				}
			: {}),
		...(Object.keys(details).length ? { details } : {}),
		...(isRecord(operation) ? { recovery: operation.recovery } : Object.keys(recovery).length ? { recovery } : {}),
	};
	return {
		content: [{ type: "text", text: stableJson(publicError) }],
		details: normalizeDetails({ error: normalized }),
		isError: true,
	};
}
