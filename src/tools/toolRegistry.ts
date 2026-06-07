import { registerArtifactTool } from "./registerArtifactTool.js";
import { registerCommandTool } from "./registerCommandTool.js";
import { registerEvidenceTool } from "./registerEvidenceTool.js";
import { registerExecuteTool } from "./registerExecuteTool.js";
import { registerFrameTool, registerHookTool, registerNetworkTool, registerWaitTool } from "./registerNativeActionTools.js";
import { registerObserveTool } from "./registerObserveTool.js";
import { registerMemoryTool } from "./registerMemoryTool.js";
import { registerPickTool } from "./registerPickTool.js";
import { registerScreenshotTool } from "./registerScreenshotTool.js";
import { registerTabsTool } from "./registerTabsTool.js";
import { registerDownloadTool, registerUploadTool } from "./registerTransferTools.js";
import {
	registerCallbackOastTool,
	registerCookieAnalyzeTool,
	registerCrawlTool,
	registerFuzzTool,
	registerHttpReplayTool,
	registerSqliTool,
	registerTemplateTool,
} from "./registerWebSecurityTools.js";
import type { ToolRegistrar } from "./toolShared.js";

const CORE_BROWSER_TOOL_REGISTRARS: readonly ToolRegistrar[] = [
	registerTabsTool,
	registerCommandTool,
	registerExecuteTool,
	registerObserveTool,
	registerPickTool,
	registerDownloadTool,
	registerUploadTool,
	registerWaitTool,
	registerNetworkTool,
	registerHookTool,
	registerEvidenceTool,
	registerFrameTool,
	registerScreenshotTool,
	registerArtifactTool,
	registerMemoryTool,
];

const WEB_SECURITY_TOOL_REGISTRARS: readonly ToolRegistrar[] = [
	registerCrawlTool,
	registerFuzzTool,
	registerSqliTool,
	registerTemplateTool,
	registerCallbackOastTool,
	registerCookieAnalyzeTool,
	registerHttpReplayTool,
];

export const BROWSER_TOOL_REGISTRARS: readonly ToolRegistrar[] = [
	...CORE_BROWSER_TOOL_REGISTRARS,
	...WEB_SECURITY_TOOL_REGISTRARS,
];

export const WEB_SECURITY_TOOL_NAMES = new Set([
	"browser_crawl",
	"browser_fuzz",
	"browser_sqli",
	"browser_template",
	"browser_callback_oast",
	"browser_cookie_analyze",
	"browser_http_replay",
]);

export function resolveBrowserToolRegistrars(): readonly ToolRegistrar[] {
	return BROWSER_TOOL_REGISTRARS;
}
