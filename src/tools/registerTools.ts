import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { ensureBuiltinDistillersRegistered } from "./distillerRegistry.js";
import { resolveBrowserToolRegistrars } from "./toolRegistry.js";
import type { EnsureStarted, ToolRegistrarContext } from "./toolShared.js";

export function registerBrowserTools(_pi: ExtensionAPI, _server: BrowserBridgeServer, ensureStarted: EnsureStarted, options: { securityToolsEnabled?: boolean } = {}) {
	ensureBuiltinDistillersRegistered();
	const context: ToolRegistrarContext = { pi: _pi, ensureStarted };
	for (const registerTool of resolveBrowserToolRegistrars(options)) registerTool(context);
}
