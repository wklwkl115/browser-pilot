import { stat } from "node:fs/promises";
import path from "node:path";

export function codedTransferError(code: string, message: string, details: Record<string, unknown> = {}): Error {
	const error = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
	error.name = "TransferToolError";
	error.code = code;
	error.details = details;
	delete error.stack;
	return error;
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

export function requireUploadConfirmation(confirm: unknown, selector: unknown): void {
	if (confirm !== true) throw codedTransferError("UPLOAD_CONFIRMATION_REQUIRED", "browser_upload requires confirm:true after user approval", { selector });
}

export function rejectUnsafeExecuteCommand(command: { cmd?: unknown }): void {
	if (String(command?.cmd || "") === "transfer.upload") {
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
	return {
		cmd: "transfer.download",
		selector: hasSelector ? String(params.selector).trim() : undefined,
		url: hasUrl ? String(params.url).trim() : undefined,
		mode: hasUrl ? "url" : params.mode,
		index: params.index,
		filename: params.filename,
		conflictAction: params.conflictAction,
		saveAs: params.saveAs,
	};
}

export function buildTransferUploadCommand(selector: string, files: string[], index: unknown): Record<string, unknown> {
	return { cmd: "transfer.upload", selector, files, index };
}
