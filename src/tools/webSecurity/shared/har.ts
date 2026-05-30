import { readFile } from "node:fs/promises";
import { createCodedError } from "../../../utils/codedError";
import { tryJson } from "../../../utils/json";
import { SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS, SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS, unsafeRegexReason } from "../../../utils/safeRegex";
import { absoluteUrl, headersArrayToMap, parseSetCookieLine } from "./http";
import { asString, isRecord, normalizeHeaderName, positiveInt } from "./normalize";
import type { ReplayOptions } from "./types";

export const MAX_HAR_URL_PATTERN_CHARS = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS;
export const MAX_HAR_URL_MATCH_CHARS = SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS;
export const MAX_HAR_FILTER_CANDIDATE_ENTRIES = 10_000;

type HarDependencyUrlOptions = Pick<ReplayOptions, "baseUrl" | "defaultScheme">;

function harInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "HarInputError", code: "INVALID_RULE", message, details, suppressStack: false });
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
	if (path) {
		const parsed = tryJson(await readFile(path, "utf8"));
		if (parsed === undefined) throw harInputError("harPath must contain valid JSON", { harPath: path });
		har = parsed;
	}
	if (!isRecord(har)) return [];
	const entries = isRecord(har.log) && Array.isArray(har.log.entries) ? har.log.entries.filter(isRecord) : [];
	let selected = entries;
	const maxEntries = Math.min(100, positiveInt(options.harMaxEntries, options.harEntryIndex !== undefined ? 1 : 20));
	if (options.harEntryIndex !== undefined) {
		const index = typeof options.harEntryIndex === "number" ? options.harEntryIndex : Number(options.harEntryIndex);
		if (!Number.isInteger(index) || index < 0) throw harInputError("harEntryIndex must be a zero-based integer", { harEntryIndex: options.harEntryIndex });
		selected = entries[index] ? [entries[index]] : [];
	}
	const patternText = asString(options.harUrlPattern)?.trim();
	if (patternText) {
		const matcher = compileHarUrlMatcher(patternText);
		selected = selected.slice(0, MAX_HAR_FILTER_CANDIDATE_ENTRIES).filter((entry) => matcher(asString(isRecord(entry.request) ? entry.request.url : undefined) || ""));
	}
	return selected.slice(0, maxEntries);
}

export function harHeaderValues(value: unknown, headerName: string): string[] {
	const target = normalizeHeaderName(headerName);
	if (Array.isArray(value)) return value.filter(isRecord).filter((item) => normalizeHeaderName(String(item.name)) === target).map((item) => asString(item.value)).filter((item): item is string => item !== undefined);
	if (isRecord(value)) return Object.entries(value).filter(([name]) => normalizeHeaderName(name) === target).flatMap(([, item]) => Array.isArray(item) ? item.map((part) => asString(part)).filter((part): part is string => part !== undefined) : asString(item) !== undefined ? [String(item)] : []);
	return [];
}

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
			const sharedCookies = previousResponse.cookies.filter((cookie) => cookie?.name && currentCookies.has(String(cookie.name)) && (cookie.value === "" || currentCookies.get(String(cookie.name)) === cookie.value || currentCookies.get(String(cookie.name)) !== undefined));
			if (sharedCookies.length) addEdge(fromIndex, toIndex, "cookie", { cookies: sharedCookies.map((cookie) => cookie?.name).filter(Boolean) });
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
