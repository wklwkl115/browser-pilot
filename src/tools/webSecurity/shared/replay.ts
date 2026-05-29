import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { FETCH_OMIT_HEADER_NAMES, fetchWithRedirects, mergeCookieHeaders, redirectLocation, sanitizeFetchHeaders, setCookieHeader, setHeaderCaseInsensitive } from "./http";
import { buildMultipartBodyFromParts, multipartPartsFromValue, parseMultipartBody, setMultipartContentTypeVariant, summarizeMultipartParts } from "./multipart";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, asString, isRecord, normalizeHeaderName, positiveInt, stringList } from "./normalize";
import { applyTemplateVars, evaluateDslExtractor, jsonPathParts, normalizeDslExtractors } from "./template";
import { harEntriesFromOptions } from "./har";
import type { CookieProvider, FetchStep, HeaderMap, ReplayOptions, ReplayRequest } from "./types";

export type NormalizedReplayOptions = {
	timeoutMs: number;
	maxBodyBytes: number;
	followRedirects: boolean;
	maxRedirects: number;
	bindBrowserSession: boolean;
	cookieMode: "merge" | "replace" | "preserve";
	compareBaseline: boolean;
	sequenceCookies: boolean;
	continueOnError: boolean;
	variableScope: "sequence" | "step";
	variables: Record<string, string>;
	cookieProvider?: CookieProvider;
};

export { buildReplayRequest, parseRawHttpRequest } from "./requestTemplate";

export function requestContentType(headers: HeaderMap): string {
	const found = Object.entries(headers).find(([name]) => normalizeHeaderName(name) === "content-type");
	return found?.[1] || "";
}

export function inferFuzzParamLocations(request: ReplayRequest, explicit: unknown): string[] {
	const requested = stringList(explicit).flatMap((item) => item.split(/[ ,\s]+/)).map((item) => item.toLowerCase()).filter(Boolean);
	if (requested.includes("all")) return ["query", "json", "form", "multipart", "header"];
	if (requested.length) return [...new Set(requested)];
	const out = new Set<string>();
	const url = new URL(request.url);
	if (url.searchParams.size || request.method === "GET" || request.method === "HEAD" || request.body === undefined) out.add("query");
	const body = typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body.toString() : "";
	const contentType = requestContentType(request.headers).toLowerCase();
	if (body.trim()) {
		if (contentType.includes("multipart/form-data")) out.add("multipart");
		if (contentType.includes("json") || /^[\s\r\n]*[\[{]/.test(body)) out.add("json");
		if (contentType.includes("x-www-form-urlencoded") || /^[^=]+=[\s\S]*/.test(body)) out.add("form");
	}
	return Array.from(out);
}

function hasOwnJsonProperty(value: unknown, key: string | number): boolean {
	return value !== undefined && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function getOwnJsonProperty(value: unknown, key: string | number): unknown {
	return hasOwnJsonProperty(value, key) ? (value as any)[key as any] : undefined;
}

function setOwnJsonProperty(target: unknown, key: string | number, value: unknown) {
	if (typeof key === "number" || hasOwnJsonProperty(target, key)) {
		(target as any)[key as any] = value;
		return;
	}
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function createJsonContainer(next: string | number): Record<string, unknown> | unknown[] {
	return typeof next === "number" ? [] : Object.create(null);
}

function collectJsonParamPaths(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		value.slice(0, 20).forEach((item, index) => collectJsonParamPaths(item, `${prefix}[${index}]`, out));
		return out;
	}
	if (!isRecord(value)) return out;
	for (const [key, child] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		out.add(path);
		collectJsonParamPaths(child, path, out);
	}
	return out;
}

export function existingParamNames(request: ReplayRequest, locations: string[]): string[] {
	const names = new Set<string>();
	if (locations.includes("query")) for (const key of new URL(request.url).searchParams.keys()) names.add(key);
	const body = typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body.toString() : "";
	if (locations.includes("form") && body) for (const key of new URLSearchParams(body).keys()) names.add(key);
	if (locations.includes("multipart") && request.body !== undefined) {
		try {
			for (const part of parseMultipartBody(request.body, requestContentType(request.headers)).parts) names.add(part.name);
		} catch {}
	}
	if (locations.includes("json") && body) {
		try {
			for (const key of collectJsonParamPaths(JSON.parse(body))) names.add(key);
		} catch {}
	}
	if (locations.includes("header")) for (const key of Object.keys(request.headers)) if (!FETCH_OMIT_HEADER_NAMES.has(normalizeHeaderName(key))) names.add(key);
	return Array.from(names);
}

export function parseFuzzParamValue(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (/^(?:true|false|null)$/i.test(trimmed) || /^-?\d+(?:\.\d+)?$/.test(trimmed) || /^[\[{]/.test(trimmed)) {
		try {
			return JSON.parse(trimmed);
		} catch {}
	}
	return value;
}

function setJsonPath(root: unknown, path: string, value: unknown) {
	const parts = jsonPathParts(path);
	let current: any = root;
	for (let i = 0; i < parts.length - 1; i += 1) {
		const part = parts[i];
		const next = parts[i + 1];
		if (typeof part === "number") {
			if (!Array.isArray(current)) throw new Error(`JSON path expects array at ${String(part)}`);
		} else if (!isRecord(current) && !Array.isArray(current)) {
			throw new Error(`JSON path expects object at ${part}`);
		}
		let child = getOwnJsonProperty(current, part);
		if (child === undefined || child === null) {
			child = createJsonContainer(next);
			setOwnJsonProperty(current, part, child);
		}
		current = child;
	}
	const last = parts[parts.length - 1];
	if (typeof last === "number") {
		if (!Array.isArray(current)) throw new Error(`JSON path expects array at ${String(last)}`);
	} else if (!isRecord(current) && !Array.isArray(current)) {
		throw new Error(`JSON path expects object at ${last}`);
	}
	setOwnJsonProperty(current, last, value);
}

function deleteJsonPath(root: unknown, path: string) {
	const parts = jsonPathParts(path);
	let current: any = root;
	for (let i = 0; i < parts.length - 1; i += 1) {
		const part = parts[i];
		if (!hasOwnJsonProperty(current, part)) return;
		current = getOwnJsonProperty(current, part);
		if (current === undefined || current === null) return;
	}
	const last = parts[parts.length - 1];
	if (!hasOwnJsonProperty(current, last)) return;
	if (Array.isArray(current) && typeof last === "number") current.splice(last, 1);
	else if (current && typeof current === "object") delete current[last as any];
}

export function mutateParamRequest(base: ReplayRequest, location: string, paramName: string, value: unknown, operation = "set", contentTypeVariant = "normal"): ReplayRequest {
	const request: ReplayRequest = { url: base.url, method: base.method, headers: { ...base.headers }, body: base.body, multipart: base.multipart };
	const stringValue = typeof value === "string" ? value : JSON.stringify(value);
	if (location === "query") {
		const url = new URL(request.url);
		if (operation === "delete") url.searchParams.delete(paramName);
		else if (operation === "add") url.searchParams.append(paramName, stringValue);
		else url.searchParams.set(paramName, stringValue);
		request.url = url.toString();
		return request;
	}
	if (location === "header") {
		const normalized = normalizeHeaderName(paramName);
		if (operation === "delete") {
			for (const key of Object.keys(request.headers)) if (normalizeHeaderName(key) === normalized) delete request.headers[key];
		} else {
			setHeaderCaseInsensitive(request.headers, paramName, stringValue);
			if (normalized !== paramName) setHeaderCaseInsensitive(request.headers, normalized, stringValue);
		}
		return request;
	}
	if (location === "form") {
		const params = new URLSearchParams(typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body.toString() : "");
		if (operation === "delete") params.delete(paramName);
		else if (operation === "add") params.append(paramName, stringValue);
		else params.set(paramName, stringValue);
		request.body = params.toString();
		if (!requestContentType(request.headers)) request.headers["Content-Type"] = "application/x-www-form-urlencoded";
		return request;
	}
	if (location === "multipart") {
		const parsed = parseMultipartBody(request.body, requestContentType(request.headers));
		const existing = parsed.parts.filter((part) => part.name === paramName);
		let parts = parsed.parts.filter((part) => operation === "add" || part.name !== paramName);
		if (operation !== "delete") {
			const template = existing[0];
			const nextParts = multipartPartsFromValue(paramName, parseFuzzParamValue(value), template);
			parts = [...parts, ...nextParts];
		}
		const boundary = parsed.boundary || `----pi-browser-tools-${randomUUID()}`;
		const rebuilt = buildMultipartBodyFromParts(parts, boundary);
		request.body = rebuilt.body;
		setMultipartContentTypeVariant(request.headers, boundary, contentTypeVariant);
		request.multipart = summarizeMultipartParts(parts, boundary, contentTypeVariant);
		return request;
	}
	if (location === "json") {
		let parsed: unknown = {};
		const body = typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body.toString() : "";
		if (body.trim()) {
			try {
				parsed = JSON.parse(body);
			} catch (error) {
				throw new Error(`Invalid JSON request body; cannot mutate JSON parameter ${paramName}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!isRecord(parsed) && !Array.isArray(parsed)) throw new Error(`JSON request body must be an object or array to mutate JSON parameter ${paramName}`);
		if (operation === "delete") deleteJsonPath(parsed, paramName);
		else setJsonPath(parsed, paramName, parseFuzzParamValue(value));
		request.body = JSON.stringify(parsed);
		if (!requestContentType(request.headers)) request.headers["Content-Type"] = "application/json";
		return request;
	}
	throw new Error(`Unsupported parameter fuzz location: ${location}`);
}

export function replayVariableMap(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isRecord(value)) return out;
	for (const [key, item] of Object.entries(value)) out[key] = typeof item === "string" ? item : asString(item) ?? JSON.stringify(item);
	return out;
}

export function normalizeReplayVariableScope(value: unknown, fallback: "sequence" | "step" = "sequence"): "sequence" | "step" {
	const normalized = String(value || fallback).toLowerCase();
	if (["step", "local", "ephemeral"].includes(normalized)) return "step";
	if (["sequence", "global", "shared", "persist"].includes(normalized)) return "sequence";
	return fallback;
}

export function normalizeReplayOptions(options: ReplayOptions): NormalizedReplayOptions {
	const followRedirects = options.followRedirects === true;
	const cookieMode = String(options.cookieMode || "merge").toLowerCase();
	return {
		timeoutMs: positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS),
		maxBodyBytes: positiveInt(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
		followRedirects,
		maxRedirects: positiveInt(options.maxRedirects, followRedirects ? 5 : 0),
		bindBrowserSession: options.bindBrowserSession === true,
		cookieMode: cookieMode === "replace" ? "replace" : cookieMode === "preserve" ? "preserve" : "merge",
		compareBaseline: options.compareBaseline === true,
		sequenceCookies: options.sequenceCookies !== false,
		continueOnError: options.continueOnError === true,
		variableScope: normalizeReplayVariableScope(options.variableScope, "sequence"),
		variables: replayVariableMap(options.variables),
		cookieProvider: options.cookieProvider,
	};
}

export function applyReplayVariables(value: unknown, variables: Record<string, string>): unknown {
	if (!Object.keys(variables).length) return value;
	if (typeof value === "string") return applyTemplateVars(value, variables);
	if (Buffer.isBuffer(value)) return value;
	if (Array.isArray(value)) return value.map((item) => applyReplayVariables(item, variables));
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = applyReplayVariables(item, variables);
		return out;
	}
	return value;
}

export function replayStepExtractors(input: unknown): unknown {
	return isRecord(input) ? input.extractors ?? input.captures : undefined;
}

export function extractReplayVariables(value: unknown, final: FetchStep): Record<string, string> {
	const extractors = normalizeDslExtractors(value);
	if (!extractors.length) return {};
	const headersLower: HeaderMap = {};
	for (const [name, headerValue] of Object.entries(final.headers)) headersLower[normalizeHeaderName(name)] = headerValue;
	const out: Record<string, string> = {};
	for (const extractor of extractors) {
		const items = evaluateDslExtractor(extractor, final, headersLower);
		const first = items.find((item) => isRecord(item) && item.value !== undefined);
		const name = extractor.name || extractor.header || extractor.cookie || extractor.jsonPath;
		if (name && first && isRecord(first)) out[name] = typeof first.value === "string" ? first.value : asString(first.value) ?? JSON.stringify(first.value);
	}
	return out;
}

export async function sendReplayLikeRequest(request: ReplayRequest, options: NormalizedReplayOptions) {
	const headers = { ...request.headers };
	const injectedBrowserCookie = options.bindBrowserSession === true ? await options.cookieProvider?.(request.url) : undefined;
	if (injectedBrowserCookie) {
		const currentCookie = headers.Cookie ?? headers.cookie;
		if (options.cookieMode === "replace") setCookieHeader(headers, injectedBrowserCookie);
		else if (options.cookieMode !== "preserve") setCookieHeader(headers, mergeCookieHeaders(currentCookie, injectedBrowserCookie));
		else if (!currentCookie) setCookieHeader(headers, injectedBrowserCookie);
	}
	const bodyOmittedForMethod = (request.method === "GET" || request.method === "HEAD") && request.body !== undefined;
	const sanitized = sanitizeFetchHeaders(headers);
	const exchange = await fetchWithRedirects({ url: request.url, method: request.method, headers: sanitized.headers, body: bodyOmittedForMethod ? undefined : request.body }, options);
	return { exchange, sanitized, bodyOmittedForMethod, cookiesBound: !!injectedBrowserCookie };
}

export function cookieHeaderFromSetCookie(lines: string[]): string | undefined {
	const pairs: string[] = [];
	for (const line of lines) {
		const first = line.split(";", 1)[0]?.trim();
		if (first && first.includes("=")) pairs.push(first);
	}
	return pairs.length ? pairs.join("; ") : undefined;
}

export { buildHarDependencyGraph, harDependencyRequestInfo, harDependencyResponseInfo, harEntriesFromOptions, harHeaderValues, MAX_HAR_FILTER_CANDIDATE_ENTRIES, MAX_HAR_URL_MATCH_CHARS, MAX_HAR_URL_PATTERN_CHARS } from "./har";

export function replayInputOptions(input: unknown, parent: ReplayOptions): ReplayOptions {
	const common: ReplayOptions = { ...parent, url: undefined, rawRequest: undefined, request: undefined, body: undefined, bodyBase64: undefined, multipart: undefined, requests: undefined, sequence: undefined, har: undefined, harPath: undefined };
	if (typeof input === "string") return { ...common, rawRequest: input };
	if (isRecord(input) && isRecord(input.request) && (input.startedDateTime || input.response || input.time)) return { ...common, request: input.request, rawRequest: undefined, url: undefined };
	if (isRecord(input)) return { ...common, ...input, cookieProvider: parent.cookieProvider, timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : parent.timeoutMs, maxBodyBytes: typeof input.maxBodyBytes === "number" ? input.maxBodyBytes : parent.maxBodyBytes, defaultScheme: input.defaultScheme ?? parent.defaultScheme, baseUrl: input.baseUrl ?? parent.baseUrl };
	throw new Error("Sequence entries must be raw request strings, captured request objects, HAR entries, or replay option objects");
}

export async function replaySequenceInputs(options: ReplayOptions): Promise<Array<{ input: unknown; source: string; label?: string }>> {
	const direct = Array.isArray(options.sequence) ? options.sequence : Array.isArray(options.requests) ? options.requests : [];
	if (direct.length) return direct.map((input, index) => ({ input, source: "sequence", label: `step-${index + 1}` }));
	const harEntries = await harEntriesFromOptions(options);
	return harEntries.map((entry, index) => ({ input: entry, source: "har", label: asString(isRecord(entry.request) ? entry.request.url : undefined) || `har-${index + 1}` }));
}

