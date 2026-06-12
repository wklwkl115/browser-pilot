import { Type } from "typebox";
import { nativeTransferToolMetadata } from "../protocol/nativeActionMetadata.js";
import { summarizeTransferData } from "./summaries/index.js";
import { buildTransferDownloadCommand, buildTransferUploadCommand, checkedUploadFiles, codedTransferError, requireDownloadTarget, requireUploadConfirmation } from "./transferValidation.js";
import { artifactFallbackName, defineBrowserTool, jsonToolResult, runTool, sharedTabScopedToolParams, targetTabId, toolMaxChars, toolTimeoutMs } from "./toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";
import { isRecord } from "../utils/records.js";

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

export function registerDownloadTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_download",
		label: "Browser Download",
		description: "Trigger or wait for a browser download and return the completed local file path from Chrome downloads.",
		promptSnippet: "Download via selector click, media selector extraction, or direct HTTP(S) URL; returns download id/path/state.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_download when the task needs a stable downloaded file path instead of scripting a click manually."],
		parameters: strictToolParameters({
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				requireDownloadTarget(params);
				const command = buildTransferDownloadCommand(params);
				const timeoutMs = toolTimeoutMs(params.timeoutMs, 35_000);
				const maxChars = toolMaxChars(params, "browser_download");
				command.timeoutMs = timeoutMs;
				const server = await ensureStarted();
				const result = await server.sendCommand(command as typeof command & { cmd: string }, { browserSessionId: params.browserSessionId, tabId: targetTabId(params) as string | number | undefined, timeoutMs });
				const expectMime = typeof params.expectMime === "string" && params.expectMime.trim()
					? params.expectMime.trim().toLowerCase()
					: (command.mode === "media" ? "image" : undefined);
				if (expectMime) annotateDownloadMimeMismatch(result, expectMime);
				return await jsonToolResult(result, params, ctx, {
					toolName: "browser_download",
					command: nativeTransferToolMetadata.browser_download.command,
					maxChars,
					fallbackName: artifactFallbackName(nativeTransferToolMetadata.browser_download.artifactPrefix),
					details: { command: nativeTransferToolMetadata.browser_download.command, mode: command.mode || "click" },
					artifactValue: result,
					distill: summarizeTransferData,
				});
			});
		},
	});
}

export function registerUploadTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_upload",
		label: "Browser Upload",
		description: "Upload local file(s) through a page file chooser using CDP DOM.setFileInputFiles.",
		promptSnippet: "Click a file input/chooser selector and set absolute local file paths after explicit confirmation.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_upload only after the user explicitly approves the exact local file path(s); set confirm:true."],
		parameters: strictToolParameters({
			...sharedTabScopedToolParams(),
			selector: Type.String({ description: "CSS selector for the file input, label, or button that opens the file chooser." }),
			files: Type.Array(Type.String({ description: "Absolute local file path to upload." }), { description: "One or more absolute local file paths." }),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when selector matches multiple elements; default 0." })),
			confirm: Type.Boolean({ description: "Must be true to confirm the user approved uploading these exact local file path(s)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				requireUploadConfirmation(params.confirm, params.selector);
				const selector = String(params.selector || "").trim();
				if (!selector) throw codedTransferError("UPLOAD_SELECTOR_REQUIRED", "browser_upload requires selector", {});
				const files = await checkedUploadFiles(params.files);
				const server = await ensureStarted();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_upload");
				server.acquireUiLock(params.browserSessionId, "browser_upload");
				try {
					const command = buildTransferUploadCommand(selector, files, params.index);
					command.timeoutMs = timeoutMs;
					const result = await server.sendCommand(command as typeof command & { cmd: string }, { browserSessionId: params.browserSessionId, tabId: targetTabId(params) as string | number | undefined, timeoutMs });
					return await jsonToolResult(result, params, ctx, {
						toolName: "browser_upload",
						command: nativeTransferToolMetadata.browser_upload.command,
						maxChars,
						fallbackName: artifactFallbackName(nativeTransferToolMetadata.browser_upload.artifactPrefix),
						details: { command: nativeTransferToolMetadata.browser_upload.command, selector, files_count: files.length },
						artifactValue: result,
						distill: summarizeTransferData,
					});
				} finally {
					server.releaseUiLock(params.browserSessionId);
				}
			});
		},
	});
}
