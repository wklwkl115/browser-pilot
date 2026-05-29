import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import tls from "node:tls";
import { asString, DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, defaultScheme, isRecord, normalizeHeaderName, normalizeMethod, numericList, positiveInt, sha256Hex, stringList } from "./normalize";
import type { FetchExchange, FetchRequest, FetchStep, HeaderMap, ProbeOptions, WebFetchOptions } from "./types";

export const TEXTUAL_CONTENT_TYPE = /(?:^|[\s;/+.-])(text|json|xml|html|javascript|ecmascript|x-www-form-urlencoded|svg|graphql)(?:[\s;/+.-]|$)/i;
export const REDACTED_HEADER_NAMES = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token"]);
export const FETCH_OMIT_HEADER_NAMES = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "proxy-connection", "expect"]);

export type CookieSample = { source: string; name?: string; value: string; attributes?: Record<string, string | boolean> };
export type ResponseFingerprint = { status: number; title?: string; bodyBytes: number; bodySha256: string; location?: string };

const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata.google.internal.", "metadata", "metadata.azure", "metadata.azure.internal"]);

function privateTargetError(url: string, host: string, address: string, kind: string): Error {
	const error = new Error(`Private or metadata target requires explicit allowPrivateTargets opt-in: ${url}`) as Error & { code?: string; details?: Record<string, unknown> };
	error.name = "PrivateTargetBlocked";
	error.code = "PRIVATE_TARGET_BLOCKED";
	error.details = { url, host, address, kind };
	return error;
}

function isLoopbackAddress(address: string): boolean {
	return address === "127.0.0.1" || address === "::1" || /^127\./.test(address);
}

function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map((item) => Number(item));
	if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false;
	return parts[0] === 10
		|| (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
		|| (parts[0] === 192 && parts[1] === 168)
		|| (parts[0] === 169 && parts[1] === 254);
}

function isPrivateIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized === "::1";
}

export async function assertAllowedTargetUrl(url: string, options: { allowPrivateTargets?: boolean; allowLoopback?: boolean } = {}): Promise<void> {
	const parsed = new URL(url);
	const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	if (options.allowPrivateTargets) return;
	if (METADATA_HOSTS.has(host)) throw privateTargetError(url, host, host, "metadata_host");
	if (host === "localhost") {
		if (options.allowLoopback === false) throw privateTargetError(url, host, host, "loopback_host");
		return;
	}
	if (isIP(host)) {
		if (isLoopbackAddress(host)) {
			if (options.allowLoopback === false) throw privateTargetError(url, host, host, "loopback_ip");
			return;
		}
		if ((isIP(host) === 4 && isPrivateIpv4(host)) || (isIP(host) === 6 && isPrivateIpv6(host))) throw privateTargetError(url, host, host, "private_ip_literal");
		return;
	}
	const resolved = await lookup(host, { all: true, verbatim: true }).catch(() => []);
	for (const item of resolved) {
		const address = String(item.address || "");
		if (!address) continue;
		if (isLoopbackAddress(address)) {
			if (options.allowLoopback === false) throw privateTargetError(url, host, address, "loopback_dns");
			continue;
		}
		if ((item.family === 4 && isPrivateIpv4(address)) || (item.family === 6 && isPrivateIpv6(address))) throw privateTargetError(url, host, address, "private_dns");
	}
}

export function normalizeHeaders(value: unknown): HeaderMap {
	const out: HeaderMap = {};
	if (!isRecord(value)) return out;
	for (const [rawName, rawValue] of Object.entries(value)) {
		const name = rawName.trim();
		if (!name || name.startsWith(":")) continue;
		if (rawValue === undefined || rawValue === null) continue;
		if (Array.isArray(rawValue)) out[name] = rawValue.map((item) => asString(item) ?? "").join(", ");
		else out[name] = asString(rawValue) ?? JSON.stringify(rawValue);
	}
	return out;
}

export function headersArrayToMap(value: unknown): HeaderMap {
	if (!Array.isArray(value)) return normalizeHeaders(value);
	const out: HeaderMap = {};
	for (const item of value) {
		if (!isRecord(item)) continue;
		const name = asString(item.name ?? item.key);
		const val = asString(item.value ?? item.val);
		if (name && val !== undefined) out[name] = val;
	}
	return out;
}

export function redactHeaders(headers: HeaderMap): HeaderMap {
	const out: HeaderMap = {};
	for (const [name, value] of Object.entries(headers)) out[name] = REDACTED_HEADER_NAMES.has(normalizeHeaderName(name)) ? "[redacted]" : value;
	return out;
}

function responseHeadersToMap(headers: Headers): { headers: HeaderMap; setCookie: string[] } {
	const out: HeaderMap = {};
	for (const [name, value] of headers.entries()) out[name] = value;
	const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
	const setCookie = typeof getSetCookie === "function" ? getSetCookie.call(headers) : (headers.get("set-cookie") ? [String(headers.get("set-cookie"))] : []);
	return { headers: out, setCookie };
}

export function absoluteUrl(input: unknown, options: { baseUrl?: unknown; scheme?: unknown } = {}): string {
	const raw = asString(input)?.trim();
	if (!raw) throw new Error("A URL is required");
	try {
		return new URL(raw).toString();
	} catch {}
	const base = asString(options.baseUrl)?.trim();
	if (base) return new URL(raw, absoluteUrl(base, { scheme: options.scheme })).toString();
	if (/^[A-Za-z0-9.-]+(?::\d+)?(?:\/.*)?$/.test(raw)) return new URL(`${defaultScheme(options.scheme)}://${raw}`).toString();
	throw new Error(`Invalid URL: ${raw}`);
}

export function normalizeProbeTargets(options: Pick<ProbeOptions, "url" | "urls" | "paths" | "ports" | "schemes" | "defaultScheme">): string[] {
	const rawTargets = Array.isArray(options.urls) ? [...options.urls] : options.urls !== undefined ? [options.urls] : [];
	if (options.url !== undefined) rawTargets.unshift(options.url);
	if (!rawTargets.length) throw new Error("browser_recon_probe requires url or urls");
	const paths = Array.isArray(options.paths) ? options.paths : options.paths !== undefined ? [options.paths] : [];
	const schemes = stringList(options.schemes).map((item) => item.toLowerCase()).filter((item) => item === "http" || item === "https");
	const ports = numericList(options.ports).filter((port) => port > 0 && port <= 65_535);
	const targets: string[] = [];
	for (const item of rawTargets) {
		const raw = asString(item)?.trim() || "";
		const baseUrls = schemes.length ? schemes.map((scheme) => {
			const current = absoluteUrl(raw, { scheme });
			const parsed = new URL(current);
			parsed.protocol = `${scheme}:`;
			return parsed.toString();
		}) : [absoluteUrl(raw, { scheme: options.defaultScheme })];
		for (const baseUrl of baseUrls) {
			const portUrls = ports.length ? ports.map((port) => {
				const parsed = new URL(baseUrl);
				parsed.port = String(port);
				return parsed.toString();
			}) : [baseUrl];
			for (const portUrl of portUrls) {
				if (paths.length) for (const path of paths) targets.push(new URL(asString(path) || "/", portUrl).toString());
				else targets.push(portUrl);
			}
		}
	}
	return [...new Set(targets)];
}

export function parseCookieHeader(header: string | undefined): Map<string, string> {
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

export function mergeCookieHeaders(left: string | undefined, right: string | undefined): string | undefined {
	const map = parseCookieHeader(left);
	for (const [name, value] of parseCookieHeader(right)) map.set(name, value);
	const merged = Array.from(map.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
	return merged || undefined;
}

export function setCookieHeader(headers: HeaderMap, value: string | undefined) {
	delete headers.Cookie;
	delete headers.cookie;
	if (value) headers.Cookie = value;
}

function cookiesToHeader(cookies: unknown): string | undefined {
	const items = Array.isArray(cookies) ? cookies : isRecord(cookies) && Array.isArray(cookies.data) ? cookies.data : [];
	const pairs: string[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const name = asString(item.name)?.trim();
		const value = asString(item.value);
		if (name && value !== undefined) pairs.push(`${name}=${value}`);
	}
	return pairs.length ? pairs.join("; ") : undefined;
}

export function browserCookiesToHeader(cookies: unknown): string | undefined {
	return cookiesToHeader(cookies);
}

export function parseSetCookieLine(raw: string, source: string): CookieSample | undefined {
	const line = raw.replace(/^set-cookie\s*:\s*/i, "").trim();
	const parts = line.split(";").map((part) => part.trim()).filter(Boolean);
	const first = parts.shift();
	if (!first) return undefined;
	const idx = first.indexOf("=");
	if (idx <= 0) return undefined;
	const attributes: Record<string, string | boolean> = {};
	for (const attr of parts) {
		const eq = attr.indexOf("=");
		if (eq > 0) attributes[attr.slice(0, eq).trim().toLowerCase()] = attr.slice(eq + 1).trim();
		else attributes[attr.toLowerCase()] = true;
	}
	return { source, name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim(), attributes };
}

export function sanitizeFetchHeaders(headers: HeaderMap): { headers: HeaderMap; omittedHeaderNames: string[] } {
	const out: HeaderMap = {};
	const omittedHeaderNames: string[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const lower = normalizeHeaderName(name);
		if (!lower || lower.startsWith(":") || FETCH_OMIT_HEADER_NAMES.has(lower)) {
			omittedHeaderNames.push(name);
			continue;
		}
		out[name] = value;
	}
	return { headers: out, omittedHeaderNames };
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<{ bodyText: string; bodyBytes: number; bodyTruncated: boolean; bodyBase64?: string }> {
	if (!response.body) return { bodyText: "", bodyBytes: 0, bodyTruncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = maxBytes - total;
		if (remaining > 0) {
			const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
			chunks.push(slice);
			total += slice.byteLength;
		}
		if (value.byteLength > remaining) {
			truncated = true;
			try {
				await reader.cancel();
			} catch {}
			break;
		}
	}
	const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	const contentType = response.headers.get("content-type") || "";
	if (!TEXTUAL_CONTENT_TYPE.test(contentType) && buffer.length > 0) return { bodyText: "", bodyBytes: buffer.length, bodyTruncated: truncated, bodyBase64: buffer.toString("base64") };
	return { bodyText: buffer.toString("utf8"), bodyBytes: buffer.length, bodyTruncated: truncated };
}

export function extractTitle(bodyText: string): string | undefined {
	const match = bodyText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) : undefined;
}

function extractMetaGenerator(bodyText: string): string | undefined {
	const match = bodyText.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i) || bodyText.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
	return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 160) : undefined;
}

function pushTechHint(out: Array<Record<string, unknown>>, seen: Set<string>, hint: Record<string, unknown>) {
	const key = JSON.stringify([hint.category, hint.label, hint.source, hint.name, hint.pattern]);
	if (seen.has(key)) return;
	seen.add(key);
	out.push(hint);
}

function productLabel(value: string): string {
	return value.split(/[;,]/)[0]?.split("/")[0]?.trim() || value.trim();
}

function murmurHash3_32(buffer: Buffer, seed = 0): number {
	const c1 = 0xcc9e2d51;
	const c2 = 0x1b873593;
	let hash = seed >>> 0;
	const blockCount = Math.floor(buffer.length / 4);
	for (let i = 0; i < blockCount; i += 1) {
		let k = buffer.readUInt32LE(i * 4);
		k = Math.imul(k, c1);
		k = (k << 15) | (k >>> 17);
		k = Math.imul(k, c2);
		hash ^= k;
		hash = (hash << 13) | (hash >>> 19);
		hash = (Math.imul(hash, 5) + 0xe6546b64) >>> 0;
	}
	let tail = 0;
	const offset = blockCount * 4;
	switch (buffer.length & 3) {
		case 3: tail ^= buffer[offset + 2] << 16;
		case 2: tail ^= buffer[offset + 1] << 8;
		case 1:
			tail ^= buffer[offset];
			tail = Math.imul(tail, c1);
			tail = (tail << 15) | (tail >>> 17);
			tail = Math.imul(tail, c2);
			hash ^= tail;
	}
	hash ^= buffer.length;
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return hash | 0;
}

function shodanFaviconMmh3(buffer: Buffer): number {
	const wrapped = `${buffer.toString("base64").match(/.{1,76}/g)?.join("\n") || ""}\n`;
	return murmurHash3_32(Buffer.from(wrapped, "utf8"), 0);
}

function simHash64(buffer: Buffer): string {
	if (!buffer.length) return "0000000000000000";
	const weights = new Array<number>(64).fill(0);
	for (let offset = 0; offset < buffer.length; offset += 16) {
		const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + 16));
		const digest = createHash("sha256").update(chunk).update(Buffer.from([chunk.length])).digest();
		const weight = Math.max(1, chunk.length);
		for (let bit = 0; bit < 64; bit += 1) {
			const set = (digest[bit >> 3] & (1 << (bit & 7))) !== 0;
			weights[bit] += set ? weight : -weight;
		}
	}
	let out = 0n;
	for (let bit = 0; bit < 64; bit += 1) if (weights[bit] >= 0) out |= 1n << BigInt(bit);
	return out.toString(16).padStart(16, "0");
}

export function detectTechHints(headers: HeaderMap, bodyText: string, setCookie: string[]): Array<Record<string, unknown>> {
	const hints: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	const server = headers.server || headers.Server;
	const powered = headers["x-powered-by"] || headers["X-Powered-By"];
	if (server) pushTechHint(hints, seen, { source: "header", category: "server", name: "server", value: server, label: productLabel(server), confidence: "high" });
	if (powered) pushTechHint(hints, seen, { source: "header", category: "framework", name: "x-powered-by", value: powered, label: productLabel(powered), confidence: "high" });
	const generator = extractMetaGenerator(bodyText);
	if (generator) pushTechHint(hints, seen, { source: "meta", category: "generator", name: "generator", value: generator, label: productLabel(generator), confidence: "medium" });
	const haystack = bodyText.slice(0, 300_000).toLowerCase();
	for (const entry of [
		{ label: "Next.js", category: "framework", patterns: ["__next_data__", "/_next/"] },
		{ label: "WordPress", category: "cms", patterns: ["wp-content", "wp-includes"] },
		{ label: "React", category: "framework", patterns: ["data-reactroot", "react-dom", "__react"] },
		{ label: "Vue", category: "framework", patterns: ["__vue__", "data-v-"] },
		{ label: "Angular", category: "framework", patterns: ["ng-version", "ng-app", "angular.js"] },
		{ label: "jQuery", category: "library", patterns: ["jquery", "$.ajax"] },
		{ label: "Vite", category: "build-tool", patterns: ["/@vite/client", "vite.svg", "__vite__"] },
	]) {
		const pattern = entry.patterns.find((item) => haystack.includes(item));
		if (pattern) pushTechHint(hints, seen, { source: "body", category: entry.category, pattern, label: entry.label, confidence: "medium" });
	}
	const cookieText = setCookie.join("\n").toLowerCase();
	for (const entry of [
		{ label: "PHP", category: "runtime", pattern: "phpsessid" },
		{ label: "Express session", category: "session", pattern: "connect.sid" },
		{ label: "Django CSRF", category: "session", pattern: "csrftoken" },
		{ label: "Laravel session", category: "session", pattern: "laravel_session" },
		{ label: "JSESSIONID", category: "session", pattern: "jsessionid" },
		{ label: "ASP.NET session", category: "session", pattern: "asp.net_sessionid" },
	]) if (cookieText.includes(entry.pattern)) pushTechHint(hints, seen, { source: "cookie", category: entry.category, pattern: entry.pattern, label: entry.label, confidence: "medium" });
	return hints.slice(0, 30);
}

export function detectFingerprints(headers: HeaderMap, bodyText: string, setCookie: string[]): Array<Record<string, unknown>> {
	const hints = detectTechHints(headers, bodyText, setCookie);
	const fingerprints: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	for (const hint of hints) {
		const label = asString(hint.label) || asString(hint.value);
		if (!label) continue;
		const key = `${hint.category}:${label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		fingerprints.push({ label, category: hint.category, source: hint.source, confidence: hint.confidence });
	}
	return fingerprints.slice(0, 20);
}

export function detectTech(headers: HeaderMap, bodyText: string, setCookie: string[]): string[] {
	const found = new Set<string>();
	for (const hint of detectTechHints(headers, bodyText, setCookie)) {
		const source = asString(hint.source);
		const label = asString(hint.label) || asString(hint.value);
		if (!label) continue;
		if (source === "header" && hint.name) found.add(`${hint.name}:${label}`);
		else found.add(label);
	}
	return Array.from(found).slice(0, 20);
}

export function redirectLocation(status: number, headers: HeaderMap, url: string): string | undefined {
	if (status < 300 || status >= 400) return undefined;
	const location = headers.location || headers.Location;
	if (!location) return undefined;
	try {
		return new URL(location, url).toString();
	} catch {
		return undefined;
	}
}

export function redirectMethod(method: string, status: number): string {
	return status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD") ? "GET" : method;
}

export async function fetchSingle(request: FetchRequest, options: Required<Pick<WebFetchOptions, "timeoutMs" | "maxBodyBytes">> & Pick<WebFetchOptions, "allowPrivateTargets">): Promise<FetchStep> {
	await assertAllowedTargetUrl(request.url, { allowPrivateTargets: options.allowPrivateTargets, allowLoopback: true });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const startedAt = Date.now();
	try {
		const init: RequestInit = { method: request.method, headers: request.headers, redirect: "manual", signal: controller.signal };
		if (request.body !== undefined && request.method !== "GET" && request.method !== "HEAD") init.body = request.body as BodyInit;
		const response = await fetch(request.url, init);
		const { headers, setCookie } = responseHeadersToMap(response.headers);
		const body = request.method === "HEAD" ? { bodyText: "", bodyBytes: 0, bodyTruncated: false } : await readBodyLimited(response, options.maxBodyBytes);
		return {
			url: request.url,
			status: response.status,
			statusText: response.statusText,
			ok: response.ok,
			headers,
			setCookie,
			elapsedMs: Date.now() - startedAt,
			...body,
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchWithRedirects(request: FetchRequest, options: WebFetchOptions): Promise<FetchExchange> {
	const followRedirects = options.followRedirects === true;
	const allowPrivateTargets = options.allowPrivateTargets === true;
	const maxRedirects = positiveInt(options.maxRedirects, followRedirects ? 5 : 0);
	const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const maxBodyBytes = positiveInt(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
	const chain: FetchStep[] = [];
	let current = { ...request };
	for (let i = 0; i <= maxRedirects; i += 1) {
		const step = await fetchSingle(current, { timeoutMs, maxBodyBytes, allowPrivateTargets });
		chain.push(step);
		const nextUrl = followRedirects ? redirectLocation(step.status, step.headers, current.url) : undefined;
		if (!nextUrl) break;
		const nextMethod = redirectMethod(current.method, step.status);
		current = { url: nextUrl, method: nextMethod, headers: { ...current.headers }, body: nextMethod === current.method ? current.body : undefined };
	}
	return { chain, final: chain[chain.length - 1] };
}

export function responseBodyHash(step: FetchStep): string {
	if (step.bodyBase64) return sha256Hex(Buffer.from(step.bodyBase64, "base64"));
	return sha256Hex(step.bodyText || "");
}

export async function fetchFaviconHash(url: string, headers: HeaderMap, options: WebFetchOptions): Promise<Record<string, unknown> | undefined> {
	const faviconUrl = new URL("/favicon.ico", url).toString();
	const sanitized = sanitizeFetchHeaders(headers);
	try {
		const icon = await fetchSingle({ url: faviconUrl, method: "GET", headers: sanitized.headers }, { timeoutMs: positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS), maxBodyBytes: Math.min(256_000, positiveInt(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)), allowPrivateTargets: options.allowPrivateTargets === true });
		const buffer = icon.bodyBase64 ? Buffer.from(icon.bodyBase64, "base64") : Buffer.from(icon.bodyText || "", "utf8");
		return { url: faviconUrl, status: icon.status, contentType: contentTypeOf(icon.headers), bodyBytes: icon.bodyBytes, sha256: responseBodyHash(icon), mmh3: buffer.length ? shodanFaviconMmh3(buffer) : 0, simHash64: simHash64(buffer), bodyTruncated: icon.bodyTruncated };
	} catch (error) {
		return { url: faviconUrl, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function inspectTlsCertificate(url: string, timeoutMs: number, options: Pick<WebFetchOptions, "allowPrivateTargets"> = {}): Promise<Record<string, unknown> | undefined> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") return undefined;
	await assertAllowedTargetUrl(url, { allowPrivateTargets: options.allowPrivateTargets, allowLoopback: true });
	return await new Promise((resolve) => {
		const socket = tls.connect({ host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 443, servername: parsed.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
			const cert = socket.getPeerCertificate(true);
			socket.destroy();
			if (!cert || !Object.keys(cert).length) return resolve(undefined);
			resolve({ subject: cert.subject, issuer: cert.issuer, subjectaltname: cert.subjectaltname, validFrom: cert.valid_from, validTo: cert.valid_to, fingerprint256: cert.fingerprint256, serialNumber: cert.serialNumber });
		});
		socket.on("timeout", () => {
			socket.destroy();
			resolve({ error: `TLS certificate inspection timed out after ${timeoutMs}ms` });
		});
		socket.on("error", (error) => resolve({ error: error instanceof Error ? error.message : String(error) }));
	});
}

export function compactStep(step: FetchStep) {
	return {
		url: step.url,
		status: step.status,
		statusText: step.statusText,
		location: redirectLocation(step.status, step.headers, step.url),
		elapsedMs: step.elapsedMs,
		headers: redactHeaders(step.headers),
		headerNames: Object.keys(step.headers),
		bodyBytes: step.bodyBytes,
		bodyTruncated: step.bodyTruncated,
	};
}

export function contentTypeOf(headers: HeaderMap): string {
	return headers["content-type"] || headers["Content-Type"] || "";
}

export function responseFingerprint(final: FetchStep): ResponseFingerprint {
	return { status: final.status, title: extractTitle(final.bodyText), bodyBytes: final.bodyBytes, bodySha256: responseBodyHash(final), location: redirectLocation(final.status, final.headers, final.url) };
}

export function responseDistance(left: ResponseFingerprint, right: ResponseFingerprint): number {
	let score = Math.abs(left.bodyBytes - right.bodyBytes);
	if (left.status !== right.status) score += 10_000;
	if (left.title !== right.title) score += 2_000;
	if (left.location !== right.location) score += 2_000;
	if (left.bodySha256 !== right.bodySha256) score += 500;
	return score;
}

export function responsesDiffer(left: ResponseFingerprint, right: ResponseFingerprint): boolean {
	return left.status !== right.status || left.title !== right.title || left.bodyBytes !== right.bodyBytes || left.bodySha256 !== right.bodySha256 || left.location !== right.location;
}

export function setHeaderCaseInsensitive(headers: HeaderMap, name: string, value: string) {
	for (const key of Object.keys(headers)) if (normalizeHeaderName(key) === normalizeHeaderName(name)) delete headers[key];
	headers[name] = value;
}
