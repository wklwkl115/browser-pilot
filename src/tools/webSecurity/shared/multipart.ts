import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { setHeaderCaseInsensitive } from "./http";
import { asString, isRecord, stringList } from "./normalize";
import type { HeaderMap } from "./types";

export type MultipartPart = { name: string; filename?: string; contentType?: string; body: Buffer };

function multipartHeaderValue(value: string): string {
	return value.replace(/["\\\r\n]/g, (char) => (char === "\"" ? "%22" : char === "\\" ? "%5C" : ""));
}

function multipartBuffer(value: unknown): Buffer {
	if (isRecord(value) && asString(value.bodyBase64)) return Buffer.from(String(value.bodyBase64), "base64");
	const text = isRecord(value) ? asString(value.content ?? value.body ?? value.value) : asString(value);
	return Buffer.from(text ?? "", "utf8");
}

function multipartPartDescriptor(value: unknown): { body: Buffer; contentType: string } | undefined {
	if (!isRecord(value)) return undefined;
	const multipartValue = isRecord(value.multipart) ? value.multipart : value;
	if (!isRecord(multipartValue)) return undefined;
	const hasDescriptor = Array.isArray(multipartValue.parts) || Array.isArray(multipartValue.files) || Array.isArray(multipartValue.fields) || isRecord(multipartValue.fields);
	if (!hasDescriptor) return undefined;
	const built = buildMultipartBody(multipartValue);
	if (!built) return undefined;
	const contentTypeHint = asString(value.contentType)?.trim() || asString(multipartValue.contentType)?.trim();
	const baseContentType = contentTypeHint && /^multipart\//i.test(contentTypeHint) ? contentTypeHint.replace(/;\s*boundary=.*$/i, "").trim() : "multipart/form-data";
	return { body: built.body, contentType: built.contentType.replace(/^multipart\/form-data/i, baseContentType) };
}

export function multipartPartsFromValue(name: string, value: unknown, existing?: MultipartPart): MultipartPart[] {
	if (Array.isArray(value)) return value.flatMap((item) => multipartPartsFromValue(name, item, existing));
	const nested = multipartPartDescriptor(value);
	if (nested) {
		return [{
			name,
			filename: asString(isRecord(value) ? value.filename : undefined)?.trim() || existing?.filename || "blob",
			contentType: nested.contentType,
			body: nested.body,
		}];
	}
	if (isRecord(value) && (value.filename !== undefined || value.contentType !== undefined || value.content !== undefined || value.body !== undefined || value.bodyBase64 !== undefined)) {
		return [{
			name,
			filename: asString(value.filename)?.trim() || existing?.filename || "blob",
			contentType: asString(value.contentType)?.trim() || existing?.contentType || "application/octet-stream",
			body: multipartBuffer(value),
		}];
	}
	if (existing?.filename) return [{ name, filename: existing.filename, contentType: existing.contentType || "application/octet-stream", body: multipartBuffer({ content: value }) }];
	return [{ name, body: multipartBuffer({ content: typeof value === "string" ? value : JSON.stringify(value) }) }];
}

export function buildMultipartBodyFromParts(parts: MultipartPart[], boundary: string): { body: Buffer; contentType: string } {
	const chunks: Buffer[] = [];
	const append = (text: string) => chunks.push(Buffer.from(text, "utf8"));
	for (const part of parts) {
		if (part.filename) {
			append(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeaderValue(part.name)}"; filename="${multipartHeaderValue(part.filename)}"\r\nContent-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`);
			chunks.push(part.body);
			append("\r\n");
		} else {
			append(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeaderValue(part.name)}"\r\n\r\n`);
			chunks.push(part.body);
			append("\r\n");
		}
	}
	append(`--${boundary}--\r\n`);
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function buildMultipartParts(value: unknown, defaultName?: string): MultipartPart[] {
	if (!isRecord(value)) return [];
	const parts: MultipartPart[] = [];
	const fieldItems: Array<[string, unknown]> = [];
	if (isRecord(value.fields)) for (const [name, fieldValue] of Object.entries(value.fields)) fieldItems.push([name, fieldValue]);
	if (Array.isArray(value.fields)) for (const item of value.fields) if (isRecord(item) && asString(item.name)) fieldItems.push([String(item.name), item.value ?? item.body ?? item.content ?? ""]);
	for (const [name, fieldValue] of fieldItems) parts.push(...multipartPartsFromValue(name, fieldValue));
	if (Array.isArray(value.parts)) {
		for (const item of value.parts) {
			if (!isRecord(item)) continue;
			const name = asString(item.name)?.trim() || defaultName;
			if (!name) continue;
			parts.push(...multipartPartsFromValue(name, item));
		}
	}
	const files = Array.isArray(value.files) ? value.files : [];
	for (const file of files) {
		if (!isRecord(file)) continue;
		const name = asString(file.name)?.trim() || defaultName;
		if (!name) continue;
		parts.push(...multipartPartsFromValue(name, file));
	}
	return parts;
}

export function buildMultipartBody(value: unknown): { body: Buffer; contentType: string; parts: MultipartPart[]; summary: Record<string, unknown> } | undefined {
	const source = isRecord(value) && isRecord(value.multipart) ? value.multipart : value;
	if (!isRecord(source)) return undefined;
	const boundary = asString(source.boundary)?.trim() || `----pi-browser-tools-${randomUUID()}`;
	const parts = buildMultipartParts(source);
	if (!parts.length) return undefined;
	const built = buildMultipartBodyFromParts(parts, boundary);
	return { ...built, parts, summary: summarizeMultipartParts(parts, boundary, "normal") };
}

function multipartBoundaryFromContentType(contentType: string): string | undefined {
	const match = contentType.match(/\bboundary=(?:"([^"]+)"|([^;\s]+))/i);
	return match?.[1] || match?.[2]?.trim();
}

function multipartBodyBuffer(body: string | Buffer | undefined): Buffer {
	if (Buffer.isBuffer(body)) return body;
	return Buffer.from(body || "", "utf8");
}

type MultipartDelimiter = { markerStart: number; bodyEnd: number; nextPartStart: number; closing: boolean };

function delimiterEndsAtLineBoundary(buffer: Buffer, index: number): boolean {
	return index >= buffer.length || buffer[index] === 13 || buffer[index] === 10 || buffer[index] === 32 || buffer[index] === 9;
}

function findMultipartDelimiters(buffer: Buffer, boundary: string): MultipartDelimiter[] {
	const marker = Buffer.from(`--${boundary}`, "latin1");
	const delimiters: MultipartDelimiter[] = [];
	let searchFrom = 0;
	while (searchFrom < buffer.length) {
		const markerStart = buffer.indexOf(marker, searchFrom);
		if (markerStart < 0) break;
		const lineStart = markerStart >= 2 && buffer[markerStart - 2] === 13 && buffer[markerStart - 1] === 10;
		if (markerStart !== 0 && !lineStart) {
			searchFrom = markerStart + 1;
			continue;
		}
		let afterMarker = markerStart + marker.length;
		let closing = false;
		if (buffer[afterMarker] === 45 && buffer[afterMarker + 1] === 45 && delimiterEndsAtLineBoundary(buffer, afterMarker + 2)) {
			closing = true;
			afterMarker += 2;
			while (buffer[afterMarker] === 32 || buffer[afterMarker] === 9) afterMarker += 1;
			if (buffer[afterMarker] === 13 && buffer[afterMarker + 1] === 10) afterMarker += 2;
			else if (buffer[afterMarker] === 10) afterMarker += 1;
		} else if (delimiterEndsAtLineBoundary(buffer, afterMarker)) {
			while (buffer[afterMarker] === 32 || buffer[afterMarker] === 9) afterMarker += 1;
			if (buffer[afterMarker] === 13 && buffer[afterMarker + 1] === 10) afterMarker += 2;
			else if (buffer[afterMarker] === 10) afterMarker += 1;
			else {
				searchFrom = markerStart + 1;
				continue;
			}
		} else {
			searchFrom = markerStart + 1;
			continue;
		}
		delimiters.push({ markerStart, bodyEnd: markerStart === 0 ? markerStart : markerStart - 2, nextPartStart: afterMarker, closing });
		searchFrom = afterMarker;
	}
	return delimiters;
}

function getHeaderCaseInsensitive(headers: HeaderMap, name: string): string | undefined {
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === normalized) return value;
	return undefined;
}

export function parseMultipartBody(body: string | Buffer | undefined, contentType: string): { boundary: string; parts: MultipartPart[] } {
	const boundary = multipartBoundaryFromContentType(contentType);
	if (!boundary) throw new Error("multipart/form-data request is missing boundary");
	const buffer = multipartBodyBuffer(body);
	const delimiters = findMultipartDelimiters(buffer, boundary);
	const parts: MultipartPart[] = [];
	for (let i = 0; i < delimiters.length - 1; i += 1) {
		const current = delimiters[i];
		if (current.closing) break;
		const next = delimiters[i + 1];
		const item = buffer.subarray(current.nextPartStart, next.bodyEnd);
		const splitAt = item.indexOf(Buffer.from("\r\n\r\n", "latin1"));
		if (splitAt < 0) continue;
		const head = item.subarray(0, splitAt).toString("latin1");
		const bodyBuffer = item.subarray(splitAt + 4);
		const headers: HeaderMap = {};
		for (const line of head.split("\r\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
		const disposition = getHeaderCaseInsensitive(headers, "Content-Disposition") || "";
		const name = disposition.match(/\bname="([^"]+)"/)?.[1];
		if (!name) continue;
		const filename = disposition.match(/\bfilename="([^"]*)"/)?.[1] || undefined;
		const partContentType = getHeaderCaseInsensitive(headers, "Content-Type");
		parts.push({ name, filename, contentType: partContentType, body: Buffer.from(bodyBuffer) });
	}
	return { boundary, parts };
}

export function multipartContentTypeVariants(value: unknown): string[] {
	const requested = stringList(value).flatMap((item) => item.split(/[\s,]+/)).map((item) => item.toLowerCase()).filter(Boolean);
	const variants = requested.filter((item) => ["normal", "quoted", "missing-boundary", "mismatch"].includes(item));
	return variants.length ? [...new Set(variants)] : ["normal"];
}

export function setMultipartContentTypeVariant(headers: HeaderMap, boundary: string, variant: string) {
	if (variant === "quoted") setHeaderCaseInsensitive(headers, "Content-Type", `multipart/form-data; boundary="${boundary}"`);
	else if (variant === "missing-boundary") setHeaderCaseInsensitive(headers, "Content-Type", "multipart/form-data");
	else if (variant === "mismatch") setHeaderCaseInsensitive(headers, "Content-Type", `multipart/form-data; boundary=${boundary}-mismatch`);
	else setHeaderCaseInsensitive(headers, "Content-Type", `multipart/form-data; boundary=${boundary}`);
}

export function summarizeMultipartParts(parts: MultipartPart[], boundary: string, contentTypeVariant: string) {
	const nameCounts: Record<string, number> = {};
	const contentTypes: string[] = [];
	const filenames: string[] = [];
	let fieldCount = 0;
	let fileCount = 0;
	let nestedMultipartPartCount = 0;
	for (const part of parts) {
		nameCounts[part.name] = (nameCounts[part.name] || 0) + 1;
		if (part.filename) {
			fileCount += 1;
			if (filenames.length < 20 && !filenames.includes(part.filename)) filenames.push(part.filename);
		} else fieldCount += 1;
		if (part.contentType) {
			if (contentTypes.length < 20 && !contentTypes.includes(part.contentType)) contentTypes.push(part.contentType);
			if (/^multipart\//i.test(part.contentType)) nestedMultipartPartCount += 1;
		}
	}
	const repeatedNameCounts = Object.entries(nameCounts)
		.filter(([, count]) => count > 1)
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 20);
	return { boundary, contentTypeVariant, partCount: parts.length, fieldCount, fileCount, nestedMultipartPartCount, repeatedNameCounts, filenames, contentTypes };
}
