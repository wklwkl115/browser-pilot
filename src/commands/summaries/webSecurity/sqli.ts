import { asArray, increment, isRecord, resultItems, summaryTable, topCounts, type Summary } from "./shared.js";

export function summarizeSqliProbeData(value: unknown): Summary {
	const matched = isRecord(value) ? asArray(value.matched).filter(isRecord) : [];
	const results = resultItems(value);
	const failures = isRecord(value) ? asArray(value.failures).filter(isRecord) : [];
	const typeCounts: Record<string, number> = {};
	const paramCounts: Record<string, number> = {};
	for (const item of results) {
		increment(typeCounts, item.type ?? "unknown");
		increment(paramCounts, item.paramName ?? "unknown");
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		caseCount: isRecord(value) ? value.caseCount : undefined,
		requestCount: isRecord(value) ? value.requestCount : undefined,
		matchedCount: matched.length,
		failureCount: failures.length,
		oracleTypes: isRecord(value) ? value.oracleTypes : undefined,
		dbmsPayloadPack: isRecord(value) ? value.dbmsPayloadPack : undefined,
		dbmsFingerprints: isRecord(value) ? value.dbmsFingerprints : undefined,
		columnHints: summaryTable(isRecord(value) ? asArray(value.columnHints).filter(isRecord) : [], [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "orderByMaxValid", value: (item) => item.orderByMaxValid },
			{ key: "unionSelectColumns", value: (item) => item.unionSelectColumns },
			{ key: "confidence", value: (item) => item.confidence },
		], 10),
		echoPositions: summaryTable(isRecord(value) ? asArray(value.echoPositions).filter(isRecord) : [], [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "columns", value: (item) => item.columnCount },
			{ key: "position", value: (item) => item.position },
		], 20),
		extractions: summaryTable(isRecord(value) ? asArray(value.extractions).filter(isRecord) : [], [
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "expression", value: (item) => item.expression },
			{ key: "value", value: (item) => item.value },
			{ key: "length", value: (item) => item.length },
			{ key: "attempts", value: (item) => item.attempts },
			{ key: "complete", value: (item) => item.complete },
		], 10),
		truncatedCases: isRecord(value) ? value.truncatedCases : undefined,
		timeThresholdMs: isRecord(value) ? value.timeThresholdMs : undefined,
		typeCounts: topCounts(typeCounts),
		paramCounts: topCounts(paramCounts),
		matched: summaryTable(matched, [
			{ key: "type", value: (item) => item.type },
			{ key: "location", value: (item) => item.location },
			{ key: "param", value: (item) => item.paramName },
			{ key: "payload", value: (item) => item.payload ?? (isRecord(item.payloads) ? item.payloads.truePayload : undefined) },
			{ key: "status", value: (item) => isRecord(item.response) ? item.response.status : isRecord(item.trueResponse) ? item.trueResponse.status : undefined },
			{ key: "bodyBytes", value: (item) => isRecord(item.response) ? item.response.bodyBytes : isRecord(item.trueResponse) ? item.trueResponse.bodyBytes : undefined },
			{ key: "elapsedDeltaMs", value: (item) => item.elapsedDeltaMs },
			{ key: "sqlError", value: (item) => item.sqlError },
			{ key: "dbms", value: (item) => item.dbms },
			{ key: "columns", value: (item) => item.columnCount },
			{ key: "echoPosition", value: (item) => item.echoPosition },
			{ key: "baselineDistance", value: (item) => item.baselineDistance },
		], 30),
		failures: summaryTable(failures, [
			{ key: "type", value: (failure) => failure.type },
			{ key: "param", value: (failure) => failure.paramName },
			{ key: "error", value: (failure) => failure.error },
		], 10),
		nextActions: [
			"use browser_http_replay with confirmed payloads to verify reproducibility and preserve baseline-vs-mutated evidence",
			"use browser_sqli engine=sqlmap with the same scoped request template when deeper bounded automation is explicitly needed",
			"save or read response artifacts for manual review when extraction, DBMS hints, or UNION evidence need confirmation",
		],
	};
}
