import { responseReplayDelta } from "../shared/baseline.js";
import { createCodedError } from "../../../utils/codedError.js";
import { compactStep, extractTitle, mergeCookieHeaders, redactHeaders, redirectLocation, responseBodyHash, responseFingerprint, setCookieHeader } from "../shared/http.js";
import { asString, isRecord, positiveInt, stringList } from "../shared/normalize.js";
import { applyReplayVariables, buildHarDependencyGraph, buildReplayRequest, cookieHeaderFromSetCookie, extractReplayVariables, normalizeReplayOptions, normalizeReplayVariableScope, replayInputOptions, replaySequenceInputs, replayStepExtractors, replayVariableMap, sendReplayLikeRequest } from "../shared/replay.js";
import type { FetchStep, ReplayOptions, ReplayRequest } from "../shared/types.js";

function clusterReplayResponses(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const clusters = new Map<string, { status?: unknown; title?: unknown; bodyBytes?: unknown; bodySha256?: unknown; location?: unknown; count: number; okCount: number; sampleSteps: Array<number | string> }>();
	for (const step of steps) {
		if (!isRecord(step.response)) continue;
		const response = step.response;
		const body = isRecord(response.body) ? response.body : {};
		const key = `${response.status}|${response.title || ""}|${body.bytes || 0}|${body.sha256 || ""}|${response.location || ""}`;
		let cluster = clusters.get(key);
		if (!cluster) {
			cluster = { status: response.status, title: response.title, bodyBytes: body.bytes, bodySha256: body.sha256, location: response.location, count: 0, okCount: 0, sampleSteps: [] };
			clusters.set(key, cluster);
		}
		cluster.count += 1;
		if (step.ok !== false) cluster.okCount += 1;
		const sample = typeof step.index === "number" ? step.index : step.label;
		if (sample !== undefined && cluster.sampleSteps.length < 10) cluster.sampleSteps.push(sample as number | string);
	}
	return Array.from(clusters.values()).sort((a, b) => b.count - a.count).slice(0, 50);
}

function replayRequestRecord(request: ReplayRequest, sent: Awaited<ReturnType<typeof sendReplayLikeRequest>>, options: ReturnType<typeof normalizeReplayOptions>) {
	return {
		url: request.url,
		method: request.method,
		headers: redactHeaders(sent.sanitized.headers),
		headerNames: Object.keys(sent.sanitized.headers),
		omittedHeaderNames: sent.sanitized.omittedHeaderNames,
		bodyBytes: request.body === undefined || sent.bodyOmittedForMethod ? 0 : Buffer.byteLength(request.body),
		bodyOmittedForMethod: sent.bodyOmittedForMethod,
		cookiesBound: sent.cookiesBound,
		cookieMode: options.cookieMode,
		csrfReflected: sent.csrfReflected,
		multipart: request.multipart,
	};
}

function replayResponseRecord(final: FetchStep) {
	return {
		url: final.url,
		status: final.status,
		statusText: final.statusText,
		title: extractTitle(final.bodyText),
		location: redirectLocation(final.status, final.headers, final.url),
		headers: redactHeaders(final.headers),
		headerNames: Object.keys(final.headers),
		body: { bytes: final.bodyBytes, sha256: responseBodyHash(final), truncated: final.bodyTruncated, text: final.bodyText, base64: final.bodyBase64 },
		elapsedMs: final.elapsedMs,
	};
}

function replayDeltaRecord(baseline: FetchStep, final: FetchStep) {
	const left = responseFingerprint(baseline);
	const right = responseFingerprint(final);
	return responseReplayDelta(left, right);
}

async function executeReplayRequest(request: ReplayRequest, options: ReturnType<typeof normalizeReplayOptions>) {
	const sent = await sendReplayLikeRequest(request, options);
	const final = sent.exchange.final;
	return {
		ok: final.status >= 200 && final.status < 400,
		request: replayRequestRecord(request, sent, options),
		response: replayResponseRecord(final),
		redirects: sent.exchange.chain.slice(0, -1).map(compactStep),
		final,
	};
}

function baseMultipartDescriptor(value: unknown): Record<string, unknown> | undefined {
	const source = isRecord(value) && isRecord(value.multipart) ? value.multipart : value;
	if (!isRecord(source)) return undefined;
	const next = { ...source };
	delete next.fileFieldMatrix;
	return next;
}

function httpReplayInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "HttpReplayInputError", code: "INVALID_RULE", message, details, suppressStack: false });
}

function normalizeMatrixFileDescriptor(template: Record<string, unknown>, fieldName: string, value: unknown): Record<string, unknown> {
	if (isRecord(value)) return { ...template, ...value, name: fieldName };
	return { ...template, name: fieldName, content: typeof value === "string" ? value : JSON.stringify(value) };
}

function multipartMatrixCase(template: Record<string, unknown>, fieldName: string, rawValue: unknown) {
	const rawFiles = Array.isArray(rawValue) ? rawValue : [rawValue];
	const files = rawFiles.map((item) => normalizeMatrixFileDescriptor(template, fieldName, item));
	const filenames = files.map((file) => asString(file.filename)?.trim() || "blob");
	const contentTypes = [...new Set(files.map((file) => asString(file.contentType)?.trim() || asString(template.contentType)?.trim() || "application/octet-stream"))];
	const nestedMultipartFileCount = files.filter((file) => /^multipart\//i.test(asString(file.contentType) || "")).length;
	return {
		files,
		info: { fieldName, fileCount: files.length, filenames, contentTypes, nestedMultipartFileCount, kind: nestedMultipartFileCount ? "nested-multipart" : files.length > 1 ? "multi-file" : "single-file" },
		label: `field=${fieldName} files=${files.length} ${filenames.slice(0, 3).join(",")}`,
	};
}

function buildMultipartFileFieldMatrixSequence(options: ReplayOptions) {
	const multipart = baseMultipartDescriptor(options.multipart);
	const source = isRecord(options.multipart) && isRecord(options.multipart.multipart) ? options.multipart.multipart : options.multipart;
	if (!multipart || !isRecord(source) || !isRecord(source.fileFieldMatrix)) return undefined;
	const matrix = source.fileFieldMatrix;
	const baseMutations = isRecord(options.mutations) ? options.mutations : {};
	if (baseMutations.multipart !== undefined) throw httpReplayInputError("browser_http_replay multipart.fileFieldMatrix cannot be combined with mutations.multipart", { field: "multipart.fileFieldMatrix|mutations.multipart" });
	const baseFiles = Array.isArray(multipart.files) ? multipart.files.filter(isRecord) : [];
	if (baseFiles.length !== 1) throw httpReplayInputError("browser_http_replay multipart.fileFieldMatrix requires exactly one template file in multipart.files", { fileCount: baseFiles.length });
	const template = { ...baseFiles[0] };
	const templateFieldName = asString(template.name)?.trim() || "file";
	const fieldNames = stringList(matrix.fieldNames).length ? stringList(matrix.fieldNames) : [templateFieldName];
	const rawFileValues = Array.isArray(matrix.fileValues) && matrix.fileValues.length ? matrix.fileValues : [template];
	const maxCases = Math.min(100, positiveInt(matrix.maxCases, 50));
	const sequence: Array<{ input: unknown; source: string; label?: string }> = [];
	let truncatedCases = 0;
	outer: for (const fieldName of fieldNames) {
		for (const rawValue of rawFileValues) {
			const matrixCase = multipartMatrixCase(template, fieldName, rawValue);
			const stepInput: Record<string, unknown> = {
				...options,
				requests: undefined,
				sequence: undefined,
				har: undefined,
				harPath: undefined,
				multipart,
				mutations: { ...baseMutations, multipart: { ...multipart, files: matrixCase.files } },
				multipartMatrixCase: matrixCase.info,
			};
			sequence.push({ input: stepInput, source: "multipart-matrix", label: matrixCase.label });
			if (sequence.length >= maxCases) {
				truncatedCases = Math.max(0, fieldNames.length * rawFileValues.length - sequence.length);
				break outer;
			}
		}
	}
	return {
		sequence,
		info: {
			caseCount: sequence.length,
			truncatedCases,
			fieldNames,
			fileValueCount: rawFileValues.length,
			maxCases,
		},
	};
}

type ReplaySequenceItem = { input: unknown; source: string; label?: string };
type ReplaySequenceState = { steps: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>>; variables: Record<string, string>; cookieHeader?: string };

function applySequenceCookie(request: ReplayRequest, options: ReturnType<typeof normalizeReplayOptions>, cookieHeader?: string): void {
	if (options.sequenceCookies && cookieHeader) setCookieHeader(request.headers, mergeCookieHeaders(request.headers.Cookie ?? request.headers.cookie, cookieHeader));
}

function replayBaselineRecord(executed: Awaited<ReturnType<typeof executeReplayRequest>>) {
	return { request: executed.request, response: executed.response, redirects: executed.redirects };
}

async function executeReplayComparison(options: ReplayOptions, normalized: ReturnType<typeof normalizeReplayOptions>, sequenceCookieHeader?: string) {
	const request = buildReplayRequest(options);
	applySequenceCookie(request, normalized, sequenceCookieHeader);
	const baselineExecuted = normalized.compareBaseline ? await executeReplayRequest(buildReplayBaselineRequest(options, normalized, sequenceCookieHeader), normalized) : undefined;
	const executed = await executeReplayRequest(request, normalized);
	return { executed, baseline: baselineExecuted ? replayBaselineRecord(baselineExecuted) : undefined, delta: baselineExecuted ? replayDeltaRecord(baselineExecuted.final, executed.final) : undefined };
}

function buildReplayBaselineRequest(options: ReplayOptions, normalized: ReturnType<typeof normalizeReplayOptions>, sequenceCookieHeader?: string): ReplayRequest {
	const request = buildReplayRequest({ ...options, mutations: undefined });
	applySequenceCookie(request, normalized, sequenceCookieHeader);
	return request;
}

function prepareReplaySequenceStep(item: ReplaySequenceItem, parentOptions: ReplayOptions, parentNormalized: ReturnType<typeof normalizeReplayOptions>, state: ReplaySequenceState) {
	const input = isRecord(item.input) ? item.input : undefined;
	const variables = { ...state.variables, ...replayVariableMap(input?.variables) };
	const variableScope = normalizeReplayVariableScope(input?.variableScope ?? input?.captureScope, parentNormalized.variableScope);
	const options = applyReplayVariables(replayInputOptions(item.input, parentOptions), variables) as ReplayOptions;
	return { input, variables, variableScope, options, normalized: normalizeReplayOptions(options) };
}

async function executeReplaySequenceStep(index: number, item: ReplaySequenceItem, parentOptions: ReplayOptions, parentNormalized: ReturnType<typeof normalizeReplayOptions>, state: ReplaySequenceState): Promise<boolean> {
	const step = prepareReplaySequenceStep(item, parentOptions, parentNormalized, state);
	try {
		const comparison = await executeReplayComparison(step.options, step.normalized, state.cookieHeader);
		const capturedVariables = extractReplayVariables(replayStepExtractors(item.input), comparison.executed.final);
		const persistedVariableNames = step.variableScope === "sequence" ? Object.keys(capturedVariables) : [];
		if (persistedVariableNames.length) state.variables = { ...state.variables, ...capturedVariables };
		const setCookie = step.normalized.sequenceCookies ? cookieHeaderFromSetCookie(comparison.executed.final.setCookie) : undefined;
		if (setCookie) state.cookieHeader = mergeCookieHeaders(state.cookieHeader, setCookie);
		state.steps.push({ index, source: item.source, label: item.label, ok: comparison.executed.ok, request: comparison.executed.request, response: comparison.executed.response, redirects: comparison.executed.redirects, baseline: comparison.baseline, delta: comparison.delta, variableScope: step.variableScope, usedVariableNames: Object.keys(step.variables), capturedVariableNames: Object.keys(capturedVariables), persistedVariableNames, capturedVariables, multipartMatrixCase: step.input?.multipartMatrixCase });
		return true;
	} catch (error) {
		const failure = { index, source: item.source, label: item.label, variableScope: step.variableScope, multipartMatrixCase: step.input?.multipartMatrixCase, error: error instanceof Error ? error.message : String(error) };
		state.failures.push(failure);
		state.steps.push({ ...failure, ok: false });
		return step.normalized.continueOnError;
	}
}

async function executeReplaySequence(sequence: ReplaySequenceItem[], options: ReplayOptions, normalized: ReturnType<typeof normalizeReplayOptions>, extra: { mode?: string; multipartMatrix?: Record<string, unknown> } = {}) {
	const dependencyGraph = buildHarDependencyGraph(sequence, { baseUrl: options.baseUrl, defaultScheme: options.defaultScheme });
	const state: ReplaySequenceState = { steps: [], failures: [], variables: { ...normalized.variables } };
	for (let index = 0; index < sequence.length; index += 1) if (!await executeReplaySequenceStep(index, sequence[index], options, normalized, state)) break;
	const last = [...state.steps].reverse().find((step) => isRecord(step.response));
	return {
		ok: state.failures.length === 0 && state.steps.every((step) => step.ok !== false), generatedAt: new Date().toISOString(), mode: (extra.mode || "sequence") as "sequence" | "multipart-matrix", stepCount: state.steps.length, failureCount: state.failures.length,
		sequenceCookies: normalized.sequenceCookies, variableScope: normalized.variableScope, variableNames: Object.keys(state.variables), variables: state.variables,
		request: isRecord(last) ? last.request : undefined, response: isRecord(last) ? last.response : undefined, redirects: isRecord(last) && Array.isArray(last.redirects) ? last.redirects : [],
		dependencyGraph, multipartMatrix: extra.multipartMatrix, clusters: clusterReplayResponses(state.steps), steps: state.steps, failures: state.failures,
	};
}

export async function runHttpReplay(options: ReplayOptions) {
	const explicitSequence = await replaySequenceInputs(options);
	if (explicitSequence.length && isRecord(options.multipart) && isRecord(options.multipart.fileFieldMatrix)) {
		throw httpReplayInputError("browser_http_replay multipart.fileFieldMatrix is only supported for direct single-request replay inputs; remove requests/sequence/HAR or enumerate the steps explicitly", { field: "multipart.fileFieldMatrix", sequenceLength: explicitSequence.length });
	}
	const normalized = normalizeReplayOptions(options);
	const multipartMatrix = explicitSequence.length ? undefined : buildMultipartFileFieldMatrixSequence(options);
	const sequence = multipartMatrix?.sequence || explicitSequence;
	if (sequence.length) return executeReplaySequence(sequence, options, normalized, { mode: multipartMatrix ? "multipart-matrix" : "sequence", multipartMatrix: multipartMatrix?.info });
	const interpolatedOptions = applyReplayVariables(options, normalized.variables) as ReplayOptions;
	const singleNormalized = normalizeReplayOptions(interpolatedOptions);
	const comparison = await executeReplayComparison(interpolatedOptions, singleNormalized);
	return { ok: comparison.executed.ok, generatedAt: new Date().toISOString(), mode: "single" as const, variableScope: normalized.variableScope, variableNames: Object.keys(normalized.variables), variables: normalized.variables, request: comparison.executed.request, response: comparison.executed.response, redirects: comparison.executed.redirects, baseline: comparison.baseline, delta: comparison.delta };
}
