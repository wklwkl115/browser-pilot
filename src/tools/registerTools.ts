import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { ensureBuiltinDistillersRegistered } from "./distillerRegistry.js";
import { resolveBrowserToolRegistrars } from "./toolRegistry.js";
import type { EnsureStarted, MemoryResultResourceResolver, ToolRegistrarContext } from "./toolShared.js";

export function registerBrowserTools(_pi: ExtensionAPI, _server: BrowserBridgeServer, ensureStarted: EnsureStarted, options: { securityToolsEnabled?: boolean; memoryEvidenceResolver?: MemoryResultResourceResolver } = {}) {
	ensureBuiltinDistillersRegistered();
	const context: ToolRegistrarContext = { pi: _pi, ensureStarted, memoryEvidenceResolver: options.memoryEvidenceResolver };
	for (const registerTool of resolveBrowserToolRegistrars(options)) registerTool(context);
}
