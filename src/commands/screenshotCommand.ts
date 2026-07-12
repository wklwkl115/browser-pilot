import { Type } from "typebox";
import { nativeCommandToolMetadata } from "./nativeActionMetadata.js";
import { resolveArtifactPath, saveDataUrl } from "../artifacts/artifactFiles.js";
import { defineBrowserCommand, inlineJsonCommandResult, runCommandHandler, sharedTabScopedToolParams, targetTabId, commandTimeoutMs } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";

// Decode pixel dimensions from a base64 image data URL so the screenshot summary can report
// width/height without reading the saved image. PNG (IHDR) and JPEG (SOF) are covered;
// unknown formats return undefined rather than guessing.
export function imageDimensions(dataUrl: string): { width: number; height: number } | undefined {
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return undefined;
	let buf: Buffer;
	try { buf = Buffer.from(dataUrl.slice(comma + 1), "base64"); } catch { return undefined; }
	if (buf.length < 24) return undefined;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		let off = 2;
		while (off + 9 < buf.length) {
			if (buf[off] !== 0xff) { off += 1; continue; }
			const marker = buf[off + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
			}
			off += 2 + buf.readUInt16BE(off + 2);
		}
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
			format: Type.Optional(Type.String({ description: "png | jpeg | webp" })),
			quality: Type.Optional(Type.Number({ description: "JPEG/WebP quality" })),
			captureBeyondViewport: Type.Optional(Type.Boolean({ description: "CDP captureBeyondViewport" })),
			fallback: Type.Optional(Type.Boolean({ description: "Allow visible-tab fallback" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const server = await ensureStarted();
				const format = String(params.format || "png").toLowerCase();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const commandName = nativeCommandToolMetadata.browser_screenshot.command;
				const result = await server.sendCommand({ cmd: commandName, format, quality: params.quality, captureBeyondViewport: params.captureBeyondViewport, fallback: params.fallback, timeoutMs }, { browserSessionId: params.browserSessionId, tabId: targetTabId(params) as string | number | undefined, timeoutMs });
				const data = result.data as Record<string, unknown> | undefined;
				const screenshot = typeof data?.screenshot === "string" ? data.screenshot : undefined;
				let saved: Record<string, unknown> | undefined;
				if (screenshot) {
					const actualFormat = typeof data?.format === "string" ? data.format.toLowerCase() : format;
					const ext = actualFormat === "jpeg" ? "jpg" : actualFormat;
					const outputPath = resolveArtifactPath(ctx, params.outputPath, `screenshot-${Date.now()}.${ext}`);
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
