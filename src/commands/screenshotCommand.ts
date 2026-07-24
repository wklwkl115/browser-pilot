import { Type } from "typebox";
import { decodeDataUrl, resolveArtifactPath, saveBuffer } from "../artifacts/artifactFiles.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserCommand, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, strictCommandParameters } from "./commandShared.js";
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
		description: "Capture a native screenshot and return it as an MCP resource.",
		promptGuidelines: ["Use browser_screenshot when visual state is required; prefer browser_observe for text and page structure."],
		parameters: strictCommandParameters({
			...sharedTabScopedToolParams(),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture beyond the visible viewport." })),
		}),
		async execute(params, signal, ctx) {
			return await runCommandHandler(async () => {
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const result = await server.sendCommand({ cmd: SCREENSHOT_COMMAND, format: "png", captureBeyondViewport: params.fullPage === true, fallback: true, timeoutMs }, { tabId: targetTabId(params) as string | number | undefined, timeoutMs, signal });
				const data = result.data as Record<string, unknown> | undefined;
				const screenshot = typeof data?.screenshot === "string" ? data.screenshot : undefined;
				let saved: Awaited<ReturnType<typeof saveBuffer>> | undefined;
				let dimensions: { width: number; height: number } | undefined;
				if (screenshot) {
					const outputPath = resolveArtifactPath(ctx, undefined, `screenshot-${Date.now()}.png`);
					const decoded = decodeDataUrl(screenshot);
					dimensions = imageDimensions(decoded.buffer);
					saved = await saveBuffer(decoded.buffer, outputPath, decoded.mime);
				}
				return jsonResult({ captured: Boolean(saved), ...(dimensions ?? {}), ...(saved ? { mime: saved.mime } : {}) }, { saved });
			});
		},
	});
}
