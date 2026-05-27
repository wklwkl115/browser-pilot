import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer";
import { resolveBrowserToolRegistrars } from "./toolRegistry";
import type { EnsureStarted, ToolRegistrarContext } from "./toolShared";

export function registerBrowserTools(_pi: ExtensionAPI, _server: BrowserBridgeServer, ensureStarted: EnsureStarted, options: { securityToolsEnabled?: boolean } = {}) {
	const context: ToolRegistrarContext = { pi: _pi, ensureStarted };
	for (const registerTool of resolveBrowserToolRegistrars(options)) registerTool(context);
}
