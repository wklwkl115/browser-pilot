import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer";
import { registerTabsTool } from "./registerTabsTool";
import { registerExecuteTool } from "./registerExecuteTool";
import { registerScanTool } from "./registerScanTool";
import { registerPickTool } from "./registerPickTool";
import { registerContentTool } from "./registerContentTool";
import { registerQueryTool, registerClickTool, registerTypeTool } from "./registerElementActionTools";
import { registerSemanticDomTools } from "./registerSemanticDomTools";
import { registerDownloadTool, registerUploadTool } from "./registerTransferTools";
import { registerWaitTool, registerNetworkTool, registerHookTool, registerFrameTool } from "./registerNativeActionTools";
import { registerEvidenceTool } from "./registerEvidenceTool";
import { registerHtmlTool } from "./registerHtmlTool";
import { registerScreenshotTool } from "./registerScreenshotTool";
import { registerArtifactTool } from "./registerArtifactTool";
import type { EnsureStarted, ToolRegistrarContext } from "./toolShared";

export function registerBrowserTools(_pi: ExtensionAPI, _server: BrowserBridgeServer, ensureStarted: EnsureStarted) {
	const context: ToolRegistrarContext = { pi: _pi, ensureStarted };
	registerTabsTool(context);
	registerExecuteTool(context);
	registerScanTool(context);
	registerPickTool(context);
	registerContentTool(context);
	registerQueryTool(context);
	registerClickTool(context);
	registerTypeTool(context);
	registerSemanticDomTools(context);
	registerDownloadTool(context);
	registerUploadTool(context);
	registerWaitTool(context);
	registerNetworkTool(context);
	registerHookTool(context);
	registerEvidenceTool(context);
	registerFrameTool(context);
	registerHtmlTool(context);
	registerScreenshotTool(context);
	registerArtifactTool(context);
}
