import { Type } from "typebox";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { summarizeTransferData } from "./summaries/index";
import { buildTransferDownloadCommand, buildTransferUploadCommand, checkedUploadFiles, codedTransferError, requireDownloadTarget, requireUploadConfirmation } from "./transferValidation";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function sharedTransferParams() {
	return {
		tabId: optionalTargetTabId(),
		detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
		outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
		timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
	};
}

export function registerDownloadTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_download",
		label: "Browser Download",
		description: "Trigger or wait for a browser download and return the completed local file path from Chrome downloads.",
		promptSnippet: "Download via selector click, media selector extraction, or direct HTTP(S) URL; returns download id/path/state.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_download when the task needs a stable downloaded file path instead of scripting a click manually."],
		parameters: Type.Object({
			...sharedTransferParams(),
			selector: Type.Optional(Type.String({ description: "CSS selector to click or inspect for media download." })),
			url: Type.Optional(Type.String({ description: "Direct HTTP(S) URL to download via Chrome downloads API." })),
			mode: Type.Optional(Type.String({ description: "click | media | url. Default click for selector, url when url is provided." })),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when selector matches multiple elements; default 0." })),
			filename: Type.Optional(Type.String({ description: "Optional suggested filename for direct URL or media mode. Chrome may still uniquify or adjust it." })),
			conflictAction: Type.Optional(Type.String({ description: "Direct URL only: uniquify | overwrite | prompt." })),
			saveAs: Type.Optional(Type.Boolean({ description: "Direct URL only: ask Chrome to show Save As dialog; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireDownloadTarget(params);
				const command = buildTransferDownloadCommand(params);
				const timeoutMs = asPositiveInt(params.timeoutMs, 35_000);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_download"));
				command.timeoutMs = timeoutMs;
				const server = await ensureStarted();
				const result = await server.sendCommand(command, { tabId: params.tabId, timeoutMs });
				return await distilledJsonResult(result, {
					toolName: "browser_download",
					command: "transfer.download",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `download-${Date.now()}.json`,
					details: { command: "transfer.download", mode: command.mode || "click" },
					artifactValue: result,
					distill: summarizeTransferData,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

export function registerUploadTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_upload",
		label: "Browser Upload",
		description: "Upload local file(s) through a page file chooser using CDP DOM.setFileInputFiles.",
		promptSnippet: "Click a file input/chooser selector and set absolute local file paths after explicit confirmation.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_upload only after the user explicitly approves the exact local file path(s); set confirm:true."],
		parameters: Type.Object({
			...sharedTransferParams(),
			selector: Type.String({ description: "CSS selector for the file input, label, or button that opens the file chooser." }),
			files: Type.Array(Type.String({ description: "Absolute local file path to upload." }), { description: "One or more absolute local file paths." }),
			index: Type.Optional(Type.Number({ description: "Zero-based match index when selector matches multiple elements; default 0." })),
			confirm: Type.Boolean({ description: "Must be true to confirm the user approved uploading these exact local file path(s)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireUploadConfirmation(params.confirm, params.selector);
				const selector = String(params.selector || "").trim();
				if (!selector) throw codedTransferError("UPLOAD_SELECTOR_REQUIRED", "browser_upload requires selector", {});
				const files = await checkedUploadFiles(params.files);
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_upload"));
				const command = buildTransferUploadCommand(selector, files, params.index);
				command.timeoutMs = timeoutMs;
				const result = await server.sendCommand(command, { tabId: params.tabId, timeoutMs });
				return await distilledJsonResult(result, {
					toolName: "browser_upload",
					command: "transfer.upload",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `upload-${Date.now()}.json`,
					details: { command: "transfer.upload", selector, files_count: files.length },
					artifactValue: result,
					distill: summarizeTransferData,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
