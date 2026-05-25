import { Buffer } from "node:buffer";
import { absoluteUrl, headersArrayToMap, normalizeHeaders, setHeaderCaseInsensitive } from "./http";
import { buildMultipartBody } from "./multipart";
import { asString, defaultScheme, isRecord, normalizeHeaderName, normalizeMethod } from "./normalize";
import type { HeaderMap, ReplayOptions, ReplayRequest } from "./types";

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
