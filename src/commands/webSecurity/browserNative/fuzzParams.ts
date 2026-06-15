import { createCodedError } from "../../../utils/codedError.js";
import { matchesStatusBodyResult, responseChangeDelta, responseDeltaClassifier } from "../shared/baseline.js";
import { compactStep, extractTitle, redirectLocation, responseBodyHash } from "../shared/http.js";
import { multipartContentTypeVariants } from "../shared/multipart.js";
import { isRecord, numericList, positiveInt, readWordlist, sleep, stringList } from "../shared/normalize.js";
import { buildReplayRequest, existingParamNames, inferFuzzParamLocations, mutateParamRequest, normalizeReplayOptions, sendReplayLikeRequest } from "../shared/replay.js";
import type { FuzzParamsOptions } from "../shared/types.js";

type NormalizedFuzzParamsOptions = ReturnType<typeof normalizeReplayOptions> & {
	locations: string[];
	paramNames: string[];
	values: Array<{ label: string; value: unknown }>;
	operations: string[];
	contentTypeVariants: string[];
	matchStatus: number[];
	filterStatus: number[];
	filterBodyBytes: number[];
	maxCases: number;
	rateLimitPerSecond: number;
	delayMs: number;
};

function clusterMultipartParserResults(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const clusters = new Map<string, { key: string; status?: unknown; title?: unknown; bodyBytes?: unknown; bodySha256?: unknown; responseLocation?: unknown; count: number; matchedCount: number; contentTypeVariants: string[]; params: string[]; operations: string[]; multipartShapes: string[]; repeatedNames: string[]; nestedMultipartPartCount: number }>();
	for (const item of results) {
		if (item.location !== "multipart") continue;
		const key = `${item.status}|${item.title || ""}|${item.bodyBytes || 0}|${item.bodySha256 || ""}|${item.responseLocation || ""}`;
		let cluster = clusters.get(key);
		if (!cluster) {
			cluster = { key, status: item.status, title: item.title, bodyBytes: item.bodyBytes, bodySha256: item.bodySha256, responseLocation: item.responseLocation, count: 0, matchedCount: 0, contentTypeVariants: [], params: [], operations: [], multipartShapes: [], repeatedNames: [], nestedMultipartPartCount: 0 };
			clusters.set(key, cluster);
		}
		cluster.count += 1;
		if (item.matched === true) cluster.matchedCount += 1;
		if (typeof item.contentTypeVariant === "string" && cluster.contentTypeVariants.length < 20 && !cluster.contentTypeVariants.includes(item.contentTypeVariant)) cluster.contentTypeVariants.push(item.contentTypeVariant);
		if (typeof item.paramName === "string" && cluster.params.length < 20 && !cluster.params.includes(item.paramName)) cluster.params.push(item.paramName);
		if (typeof item.operation === "string" && cluster.operations.length < 10 && !cluster.operations.includes(item.operation)) cluster.operations.push(item.operation);
		const multipart = isRecord(item.multipart) ? item.multipart : undefined;
		if (multipart) {
			const shape = `parts=${Number(multipart.partCount || 0)} files=${Number(multipart.fileCount || 0)} fields=${Number(multipart.fieldCount || 0)} nested=${Number(multipart.nestedMultipartPartCount || 0)}`;
			if (cluster.multipartShapes.length < 10 && !cluster.multipartShapes.includes(shape)) cluster.multipartShapes.push(shape);
			cluster.nestedMultipartPartCount = Math.max(cluster.nestedMultipartPartCount, Number(multipart.nestedMultipartPartCount || 0));
			const repeated = Array.isArray(multipart.repeatedNameCounts) ? multipart.repeatedNameCounts : [];
			for (const entry of repeated) {
				if (!isRecord(entry) || typeof entry.name !== "string") continue;
				if (cluster.repeatedNames.length < 20 && !cluster.repeatedNames.includes(entry.name)) cluster.repeatedNames.push(entry.name);
			}
		}
	}
	return Array.from(clusters.values()).sort((a, b) => b.count - a.count).slice(0, 50);
}

function fuzzParamsInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "FuzzParamsInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

async function normalizeFuzzParamsOptions(options: FuzzParamsOptions): Promise<NormalizedFuzzParamsOptions> {
	const baseRequest = buildReplayRequest(options);
	const locations = inferFuzzParamLocations(baseRequest, options.locations);
	if (!locations.length) throw fuzzParamsInputError("browser_fuzz_params requires locations or an inferable query/json/form request", { field: "locations" });
	const explicitParamNames = stringList(options.paramNames);
	const paramNames = explicitParamNames.length ? explicitParamNames : existingParamNames(baseRequest, locations);
	if (!paramNames.length) throw fuzzParamsInputError("browser_fuzz_params requires paramNames or existing request parameters", { field: "paramNames" });
	const stringValues = [...stringList(options.values), ...stringList(options.words), ...stringList(options.wordlist), ...(await readWordlist(options.wordlistPath))];
	const jsonValues = Array.isArray(options.jsonValues) ? options.jsonValues : options.jsonValues !== undefined ? [options.jsonValues] : [];
	const values = [...stringValues.map((value) => ({ label: value, value })), ...jsonValues.map((value) => ({ label: typeof value === "string" ? value : JSON.stringify(value), value }))];
	const operations = stringList(options.operations).flatMap((item) => item.split(/[,\s]+/)).map((item) => item.toLowerCase()).filter((item) => ["set", "add", "delete"].includes(item));
	const selectedOperations = operations.length ? [...new Set(operations)] : ["set"];
	const selectedContentTypeVariants = multipartContentTypeVariants(options.contentTypeVariants);
	if (!values.length && selectedOperations.some((operation) => operation !== "delete")) throw fuzzParamsInputError("browser_fuzz_params requires values, jsonValues, words, wordlist, or wordlistPath for set/add operations", { field: "values|jsonValues|words|wordlist|wordlistPath", operations: selectedOperations });
	const maxCases = Math.min(5_000, positiveInt(options.maxCases, 500));
	const matchStatus = numericList(options.matchStatus);
	const filterStatus = numericList(options.filterStatus);
	const filterBodyBytes = numericList(options.filterBodyBytes);
	const rateLimitPerSecond = positiveInt(options.rateLimitPerSecond, 0);
	return {
		...normalizeReplayOptions(options),
		locations,
		paramNames,
		values,
		operations: selectedOperations,
		contentTypeVariants: selectedContentTypeVariants,
		matchStatus,
		filterStatus,
		filterBodyBytes,
		maxCases,
		rateLimitPerSecond,
		delayMs: rateLimitPerSecond > 0 ? Math.ceil(1000 / rateLimitPerSecond) : 0,
	};
}

export async function runFuzzParams(options: FuzzParamsOptions) {
	const baseRequest = buildReplayRequest(options);
	const normalized = await normalizeFuzzParamsOptions(options);
	const limitedCases = [] as Array<{ location: string; paramName: string; operation: string; valueLabel?: string; value?: unknown; contentTypeVariant?: string }>;
	let totalCaseCount = 0;
	for (const location of normalized.locations) for (const paramName of normalized.paramNames) for (const operation of normalized.operations) {
		const variants = location === "multipart" ? normalized.contentTypeVariants : [undefined];
		for (const contentTypeVariant of variants) {
			if (operation === "delete") {
				totalCaseCount += 1;
				if (limitedCases.length < normalized.maxCases) limitedCases.push({ location, paramName, operation, contentTypeVariant });
				continue;
			}
			for (const value of normalized.values) {
				totalCaseCount += 1;
				if (limitedCases.length < normalized.maxCases) limitedCases.push({ location, paramName, operation, valueLabel: value.label, value: value.value, contentTypeVariant });
			}
		}
	}
	const baselineSent = await sendReplayLikeRequest(baseRequest, normalized);
	const baselineFinal = baselineSent.exchange.final;
	const baseline = { status: baselineFinal.status, title: extractTitle(baselineFinal.bodyText), bodyBytes: baselineFinal.bodyBytes, bodySha256: responseBodyHash(baselineFinal), location: redirectLocation(baselineFinal.status, baselineFinal.headers, baselineFinal.url), url: baselineFinal.url };
	const results: Array<Record<string, unknown>> = [];
	const failures: Array<Record<string, unknown>> = [];
	let sent = 0;
	for (const item of limitedCases) {
		try {
			const request = mutateParamRequest(baseRequest, item.location, item.paramName, item.value, item.operation, item.contentTypeVariant || "normal");
			const replay = await sendReplayLikeRequest(request, normalized);
			const final = replay.exchange.final;
			const title = extractTitle(final.bodyText);
			const bodySha256 = responseBodyHash(final);
			const responseLocation = redirectLocation(final.status, final.headers, final.url);
			const matched = matchesStatusBodyResult(final.status, final.bodyBytes, normalized);
			const fingerprint = { status: final.status, title, bodyBytes: final.bodyBytes, bodySha256, location: responseLocation };
			results.push({
				matched,
				location: item.location,
				paramName: item.paramName,
				operation: item.operation,
				contentTypeVariant: item.contentTypeVariant,
				value: item.valueLabel,
				method: request.method,
				url: final.url,
				status: final.status,
				title,
				bodyBytes: final.bodyBytes,
				bodySha256,
				bodyTruncated: final.bodyTruncated,
				responseLocation,
				multipart: request.multipart,
				redirects: replay.exchange.chain.slice(0, -1).map(compactStep),
				delta: { ...responseChangeDelta(baseline, fingerprint), classifier: responseDeltaClassifier(baseline, fingerprint) },
				body: { text: final.bodyText, base64: final.bodyBase64 },
			});
		} catch (error) {
			failures.push({ location: item.location, paramName: item.paramName, operation: item.operation, contentTypeVariant: item.contentTypeVariant, value: item.valueLabel, url: baseRequest.url, error: error instanceof Error ? error.message : String(error) });
		}
		sent += 1;
		if (normalized.delayMs > 0 && sent < limitedCases.length) await sleep(normalized.delayMs);
	}
	const matched = results.filter((item) => item.matched === true);
	const parserClusters = clusterMultipartParserResults(results);
	return { ok: failures.length === 0, generatedAt: new Date().toISOString(), baseline, locationCount: normalized.locations.length, paramCount: normalized.paramNames.length, valueCount: normalized.values.length, operations: normalized.operations, contentTypeVariants: normalized.contentTypeVariants, caseCount: limitedCases.length, requestCount: sent, matchedCount: matched.length, truncatedCases: Math.max(0, totalCaseCount - limitedCases.length), matchStatus: normalized.matchStatus, filterStatus: normalized.filterStatus, filterBodyBytes: normalized.filterBodyBytes, parserClusters, results, matched, failures };
}
