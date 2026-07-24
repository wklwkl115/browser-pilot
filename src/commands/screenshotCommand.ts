import { Type } from "typebox";
import { decodeDataUrl, resolveArtifactPath, saveBuffer } from "../artifacts/artifactFiles.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserCommand, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";

const SCREENSHOT_COMMAND = "screenshot.capture";

// Read PNG dimensions without reading the saved image.
export function imageDimensions(buf: Buffer): { width: number; height: number } | undefined {
	if (buf.length < 24) return undefined;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	return undefined;
}

export function defineScreenshotCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Native screenshot capture. Saves the image to disk by default and returns the file path.",
		promptSnippet: "Capture a screenshot of the target browser tab and save it as an artifact file.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_screenshot when visual state is required; prefer browser_observe for text and page structure."],
		parameters: strictCommandParameters({
			...sharedTabScopedToolParams(),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture beyond the visible viewport." })),
		}),
		async execute(params, _signal, ctx) {
			return await runCommandHandler(async () => {
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const commandName = SCREENSHOT_COMMAND;
				const result = await server.sendCommand({ cmd: commandName, format: "png", captureBeyondViewport: params.fullPage === true, fallback: true, timeoutMs }, { tabId: targetTabId(params) as string | number | undefined, timeoutMs });
				const data = result.data as Record<string, unknown> | undefined;
				const screenshot = typeof data?.screenshot === "string" ? data.screenshot : undefined;
				let saved: Record<string, unknown> | undefined;
				if (screenshot) {
					const outputPath = resolveArtifactPath(ctx, undefined, `screenshot-${Date.now()}.png`);
					const decoded = decodeDataUrl(screenshot);
					const dims = imageDimensions(decoded.buffer);
					saved = await saveBuffer(decoded.buffer, outputPath, decoded.mime);
					if (data) {
						data.screenshot = `[saved to ${outputPath}]`;
						if (dims && data.width === undefined) data.width = dims.width;
						if (dims && data.height === undefined) data.height = dims.height;
					}
				}
				return jsonResult({ ...result, data, saved }, { command: commandName, saved });
			});
		},
	});
}
