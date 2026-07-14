import { Type } from "typebox";
import { buildTransferDownloadCommand, buildTransferUploadCommand, checkedUploadFiles, codedTransferError, requireDownloadTarget, requireUploadConfirmation } from "./transferValidation.js";
import { defineBrowserCommand, runCommandHandler, sharedTabScopedToolParams, targetTabId, commandMaxChars, commandTimeoutMs } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { isRecord } from "../utils/records.js";
import { resolveLocalTargetTabId } from "./commandRuntime.js";
import { withBrowserOperation } from "./browserOperation.js";
import { browserOperationCommandResult } from "./browserOperationResult.js";
import path from "node:path";
import type { ValidationIssue } from "./commandDefinition.js";

export function validateDownloadArguments(args: Record<string, unknown>): ValidationIssue[] {
	const hasUrl = typeof args.url === "string" && args.url.trim().length > 0;
	const hasSelector = typeof args.selector === "string" && args.selector.trim().length > 0;
	const issues: ValidationIssue[] = [];
	if (!hasUrl && !hasSelector) issues.push({ code: "DOWNLOAD_TARGET_REQUIRED", path: "/", message: "browser_download requires selector or url" });
	if (hasUrl && hasSelector) issues.push({ code: "DOWNLOAD_TARGET_CONFLICT", path: "/", message: "browser_download accepts selector or url, not both" });
	if (hasUrl && args.mode !== undefined && args.mode !== "url") issues.push({ code: "DOWNLOAD_MODE_TARGET_CONFLICT", path: "/mode", message: "browser_download url target only accepts mode:url or omitted mode" });
	if (hasSelector && args.mode === "url") issues.push({ code: "DOWNLOAD_MODE_TARGET_CONFLICT", path: "/mode", message: "browser_download selector target accepts mode:click, mode:media, or omitted mode" });
	if (!hasUrl && (args.conflictAction !== undefined || args.saveAs !== undefined)) issues.push({ code: "DOWNLOAD_URL_OPTION_REQUIRES_URL", path: "/", message: "browser_download conflictAction/saveAs are only valid with a url target" });
	return issues;
}

export function validateUploadArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (args.confirm !== true) issues.push({ code: "UPLOAD_CONFIRMATION_REQUIRED", path: "/confirm", message: "browser_upload requires confirm:true after user approval" });
	if (typeof args.selector !== "string" || !args.selector.trim()) issues.push({ code: "UPLOAD_SELECTOR_REQUIRED", path: "/selector", message: "browser_upload requires a non-empty selector" });
	const files = Array.isArray(args.files) ? args.files : [];
	if (!files.length) issues.push({ code: "UPLOAD_FILES_REQUIRED", path: "/files", message: "browser_upload requires at least one file" });
	if (files.length > 50) issues.push({ code: "UPLOAD_FILES_LIMIT", path: "/files", message: "browser_upload accepts at most 50 files" });
	files.forEach((file, index) => {
		if (typeof file === "string" && file.trim() && !path.isAbsolute(file)) issues.push({ code: "UPLOAD_PATH_NOT_ABSOLUTE", path: `/files/${index}`, message: "browser_upload requires absolute file paths" });
	});
	return issues;
}

// B9b: a media/image download that silently completes with a `text/html` body (an anti-bot or redirect
// page) looked like success. When the caller expects a media MIME, compare the completed download's MIME
// and flag a `mimeMismatch` diagnostic — the file is still saved, but the agent is told it isn't the
// intended media (instead of discovering it only by opening the file).
function mimeMatchesExpectation(mime: string, expect: string): boolean {
	const m = mime.toLowerCase();
	if (expect === "image" || expect === "media") return /^(image|video|audio)\//.test(m);
	return m === expect || m.startsWith(expect);
}

function annotateDownloadMimeMismatch(result: unknown, expectMime: string): void {
	const data = isRecord(result) && isRecord(result.data) ? result.data : undefined;
	const download = data && isRecord(data.download) ? data.download : undefined;
	const mime = download && typeof download.mime === "string" ? download.mime : undefined;
	if (!data || !mime) return;
	if (!mimeMatchesExpectation(mime, expectMime)) {
		data.mimeMismatch = {
			expected: expectMime,
			actual: mime,
			note: `downloaded content is ${mime}, not the expected ${expectMime} — the file was saved but is likely an anti-bot/redirect HTML page, not the intended media. Verify the URL or refetch via browser_http_replay.`,
		};
	}
}

export function defineDownloadCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_download",
		label: "Browser Download",
		description: "Trigger or wait for a browser download and return the completed local file path from Chrome downloads.",
		promptSnippet: "Download via selector click, media selector extraction, or direct HTTP(S) URL; returns download id/path/state.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_download when the task needs a stable downloaded file path instead of scripting a click manually."],
		parameters: strictCommandParameters({
			...sharedTabScopedToolParams(),
			selector: Type.Optional(Type.String({ description: "CSS selector to click or inspect for media download." })),
			url: Type.Optional(Type.String({ description: "Direct HTTP(S) URL to download via Chrome downloads API." })),
			mode: Type.Optional(Type.Union([Type.Literal("click"), Type.Literal("media"), Type.Literal("url")], { description: "click | media | url. Default click for selector, url when url is provided." })),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when selector matches multiple elements; default 0." })),
			filename: Type.Optional(Type.String({ description: "Optional suggested filename for direct URL or media mode. Chrome may still uniquify or adjust it." })),
			conflictAction: Type.Optional(Type.Union([Type.Literal("uniquify"), Type.Literal("overwrite"), Type.Literal("prompt")], { description: "Direct URL only: uniquify | overwrite | prompt." })),
			saveAs: Type.Optional(Type.Boolean({ description: "Direct URL only: ask Chrome to show Save As dialog; default false." })),
			expectMime: Type.Optional(Type.String({ description: "Expected MIME or category ('image'/'media'/'video'/'audio', or a full type like 'image/png'). media mode defaults to 'image'. If the completed download's MIME doesn't match, the result flags a `mimeMismatch` diagnostic (e.g. an anti-bot text/html page returned for an image)." })),
		}),
		validateArguments: validateDownloadArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				requireDownloadTarget(params);
				const command = buildTransferDownloadCommand(params);
				const timeoutMs = commandTimeoutMs(params.timeoutMs, 35_000);
				const maxChars = commandMaxChars(params, "browser_download");
				command.timeoutMs = timeoutMs;
				const server = await ensureStarted();
				const rawTarget = targetTabId(params) as string | number | undefined;
				const tabId = resolveLocalTargetTabId(server, rawTarget, params.browserSessionId);
				const outcome = await withBrowserOperation({ server, commandName: "browser_download", command: "transfer.download", action: String(command.mode || "click"), browserSessionId: params.browserSessionId, tabId, targetRef: typeof rawTarget === "string" ? rawTarget : undefined, timeoutMs, ctx, onUpdate: _onUpdate, signal }, async ({ signal: operationSignal }) => {
					const result = await server.sendCommand(command as typeof command & { cmd: string }, { browserSessionId: params.browserSessionId, tabId: rawTarget, timeoutMs, accessMode: "write", signal: operationSignal });
					const expectMime = typeof params.expectMime === "string" && params.expectMime.trim() ? params.expectMime.trim().toLowerCase() : (command.mode === "media" ? "image" : undefined);
					if (expectMime) annotateDownloadMimeMismatch(result, expectMime);
					return result;
				});
				return await browserOperationCommandResult(outcome, {
					budgetName: "browser_download",
					maxChars,
					ctx,
					details: { command: "transfer.download", mode: command.mode || "click", operationId: outcome.operationId, status: outcome.status },
				});
			});
		},
	});
}

export function defineUploadCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_upload",
		label: "Browser Upload",
		description: "Upload local file(s) through a page file chooser using CDP DOM.setFileInputFiles.",
		promptSnippet: "Click a file input/chooser selector and set absolute local file paths after explicit confirmation.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_upload only after the user explicitly approves the exact local file path(s); set confirm:true."],
		parameters: strictCommandParameters({
			...sharedTabScopedToolParams(),
			selector: Type.String({ description: "CSS selector for the file input, label, or button that opens the file chooser." }),
			files: Type.Array(Type.String({ description: "Absolute local file path to upload." }), { description: "One or more absolute local file paths." }),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when selector matches multiple elements; default 0." })),
			confirm: Type.Boolean({ description: "Must be true to confirm the user approved uploading these exact local file path(s)." }),
		}),
		validateArguments: validateUploadArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				requireUploadConfirmation(params.confirm, params.selector);
				const selector = String(params.selector || "").trim();
				if (!selector) throw codedTransferError("UPLOAD_SELECTOR_REQUIRED", "browser_upload requires selector", {});
				const files = await checkedUploadFiles(params.files);
				const server = await ensureStarted();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = commandMaxChars(params, "browser_upload");
				await server.acquireUiLock(params.browserSessionId, "browser_upload");
				try {
					const command = buildTransferUploadCommand(selector, files, params.index);
					command.timeoutMs = timeoutMs;
					const rawTarget = targetTabId(params) as string | number | undefined;
					const tabId = resolveLocalTargetTabId(server, rawTarget, params.browserSessionId);
					const outcome = await withBrowserOperation({ server, commandName: "browser_upload", command: "transfer.upload", action: "upload", browserSessionId: params.browserSessionId, tabId, targetRef: typeof rawTarget === "string" ? rawTarget : undefined, timeoutMs, ctx, onUpdate: _onUpdate, signal }, ({ signal: operationSignal }) => server.sendCommand(command as typeof command & { cmd: string }, { browserSessionId: params.browserSessionId, tabId: rawTarget, timeoutMs, accessMode: "write", signal: operationSignal }));
					return await browserOperationCommandResult(outcome, {
						budgetName: "browser_upload",
						maxChars,
						ctx,
						details: { command: "transfer.upload", selector, files_count: files.length, operationId: outcome.operationId, status: outcome.status },
					});
				} finally {
					server.releaseUiLock(params.browserSessionId);
				}
			});
		},
	});
}
