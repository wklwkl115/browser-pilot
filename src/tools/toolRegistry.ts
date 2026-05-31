import { registerArtifactTool } from "./registerArtifactTool.js";
import { registerCommandTool } from "./registerCommandTool.js";
import { registerEvidenceTool } from "./registerEvidenceTool.js";
import { registerExecuteTool } from "./registerExecuteTool.js";
import { registerFrameTool, registerHookTool, registerNetworkTool, registerWaitTool } from "./registerNativeActionTools.js";
import { registerObserveTool } from "./registerObserveTool.js";
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

export const CORE_BROWSER_TOOL_REGISTRARS: readonly ToolRegistrar[] = [
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
];

export const WEB_SECURITY_TOOL_REGISTRARS: readonly ToolRegistrar[] = [
	registerCrawlTool,
	registerFuzzTool,
	registerSqliTool,
	registerTemplateTool,
	registerCallbackOastTool,
	registerCookieAnalyzeTool,
	registerHttpReplayTool,
];

export function resolveBrowserToolRegistrars(options: { securityToolsEnabled?: boolean } = {}): readonly ToolRegistrar[] {
	return options.securityToolsEnabled === false
		? CORE_BROWSER_TOOL_REGISTRARS
		: [...CORE_BROWSER_TOOL_REGISTRARS, ...WEB_SECURITY_TOOL_REGISTRARS];
}
