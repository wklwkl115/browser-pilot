import { registerArtifactTool } from "./registerArtifactTool";
import { registerCommandTool } from "./registerCommandTool";
import { registerEvidenceTool } from "./registerEvidenceTool";
import { registerExecuteTool } from "./registerExecuteTool";
import { registerFrameTool, registerHookTool, registerNetworkTool, registerWaitTool } from "./registerNativeActionTools";
import { registerObserveTool } from "./registerObserveTool";
import { registerPickTool } from "./registerPickTool";
import { registerScreenshotTool } from "./registerScreenshotTool";
import { registerTabsTool } from "./registerTabsTool";
import { registerDownloadTool, registerUploadTool } from "./registerTransferTools";
import {
	registerCallbackOastTool,
	registerCookieAnalyzeTool,
	registerCrawlTool,
	registerFuzzTool,
	registerHttpReplayTool,
	registerSqliTool,
	registerTemplateTool,
} from "./registerWebSecurityTools";
import type { ToolRegistrar } from "./toolShared";

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
