import type { Summary } from "./common.js";
import { isRecord } from "./common.js";

function maybeString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function summarizeTransferData(value: unknown): Summary {
	const envelope = isRecord(value) ? value : {};
	const data = isRecord(envelope.data) ? envelope.data : envelope;
	const download = isRecord(data.download) ? data.download : undefined;
	const lines: string[] = [];
	const items: Record<string, unknown>[] = [];
	const mimeMismatch = isRecord(data.mimeMismatch) ? data.mimeMismatch : undefined;
	if (download) {
		const id = data.downloadId ?? download.id;
		const path = maybeString(data.path) ?? maybeString(download.path) ?? maybeString(download.filename);
		lines.push(`download ${id ?? "?"}: ${download.state ?? "unknown"}${path ? ` -> ${path}` : ""}`);
		if (mimeMismatch) lines.push(`⚠ mime mismatch: expected ${mimeMismatch.expected}, got ${mimeMismatch.actual}`);
		items.push({ id, state: download.state, path, url: download.finalUrl ?? download.url, mime: download.mime, bytesReceived: download.bytesReceived, totalBytes: download.totalBytes, danger: download.danger });
	} else if (data.uploaded === true) {
		lines.push(`uploaded ${data.files_count ?? "?"} file(s) to ${maybeString(data.selector) ?? "selector"}`);
		items.push({ uploaded: true, files_count: data.files_count, selector: data.selector, isMultiple: data.isMultiple, mode: data.mode });
	} else {
		lines.push("transfer result");
		items.push(data);
	}
	return { lines, items, stats: { count: items.length }, ...(mimeMismatch ? { mimeMismatch } : {}) };
}
