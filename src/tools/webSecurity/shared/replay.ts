import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS, SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS, unsafeRegexReason } from "../../../utils/safeRegex";
import { FETCH_OMIT_HEADER_NAMES, absoluteUrl, fetchWithRedirects, headersArrayToMap, mergeCookieHeaders, normalizeHeaders, parseSetCookieLine, redirectLocation, sanitizeFetchHeaders, setCookieHeader, setHeaderCaseInsensitive } from "./http";
import { buildMultipartBody, buildMultipartBodyFromParts, multipartContentTypeVariants, multipartPartsFromValue, parseMultipartBody, setMultipartContentTypeVariant, summarizeMultipartParts } from "./multipart";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, asString, defaultScheme, isRecord, normalizeHeaderName, normalizeMethod, positiveInt, stringList } from "./normalize";
import { applyTemplateVars, evaluateDslExtractor, jsonPathParts, normalizeDslExtractors } from "./template";
import type { CookieProvider, FetchStep, HeaderMap, ReplayOptions, ReplayRequest } from "./types";

export const MAX_HAR_URL_PATTERN_CHARS = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS;
export const MAX_HAR_URL_MATCH_CHARS = SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS;
export const MAX_HAR_FILTER_CANDIDATE_ENTRIES = 10_000;

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

function appendRawHeader(headers: HeaderMap, rawName: string, rawValue: string): string {
	const name = rawName.trim();
	const value = rawValue.trim();
	const normalized = normalizeHeaderName(name);
	const existingName = Object.keys(headers).find((key) => normalizeHeaderName(key) === normalized);
	if (!existingName) {
		headers[name] = value;
		return name;
	}
	const separator = normalized === "cookie" ? "; " : ", ";
	headers[existingName] = headers[existingName] ? `${headers[existingName]}${separator}${value}` : value;
	return existingName;
}

export function parseRawHttpRequest(rawValue: unknown, options: { baseUrl?: unknown; defaultScheme?: unknown } = {}) {
	const raw = asString(rawValue);
	if (!raw) throw new Error("rawRequest must be a non-empty string");
	const split = raw.match(/\r?\n\r?\n/);
	const splitAt = split?.index ?? -1;
	const separatorLength = split?.[0]?.length ?? 0;
	const head = (splitAt >= 0 ? raw.slice(0, splitAt) : raw).replace(/\r\n/g, "\n");
	const body = splitAt >= 0 ? raw.slice(splitAt + separatorLength) : undefined;
	const lines = head.split("\n").filter(Boolean);
	const requestLine = lines.shift() || "";
	const match = requestLine.match(/^(\S+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/i);
	if (!match) throw new Error("rawRequest first line must be: METHOD path HTTP/1.1");
	const headers: HeaderMap = {};
	let lastName = "";
	for (const line of lines) {
		if (/^[\t ]/.test(line) && lastName) {
			headers[lastName] = `${headers[lastName]} ${line.trim()}`;
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		lastName = appendRawHeader(headers, line.slice(0, idx), line.slice(idx + 1));
	}
	const host = headers.Host || headers.host;
	const target = match[2];
	const baseUrl = options.baseUrl || (host ? `${defaultScheme(options.defaultScheme)}://${host}` : undefined);
	return { method: normalizeMethod(match[1]), url: absoluteUrl(target, { baseUrl, scheme: options.defaultScheme }), headers, body };
}

function capturedBodyFromPostData(postData: unknown): string | Buffer | undefined {
	if (typeof postData === "string") return postData;
	if (!isRecord(postData)) return undefined;
	const text = asString(postData.text);
	if (text === undefined) return undefined;
	return String(postData.encoding || "").toLowerCase() === "base64" ? Buffer.from(text, "base64") : text;
}

function capturedRequestTemplate(value: unknown) {
	if (!isRecord(value)) return {};
	const source = isRecord(value.request) ? value.request : value;
	const body = capturedBodyFromPostData(source.postData) ?? asString(source.body) ?? (asString(source.bodyBase64) ? Buffer.from(String(source.bodyBase64), "base64") : undefined);
	return {
		url: asString(source.url),
		method: asString(source.method),
		headers: headersArrayToMap(source.headers),
		body,
	};
}

function requestBodyFromOptions(options: ReplayOptions, mutation: Record<string, unknown>): string | Buffer | undefined {
	const bodyBase64 = asString(mutation.bodyBase64) ?? asString(options.bodyBase64);
	if (bodyBase64 !== undefined) return Buffer.from(bodyBase64, "base64");
	const body = asString(mutation.body) ?? asString(options.body);
	return body;
}

export function buildReplayRequest(options: ReplayOptions): ReplayRequest {
	const raw = options.rawRequest !== undefined ? parseRawHttpRequest(options.rawRequest, { baseUrl: options.baseUrl, defaultScheme: options.defaultScheme }) : {};
	const captured = capturedRequestTemplate(options.request);
	const mutation = isRecord(options.mutations) ? options.mutations : {};
	const urlValue = mutation.url ?? options.url ?? raw.url ?? captured.url;
	const url = absoluteUrl(urlValue, { baseUrl: options.baseUrl, scheme: options.defaultScheme });
	const method = normalizeMethod(mutation.method ?? options.method ?? raw.method ?? captured.method, "GET");
	const headers = { ...headersArrayToMap(captured.headers), ...normalizeHeaders(raw.headers), ...normalizeHeaders(options.headers), ...normalizeHeaders(mutation.headers) };
	let body = requestBodyFromOptions(options, mutation) ?? raw.body ?? captured.body;
	const multipart = buildMultipartBody(mutation.multipart ?? options.multipart);
	if (multipart) {
		body = multipart.body;
		setHeaderCaseInsensitive(headers, "Content-Type", multipart.contentType);
	}
	return { url, method, headers, body, multipart: multipart?.summary };
}

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
	const browserCookie = options.bindBrowserSession === true ? await options.cookieProvider?.(request.url) : undefined;
	if (browserCookie) {
		const currentCookie = headers.Cookie ?? headers.cookie;
		if (options.cookieMode === "replace") setCookieHeader(headers, browserCookie);
		else if (options.cookieMode !== "preserve") setCookieHeader(headers, mergeCookieHeaders(currentCookie, browserCookie));
		else if (!currentCookie) setCookieHeader(headers, browserCookie);
	}
	const bodyOmittedForMethod = (request.method === "GET" || request.method === "HEAD") && request.body !== undefined;
	const sanitized = sanitizeFetchHeaders(headers);
	const exchange = await fetchWithRedirects({ url: request.url, method: request.method, headers: sanitized.headers, body: bodyOmittedForMethod ? undefined : request.body }, options);
	return { exchange, sanitized, bodyOmittedForMethod, cookiesBound: !!browserCookie };
}

export function cookieHeaderFromSetCookie(lines: string[]): string | undefined {
	const pairs: string[] = [];
	for (const line of lines) {
		const first = line.split(";", 1)[0]?.trim();
		if (first && first.includes("=")) pairs.push(first);
	}
	return pairs.length ? pairs.join("; ") : undefined;
}

function boundedHarUrlText(url: string): string {
	return url.length > MAX_HAR_URL_MATCH_CHARS ? url.slice(0, MAX_HAR_URL_MATCH_CHARS) : url;
}

function compileHarUrlMatcher(patternText: string): (url: string) => boolean {
	const unsafeReason = unsafeRegexReason(patternText, MAX_HAR_URL_PATTERN_CHARS);
	if (unsafeReason) {
		if (unsafeReason === "pattern_too_long") return () => false;
		return (url) => boundedHarUrlText(url).includes(patternText);
	}
	try {
		const pattern = new RegExp(patternText);
		return (url) => pattern.test(boundedHarUrlText(url));
	} catch {
		return (url) => boundedHarUrlText(url).includes(patternText);
	}
}

export async function harEntriesFromOptions(options: ReplayOptions): Promise<Array<Record<string, unknown>>> {
	let har = options.har;
	const path = asString(options.harPath)?.trim();
	if (path) har = JSON.parse(await readFile(path, "utf8"));
	if (!isRecord(har)) return [];
	const entries = isRecord(har.log) && Array.isArray(har.log.entries) ? har.log.entries.filter(isRecord) : [];
	let selected = entries;
	const maxEntries = Math.min(100, positiveInt(options.harMaxEntries, options.harEntryIndex !== undefined ? 1 : 20));
	if (options.harEntryIndex !== undefined) {
		const index = typeof options.harEntryIndex === "number" ? options.harEntryIndex : Number(options.harEntryIndex);
		if (!Number.isInteger(index) || index < 0) throw new Error("harEntryIndex must be a zero-based integer");
		selected = entries[index] ? [entries[index]] : [];
	}
	const patternText = asString(options.harUrlPattern)?.trim();
	if (patternText) {
		const matcher = compileHarUrlMatcher(patternText);
		selected = selected.slice(0, MAX_HAR_FILTER_CANDIDATE_ENTRIES).filter((entry) => matcher(asString(isRecord(entry.request) ? entry.request.url : undefined) || ""));
	}
	return selected.slice(0, maxEntries);
}

export function replayInputOptions(input: unknown, parent: ReplayOptions): ReplayOptions {
	const common: ReplayOptions = { ...parent, url: undefined, rawRequest: undefined, request: undefined, body: undefined, bodyBase64: undefined, multipart: undefined, requests: undefined, sequence: undefined, har: undefined, harPath: undefined };
	if (typeof input === "string") return { ...common, rawRequest: input };
	if (isRecord(input) && isRecord(input.request) && (input.startedDateTime || input.response || input.time)) return { ...common, request: input.request, rawRequest: undefined, url: undefined };
	if (isRecord(input)) return { ...common, ...input, cookieProvider: parent.cookieProvider, timeoutMs: input.timeoutMs ?? parent.timeoutMs, maxBodyBytes: input.maxBodyBytes ?? parent.maxBodyBytes, defaultScheme: input.defaultScheme ?? parent.defaultScheme, baseUrl: input.baseUrl ?? parent.baseUrl };
	throw new Error("Sequence entries must be raw request strings, captured request objects, HAR entries, or replay option objects");
}

export async function replaySequenceInputs(options: ReplayOptions): Promise<Array<{ input: unknown; source: string; label?: string }>> {
	const direct = Array.isArray(options.sequence) ? options.sequence : Array.isArray(options.requests) ? options.requests : [];
	if (direct.length) return direct.map((input, index) => ({ input, source: "sequence", label: `step-${index + 1}` }));
	const harEntries = await harEntriesFromOptions(options);
	return harEntries.map((entry, index) => ({ input: entry, source: "har", label: asString(isRecord(entry.request) ? entry.request.url : undefined) || `har-${index + 1}` }));
}

export function harHeaderValues(value: unknown, headerName: string): string[] {
	const target = normalizeHeaderName(headerName);
	if (Array.isArray(value)) return value.filter(isRecord).filter((item) => normalizeHeaderName(String(item.name)) === target).map((item) => asString(item.value)).filter((item): item is string => item !== undefined);
	if (isRecord(value)) return Object.entries(value).filter(([name]) => normalizeHeaderName(name) === target).flatMap(([, item]) => Array.isArray(item) ? item.map((part) => asString(part)).filter((part): part is string => part !== undefined) : asString(item) !== undefined ? [String(item)] : []);
	return [];
}

type HarDependencyUrlOptions = Pick<ReplayOptions, "baseUrl" | "defaultScheme">;

const HAR_DEPENDENCY_FALLBACK_BASE = "http://har-relative.invalid/";

function normalizeHarDependencyUrl(value: unknown, options: HarDependencyUrlOptions = {}) {
	const raw = asString(value)?.trim();
	if (!raw) return undefined;
	try {
		const parsed = new URL(absoluteUrl(raw, { baseUrl: options.baseUrl, scheme: options.defaultScheme }));
		parsed.hash = "";
		return parsed.toString();
	} catch {}
	try {
		const parsed = new URL(raw, HAR_DEPENDENCY_FALLBACK_BASE);
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function resolveHarDependencyUrl(value: unknown, requestUrl?: string, options: HarDependencyUrlOptions = {}) {
	const raw = asString(value)?.trim();
	if (!raw) return undefined;
	if (requestUrl) {
		try {
			const parsed = new URL(raw, requestUrl);
			parsed.hash = "";
			return parsed.toString();
		} catch {}
	}
	return normalizeHarDependencyUrl(raw, options);
}

export function harDependencyRequestInfo(entry: unknown) {
	const request = isRecord(entry) && isRecord(entry.request) ? entry.request : {};
	const url = asString(request.url);
	const headers = headersArrayToMap(request.headers);
	return { url, method: asString(request.method), headers, referer: headers["Referer"] || headers.referer, cookieHeader: headers.Cookie || headers.cookie };
}

export function harDependencyResponseInfo(entry: unknown, requestUrl?: string, options: HarDependencyUrlOptions = {}) {
	const response = isRecord(entry) && isRecord(entry.response) ? entry.response : {};
	const headers = headersArrayToMap(response.headers);
	const rawLocation = asString(response.redirectURL) || harHeaderValues(response.headers, "location")[0];
	const normalizedRequestUrl = normalizeHarDependencyUrl(requestUrl, options);
	const locationKey = rawLocation ? resolveHarDependencyUrl(rawLocation, normalizedRequestUrl, options) : undefined;
	const cookies = harHeaderValues(response.headers, "set-cookie").map((line) => parseSetCookieLine(line, "set-cookie")).filter((item) => !!item && typeof item.name === "string");
	return { status: typeof response.status === "number" ? response.status : Number(response.status), headers, location: rawLocation, locationKey, cookies };
}

export function buildHarDependencyGraph(sequence: Array<{ input: unknown; source: string; label?: string }>, options: HarDependencyUrlOptions = {}) {
	const items = sequence.filter((item) => item.source === "har");
	if (!items.length) return undefined;
	const nodes = items.map((item, index) => {
		const request = harDependencyRequestInfo(item.input);
		const response = harDependencyResponseInfo(item.input, request.url, options);
		return {
			id: `har-${index}`,
			index,
			label: item.label,
			method: request.method,
			url: request.url,
			status: Number.isFinite(response.status) ? response.status : undefined,
			startedAt: isRecord(item.input) ? asString(item.input.startedDateTime) : undefined,
		};
	});
	const edges: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	const addEdge = (fromIndex: number, toIndex: number, type: string, details: Record<string, unknown> = {}) => {
		const key = `${fromIndex}|${toIndex}|${type}|${JSON.stringify(details)}`;
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({ from: `har-${fromIndex}`, to: `har-${toIndex}`, fromIndex, toIndex, type, ...details });
	};
	for (let toIndex = 0; toIndex < items.length; toIndex += 1) {
		const currentRequest = harDependencyRequestInfo(items[toIndex].input);
		const currentUrl = normalizeHarDependencyUrl(currentRequest.url, options);
		const currentReferer = resolveHarDependencyUrl(currentRequest.referer, currentUrl, options);
		const currentCookies = parseCookieHeader(currentRequest.cookieHeader);
		for (let fromIndex = 0; fromIndex < toIndex; fromIndex += 1) {
			const previousRequest = harDependencyRequestInfo(items[fromIndex].input);
			const previousUrl = normalizeHarDependencyUrl(previousRequest.url, options);
			const previousResponse = harDependencyResponseInfo(items[fromIndex].input, previousRequest.url, options);
			if (previousResponse.locationKey && currentUrl && previousResponse.locationKey === currentUrl) addEdge(fromIndex, toIndex, "redirect", { location: previousResponse.location });
			if (currentReferer && previousUrl && previousUrl === currentReferer) addEdge(fromIndex, toIndex, "referer", { referer: currentRequest.referer || currentReferer });
			const sharedCookies = previousResponse.cookies.filter((cookie) => cookie.name && currentCookies.has(String(cookie.name)) && (cookie.value === "" || currentCookies.get(String(cookie.name)) === cookie.value || currentCookies.get(String(cookie.name)) !== undefined));
			if (sharedCookies.length) addEdge(fromIndex, toIndex, "cookie", { cookies: sharedCookies.map((cookie) => cookie.name).filter(Boolean) });
		}
	}
	const edgeTypeCounts: Record<string, number> = {};
	for (const edge of edges) {
		const key = String(edge.type || "unknown");
		edgeTypeCounts[key] = (edgeTypeCounts[key] || 0) + 1;
	}
	const edgeTypes = Object.entries(edgeTypeCounts).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 20);
	return { source: "har", nodeCount: nodes.length, edgeCount: edges.length, edgeTypes, nodes, edges };
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	for (const part of String(header || "").split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const name = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (name) map.set(name, value);
	}
	return map;
}
