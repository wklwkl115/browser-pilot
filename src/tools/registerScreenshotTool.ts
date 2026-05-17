import { Type } from "typebox";
import { errorResult, jsonResult } from "../utils/toolResult";
import { resolveArtifactPath, saveDataUrl } from "./artifacts";
import { defaultResultBudget } from "./budgets";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, optionalTargetTabId, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerScreenshotTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Native screenshot capture. Saves the image to disk by default and returns the file path.",
		promptSnippet: "Capture a screenshot of the target browser tab and save it as an artifact file.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_screenshot when visual state is required; prefer targeted browser_scan/browser_html for text."],
		parameters: Type.Object({
			tabId: optionalTargetTabId(),
			format: Type.Optional(Type.String({ description: "png | jpeg | webp" })),
			quality: Type.Optional(Type.Number({ description: "JPEG/WebP quality" })),
			captureBeyondViewport: Type.Optional(Type.Boolean({ description: "CDP captureBeyondViewport" })),
			fallback: Type.Optional(Type.Boolean({ description: "Allow visible-tab fallback" })),
			outputPath: Type.Optional(Type.String({ description: "Output image path; defaults to .pi/browser-artifacts" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
			maxChars: Type.Optional(Type.Number({ description: "Maximum metadata characters returned" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const format = String(params.format || "png").toLowerCase();
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_screenshot"));
				const result = await server.sendCommand({ cmd: "screenshot.capture", format, quality: params.quality, captureBeyondViewport: params.captureBeyondViewport, fallback: params.fallback, timeoutMs }, { tabId: params.tabId, timeoutMs });
				const data = result.data as Record<string, unknown> | undefined;
				const screenshot = typeof data?.screenshot === "string" ? data.screenshot : undefined;
				let saved: Record<string, unknown> | undefined;
				if (screenshot) {
					const ext = format === "jpeg" ? "jpg" : format;
					const outputPath = resolveArtifactPath(ctx, params.outputPath, `screenshot-${Date.now()}.${ext}`);
					saved = await saveDataUrl(screenshot, outputPath);
					if (data) data.screenshot = `[saved to ${outputPath}]`;
				}
				return jsonResult({ ...result, data, saved }, { command: "screenshot.capture", saved }, maxChars);
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
