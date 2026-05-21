import { Type } from "typebox";
import { resolveArtifactPath, saveDataUrl } from "./artifacts";
import { inlineJsonToolResult, runTool, sharedTabScopedToolParams, toolTimeoutMs } from "./toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerScreenshotTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Native screenshot capture. Saves the image to disk by default and returns the file path.",
		promptSnippet: "Capture a screenshot of the target browser tab and save it as an artifact file.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_screenshot when visual state is required; prefer targeted browser_scan/browser_html for text."],
		parameters: Type.Object({
			...sharedTabScopedToolParams({ includeDetailLevel: false, outputPathDescription: "Output image path; defaults to .pi/browser-artifacts", maxCharsDescription: "Maximum metadata characters returned" }),
			format: Type.Optional(Type.String({ description: "png | jpeg | webp" })),
			quality: Type.Optional(Type.Number({ description: "JPEG/WebP quality" })),
			captureBeyondViewport: Type.Optional(Type.Boolean({ description: "CDP captureBeyondViewport" })),
			fallback: Type.Optional(Type.Boolean({ description: "Allow visible-tab fallback" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const server = await ensureStarted();
				const format = String(params.format || "png").toLowerCase();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const result = await server.sendCommand({ cmd: "screenshot.capture", format, quality: params.quality, captureBeyondViewport: params.captureBeyondViewport, fallback: params.fallback, timeoutMs }, { tabId: params.tabId, timeoutMs });
				const data = result.data as Record<string, unknown> | undefined;
				const screenshot = typeof data?.screenshot === "string" ? data.screenshot : undefined;
				let saved: Record<string, unknown> | undefined;
				if (screenshot) {
					const actualFormat = typeof data?.format === "string" ? data.format.toLowerCase() : format;
					const ext = actualFormat === "jpeg" ? "jpg" : actualFormat;
					const outputPath = resolveArtifactPath(ctx, params.outputPath, `screenshot-${Date.now()}.${ext}`);
					saved = await saveDataUrl(screenshot, outputPath);
					if (data) data.screenshot = `[saved to ${outputPath}]`;
				}
				return inlineJsonToolResult({ ...result, data, saved }, { command: "screenshot.capture", saved }, params, "browser_screenshot");
			});
		},
	});
}
