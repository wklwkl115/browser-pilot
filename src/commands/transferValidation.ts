import { stat } from "node:fs/promises";
import path from "node:path";
import { nativeTransferToolMetadata } from "../bridge/protocol/nativeActionMetadata.js";
import type { NativeErrorCode } from "../bridge/protocol/nativeErrorCodes.js";
import { createCodedError } from "../utils/codedError.js";

export function codedTransferError(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "TransferToolError", code, message, details });
}

export function asUploadFiles(value: unknown): string[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return values.map((item) => String(item || "").trim()).filter(Boolean);
}

export function requireDownloadTarget(params: Record<string, unknown>): void {
	const hasUrl = typeof params.url === "string" && params.url.trim();
	const hasSelector = typeof params.selector === "string" && params.selector.trim();
	if (!hasUrl && !hasSelector) throw codedTransferError("DOWNLOAD_TARGET_REQUIRED", "browser_download requires selector or url", {});
}

export type TransferDownloadMode = "click" | "media" | "url";

export function normalizeTransferDownloadMode(params: Record<string, unknown>): TransferDownloadMode {
	const hasUrl = typeof params.url === "string" && params.url.trim();
	const rawMode = params.mode;
	if (rawMode === undefined || rawMode === null || rawMode === "") return hasUrl ? "url" : "click";
	if (typeof rawMode !== "string") {
		throw codedTransferError("INVALID_RULE", "browser_download mode must be one of click, media, or url", { mode: rawMode, allowedModes: ["click", "media", "url"] });
	}
	const mode = rawMode.trim().toLowerCase();
	if (!["click", "media", "url"].includes(mode)) {
		throw codedTransferError("INVALID_RULE", "browser_download mode must be one of click, media, or url", { mode: rawMode, allowedModes: ["click", "media", "url"] });
	}
	if (hasUrl && mode !== "url") {
		throw codedTransferError("INVALID_RULE", "browser_download url target only accepts mode:url or omitted mode", { mode, target: "url", allowedModes: ["url"] });
	}
	if (!hasUrl && mode === "url") {
		throw codedTransferError("INVALID_RULE", "browser_download selector target only accepts mode:click, mode:media, or omitted mode", { mode, target: "selector", allowedModes: ["click", "media"] });
	}
	return mode as TransferDownloadMode;
}

export function requireUploadConfirmation(confirm: unknown, selector: unknown): void {
	if (confirm !== true) throw codedTransferError("UPLOAD_CONFIRMATION_REQUIRED", "browser_upload requires confirm:true after user approval", { selector });
}

export function rejectUnsafeExecuteCommand(command: { cmd?: unknown }): void {
	if (String(command?.cmd || "") === nativeTransferToolMetadata.browser_upload.command) {
		throw codedTransferError("UPLOAD_REQUIRES_BROWSER_UPLOAD", "transfer.upload must be invoked through browser_upload so confirm:true and file path validation are enforced", {});
	}
}

export async function checkedUploadFiles(value: unknown): Promise<string[]> {
	const files = asUploadFiles(value);
	if (!files.length) throw codedTransferError("UPLOAD_FILES_REQUIRED", "browser_upload requires at least one file", {});
	if (files.length > 50) throw codedTransferError("UPLOAD_FILES_LIMIT", "browser_upload accepts at most 50 files", { count: files.length, max: 50 });
	const resolved: string[] = [];
	for (const file of files) {
		if (!path.isAbsolute(file)) throw codedTransferError("UPLOAD_PATH_NOT_ABSOLUTE", "browser_upload requires absolute file paths", { path: file });
		let info;
		try { info = await stat(file); }
		catch (error) { throw codedTransferError("UPLOAD_FILE_NOT_FOUND", "browser_upload file does not exist", { path: file, cause: error instanceof Error ? error.message : String(error) }); }
		if (!info.isFile()) throw codedTransferError("UPLOAD_PATH_NOT_FILE", "browser_upload path is not a file", { path: file });
		resolved.push(path.resolve(file));
	}
	return resolved;
}

export function buildTransferDownloadCommand(params: Record<string, unknown>): Record<string, unknown> {
	const hasUrl = typeof params.url === "string" && params.url.trim();
	const hasSelector = typeof params.selector === "string" && params.selector.trim();
	const mode = normalizeTransferDownloadMode(params);
	return {
		cmd: nativeTransferToolMetadata.browser_download.command,
		selector: hasSelector ? String(params.selector).trim() : undefined,
		url: hasUrl ? String(params.url).trim() : undefined,
		mode,
		index: params.index,
		filename: params.filename,
		conflictAction: params.conflictAction,
		saveAs: params.saveAs,
	};
}

export function buildTransferUploadCommand(selector: string, files: string[], index: unknown): Record<string, unknown> {
	return { cmd: nativeTransferToolMetadata.browser_upload.command, selector, files, index };
}
