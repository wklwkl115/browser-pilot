import type { BrowserToolHost } from "../frontend/toolHost.js";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { ensureBuiltinDistillersRegistered } from "./distillerRegistry.js";
import { withRelevanceTraceTap } from "./relevanceTraceAdapter.js";
import { resolveBrowserToolRegistrars } from "./toolRegistry.js";
import type { EnsureStarted, MemoryResultResourceResolver, ToolRegistrarContext } from "./toolShared.js";

export function registerBrowserTools(pi: BrowserToolHost, server: BrowserBridgeServer, ensureStarted: EnsureStarted, options: { memoryEvidenceResolver?: MemoryResultResourceResolver } = {}) {
	ensureBuiltinDistillersRegistered();
	const context: ToolRegistrarContext = { pi: withRelevanceTraceTap(pi, server), ensureStarted, memoryEvidenceResolver: options.memoryEvidenceResolver };
	for (const registerTool of resolveBrowserToolRegistrars()) registerTool(context);
}
