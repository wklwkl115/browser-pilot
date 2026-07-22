import { Type } from "typebox";
import { resolveArtifactPath, saveDataUrl } from "../artifacts/artifactFiles.js";
import { defineBrowserCommand, inlineJsonCommandResult, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";

const SCREENSHOT_COMMAND = "screenshot.capture";

// Decode PNG dimensions without reading the saved image.
export function imageDimensions(dataUrl: string): { width: number; height: number } | undefined {
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return undefined;
	let buf: Buffer;
	try { buf = Buffer.from(dataUrl.slice(comma + 1), "base64"); } catch { return undefined; }
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
					const dims = imageDimensions(screenshot);
					saved = await saveDataUrl(screenshot, outputPath);
					if (data) {
						data.screenshot = `[saved to ${outputPath}]`;
						if (dims && data.width === undefined) data.width = dims.width;
						if (dims && data.height === undefined) data.height = dims.height;
					}
				}
				return inlineJsonCommandResult({ ...result, data, saved }, { command: commandName, saved }, params, "browser_screenshot");
			});
		},
	});
}
