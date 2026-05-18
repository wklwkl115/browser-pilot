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

export function parseMultipartBody(body: string | Buffer | undefined, contentType: string): { boundary: string; parts: MultipartPart[] } {
	const boundary = multipartBoundaryFromContentType(contentType);
	if (!boundary) throw new Error("multipart/form-data request is missing boundary");
	const raw = multipartBodyBuffer(body).toString("latin1");
	const segments = raw.split(`--${boundary}`);
	const parts: MultipartPart[] = [];
	for (const segment of segments) {
		let item = segment;
		if (!item || item === "--\r\n" || item === "--" || item === "\r\n") continue;
		if (item.startsWith("\r\n")) item = item.slice(2);
		if (item.endsWith("\r\n")) item = item.slice(0, -2);
		if (item.endsWith("--")) item = item.slice(0, -2);
		const splitAt = item.indexOf("\r\n\r\n");
		if (splitAt < 0) continue;
		const head = item.slice(0, splitAt);
		const bodyText = item.slice(splitAt + 4);
		const headers: HeaderMap = {};
		for (const line of head.split("\r\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
		const disposition = headers["Content-Disposition"] || headers["content-disposition"] || "";
		const name = disposition.match(/\bname="([^"]+)"/)?.[1];
		if (!name) continue;
		const filename = disposition.match(/\bfilename="([^"]*)"/)?.[1] || undefined;
		const partContentType = headers["Content-Type"] || headers["content-type"] || undefined;
		parts.push({ name, filename, contentType: partContentType, body: Buffer.from(bodyText, "latin1") });
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
